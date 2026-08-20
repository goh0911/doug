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

// 用語集をプロンプトに載せる上限（親設計 §5.4 は 30 だった）。
//
// 60 に上げた理由: 実機で承認 49 語のうち 19 語が黙って落ちていた。下の sort は
// count 降順のつもりだが、count はどこでもインクリメントされておらず
// （series-store.js:525 で 0 に初期化されるだけ）、実データでも count>0 の語は
// 0 件だった。全語が同点なので並び順は chrome.storage が返すキー順＝辞書順になり、
// RED HULK / ROXXON / TONY STARK といった中心的な語が頭文字だけを理由に落ちて、
// 代わりに JACK KIRBY / MINECRAFT が載っていた。
//
// 承認は利用者が 1 語ずつ選ぶ行為なので、選んだものが黙って消えるのが最も悪い。
// 一方、無制限にするとプロンプトが際限なく伸びるので上限自体は残す。60 語なら
// 追加は 400 字程度で、翻訳プロンプト全体からすれば小さい。
//
// 本筋は count を実際に数えて優先順位を機能させること。それは別途。
const GLOSSARY_CAP = 60;

// 例文をプロンプトに載せる上限（Phase 6）
const EXAMPLES_CAP = 5;

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
export function buildSeriesPromptSection({ seriesName, glossaryLangMap, toneStyle, examples } = {}) {
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

  // 例文: 有効な要素のみ・上位 EXAMPLES_CAP 件（Phase 6）
  const exampleList = Array.isArray(examples)
    ? examples
        .filter((e) => e && typeof e.original === 'string' && typeof e.translated === 'string')
        .slice(0, EXAMPLES_CAP)
    : [];

  if (entries.length === 0 && !toneInstruction && exampleList.length === 0) return '';

  const lines = [];
  if (seriesName) lines.push(`このコミックは「${seriesName}」シリーズです。`);
  if (entries.length > 0) {
    lines.push('【用語集】以下の固有名詞は必ずこの訳語を使用してください:');
    entries.forEach((e, i) => lines.push(`${i + 1}. ${e.orig} → ${e.translated}`));
  }
  if (toneInstruction) lines.push(`【訳文の口調】${toneInstruction}`);
  if (exampleList.length > 0) {
    lines.push('【翻訳例】以下の対訳と同じ口調・言い回しで訳してください:');
    exampleList.forEach((e, i) => lines.push(`${i + 1}. ${e.original} → ${e.translated}`));
  }
  return lines.join('\n');
}
