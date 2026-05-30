// utils/glossary-substitute.js
// 層B: 翻訳結果(translated)への用語集置換。pure 関数（chrome.* 非依存）。
//
// 重要: content.js に同一ロジックのコピーが存在する（classic script は ES module を
// import できないため）。このファイルを変更したら content.js 側のコピーも必ず同期すること。
// （CLAUDE.md「新機能追加時のチェックリスト」参照）

// 正規表現メタ文字をエスケープ
function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 1 吹き出しの訳文に用語集置換を適用する（1 パス・冪等）。
 *
 * ガード（逆翻訳衝突防止）: glossary の original が当該吹き出しの原文 originalText に
 * 含まれる用語のみを置換対象にする。
 *
 * 冪等性: 対象語を長い順にソートして alternation で 1 回だけ置換するため、
 * 置換結果に再マッチせず、複数回適用しても結果は変わらない。
 *
 * @param {string} translatedText 訳文
 * @param {string} originalText その吹き出しの原文
 * @param {Object<string,{translated:string, approved?:boolean}>} glossaryLangMap
 * @returns {{ text: string, hits: number }}
 */
export function substituteGlossaryTerms(translatedText, originalText, glossaryLangMap) {
  if (typeof translatedText !== 'string' || !glossaryLangMap || typeof glossaryLangMap !== 'object') {
    return { text: translatedText, hits: 0 };
  }

  // approved かつ 原文に在席する用語のみ対象
  const terms = Object.keys(glossaryLangMap).filter((orig) => {
    const e = glossaryLangMap[orig];
    return (
      e &&
      e.approved === true &&
      typeof e.translated === 'string' &&
      typeof originalText === 'string' &&
      orig.length > 0 &&
      originalText.includes(orig)
    );
  });
  if (terms.length === 0) return { text: translatedText, hits: 0 };

  // 長い順にソート（部分一致誤爆の緩和: Hulkbuster を Hulk より先に）
  terms.sort((a, b) => b.length - a.length);

  // alternation で 1 パス置換（マッチ済み領域は再走査されないため冪等）
  const re = new RegExp(terms.map(escapeRegExp).join('|'), 'g');
  let hits = 0;
  const text = translatedText.replace(re, (m) => {
    hits++;
    return glossaryLangMap[m].translated;
  });
  return { text, hits };
}

/**
 * translations 配列全体に層B置換を適用する。
 * @param {Array<{original?:string, translated?:string}>} translations
 * @param {Object} glossaryLangMap
 * @returns {{ translations: Array, totalHits: number }}
 */
export function applyGlossaryPostProcess(translations, glossaryLangMap) {
  if (!Array.isArray(translations) || !glossaryLangMap || typeof glossaryLangMap !== 'object') {
    return { translations, totalHits: 0 };
  }
  let totalHits = 0;
  const out = translations.map((t) => {
    if (!t || typeof t.translated !== 'string') return t;
    const { text, hits } = substituteGlossaryTerms(t.translated, t.original ?? '', glossaryLangMap);
    totalHits += hits;
    return hits > 0 ? { ...t, translated: text } : t;
  });
  return { translations: out, totalHits };
}
