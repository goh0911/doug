// utils/gloss-cache.js — glossDefs の TTL 判定と容量トリム（chrome.* 非依存）
// 設計書 §6.2・§10.1

/** 1 シリーズあたりの上限（約 520 バイト × 30 語） */
export const GLOSSDEFS_SERIES_MAX_BYTES = 16 * 1024;

/** 失敗エントリの再試行間隔。記事が加筆される可能性があるため恒久的に諦めない */
export const FAILED_TTL_MS = 24 * 60 * 60 * 1000;

/** UTF-8 バイト数（series-store.js の計測方法に合わせる） */
function byteLength(value) {
  return new TextEncoder().encode(JSON.stringify(value)).length;
}

/**
 * キャッシュエントリがそのまま使えるか（＝再取得が不要か）を判定する
 * @param {object} entry
 * @param {number} now
 * @returns {boolean}
 */
export function isUsable(entry, now) {
  if (!entry || typeof entry !== 'object') return false;
  if (typeof entry.at !== 'number') return false;
  if (entry.failed === true) return now - entry.at < FAILED_TTL_MS;
  return typeof entry.identity === 'string' || typeof entry.powers === 'string';
}

/**
 * 上限に収まるようエントリを落とす。
 * 落とす順序: 失敗エントリ（古い順）→ 成功エントリ（古い順）
 * @param {object} langMap
 * @param {number} maxBytes
 * @returns {object} 新しいオブジェクト（入力は変更しない）
 */
export function trimGlossDefs(langMap, maxBytes) {
  if (!langMap || typeof langMap !== 'object') return {};

  const entries = Object.entries(langMap).filter(
    ([, v]) => v && typeof v === 'object' && typeof v.at === 'number'
  );

  // 残す優先度が高い順に並べる（成功が先、同種なら新しい順）
  entries.sort((a, b) => {
    const aFailed = a[1].failed === true ? 1 : 0;
    const bFailed = b[1].failed === true ? 1 : 0;
    if (aFailed !== bFailed) return aFailed - bFailed;
    return b[1].at - a[1].at;
  });

  const out = {};
  for (const [key, value] of entries) {
    const provisional = { ...out, [key]: value };
    if (byteLength(provisional) > maxBytes) break;
    out[key] = value;
  }
  return out;
}
