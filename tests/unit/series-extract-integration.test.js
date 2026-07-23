// tests/unit/series-extract-integration.test.js
// Phase 4: chrome.storage.local をモックして series-store の Phase 4 関数をテスト

import { describe, it, expect, beforeEach } from 'vitest';

// ============================================================
// chrome.storage.local メモリモック
// ============================================================
let _store = {};

const chromeMock = {
  storage: {
    local: {
      QUOTA_BYTES: 10 * 1024 * 1024,
      async get(key) {
        if (key === null) return { ..._store };
        if (typeof key === 'string') return { [key]: _store[key] };
        const result = {};
        for (const k of key) result[k] = _store[k];
        return result;
      },
      async set(obj) { Object.assign(_store, obj); },
      async remove(key) {
        if (typeof key === 'string') delete _store[key];
        else key.forEach(k => delete _store[k]);
      },
    },
  },
};

beforeEach(() => {
  _store = {};
  globalThis.chrome = chromeMock;
});

async function loadStore() {
  return await import('../../series-store.js');
}

// シリーズを作る共通ヘルパ
function makeSeries(overrides = {}) {
  return {
    meta: { name: 'Test', issueCount: 1, lastVisitedAt: Date.now() - 61_000 },
    urlPatterns: [],
    overrides: {},
    glossary: { ja: {} },
    tone: { style: 'auto' },
    stats: {
      translationCount: 1,
      lastTranslatedAt: Date.now() - 61_000,
      glossaryHits: 0,
      extractionRuns: 0,
      candidatesAdded: 0,
      candidatesRejected: 0,
      lastExtractionAt: null,
    },
    recentPairs: [],
    extractionDue: false,
    extractionRunning: null,
    extractionFailures: 0,
    rejectedOriginals: [],
    ...overrides,
  };
}

// ============================================================
// ペア追加 → extractionDue フロー
// ============================================================
describe('ペア追加 → extractionDue フロー', () => {
  it('recentPairs が 20 件に達すると extractionDue が true になる', async () => {
    const { recordSeriesTranslation, getSeries } = await loadStore();
    const old = Date.now() - 61_000;
    _store['series:flow001'] = makeSeries({
      recentPairs: Array.from({ length: 19 }, (_, i) => ({
        original: 'term' + i,
        translated: '訳' + i,
        at: old,
      })),
      stats: { translationCount: 1, lastTranslatedAt: old },
    });

    await recordSeriesTranslation({
      seriesId: 'flow001',
      name: 'Test',
      detectionSource: 'regex',
      url: 'https://example.com/comic/2',
      pairs: [{ original: 'The Hulk smashed the wall', translated: 'ハルクが壁を破壊した' }],
    });

    const series = await getSeries('flow001');
    expect(series.recentPairs.length).toBeGreaterThanOrEqual(20);
    expect(series.extractionDue).toBe(true);
  });

  it('recentPairs が 50 件超で古いものから捨てられる', async () => {
    const { recordSeriesTranslation, getSeries } = await loadStore();
    const old = Date.now() - 61_000;

    const existing50 = Array.from({ length: 50 }, (_, i) => ({
      original: `oldterm${i}`,
      translated: `訳${i}`,
      at: old + i,
    }));

    _store['series:flow002'] = makeSeries({
      recentPairs: existing50,
      extractionDue: true,
      stats: { translationCount: 50, lastTranslatedAt: old },
    });

    await recordSeriesTranslation({
      seriesId: 'flow002',
      name: 'Test',
      detectionSource: 'regex',
      url: 'https://example.com/comic/51',
      pairs: [{ original: 'NewTermLong', translated: '新語' }],
    });

    const series = await getSeries('flow002');
    expect(series.recentPairs.length).toBeLessThanOrEqual(50);
  });
});

// ============================================================
// マージ後 recentPairs クリア・extractionDue=false
// ============================================================
describe('applyExtractionResult — マージ後のクリーンアップ', () => {
  it('成功後に recentPairs がクリアされ extractionDue=false になる', async () => {
    const { applyExtractionResult, getSeries } = await loadStore();
    _store['series:merge001'] = makeSeries({
      recentPairs: [{ original: 'Hulk', translated: 'ハルク', at: Date.now() }],
      extractionDue: true,
      extractionRunning: { startedAt: Date.now() - 1000 },
    });

    await applyExtractionResult({
      seriesId: 'merge001',
      candidates: [{ original: 'Hulk', translated: 'ハルク' }],
      success: true,
    });

    const series = await getSeries('merge001');
    expect(series.recentPairs).toHaveLength(0);
    expect(series.extractionDue).toBe(false);
    expect(series.extractionRunning).toBeNull();
  });

  it('成功後に glossaryLangMap に候補が追加される', async () => {
    const { applyExtractionResult, getSeries } = await loadStore();
    _store['series:merge002'] = makeSeries({
      glossary: { ja: {} },
      extractionRunning: { startedAt: Date.now() - 1000 },
    });

    const result = await applyExtractionResult({
      seriesId: 'merge002',
      candidates: [
        { original: 'Hulk', translated: 'ハルク' },
        { original: 'Banner', translated: 'バナー' },
      ],
      success: true,
    });

    expect(result.added).toBe(2);
    const series = await getSeries('merge002');
    expect(series.glossary.ja['Hulk']).toBeDefined();
    expect(series.glossary.ja['Banner']).toBeDefined();
    expect(series.glossary.ja['Hulk'].approved).toBe(false);
    expect(series.glossary.ja['Hulk'].source).toBe('nano-extract');
  });
});

