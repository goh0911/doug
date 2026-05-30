// series-store.js — series:* ストレージ層（Chrome.storage.local を直接使う）
// Phase 2A: CRUD + LRU 容量管理 + 並行書込直列化 + サニタイズ

import { sanitizeGlossaryText, sanitizeToneStyle } from './utils/sanitize.js';
import { derivePathPrefix } from './utils/url-pattern.js';

// ============================================================
// 容量閾値（§0 実測値に基づく確定値）
// ============================================================
const WARN_THRESHOLD    = 6.5 * 1024 * 1024;  // 6.5 MB
const ARCHIVE_THRESHOLD = 7.32 * 1024 * 1024; // 7.32 MB

// glossary 全体の上限（1 シリーズあたり 2 KB）
const GLOSSARY_SERIES_MAX_BYTES = 2 * 1024;

// 60 秒以内の同一シリーズ再翻訳は no-op（spam 防止）
const NO_OP_INTERVAL_MS = 60 * 1000;

// ============================================================
// 並行書込直列化キュー（§3.4）
// ============================================================
const writeQueue = new Map(); // seriesId → Promise

async function withSeriesLock(seriesId, fn) {
  const prev = writeQueue.get(seriesId) || Promise.resolve();
  const next = prev.then(fn).catch(() => { /* swallow */ });
  writeQueue.set(seriesId, next);
  return next;
}

// ============================================================
// 内部ヘルパー
// ============================================================

/** 全 series:* エントリを取得する（raw オブジェクト） */
async function getAllSeriesRaw() {
  const all = await chrome.storage.local.get(null);
  const result = {};
  for (const [k, v] of Object.entries(all)) {
    if (k.startsWith('series:')) result[k] = v;
  }
  return result;
}

/** 使用量情報を計算して返す */
async function computeUsageInfo() {
  const raw = await getAllSeriesRaw();
  const MAX_QUOTA = chrome.storage.local.QUOTA_BYTES;
  const usedBytes = Object.values(raw).reduce(
    (sum, v) => sum + new TextEncoder().encode(JSON.stringify(v)).length, 0
  );
  const seriesCount = Object.keys(raw).length;
  return {
    usedBytes,
    totalBytes: MAX_QUOTA,
    seriesCount,
    isNearWarn: usedBytes >= WARN_THRESHOLD,
    isNearArchive: usedBytes >= ARCHIVE_THRESHOLD,
  };
}

/** LRU: lastVisitedAt 最古のシリーズを 1 件削除して空きを作る */
async function evictOldestSeries() {
  const raw = await getAllSeriesRaw();
  if (Object.keys(raw).length === 0) return;
  // lastVisitedAt 昇順でソートして最古を特定
  const sorted = Object.entries(raw).sort(
    ([, a], [, b]) => (a.meta?.lastVisitedAt ?? 0) - (b.meta?.lastVisitedAt ?? 0)
  );
  const [oldestKey] = sorted[0];
  await chrome.storage.local.remove(oldestKey);
  console.warn(`[doug series-store] LRU evict: ${oldestKey}`);
}

// ============================================================
// 公開 API
// ============================================================

/**
 * シリーズを 1 件取得する
 * @param {string} seriesId
 * @returns {Promise<object|null>}
 */
export async function getSeries(seriesId) {
  const key = `series:${seriesId}`;
  const result = await chrome.storage.local.get(key);
  return result[key] ?? null;
}

/**
 * 全シリーズを lastVisitedAt 降順で返す
 * @returns {Promise<Array<object>>}
 */
export async function listSeries() {
  const raw = await getAllSeriesRaw();
  return Object.entries(raw)
    .map(([k, v]) => ({ seriesId: k.slice('series:'.length), ...v }))
    .sort((a, b) => (b.meta?.lastVisitedAt ?? 0) - (a.meta?.lastVisitedAt ?? 0));
}

/**
 * 翻訳ボタン押下時に呼ぶ。存在しなければ作成、あれば更新。
 * @param {{ seriesId: string, name: string, detectionSource: string, url: string }} payload
 * @returns {Promise<object|null>} 保存した series オブジェクト or null（容量超過時）
 */
export async function recordSeriesTranslation({ seriesId, name, detectionSource, url, glossaryHits }) {
  return withSeriesLock(seriesId, async () => {
    // 容量チェック
    const usage = await computeUsageInfo();
    const MAX_QUOTA = chrome.storage.local.QUOTA_BYTES;
    if (usage.usedBytes >= MAX_QUOTA) {
      console.warn('[doug series-store] ストレージ上限に達しました。シリーズを記録できません。');
      return null;
    }
    if (usage.isNearArchive) {
      await evictOldestSeries();
    }

    const key = `series:${seriesId}`;
    const now = Date.now();
    const existing = await chrome.storage.local.get(key);
    const current = existing[key];

    if (current) {
      // 60 秒以内の再翻訳は no-op
      if (current.stats?.lastTranslatedAt && (now - current.stats.lastTranslatedAt) < NO_OP_INTERVAL_MS) {
        return current;
      }

      // urlPatterns の更新
      const origin = (() => { try { return new URL(url).origin; } catch { return url; } })();
      const pathPrefix = derivePathPrefix(url);
      const patterns = current.urlPatterns || [];
      const alreadyHas = patterns.some(p => p.origin === origin && p.pathPrefix === pathPrefix);
      if (!alreadyHas) {
        patterns.push({ origin, pathPrefix, lastSeenAt: now });
      } else {
        // lastSeenAt を更新
        const idx = patterns.findIndex(p => p.origin === origin && p.pathPrefix === pathPrefix);
        patterns[idx] = { ...patterns[idx], lastSeenAt: now };
      }

      const updated = {
        ...current,
        meta: {
          ...current.meta,
          lastVisitedAt: now,
          issueCount: (current.meta?.issueCount ?? 0) + 1,
        },
        urlPatterns: patterns,
        stats: {
          ...current.stats,
          translationCount: (current.stats?.translationCount ?? 0) + 1,
          lastTranslatedAt: now,
          glossaryHits: (current.stats?.glossaryHits ?? 0) + (glossaryHits ?? 0),
        },
      };
      await chrome.storage.local.set({ [key]: updated });
      return updated;
    } else {
      // 新規作成
      const origin = (() => { try { return new URL(url).origin; } catch { return url; } })();
      const pathPrefix = derivePathPrefix(url);
      const series = {
        meta: {
          name: name ?? seriesId,
          detectedAt: now,
          lastVisitedAt: now,
          issueCount: 1,
          detectionSource: detectionSource ?? 'url',
        },
        urlPatterns: [{ origin, pathPrefix, lastSeenAt: now }],
        overrides: { provider: null, model: null, targetLang: null },
        glossary: {},
        tone: { style: 'auto' },
        stats: { translationCount: 1, lastTranslatedAt: now, glossaryHits: glossaryHits ?? 0 },
      };
      await chrome.storage.local.set({ [key]: series });
      return series;
    }
  });
}

