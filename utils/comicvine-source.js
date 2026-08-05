// utils/comicvine-source.js — Comic Vine ソース pure 関数（chrome.* / fetch 非依存）
//
// en Wikipedia のサブソース。Wikipedia が記事を持たない作品固有の施設・組織・脇役を補う
// （実測: SHADOW BASE / GAMMA BASE / FORTEAN は Wikipedia に記事が無い）。
// 調査記録: docs/plans/2026-08-04-fandom-subsource-feasibility.md §5.1b
//
// **素の検索精度は低い。** 用語集の語で引くと 12 語中 5 語が誤答した（2026-08-04 実測）:
//   ABOMINATION → Voltron の敵（Lion Forge）   DOOM  → DC の別キャラ
//   WALT        → Simpsons（Bongo）            BANNER → Bar Sinister（Valiant）
//   TONY STARK  → Amalgam 版
// したがって passesGate / pickBestResult を通さずに使ってはならない。
//
// Wikipedia 側との違い:
//   - publisher が構造化フィールドで返るため、導入節からの推測が不要で判定が確実
//   - 一行要約（deck）がそのまま使えるため、節抽出（R-W2''）に相当する処理が不要
//   - 能力節に相当するものが無いため powers は常に空文字

import { matchPublisherKey } from './publishers.js';
// 「別名で立項された記事が、その語のことか」を判定する処理は Wikipedia 側で
// 実記事フィクスチャ付きで検証済みなので再利用する（第 1 文の主語＋別名表現のみを見る）。
// RED HULK → Thunderbolt Ross の "He later became the Red Hulk." を拾うのがこれ
import { termAppearsIn } from './wiki-source.js';

/** permissions.request({ origins: [...] }) に渡す形式 */
export const COMICVINE_ORIGIN = 'https://comicvine.gamespot.com/*';

/** GLOSS_SOURCES の識別子（解説の出典表示に使う） */
export const SOURCE_ID = 'comicvine';

const API_ENDPOINT = 'https://comicvine.gamespot.com/api/search/';

/**
 * 1 位だけでは誤答を落とせない。実測では正解が 2〜3 位に沈むことがあった
 * （ABOMINATION は 2 位、DOOM は 3 位、TONY STARK は 2 位）
 */
const SEARCH_LIMIT = 5;

/** deck がこれより短ければ解説として使わない（Wikipedia の INTRO_MIN_LENGTH と同趣旨） */
const DECK_MIN_LENGTH = 40;

/**
 * 検索対象。character だけに絞ると SHADOW BASE(team) / GAMMA BASE(location) を取り逃す
 */
const RESOURCES = 'character,location,team,concept';

/**
 * 検索 URL を組み立てる。キーが無い・語が空なら null（呼び出し側は通信しない）
 * @param {string} term
 * @param {string} apiKey
 * @param {{ limit?: number }} [opts]
 * @returns {string|null}
 */
export function buildSearchUrl(term, apiKey, { limit } = {}) {
  const t = String(term ?? '').trim();
  const key = String(apiKey ?? '').trim();
  if (t === '' || key === '') return null;

  const params = new URLSearchParams({
    api_key: key,
    format: 'json',
    query: t,
    resources: RESOURCES,
    // publisher はゲートに必須。落とすと Voltron / Bongo を判別できなくなる
    field_list: 'name,deck,resource_type,publisher,site_detail_url',
    limit: String(Number.isFinite(limit) && limit > 0 ? limit : SEARCH_LIMIT),
  });
  // URLSearchParams は空白を + にするが、Comic Vine は %20 でも + でも通る。
  // テスト・ログで読みやすい %20 に揃える（utils/wiki-source.js と同じ扱い）
  return `${API_ENDPOINT}?${params.toString().replace(/\+/g, '%20')}`;
}

/**
 * 応答を解釈する。Comic Vine は HTTP 200 のまま status_code でエラーを返す。
 *   1   = OK
 *   100 = Invalid API Key（恒久的。キーを直さない限り変わらない）
 *   107 = Rate Limit Exceeded（一時的。失敗として 24h キャッシュしてはいけない）
 * @param {object} json
 * @returns {{ status: 'ok'|'transient'|'error', results: Array<object> }}
 */
export function parseSearchResponse(json) {
  if (!json || typeof json !== 'object') return { status: 'error', results: [] };
  const code = json.status_code;
  if (code === 107) return { status: 'transient', results: [] };
  if (code !== 1) return { status: 'error', results: [] };
  return { status: 'ok', results: Array.isArray(json.results) ? json.results : [] };
}

/**
 * deck に混入する実体参照を戻す（実測: "Alpha &amp; Beta Flight"）。
 * &amp; を最後に処理すると "&amp;lt;" が "<" まで戻ってタグを生成しうるため、
 * &amp; を先に戻さない順序にしている。
 * @param {string} s
 * @returns {string}
 */
export function decodeEntities(s) {
  if (typeof s !== 'string') return '';
  return s
    .split('&lt;').join('<')
    .split('&gt;').join('>')
    .split('&quot;').join('"')
    .split('&#39;').join("'")
    .split('&#039;').join("'")
    .split('&nbsp;').join(' ')
    .split('&amp;').join('&');
}

/** 正規表現メタ文字を落とす */
function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 語境界つきで語句を含むか。BANNER が Bannerman に当たらないようにする。
 * 記号を含む語（S.H.I.E.L.D.）も扱えるよう、境界は英数字の有無で見る
 */
function containsWord(haystack, needle) {
  const h = String(haystack ?? '');
  const n = String(needle ?? '').trim();
  if (n === '') return false;
  return new RegExp(`(^|[^A-Za-z0-9])${escapeRegExp(n)}([^A-Za-z0-9]|$)`, 'i').test(h);
}

