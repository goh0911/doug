// OpenAI のモデル別リクエストパラメータ（pure 関数。chrome.* は持ち込まない）

/**
 * GPT-6.1 系は reasoning_effort を low にする。
 * 2026-11-14 実測（実コミック 1 ページ、各 3 回、Chat Completions・本番プロンプト）:
 *   Terra low   : 19〜22 秒 / $0.010〜0.011 / reasoning 71〜220   / 本文再現 13/13・類似度 0.995〜0.997
 *   Terra 既定  : 29〜31 秒 / $0.014〜0.015 / reasoning 736〜980  / 同 0.997〜0.999
 *   Terra none  : 約 20 秒  / $0.010        / reasoning 0         / 同 0.997（low と区別できない）
 *   Sol 既定    : 55〜78 秒 / $0.040〜0.054 / reasoning 1871〜3342 / 同 0.983〜0.989
 *   Sol low     : 28〜31 秒 / $0.020〜0.021 / reasoning 289〜390  / 同 0.974〜0.982
 *   参考 5.6 Sol 既定: 24〜35 秒 / 類似度 0.942〜0.948（原文を「ORPHAN … HAS A SECRET」と読む回あり）
 * 正解ラベルは Claude の書き起こしで、易しい 1 ページ（天井効果あり）。難しいページでの差は未測定。
 * 画像翻訳もテキスト生成も答えが決まっている作業で長い推論は要らないので low に落とす。
 *
 * reasoning_effort は Chat Completions で解釈される（'bogus' は 400 で拒否され、
 * 許容値は none / low / medium / high ほか）。6.1 系以外は未検証なので何も足さない
 * （選択肢から外した gpt-5.6-* が保存値に残っていても、従来どおりの body で送る）。
 *
 * @param {string} model
 * @returns {{ reasoning_effort?: string }} リクエストボディに展開して使う
 */
export function openaiReasoningParams(model) {
  if (typeof model === 'string' && model.startsWith('gpt-6.1-')) {
    return { reasoning_effort: 'low' };
  }
  return {};
}

/**
 * 画像翻訳の構造化出力（Chat Completions の response_format）。
 *
 * 2026-11-14 実測: gpt-6.1-terra は本番プロンプトの box:[y_min,x_min,y_max,x_max] に従わず
 * [y_min,x_min,x_max,y_max] で返し、本番のパースで 16 件中 12 件が範囲外（幅が負）になった。
 * 位置引数の順序をモデルに任せず、名前付き座標（x_min 等）を json_schema で固定する
 * （Ollama の OLLAMA_TRANSLATION_SCHEMA と同じ考え方。解釈は parseVisionResponse が行う）。
 *
 * strict の規則: ルートは object（配列は不可）、全プロパティを required、additionalProperties:false。
 * そのため配列を translations で包む。parseVisionResponse は最初の [ から最後の ] までを
 * 取り出すので、この包みのまま読める。
 */
export const OPENAI_TRANSLATION_RESPONSE_FORMAT = {
  type: 'json_schema',
  json_schema: {
    name: 'comic_translations',
    strict: true,
    schema: {
      type: 'object',
      properties: {
        translations: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              original: { type: 'string' },
              translated: { type: 'string' },
              type: { type: 'string', enum: ['speech', 'caption', 'sfx'] },
              x_min: { type: 'integer' },
              y_min: { type: 'integer' },
              x_max: { type: 'integer' },
              y_max: { type: 'integer' },
            },
            required: ['original', 'translated', 'type', 'x_min', 'y_min', 'x_max', 'y_max'],
            additionalProperties: false,
          },
        },
      },
      required: ['translations'],
      additionalProperties: false,
    },
  },
};
