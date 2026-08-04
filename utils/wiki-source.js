// utils/wiki-source.js — en Wikipedia ソース pure 関数（chrome.* / fetch 非依存）
// 設計書 §1・§3。取得は background.js が行い、本モジュールは URL 構築と解析のみを担う。

// 出版社の表は utils/publishers.js に集約した（Comic Vine 側からも使うため）。
// 既存の import 元を変えずに済むよう、ここから再エクスポートする
import { expectedPublisher, publisherConflicts } from './publishers.js';
export { expectedPublisher, publisherConflicts };

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
export function buildSearchUrl(term, seriesName, { maxlag } = {}) {
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
  // 非対話（先読み）の呼び出しには maxlag を付ける（MediaWiki の推奨）。
  // DB 遅延時は HTTP 200 + error:maxlag が返り、isTransientApiError が一時的失敗として拾う
  if (Number.isFinite(maxlag) && maxlag > 0) params.set('maxlag', String(maxlag));
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
    // 能力節の中の小見出し（==== Bruce Banner ==== 等）は本文ではないので落とす。
    // 残すと解説の先頭がマークアップになり、しかもそれを訳そうとして
    // 人名を崩す（実機: "==== ブーリス・バナー ====" ＝ Bruce の誤り）
    return stripHeadings(extract.slice(heads[i].end, end));
  }
  return '';
}

/** 導入節の最小長。これ未満はスタブ記事とみなし解説に使わない */
const INTRO_MIN_LENGTH = 60;

/**
 * 照合用の正規化。記号を除去して空白を畳む。
 * S.H.I.E.L.D. → shield / Spider-Man → spiderman のように表記の揺れを吸収する。
 */