/**
 * 名前の前に付く敬称・階級。これらが付くだけなら同一人物とみなす。
 * 実測: DOOM → "Doctor Doom"、FORTEAN → "General Fortean" はいずれも正解
 */
const HONORIFICS = /^(?:dr\.?|doc\.?|doctor|professor|prof\.?|mr\.?|mister|mrs\.?|ms\.?|miss|lord|lady|king|queen|prince|princess|sir|dame|saint|st\.?|captain|capt\.?|cpt\.?|commander|cmdr\.?|colonel|col\.?|general|gen\.?|major|sergeant|sgt\.?|lieutenant|lt\.?|admiral|adm\.?|agent|officer|detective|judge|chief|baron|count|duke|emperor)\s+/i;

/**
 * 候補の名前が検索語と同じ実体を指すか。
 *
 * 実測（2026-08-04）で、名前に語を含む候補には**正解と誤答が同型で並ぶ**ことが分かった:
 *   DOOM   → "Doctor Doom"（正解）  / "Amanda Von Doom"（別人）
 *   BANNER → 正解なし              / "Brian Banner"・"Bobbi-Jo Banner"（別人）
 * 両者を分けられるのは「付いているのが敬称・階級か、個人名か」だけである。
 * 括弧付き（"Tony Stark (Amalgam)"）は別世界線を示すので同一とみなさない
 * （Wikipedia の "(character)" とは逆に、Comic Vine の括弧は別版を意味する）。
 *
 * 名前に語を一切含まない候補は、別名で立項されている可能性がある
 * （RED HULK → Thunderbolt Ross、TONY STARK → Iron Man）。この場合だけ
 * deck の記述を根拠として認める。
 */
function isSameEntity(term, name, deck) {
  const t = String(term ?? '').trim().toLowerCase();
  const n = String(name ?? '').trim().toLowerCase();
  if (t === '' || n === '') return false;

  if (n === t) return true;                       // 完全一致
  // 敬称・階級を両側から外して比べる。台詞では略記で呼ばれるのに記事は正式表記で
  // 立項されているため（実測: 語 "DOC DOOM" / 候補 "Doctor Doom"）、名前側だけ
  // 外していると届かない。どちらの表記が略記でも一致させる
  if (n.replace(HONORIFICS, '') === t.replace(HONORIFICS, '')) return true;

  // 名前に語を含むのに上の 2 つに当たらない＝個人名や別版が付いている＝別の実体
  if (containsWord(n, t)) return false;

  // 名前に語が無い場合のみ、第 1 文の主語または別名表現を根拠にする
  return termAppearsIn(term, name, deck);
}

/**
 * 検証ゲート。誤った解説を出さないための唯一の関門。
 *
 * Wikipedia 側（utils/wiki-source.js の passesGate）と違い、出版社の**一致を要求する**。
 * Wikipedia は「出版社に触れない記事」を通す必要があったが（組織・場所の記事が
 * 出版社を書かないため）、Comic Vine は publisher が常に構造化フィールドで返るので
 * 一致を求められる。これが無いと Bongo の Walt や Le Lombard の Walt を落とせない。
 *
 * @param {{ term: string, name: string, deck: string, publisherName: string|null, publisher: string|null }} parts
 *   publisher: 閲覧中のサイトから期待される出版社キー（expectedPublisher の戻り値）。
 *   null なら出版社を条件にしない（未知サイト・後方互換）
 * @returns {boolean}
 */
export function passesGate(parts) {
  if (!parts || typeof parts !== 'object') return false;
  const { term, name, deck, publisherName, publisher } = parts;

  const text = decodeEntities(typeof deck === 'string' ? deck : '');
  if (text.trim().length < DECK_MIN_LENGTH) return false;

  if (publisher) {
    // 期待出版社が分かっているなら一致を要求する。表に無い出版社（Bongo 等）も却下
    if (matchPublisherKey(publisherName) !== publisher) return false;
  }

  const t = String(term ?? '').trim();
  if (t === '') return false;

  return isSameEntity(t, name, text);
}

/**
 * ゲートを通る最初の候補を返す。Comic Vine 自身の関連度順を尊重する。
 *
 * 正解が 1 位に来ない語がある（実測: ABOMINATION は 2 位、DOOM は 3 位、
 * TONY STARK は 2 位）。1 位だけを見ると誤答を掴むため、上位 5 件を走査して
 * 最初にゲートを通ったものを採る。
 *
 * @param {Array<object>} results
 * @param {string} term
 * @param {string|null} publisher
 * @returns {object|null}
 */
export function pickBestResult(results, term, publisher) {
  if (!Array.isArray(results) || results.length === 0) return null;
  const hit = results.find((r) => r && passesGate({
    term,
    name: r.name,
    deck: r.deck,
    publisherName: r.publisher && r.publisher.name,
    publisher,
  }));
  return hit ?? null;
}

/**
 * 採用した候補を GLOSS_SOURCES の material 形式に変換する。
 * @param {object} result
 * @returns {{ title: string, url: string, intro: string, powers: string }}
 */
export function toMaterial(result) {
  const name = String((result && result.name) || '');
  return {
    title: name,
    url: String((result && result.site_detail_url) || 'https://comicvine.gamespot.com/'),
    intro: decodeEntities((result && result.deck) || ''),
    // Comic Vine の deck は一行要約で能力節に相当するものが無い。
    // buildGlossPrompt が powers を文字列として要求するため空文字を渡す
    powers: '',
  };
}
