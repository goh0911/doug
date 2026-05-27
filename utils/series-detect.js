// utils/series-detect.js — シリーズ検出 pure 関数（v2 Phase 1）
// chrome.* API に依存しない。Vitest で直接テスト可能。

/**
 * Regex パターン（定義順 = 試行順）
 * 最初にマッチしたものを採用。
 */
const SERIES_PATTERNS = [
  // 1. "Immortal Hulk #20" / "Spider-Man #1.5"
  {
    name: 'hash-num',
    re: /^(.+?)\s*#\s*(\d+(?:\.\d+)?)\b/i,
    confidence: 0.95,
  },
  // 2. "One Piece Chapter 1100" / "Manga Ch.5" / "Series Vol. 3" / "Episode 12" / "Issue 3"
  {
    name: 'keyword-num',
    re: /^(.+?)\s+(?:Chapter|Ch\.?|Vol\.?|Volume|Episode|Ep\.?|Issue)\s*(\d+(?:\.\d+)?)\b/i,
    confidence: 0.9,
  },
  // 3. "ベルセルク 第41巻" / "ワンピース 第1100話" / "進撃の巨人 第100章"
  {
    name: 'ja-num',
    re: /^(.+?)\s*第\s*(\d+(?:\.\d+)?)\s*[巻話章]/,
    confidence: 0.9,
  },
  // 4. "Title 100: Subtitle" / "Title 100" — last resort
  {
    name: 'trailing-num',
    re: /^(.+?)\s+(\d+(?:\.\d+)?)(?:\s*[:：]\s*.+)?$/,
    confidence: 0.5,
  },
];

/**
 * タイトル文字列から Regex でシリーズ情報を検出する
 * @param {string} title
 * @returns {{ series: string, issueNumber: number|null, matchedPattern: string, confidence: number } | null}
 */
export function detectSeriesFromTitle(title) {
  if (!title || typeof title !== 'string') return null;
  const t = title.trim();
  for (const pattern of SERIES_PATTERNS) {
    const m = t.match(pattern.re);
    if (m) {
      return {
        series: m[1].trim(),
        issueNumber: m[2] != null ? parseFloat(m[2]) : null,
        matchedPattern: pattern.name,
        confidence: pattern.confidence,
      };
    }
  }
  return null;
}

/**
 * URL パスから シリーズ slug を抽出する（fallback 用）
 * @param {string} url
 * @returns {{ series: string, slug: string } | null}
 */
export function detectSeriesFromUrl(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const segments = u.pathname.split('/').filter(Boolean);
  if (segments.length === 0) return null;

  // 末尾セグメントが数字のみなら一つ前を採用
  // 例: /comics/immortal-hulk/20/ → "immortal-hulk"
  let series = segments[segments.length - 1];
  if (/^\d+(\.\d+)?$/.test(series) && segments.length >= 2) {
    series = segments[segments.length - 2];
  }
  // 数字埋め込みも除去: "immortal-hulk-20" → "immortal-hulk"
  series = series.replace(/[-_]\d+(\.\d+)?$/, '');
  series = series.replace(/[-_]/g, ' ').trim();

  if (!series || series.length < 2) return null;
  return { series, slug: series };
}

/**
 * シリーズ名を正規化する（SeriesId 算出の前処理）
 * @param {string} name
 * @returns {string}
 */
export function normalizeSeriesName(name) {
  return name
    .toLowerCase()
    .normalize('NFKC')                              // 全角英数→半角、半角カナ→全角等
    .replace(/[\s　]+/g, ' ')                        // 連続空白を1個に
    .replace(/[!-/:-@\[-`{-~]/g, '')               // ASCII 記号除去
    .replace(/[「」『』【】〈〉《》・…]/g, '')           // 日本語記号除去
    .trim();
}

/**
 * シリーズ名から SeriesId（16文字 hex）を生成する
 * origin は意図的に含めない（R1: サイト横断同シリーズ認識のため）
 * @param {string} seriesName
 * @returns {Promise<string>}
 */
export async function computeSeriesId(seriesName) {
  const normalized = normalizeSeriesName(seriesName);
  const buf = new TextEncoder().encode(normalized);
  const hashBuf = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(hashBuf))
    .slice(0, 8)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * ページ情報からシリーズを検出する統合関数
 * @param {{ title?: string, url?: string, h1?: string, ogTitle?: string }} input
 * @returns {Promise<{ seriesId: string, series: string, issueNumber: number|null, source: string, confidence: number } | null>}
 */
export async function detectSeries({ title, url, h1, ogTitle } = {}) {
  // 1. 入力候補を優先度順に配列化
  const candidates = [title, ogTitle, h1].filter(Boolean);

  // 2. 各候補に対し Regex を試行
  for (const text of candidates) {
    const m = detectSeriesFromTitle(text);
    if (m) {
      const seriesId = await computeSeriesId(m.series);
      return {
        seriesId,
        series: m.series,
        issueNumber: m.issueNumber,
        source: 'regex',
        confidence: m.confidence,
      };
    }
  }

  // 3. URL fallback
  if (url) {
    const u = detectSeriesFromUrl(url);
    if (u) {
      const seriesId = await computeSeriesId(u.series);
      return {
        seriesId,
        series: u.series,
        issueNumber: null,
        source: 'url',
        confidence: 0.4,
      };
    }
  }

  return null;
}
