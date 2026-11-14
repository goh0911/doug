// Claude のモデル別リクエストパラメータと応答の取り出し（pure 関数。chrome.* は持ち込まない）

/**
 * Claude 5.x 系は thinking が既定で走り、content の先頭が thinking ブロックになる。
 * 2026-11-14 実測（実コミック 1 ページ、各 3 回、/v1/messages・本番プロンプト、max_tokens 32000）:
 *   sonnet-5 既定（旧既定）   : 29〜40 秒 / $0.039〜0.049 / [thinking,text] ×3 / 本文再現 13/13・類似度 0.992〜0.999
 *   sonnet-5-5 既定(high)     : 27〜31 秒 / $0.047〜0.053 / [thinking,text] ×3 / 同 0.999
 *   sonnet-5-5 effort low     : 21〜25 秒 / $0.036〜0.045 / [thinking,text] ×3 / 同 0.999
 *   sonnet-5-5 between_tools  : 14〜25 秒 / $0.027〜0.044 / text ×2・[thinking,text] ×1（切っても返る回がある）
 *   opus-5-5 既定(medium)     : 32〜34 秒 / $0.088〜0.089 / [thinking,text] ×3 / 同 0.994〜0.999
 *   opus-5-5 effort low       : 18〜19 秒 / $0.052〜0.053 / text ×3 / 同 0.999
 *   haiku-5-5 既定(medium)    : 16〜20 秒 / $0.002〜0.003 / [thinking,text] ×3 / 同 0.993〜0.999
 *   haiku-5-5 thinking 無効   :  9〜10 秒 / $0.0012〜0.0013 / text ×3 / 同 0.999
 * 正解ラベルは Claude の書き起こしで、易しい 1 ページ（天井効果あり）。難しいページでの差は未測定。
 *
 * - opus-5-5 は thinking を無効にできない（thinking.type=disabled は 400）ので effort を low に落とす。
 * - sonnet-5-5 も disabled は 400。between_tools で thinking を切る（それでも返る回があるので、
 *   応答側は必ず extractClaudeText で text ブロックを拾う）。
 * - haiku-5-5 は disabled を受け付ける。
 * - 上記以外（旧 sonnet-5 / opus-4-8 / haiku-4-5）は未検証なので何も足さない。
 * - budget_tokens は 5.x 系で 400 になるので使わない。
 *
 * @param {string} model
 * @returns {{ thinking?: object, output_config?: object }} リクエストボディに展開して使う
 */
export function claudeThinkingParams(model) {
  if (typeof model !== 'string') return {};
  if (model.startsWith('claude-haiku-5-5')) return { thinking: { type: 'disabled' } };
  if (model.startsWith('claude-sonnet-5-5')) return { thinking: { type: 'between_tools' } };
  if (model.startsWith('claude-opus-5-5')) return { output_config: { effort: 'low' } };
  return {};
}

/**
 * /v1/messages の content から text ブロックだけを連結して返す。
 * content[0] が thinking ブロックだと content[0].text は undefined になるので、先頭固定では読まない。
 *
 * @param {unknown} content data.content
 * @returns {string} text ブロックが無ければ空文字
 */
export function extractClaudeText(content) {
  if (!Array.isArray(content)) return '';
  return content
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('');
}
