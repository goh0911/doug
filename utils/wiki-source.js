// utils/wiki-source.js — en Wikipedia ソース pure 関数（chrome.* / fetch 非依存）
// 設計書 §1・§3。取得は background.js が行い、本モジュールは URL 構築と解析のみを担う。

const API_ENDPOINT = 'https://en.wikipedia.org/w/api.php';

/** permissions.request({ origins: [...] }) に渡す形式 */
export const WIKIPEDIA_ORIGIN = 'https://en.wikipedia.org/*';

/** ソース識別子（glossDefs.source に記録する） */
export const SOURCE_ID = 'en-wikipedia';

// プレーンテキスト extract 中の見出し（== Title == 〜 ====== Title ======）
// 深さ（= の数）を捕捉するのは R-W2'' の終端判定に使うため
const HEADING_SOURCE = '^(={2,6})[ \\t]*(.+?)[ \\t]*\\1[ \\t]*$';

// 能力節の見出し判定。実測で確認した 3 形（Powers and abilities /
// Powers, abilities, and resources / Powers, skills, and equipment）は
// いずれも Powers を含むため単一の正規表現で拾える（評価メモ §40）
const POWERS_HEADING = /\bPowers\b/i;

/** extract 中の全見出しを位置つきで列挙する */
function listHeadings(extract) {
  const re = new RegExp(HEADING_SOURCE, 'gm');
  const out = [];
  let m;
  while ((m = re.exec(extract)) !== null) {
    out.push({ start: m.index, end: m.index + m[0].length, depth: m[1].length, title: m[2] });
  }
  return out;
}

/**
 * 検索 URL を構築する。シリーズ名を混ぜることで曖昧さ回避まで解決させる
 * （Vision → Vision (Marvel Comics)。実測 6/6・設計書 §1.1）
 * @param {string} term glossary の原語
 * @param {string} seriesName 検出済みシリーズ名（空可）
 * @returns {string|null} 原語が空なら null
 */
export function buildSearchUrl(term, seriesName) {
  // 二重引用符はフレーズ検索の区切りに使うため入力側から除去する
  const t = String(term ?? '').split('"').join('').trim();
  if (t === '') return null;
  const s = String(seriesName ?? '').split('"').join('').trim();

  const search = s ? `"${t}" ${s} comics` : `"${t}" comics`;
  const params = new URLSearchParams({
    action: 'query',
    generator: 'search',   // 解決と本文取得を 1 コールに畳む（設計書 §1.3）
    gsrsearch: search,
    gsrlimit: '1',
    prop: 'extracts',
    explaintext: '1',      // exintro は付けない（導入節は書誌情報しか無い・評価メモ §20.1）
    redirects: '1',
    format: 'json',
  });
  // URLSearchParams は空白を + に変換するが、テストは decodeURIComponent 後に空白を期待するため %20 に置換
  return `${API_ENDPOINT}?${params.toString().replace(/\+/g, '%20')}`;
}

/**
 * 検索レスポンスから先頭ページの title / extract を取り出す
 * @param {object} json
 * @returns {{ title: string, extract: string }|null} ヒット無しは null
 */
export function parseSearchResponse(json) {
  const pages = json && json.query && json.query.pages;
  if (!pages || typeof pages !== 'object') return null;
  const first = Object.values(pages)[0];
  if (!first || typeof first.title !== 'string' || typeof first.extract !== 'string') return null;
  return { title: first.title, extract: first.extract };
}

/**
 * 導入節（最初の見出しより前）を返す
 * @param {string} extract
 * @returns {string}
 */
export function extractIntro(extract) {
  if (typeof extract !== 'string' || extract === '') return '';
  const heads = listHeadings(extract);
  return (heads.length > 0 ? extract.slice(0, heads[0].start) : extract).trim();
}

/**
 * 能力節を抽出する。終端は「同じ深さ以下の見出し」（R-W2''）。
 * 深さを無視すると直後の小見出しで終端して本文が 0 字になる
 * @param {string} extract
 * @returns {string} 能力節が無ければ空文字
 */
export function extractPowers(extract) {
  if (typeof extract !== 'string' || extract === '') return '';
  const heads = listHeadings(extract);
  for (let i = 0; i < heads.length; i++) {
    if (!POWERS_HEADING.test(heads[i].title)) continue;
    let end = extract.length;
    for (let j = i + 1; j < heads.length; j++) {
      if (heads[j].depth <= heads[i].depth) { end = heads[j].start; break; }
    }
    return extract.slice(heads[i].end, end).trim();
  }
  return '';
}

/**
 * 検証ゲート（設計書 §1.2・実測 6/6 正答）。
 * 誤ったページの内容を黙って採用しないための唯一の関門。
 * @param {{ intro?: string, powers?: string }} parts
 * @returns {boolean}
 */
export function passesGate(parts) {
  if (!parts || typeof parts !== 'object') return false;
  const { intro, powers } = parts;
  if (typeof powers !== 'string' || powers.length === 0) return false;
  if (typeof intro !== 'string') return false;
  return /comic/i.test(intro);
}

/**
 * 出典リンク用の記事 URL を作る
 * @param {string} title
 * @returns {string}
 */
export function buildPageUrl(title) {
  const t = String(title ?? '').split(' ').join('_');
  return `https://en.wikipedia.org/wiki/${encodeURIComponent(t).split('%2F').join('/')}`;
}