// ============================================================
// 二重実行ロック
// ============================================================
describe('二重実行ロック', () => {
  it('extractionRunning が立っている状態でロック取得すると "locked"', async () => {
    const { acquireExtractionLock } = await loadStore();
    const now = Date.now();
    _store['series:lock001'] = makeSeries({
      extractionRunning: { startedAt: now - 5000 }, // 5 秒前（30 秒以内）
    });

    const result = await acquireExtractionLock('lock001');
    expect(result.status).toBe('locked');
  });

  it('30 秒経過したロックは上書き取得できる', async () => {
    const { acquireExtractionLock, getSeries } = await loadStore();
    const now = Date.now();
    _store['series:lock002'] = makeSeries({
      extractionRunning: { startedAt: now - 31_000 }, // タイムアウト
    });

    const result = await acquireExtractionLock('lock002');
    expect(result.status).toBe('ok');
    // 新しい startedAt で上書きされている
    const series = await getSeries('lock002');
    expect(series.extractionRunning.startedAt).toBeGreaterThan(now - 1000);
  });
});

// ============================================================
// 失敗カウンタ
// ============================================================
describe('失敗カウンタ', () => {
  it('extractionFailures が 3 回連続で extractionDue=false', async () => {
    const { applyExtractionResult, getSeries } = await loadStore();
    _store['series:fail001'] = makeSeries({
      extractionDue: true,
      extractionFailures: 2,
      extractionRunning: { startedAt: Date.now() },
    });

    await applyExtractionResult({ seriesId: 'fail001', candidates: [], success: false });
    const series = await getSeries('fail001');
    expect(series.extractionFailures).toBe(3);
    expect(series.extractionDue).toBe(false);
  });

  it('新規ペア追加で extractionFailures がリセットされる', async () => {
    const { recordSeriesTranslation, getSeries } = await loadStore();
    const old = Date.now() - 61_000;

    // 既に 19 件 + 失敗カウンタ 2 のシリーズ
    const pairs19 = Array.from({ length: 19 }, (_, i) => ({
      original: 'term' + i, translated: '訳', at: old,
    }));
    _store['series:fail002'] = makeSeries({
      recentPairs: pairs19,
      extractionDue: false,
      extractionFailures: 2,
      stats: { translationCount: 1, lastTranslatedAt: old },
    });

    await recordSeriesTranslation({
      seriesId: 'fail002',
      name: 'Test',
      detectionSource: 'regex',
      url: 'https://example.com/comic/2',
      pairs: [{ original: 'LongTermThatPushesThreshold', translated: 'テスト' }],
    });

    const series = await getSeries('fail002');
    expect(series.extractionDue).toBe(true);
    expect(series.extractionFailures).toBe(0);
  });
});

// ============================================================
// 却下記憶
// ============================================================
describe('却下記憶', () => {
  it('却下した original が rejectedOriginals に追加される', async () => {
    const { rejectGlossaryCandidate, getSeries } = await loadStore();
    _store['series:rej001'] = makeSeries({
      glossary: { ja: { 'Hulk': { translated: 'ハルク', approved: false } } },
    });

    await rejectGlossaryCandidate({ seriesId: 'rej001', original: 'Hulk' });
    const series = await getSeries('rej001');
    expect(series.rejectedOriginals).toContain('Hulk');
    expect(series.glossary.ja['Hulk']).toBeUndefined();
  });

  it('却下した original は applyExtractionResult で再候補化されない', async () => {
    const { rejectGlossaryCandidate, applyExtractionResult, getSeries } = await loadStore();
    _store['series:rej002'] = makeSeries({
      glossary: { ja: { 'Hulk': { translated: 'ハルク', approved: false } } },
      extractionRunning: { startedAt: Date.now() - 1000 },
    });

    await rejectGlossaryCandidate({ seriesId: 'rej002', original: 'Hulk' });

    // 同じ original が再候補として提案される
    const lockStore = makeSeries({
      glossary: { ja: {} },
      rejectedOriginals: ['Hulk'],
      extractionRunning: { startedAt: Date.now() - 1000 },
    });
    _store['series:rej002'] = lockStore;

    const result = await applyExtractionResult({
      seriesId: 'rej002',
      candidates: [{ original: 'Hulk', translated: 'ハルク' }],
      success: true,
    });

    expect(result.added).toBe(0);
    const series = await getSeries('rej002');
    expect(series.glossary.ja['Hulk']).toBeUndefined();
  });

  it('同じ original を重複却下しても rejectedOriginals に 1 件のみ', async () => {
    const { rejectGlossaryCandidate, getSeries } = await loadStore();
    _store['series:rej003'] = makeSeries({
      glossary: { ja: {} },
      rejectedOriginals: ['Hulk'],
    });

    await rejectGlossaryCandidate({ seriesId: 'rej003', original: 'Hulk' });
    const series = await getSeries('rej003');
    const count = series.rejectedOriginals.filter(x => x === 'Hulk').length;
    expect(count).toBe(1);
  });
});
