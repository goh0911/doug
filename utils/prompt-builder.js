// utils/prompt-builder.js
// 層A: シリーズの用語集・口調を翻訳プロンプトの断片として生成する。pure 関数（chrome.* 非依存）。
//
// 重要: content.js に同一ロジックのコピーが存在する（classic script は ES module を
// import できないため）。このファイルを変更したら content.js 側のコピーも必ず同期すること。
// （CLAUDE.md「新機能追加時のチェックリスト」参照）

// プリセット口調 → 指示文（'auto' は指示なし＝''）
const TONE_INSTRUCTIONS = {
  auto: '',
  '敬体': '全体的に「です・ます」調で翻訳してください。',
  '常体': '全体的に「だ・である」調で翻訳してください。',
  '硬め': '硬く落ち着いた文体で翻訳してください。',
  '柔らかめ': '柔らかく口語的な文体で翻訳してください。',
};

// 用語集をプロンプトに載せる上限（親設計 §5.4）
const GLOSSARY_CAP = 30;

// 口調指示文を返す。プリセットは変換、auto/未指定は ''、カスタムは sanitize 済み文字列をそのまま使う。
function buildToneInstruction(toneStyle) {
  if (!toneStyle || toneStyle === 'auto') return '';
  if (Object.prototype.hasOwnProperty.call(TONE_INSTRUCTIONS, toneStyle)) {
    return TONE_INSTRUCTIONS[toneStyle];
  }
  return String(toneStyle); // カスタム口調（2C で sanitize 済み）
}

/**
 * シリーズ文脈（用語集＋口調）をプロンプト断片として返す。
 * 用語集が空かつ口調指示なしの場合は '' を返す（呼び元は素のプロンプトのまま）。
 * @param {{ seriesName?:string, glossaryLangMap?:Object, toneStyle?:string }} args
 * @returns {string}
 */
export function buildSeriesPromptSection({ seriesName, glossaryLangMap, toneStyle } = {}) {
  // 用語集: approved のみ・count 降順・上位 GLOSSARY_CAP 件
  const entries =
    glossaryLangMap && typeof glossaryLangMap === 'object'
      ? Object.keys(glossaryLangMap)
          .map((orig) => ({ orig, ...glossaryLangMap[orig] }))
          .filter((e) => e.approved === true && typeof e.translated === 'string')
          .sort((a, b) => (b.count ?? 0) - (a.count ?? 0))
          .slice(0, GLOSSARY_CAP)
      : [];

  const toneInstruction = buildToneInstruction(toneStyle);

  if (entries.length === 0 && !toneInstruction) return '';

  const lines = [];
  if (seriesName) lines.push(`このコミックは「${seriesName}」シリーズです。`);
  if (entries.length > 0) {
    lines.push('【用語集】以下の固有名詞は必ずこの訳語を使用してください:');
    entries.forEach((e, i) => lines.push(`${i + 1}. ${e.orig} → ${e.translated}`));
  }
  if (toneInstruction) lines.push(`【訳文の口調】${toneInstruction}`);
  return lines.join('\n');
}
