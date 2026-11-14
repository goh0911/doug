// Gemini のモデル別リクエストパラメータ（pure 関数。chrome.* は持ち込まない）

/**
 * Gemini 4 系の thinking 既定は high（3.x の medium より重い）。
 * 2026-11-14 実測（gemini-4-hydrogen、実コミック 1 ページ、各 3 回）:
 *   既定(high): 約 23 秒 / thoughts 3000〜4600 / 検出 13〜14（14 が 5/6 回）
 *   low       : 約 12 秒 / thoughts 950〜1650 / 検出 13〜14（14 が 1/9 回）
 *   参考 gemini-3.6-flash: 約 20 秒 / 検出 12〜13
 * 14 件目の正体はタイトルロゴ "Capt. MARVEL"（吹き出し・キャプションではない）。
 * 正解ラベル（Claude の書き起こし）で採点した結果、本文 13 領域の原文再現は low / medium / high
 * で同一（平均類似度 0.999、各 3 回）。差は high だけがロゴを拾う点（high 3/3、low・medium 0/3）。
 * 評価に使ったのは易しい 1 ページ（天井効果あり）。難しいページでの差は未測定。
 * 画像翻訳もテキスト生成も、答えが決まっている作業で長い推論は要らないので low に落とす。
 *
 * フィールドは generationConfig.thinkingConfig.thinkingLevel。docs の
 * `generation_config.thinking_level` は generateContent では 400（Interactions API 用）。
 * minimal は Gemini 4 系が 400 で拒否するので使わない。
 *
 * @param {string} model
 * @returns {{ thinkingConfig?: { thinkingLevel: string } }} generationConfig に展開して使う
 */
export function geminiThinkingConfig(model) {
  if (typeof model === 'string' && model.startsWith('gemini-4-')) {
    return { thinkingConfig: { thinkingLevel: 'low' } };
  }
  return {};
}
