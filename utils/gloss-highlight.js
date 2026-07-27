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

  const out = [];
  let last = 0;
  let m;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push({ text: text.slice(last, m.index), key: null });
    out.push({ text: m[0], key: byMatch.get(m[0]) });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ text: text.slice(last), key: null });
  return out;
}