function normalizeForMatch(s) {
  return String(s ?? '')
    .toLowerCase()
    // 括弧類は語の区切りとして空白にする。除去すると語境界が消え、
    // "(carl crusher creel)" の末尾が閉じ括弧のままで一致しなくなる
    .replace(/[()[\]{}<>/|]/g, ' ')
    .replace(/[.'‘’\-–—_,:;!?"]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * タイトル用の正規化。曖昧さ回避の括弧を落としてから正規化する
 * （Vision (Marvel Comics) → vision）。
 * 本文には使わない。本文の括弧には実名が入るため
 * （Absorbing Man (Carl "Crusher" Creel)）、落とすと別名照合が壊れる。
 */
function normalizeTitleForMatch(s) {
  return normalizeForMatch(String(s ?? '').replace(/\([^)]*\)/g, ' '));
}

/**
 * 導入節の最初の段落だけを返す。記事の定義部分はここに書かれる。
 * explaintext の導入節は段落ごとに改行で区切られるため、最初の改行で切る
 * （`\n\s*\n|\n` と書いていたが、前者が当たる位置では後者も当たるので同義だった）
 */
function firstParagraph(intro) {
  const s = String(intro ?? '').trim();
  if (s === '') return '';
  const idx = s.indexOf('\n');
  return idx === -1 ? s : s.slice(0, idx).trim();
}

/** 正規化済みの haystack に、正規化済みの語が語境界つきで現れるか */
function containsWord(haystack, needle) {
  return new RegExp(`(^| )${escapeRegExp(needle)}($| )`).test(haystack);
}

/**
 * 記号を落とすと別の語に化ける表記か（S.H.I.E.L.D. → shield、Spider-Man → spiderman）。
 * この種の語は導入節の照合に元表記を使う
 */
function collapsesWhenNormalized(term) {
  return /[.'‘’\-–—_]/.test(String(term ?? ''));
}

/** 正規表現に埋め込むためのエスケープ */
function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 取得した記事が検索語の記事かを判定する。
 *
 * gsrlimit=1 の検索は語と無関係な記事を平気で返す（実測）:
 *   "S.H.I.E.L.D." Immortal Hulk comics → Absorbing Man
 *   "Gamma Base"   Immortal Hulk comics → Betty Ross
 * どちらも能力節を持ちコミック記事なので、旧ゲートは素通りさせて
 * 「別人の解説」を表示していた。
 *
 * タイトル一致だけを条件にすると別名が落ちる（Red Hulk → 記事名 Thunderbolt Ross、
 * Tony Stark → Iron Man）ため、導入節も見る。ただし照合範囲は**最初の段落まで**。
 * 導入節を丸ごと対象にすると関連作品の記述に引っかかる（実測: Absorbing Man の
 * 2 段落目にある "Agents of S.H.I.E.L.D." が S.H.I.E.L.D. と一致してしまった）。
 *
 * 一致は語境界つき（shielded / shields のような部分一致を避ける）。
 *
 * @param {string} term 検索語（glossary の原語）
 * @param {string} title 取得した記事タイトル
 * @param {string} intro 導入節
 * @returns {boolean}
 */
/**
 * 記事タイトルが検索語そのものか（曖昧さ回避の括弧は無視）。
 * "Banner" に対し "Brian Banner" は false、"S.H.I.E.L.D." は true。
 * 1 語の姓のような曖昧な語で、同姓の別人を掴むのを避けるための優先度判定に使う
 */
export function isExactTitleMatch(term, title) {
  const t = normalizeForMatch(term);
  if (t === '') return false;
  return normalizeTitleForMatch(title) === t;
}

export function termAppearsIn(term, title, intro) {
  const t = normalizeForMatch(term);
  if (t === '') return false;

  // タイトルが検索語そのものなら、それだけで記事の同一性の根拠になる。
  // 一方「タイトルに語が含まれるだけ」は根拠にならない（PARKER に対する Peter Parker）。
  // 実記事フィクスチャで確認したところ、従来タイトル部分一致で通っていた記事は
  // すべて導入節でも裏付けが取れたため、部分一致は根拠から外す（Codex 指摘 #1）
  if (isExactTitleMatch(term, title)) return true;

  // 照合範囲は「最初の文の主語部分」まで。段落全体だと、記事の主題ではない語に
  // 一致してしまう（実測: UNITED STATES MILITARY → Father Time の記事、
  // RED HULK → List of Hulk titles）。Wikipedia の導入は
  // 「X is a ...」の形なので、is/was の前が主題になる
  const para = firstParagraph(intro);
  // 主語のほかに「別名」の記述も許す。別名は記事名と違う語で立項されるため
  // （Red Hulk → 記事名 Thunderbolt Ross、"He later became the Red Hulk."）。
  // 定型表現に限定することで、無関係な語への一致は防げる
  const haystacks = [subjectOfFirstSentence(para), ...aliasPhrases(para)];

  // 記号を落とすと一般名詞に化ける語は元表記のまま照合する。
  // S.H.I.E.L.D. を shield に正規化すると Captain America の "uses a shield" に当たる
  if (collapsesWhenNormalized(term)) {
    const raw = String(term).trim();
    const re = new RegExp(`(^|[^A-Za-z0-9])${escapeRegExp(raw)}([^A-Za-z0-9]|$)`, 'i');
    return haystacks.some((h) => re.test(h));
  }

  return haystacks.some((h) => containsWord(normalizeForMatch(h), t));
}

/** 「also known as X」「later became X」等、別名を示す定型表現の X を集める */
function aliasPhrases(paragraph) {
  const re = /(?:also known as|better known as|later became|later becomes|who becomes|alias(?:es)?|a\.k\.a\.)\s+([^.,;]{1,60})/gi;
  const out = [];
  let m;
  while ((m = re.exec(String(paragraph ?? ''))) !== null) out.push(m[1]);
  return out;
}

/**
 * 最初の文のうち、主語にあたる部分を返す。
 * 「Father Time is a fictional character ...」→「Father Time」
 * 「This is a list of comics titles featuring the Hulk」→「This」
 * コピュラが見つからなければ最初の文をそのまま返す。
 */
function subjectOfFirstSentence(paragraph) {
  const s = String(paragraph ?? '').trim();
  if (s === '') return '';
  // 文末は「. 」＋大文字 で判定（Dr. / U.S. のような略語で切らないため）
  const endMatch = s.match(/\.\s+[A-Z(]/);
  const sentence = endMatch ? s.slice(0, endMatch.index + 1) : s;
  const copula = sentence.match(/\s(?:is|was|are|were)\s/i);
  return copula ? sentence.slice(0, copula.index) : sentence;
}

/** 見出し行（== X == 〜 ====== X ======）を取り除き、空行を畳む */
function stripHeadings(text) {
  return String(text ?? '')
    .split('\n')
    .filter((line) => !new RegExp(HEADING_SOURCE).test(line))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * 検証ゲート（設計書 §1.2）。誤ったページの内容を黙って採用しないための唯一の関門。
 *
 * 能力節は必須にしない。必須にすると S.H.I.E.L.D.（組織）や Gamma Base（場所）が
 * 全部落ちるため。人物なら powers を、組織・場所なら intro だけを解説に使う。
 * 品質の担保は termAppearsIn（記事の同一性）と導入節の長さに移している。
 *
 * @param {{ term?: string, title?: string, intro?: string, powers?: string, publisher?: string }} parts
 *   publisher: 閲覧中のサイトから期待される出版社キー（expectedPublisher の戻り値）。
 *   省略時は出版社を条件にしない（後方互換）
 * @returns {boolean}
 */
export function passesGate(parts) {
  if (!parts || typeof parts !== 'object') return false;
  const { term, title, intro, powers, publisher } = parts;
  if (typeof powers !== 'string') return false;
  if (typeof intro !== 'string' || intro.length < INTRO_MIN_LENGTH) return false;
  if (!/comic/i.test(intro)) return false;
  if (isNonEntityArticle(title)) return false;
  if (isDisambiguationPage(intro)) return false;
  if (publisherConflicts(intro, publisher, title)) return false;
  return termAppearsIn(term, title, intro);
}

/**
 * HTTP ステータスが一時的な失敗か。
 * 一時的失敗を「その語には記事が無い」として 24 時間キャッシュしてはいけない
 * （実測: レート制限に巻き込まれて 17 語中 14 語が丸一日「解説なし」になった）。
 * @param {number} status
 * @returns {boolean}
 */
export function isTransientHttpStatus(status) {
  const s = Number(status);
  if (!Number.isFinite(s)) return false;
  return s === 408 || s === 429 || (s >= 500 && s <= 599);
}

/**
 * MediaWiki が HTTP 200 で返す一時的エラーか。
 * maxlag / readonly / ratelimited は res.ok を素通りするため、
 * ステータスだけを見ていると「ヒット 0 件」と同じ恒久的失敗として扱ってしまう。
 * @param {object} json
 * @returns {boolean}
 */
export function isTransientApiError(json) {
  const code = json && json.error && json.error.code;
  if (typeof code !== 'string') return false;
  return /^(maxlag|readonly|ratelimited)$|internal_api_error/i.test(code);
}

/**
 * 人物・組織・場所ではなく、作品や一覧の記事か。
 * 実測: HULK → The Incredible Hulk (comic book)（出版物）、
 *       RED HULK → List of Hulk titles（一覧）。
 * どちらも「その語の解説」にならないので落とす。
 * 「(comics)」「(Marvel Comics)」はキャラクター記事の曖昧さ回避なので除外しない。
 */
/**
 * 曖昧さ回避ページか。「X may refer to:」で始まり、候補が箇条書きされるだけの記事で、
 * どの語の解説にもならない（実記事: "Peter Cannon may refer to:" が
 * 出版社の記述を含むためゲートを通り得た）。
 * @param {string} intro
 * @returns {boolean}
 */
export function isDisambiguationPage(intro) {
  return /\bmay (?:also )?refer to\s*:/i.test(String(intro ?? ''));
}

function isNonEntityArticle(title) {
  const t = String(title ?? '');
  if (/^list of /i.test(t.trim())) return true;
  return /\((?:comic book|comic strip|magazine|TV series|film|video game|novel|album|soundtrack)\)/i.test(t);
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
