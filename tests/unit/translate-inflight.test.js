// tests/unit/translate-inflight.test.js
//
// 同じ画像の翻訳が同時に走るのを 1 回にまとめる。
//
// 先読みが P2 を翻訳している最中に利用者が P2 へ移動すると、キャッシュにまだ結果が
// 無いため通常経路がもう一度翻訳していた（API 課金 2 倍・待ち時間もそのぶん）。
//
// ただし結果をそのまま横流ししてはいけない。先読みは seriesId 無しで呼ばれるため
// 層A（用語集のプロンプト注入）も層B（訳語置換）も効いていない。共有するのは
// 「翻訳の生データ」だけで、層B の適用は呼び出しごとに行う。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const local = new Map();

const areaMock = (m) => ({
  get: async (k) => {
    if (k == null) return Object.fromEntries(m);
    if (typeof k === 'string') return m.has(k) ? { [k]: m.get(k) } : {};
    if (Array.isArray(k)) return Object.fromEntries(k.filter((x) => m.has(x)).map((x) => [x, m.get(x)]));
    return Object.fromEntries(Object.entries(k).map(([x, d]) => [x, m.has(x) ? m.get(x) : d]));
  },
  set: async (o) => { for (const [k, v] of Object.entries(o)) m.set(k, v); },
  remove: async (k) => { for (const x of [].concat(k)) m.delete(x); },
  getBytesInUse: async () => 0,
  onChanged: { addListener: () => {} },
});

globalThis.chrome = {
  runtime: { id: 'test-ext-id', lastError: null, getManifest: () => ({ version: '0.0.0-test' }) },
  storage: {
    local: areaMock(local),
    session: areaMock(new Map()),
    onChanged: { addListener: () => {} },
  },
};

const { handleImageTranslation } = await import('../../translate.js');
const { invalidateSettingsCache } = await import('../../settings.js');

const IMAGE = 'data:image/jpeg;base64,/9j/4AAQSkZJRg==';
const URL_A = 'https://example.com/page-1.jpg';
const SERIES_ID = 'S1';

/** Gemini が返す形。訳文に原語が残っており、層B の置換対象になる */
const GEMINI_TEXT = JSON.stringify([
  { original: 'MEET ROXXON', translated: 'ROXXON に会え', type: 'speech', box: [100, 200, 300, 600] },
]);

function serveGemini({ delayMs = 20, fail = false } = {}) {
  globalThis.fetch = vi.fn(async () => {
    await new Promise((r) => setTimeout(r, delayMs));
    if (fail) return { ok: false, status: 500, text: async () => 'boom', json: async () => ({}) };
    return {
      ok: true,
      status: 200,
      json: async () => ({ candidates: [{ content: { parts: [{ text: GEMINI_TEXT }] } }] }),
      text: async () => GEMINI_TEXT,
    };
  });
}

beforeEach(() => {
  local.clear();
  invalidateSettingsCache();
  local.set('apiProvider', 'gemini');
  local.set('geminiApiKey', 'test-key');
  local.set('targetLang', 'ja');
  local.set(`series:${SERIES_ID}`, {
    seriesId: SERIES_ID,
    meta: { name: 'Test (2026)' },
    glossary: { ja: { ROXXON: { translated: 'ロクソン', approved: true, count: 1 } } },
    glossDefs: { ja: {} },
    recentPairs: [],
    stats: {},
  });
  serveGemini();
});

afterEach(() => {
  delete globalThis.fetch;
});

describe('同じ画像の同時翻訳', () => {
  it('先読みと通常経路が同時に走っても API 呼び出しは 1 回', async () => {
    const [prefetch, normal] = await Promise.all([
      handleImageTranslation(IMAGE, URL_A, { width: 1000, height: 1000 }, { prefetch: true }),
      handleImageTranslation(IMAGE, URL_A, { width: 1000, height: 1000 }, { seriesId: SERIES_ID }),
    ]);
    expect(globalThis.fetch.mock.calls.length).toBe(1);
    expect(prefetch.translations).toHaveLength(1);
    expect(normal.translations).toHaveLength(1);
  });

  it('待った側にも層B が適用される（先読みの結果をそのまま返さない）', async () => {
    const [, normal] = await Promise.all([
      handleImageTranslation(IMAGE, URL_A, { width: 1000, height: 1000 }, { prefetch: true }),
      handleImageTranslation(IMAGE, URL_A, { width: 1000, height: 1000 }, { seriesId: SERIES_ID }),
    ]);
    expect(normal.translations[0].translated).toBe('ロクソン に会え');
    expect(normal.glossaryHits).toBe(1);
  });

  it('先読み側は層B を適用しない（seriesId が無いので用語集を持たない）', async () => {
    const [prefetch] = await Promise.all([
      handleImageTranslation(IMAGE, URL_A, { width: 1000, height: 1000 }, { prefetch: true }),
      handleImageTranslation(IMAGE, URL_A, { width: 1000, height: 1000 }, { seriesId: SERIES_ID }),
    ]);
    expect(prefetch.translations[0].translated).toBe('ROXXON に会え');
  });

  it('進行中の翻訳が失敗したら、待った側は自分で翻訳する', async () => {
    serveGemini({ fail: true });
    const first = handleImageTranslation(IMAGE, URL_A, { width: 1000, height: 1000 }, { prefetch: true });
    await new Promise((r) => setTimeout(r, 5)); // 1 本目を進行中にする
    const second = await handleImageTranslation(IMAGE, URL_A, { width: 1000, height: 1000 }, { seriesId: SERIES_ID });
    await first;
    // 失敗を共有して終わりにしない。2 本目は自分で引き直す（合計 2 回）
    expect(globalThis.fetch.mock.calls.length).toBe(2);
    expect(second.error).toBeTruthy();
  });

  it('別の画像は待ち合わせない', async () => {
    await Promise.all([
      handleImageTranslation(IMAGE, URL_A, { width: 1000, height: 1000 }, { prefetch: true }),
      handleImageTranslation(IMAGE, 'https://example.com/page-2.jpg', { width: 1000, height: 1000 }, { prefetch: true }),
    ]);
    expect(globalThis.fetch.mock.calls.length).toBe(2);
  });

  it('翻訳が終わったあとの呼び出しはキャッシュで返る（待ち合わせが居座らない）', async () => {
    await handleImageTranslation(IMAGE, URL_A, { width: 1000, height: 1000 }, { prefetch: true });
    const again = await handleImageTranslation(IMAGE, URL_A, { width: 1000, height: 1000 }, { seriesId: SERIES_ID });
    expect(globalThis.fetch.mock.calls.length).toBe(1);
    expect(again.fromCache).toBe(true);
  });
});
