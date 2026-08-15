// utils/gloss-highlight.js
// 訳文を用語境界で分割し、描画側が <span> を組み立てられる形にする pure 関数。
//
// 重要: content.js に同一ロジックのコピーが存在する（classic script は ES module を
// import できないため）。このファイルを変更したら content.js 側のコピーも必ず同期すること。
// （CLAUDE.md「新機能追加時のチェックリスト」参照）

// 正規表現メタ文字をエスケープ
function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 訳文を用語境界で分割する。
 *
 * glossDefs は原語（英語）をキーに持つが訳文に現れるのは訳語なので、
 * terms は { match: 訳語, key: 原語 } の対で受け取り、key を返す。
 *
 * 長い順にソートして alternation で 1 パス走査するため、
 * 部分一致の誤爆（ハルクバスター に ハルク がマッチする）が起きない。
 *
 * @param {string} text 訳文
 * @param {Array<{match: string, key: string}>} terms
 * @returns {Array<{text: string, key: string|null}>} 連結すると元の text に戻る
 */
export function splitByTerms(text, terms) {
  if (typeof text !== 'string' || text === '') return [];

  const byMatch = new Map();
  if (Array.isArray(terms)) {
    for (const t of terms) {
      if (!t || typeof t.match !== 'string' || t.match === '') continue;
      if (typeof t.key !== 'string' || t.key === '') continue;
      if (!byMatch.has(t.match)) byMatch.set(t.match, t.key);
    }
  }
  if (byMatch.size === 0) return [{ text, key: null }];

  // 長い順（ハルクバスター を ハルク より先に）
  const sorted = [...byMatch.keys()].sort((a, b) => b.length - a.length);
  const re = new RegExp(sorted.map(escapeRegExp).join('|'), 'g');

  // カタカナ語が、より長いカタカナ語の内側に食い込むのを防ぐ。上の長い順の並べ替えで
  // 防げるのは「用語集どうし」の包含だけで、用語集に無い語には無力だった
  // （実測: ROSS の訳語「ロス」が「エマ・フロスト」に一致し、無関係な人物の解説が出た）。
  // 中黒（U+30FB）はこの文字クラスに入らない。「エマ・フロスト」の「エマ」は正当な一致
  const kata = /[ァ-ヺーヽヾ]/;

  const out = [];
  let last = 0;
  let m;
  while ((m = re.exec(text)) !== null) {
    if (kata.test(m[0])
      && (kata.test(text[m.index - 1] || '') || kata.test(text[m.index + m[0].length] || ''))) continue;
    if (m.index > last) out.push({ text: text.slice(last, m.index), key: null });
    out.push({ text: m[0], key: byMatch.get(m[0]) });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ text: text.slice(last), key: null });
  return out;
}

/**
 * 訳文に実際に現れる用語の key を返す。
 *
 * 「どの語の解説を要求するか」は、必ず splitByTerms と同じ物差しで決める。素朴な
 * includes で判定すると両者がずれ、下線にならないと確定している一致（より長い
 * カタカナ語への食い込み）まで要求してしまう。表示されない解説の生成に
 * Wikipedia 取得と API 課金だけが発生し、1 回 30 語の上限も食う。
 *
 * @param {string} text 訳文
 * @param {Array<{match: string, key: string}>} terms
 * @returns {Set<string>} 訳文に現れた用語の key
 */
export function findVisibleTerms(text, terms) {
  const found = new Set();
  for (const part of splitByTerms(text, terms)) {
    if (part.key) found.add(part.key);
  }
  return found;
}
