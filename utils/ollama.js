// utils/ollama.js
// content.js の IIFE 内にある Ollama 用 pure 関数のテスト専用コピー
// content.js が変更された場合はここも同期すること

/**
 * 翻訳結果の構造化出力スキーマ（Ollama の format パラメータに渡す）。
 *
 * これが無いと出力形式が安定しない。実測（qwen3.5:9b / Ollama 0.32.5）では
 * think:false だけを付けると配列ではなく単一オブジェクトが返り、
 * ollamaParseResponse の /\[[\s\S]*\]/ にマッチせず 0 件になった
 * （＝「翻訳結果がありません」）。
 * box を 4 要素固定にしているのは ollamaParseResponse が length===4 を要求するため。
 */
export const OLLAMA_TRANSLATION_SCHEMA = {
  type: 'array',
  items: {
    type: 'object',
    properties: {
      original: { type: 'string' },
      translated: { type: 'string' },
      type: { type: 'string', enum: ['speech', 'caption', 'sfx'] },
      box: { type: 'array', items: { type: 'integer' }, minItems: 4, maxItems: 4 },
    },
    required: ['original', 'translated', 'type', 'box'],
  },
};

/**
 * /api/show の応答から、そのモデルが thinking に対応しているかを判定する。
 *
 * 対応モデルに think:false を送らないと推論に入って実用にならない
 * （実測: 文字の無い 128x128 のアイコン 1 枚で 539.7 秒。think:false で 0.57 秒）。
 * 一方、非対応モデルに think を送るとエラーになり得るため、判定できない場合は
 * false を返して「送らない」（現状維持）に倒す。
 *
 * @param {object} showJson /api/show の応答
 * @returns {boolean}
 */
export function supportsThinking(showJson) {
  const caps = showJson && showJson.capabilities;
  return Array.isArray(caps) && caps.includes('thinking');
}

/**
 * /api/chat のリクエストボディを組み立てる。
 * @param {{ model: string, prompt: string, base64: string, thinking?: boolean }} input
 *   thinking: supportsThinking() の結果
 * @returns {object}
 */
export function buildOllamaChatBody({ model, prompt, base64, thinking = false } = {}) {
  const body = {
    model,
    messages: [{ role: 'user', content: prompt, images: [base64] }],
    stream: false,
    // format はモデルの機能ではなく Ollama の機能なので常に付けてよい
    format: OLLAMA_TRANSLATION_SCHEMA,
  };
  if (thinking) body.think = false;
  return body;
}

/**
 * Ollama 翻訳テキストの後処理（「」除去・末尾。除去）
 * content.js の ollamaCleanText と同一ロジック
 */
export function ollamaCleanText(text) {
  if (!text) return text;
  let s = text;
  if (s.startsWith('「') && s.endsWith('」')) s = s.slice(1, -1);
  return s.replace(/。$/, '');
}

/**
 * Ollama レスポンス JSON 文字列を bbox 配列にパース
 * content.js の ollamaParseResponse と同一ロジック
 * Ollama は bbox の y 軸スケールに 1500 を使用（Vision API とは異なる）
 */
export function ollamaParseResponse(content) {
  const cleaned = content.replace(/```json\s*/g, '').replace(/```\s*/g, '');
  const jsonMatch = cleaned.match(/\[[\s\S]*\]/);
  if (!jsonMatch) return [];

  function removeLineComments(s)           { return s.replace(/(?<!:)\/\/.*$/gm, ''); }
  function removeControlChars(s)           { return s.replace(/[\x00-\x1F\x7F]+/g, ' '); }
  function escapeLooseBackslashes(s)       { return s.replace(/\\(?!["\\\/bfnrtu])/g, '\\\\'); }
  function removeTrailingCommas(s)         { return s.replace(/,(\s*[}\]])/g, '$1'); }
  function addMissingCommasBetweenItems(s) { return s.replace(/([}\]])\s*(["{[])/g, '$1,$2'); }

  const sanitized = [
    removeLineComments,
    removeControlChars,
    escapeLooseBackslashes,
    removeTrailingCommas,
    addMissingCommasBetweenItems,
  ].reduce((s, fn) => fn(s), jsonMatch[0]);

  const candidates = [sanitized, sanitized + '}]', sanitized + '"}]'];
  const lastObj = sanitized.lastIndexOf('},');
  if (lastObj > 0) candidates.push(sanitized.substring(0, lastObj + 1) + ']');

  let results = null;
  for (const candidate of candidates) {
    try { results = JSON.parse(candidate); break; } catch { /* 次の候補へ */ }
  }
  if (!Array.isArray(results)) return [];

  try {
    return results.filter(r => r.translated && (r.box || r.bbox)).map(r => {
      let top, left, width, height;
      if (r.box && Array.isArray(r.box)) {
        const box = (r.box.length === 1 && Array.isArray(r.box[0])) ? r.box[0] : r.box;
        if (box.length === 4) {
          const [yMin, xMin, yMax, xMax] = box;
          top = (yMin / 1000) * 100; left = (xMin / 1000) * 100;
          width = ((xMax - xMin) / 1000) * 100; height = ((yMax - yMin) / 1000) * 100;
        }
      } else if (r.bbox) {
        const bx = r.bbox.x ?? r.bbox.left ?? 0, by = r.bbox.y ?? r.bbox.top ?? 0;
        const bw = r.bbox.w ?? r.bbox.width ?? 100, bh = r.bbox.h ?? r.bbox.height ?? 50;
        top = (by / 1500) * 100; left = (bx / 1000) * 100;
        width = (bw / 1000) * 100; height = (bh / 1500) * 100;
      }
      const result = {
        bbox: { top, left, width, height },
        original: r.original || '',
        translated: ollamaCleanText(r.translated),
        type: r.type || 'speech',
      };
      return result;
    })
    .filter(item => item.bbox.top != null && item.bbox.left != null);
  } catch { return []; }
}