/**
 * シリーズを削除する
 * @param {string} seriesId
 */
export async function deleteSeries(seriesId) {
  await chrome.storage.local.remove(`series:${seriesId}`);
}

/**
 * シリーズのフィールドをホワイトリスト経由で更新する
 * 許可パス: 'meta.name' / 'tone.style' / 'overrides.provider' / 'overrides.model' / 'overrides.targetLang'
 * @param {string} seriesId
 * @param {string} fieldPath
 * @param {*} value
 * @returns {Promise<boolean>} 成功したら true
 */
export async function updateSeriesField(seriesId, fieldPath, value) {
  const ALLOWED_PATHS = new Set([
    'meta.name',
    'tone.style',
    'overrides.provider',
    'overrides.model',
    'overrides.targetLang',
  ]);
  if (!ALLOWED_PATHS.has(fieldPath)) return false;

  return withSeriesLock(seriesId, async () => {
    const key = `series:${seriesId}`;
    const result = await chrome.storage.local.get(key);
    const series = result[key];
    if (!series) return false;

    // サニタイズが必要なパス
    let sanitized = value;
    if (fieldPath === 'meta.name') {
      sanitized = sanitizeGlossaryText(value, { maxLength: 100 });
      if (sanitized === null) return false;
    } else if (fieldPath === 'tone.style') {
      // プリセット値はそのまま通す
      const TONE_PRESETS = new Set(['auto', '敬体', '常体', '硬め', '柔らかめ']);
      if (!TONE_PRESETS.has(value)) {
        sanitized = sanitizeToneStyle(value);
        if (sanitized === null) return false;
      }
    }

    // fieldPath を 'a.b' 形式で分解してネストをたどる
    const [top, sub] = fieldPath.split('.');
    const updated = {
      ...series,
      [top]: {
        ...series[top],
        [sub]: sanitized,
      },
    };
    await chrome.storage.local.set({ [key]: updated });
    return true;
  });
}

/**
 * 用語集エントリを追加（または上書き）する
 * @param {string} seriesId
 * @param {string} targetLang
 * @param {string} original
 * @param {string} translated
 * @returns {Promise<boolean>} 成功したら true
 */
export async function addGlossaryEntry(seriesId, targetLang, original, translated) {
  const sanitizedOrig = sanitizeGlossaryText(original, { maxLength: 100 });
  const sanitizedTrans = sanitizeGlossaryText(translated, { maxLength: 100 });
  if (sanitizedOrig === null || sanitizedTrans === null) return false;

  return withSeriesLock(seriesId, async () => {
    const key = `series:${seriesId}`;
    const result = await chrome.storage.local.get(key);
    const series = result[key];
    if (!series) return false;

    const glossary = series.glossary ?? {};
    const langGlossary = { ...(glossary[targetLang] ?? {}) };

    // 仮追加して 2KB チェック
    const provisional = {
      ...langGlossary,
      [sanitizedOrig]: {
        translated: sanitizedTrans,
        count: 0,
        lastSeenAt: Date.now(),
        source: 'manual',
        approved: true,
      },
    };
    const glossaryBytes = new TextEncoder().encode(JSON.stringify(provisional)).length;
    if (glossaryBytes > GLOSSARY_SERIES_MAX_BYTES) return false;

    const updated = {
      ...series,
      glossary: {
        ...glossary,
        [targetLang]: provisional,
      },
    };
    await chrome.storage.local.set({ [key]: updated });
    return true;
  });
}

/**
 * 用語集エントリを削除する
 * @param {string} seriesId
 * @param {string} targetLang
 * @param {string} original
 */
export async function removeGlossaryEntry(seriesId, targetLang, original) {
  return withSeriesLock(seriesId, async () => {
    const key = `series:${seriesId}`;
    const result = await chrome.storage.local.get(key);
    const series = result[key];
    if (!series) return;

    const glossary = { ...(series.glossary ?? {}) };
    const langGlossary = { ...(glossary[targetLang] ?? {}) };
    delete langGlossary[original];
    glossary[targetLang] = langGlossary;

    await chrome.storage.local.set({ [key]: { ...series, glossary } });
  });
}

/**
 * ストレージ使用状況を返す
 * @returns {Promise<{ usedBytes: number, totalBytes: number, seriesCount: number, isNearWarn: boolean, isNearArchive: boolean }>}
 */
export async function getStorageUsageInfo() {
  return computeUsageInfo();
}
