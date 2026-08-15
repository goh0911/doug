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
 * キャッシュエントリがそのまま使えるか（＝再取得が不要か）を判定する。
 *
 * 失敗エントリは 24 時間有効だが、それは「同じ条件で引き直しても同じ結果になる」
 * という前提の上に成り立つ。前提が崩れる変更——ソースの追加・API キーの設定・
 * 検証ゲートの改修——を入れたときに失効させないと、改善が丸一日見えないまま
 * 「直っていない」と誤診することになる（実測: Comic Vine を追加した直後、
 * その前に焼き付いた失敗エントリのせいで新ソースが一度も呼ばれなかった）。
 *
 * 指紋の照合は成功エントリにも効かせる。成功は TTL を持たず無期限に残るため、
 * プロンプトや素材の取り方を直しても既存の解説が居座り、改善が実機に永久に
 * 届かなかった（実測: 用語集 156 語・解説 38 件のうち成功 36 件が、
 * 手でキャッシュを消さない限り古い文面のままだった）。
 *
 * @param {object} entry
 * @param {number} now
 * @param {string} [sourcesKey] 現在のソース構成とパイプライン世代の指紋。
 *   省略時は指紋を見ない（旧挙動）
 * @returns {boolean}
 */
export function isUsable(entry, now, sourcesKey) {
  if (!entry || typeof entry !== 'object') return false;
  if (typeof entry.at !== 'number') return false;

  if (entry.failed === true) {
    // 失敗は「どの構成で引けなかったか」なので、ソースが増えたら引き直す。指紋を
    // 持たない旧エントリも、いつの構成で失敗したか分からない以上は引き直す
    if (typeof sourcesKey === 'string' && entry.sources !== sourcesKey) return false;
    return now - entry.at < FAILED_TTL_MS;
  }

  // 成功は「どの作り方で作ったか」だけを見る。ソース構成まで一致を求めると、
  // 先読み（primaryOnly: en-wikipedia のみ）で作った解説が通常経路
  // （en-wikipedia+comicvine）で毎回作り直される。Wikipedia だけで作れた解説は
  // Comic Vine が増えても有効なので、世代（epoch）が同じなら使ってよい
  if (typeof sourcesKey === 'string' && epochOf(entry.sources) !== epochOf(sourcesKey)) return false;
  return typeof entry.identity === 'string' || typeof entry.powers === 'string';
}

/** 指紋 `${epoch}:${sourceIds}` から世代だけを取り出す。指紋が無ければ null */
function epochOf(key) {
  if (typeof key !== 'string' || key === '') return null;
  const at = key.indexOf(':');
  return at === -1 ? null : key.slice(0, at);
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
