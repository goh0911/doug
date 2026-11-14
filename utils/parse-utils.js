// utils/parse-utils.js

/**
 * 翻訳テキストの後処理（「」除去・末尾。除去）
 * background.js の cleanTranslatedText と同一ロジック
 * @param {string} text
 * @returns {string}
 */
export function cleanTranslatedText(text) {
  if (!text) return text;
  let s = text;
  if (s.startsWith('「') && s.endsWith('」')) {
    s = s.slice(1, -1);
  }
  s = s.replace(/。$/, '');
  return s;
}

// x_min/y_min/x_max/y_max がすべて数値なら名前付き座標とみなす
function hasNamedCoords(r) {
  return ['x_min', 'y_min', 'x_max', 'y_max'].every(k => typeof r[k] === 'number');
}

/**
 * Gemini/Claude/OpenAI Vision API レスポンスを bbox 配列にパース
 * background.js の parseVisionResponse と同一ロジック
 * @param {string} geminiResponse - LLM が返した JSON 文字列
 * @param {{ width?: number, height?: number }} imageDims - 画像サイズ（bbox 形式の場合に使用）
 * @returns {Array<{ bbox: object, original: string, translated: string, type: string }>}
 */
export function parseVisionResponse(geminiResponse, imageDims) {
  let cleaned = geminiResponse.replace(/```json\s*/g, '').replace(/```\s*/g, '');
  const jsonMatch = cleaned.match(/\[[\s\S]*\]/);
  if (!jsonMatch) return [];

  const imgW = imageDims?.width || 1000;
  const imgH = imageDims?.height || 1500;

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
  let parseErr = null;
  for (const candidate of candidates) {
    try { results = JSON.parse(candidate); break; } catch (e) { parseErr = parseErr ?? e; }
  }

  if (!Array.isArray(results)) return [];

  try {
    return results
      .filter(r => r.translated && (hasNamedCoords(r) || r.box || r.bbox))
      .map(r => {
        let top, left, width, height;
        if (hasNamedCoords(r)) {
          // 名前付き座標（OpenAI の json_schema 経路）。位置引数の box は軸の順序がモデルの流儀に
          // 左右される（gpt-6.1-terra は [y_min,x_min,x_max,y_max] で返した）が、名前なら曖昧さが無い
          const x1 = Math.min(r.x_min, r.x_max), x2 = Math.max(r.x_min, r.x_max);
          const y1 = Math.min(r.y_min, r.y_max), y2 = Math.max(r.y_min, r.y_max);
          left = (x1 / 1000) * 100;
          top = (y1 / 1000) * 100;
          width = ((x2 - x1) / 1000) * 100;
          height = ((y2 - y1) / 1000) * 100;
        } else if (r.box && Array.isArray(r.box)) {
          // [[y, x, Y, X]] のように1段ネストしている場合を展開
          const box = (r.box.length === 1 && Array.isArray(r.box[0])) ? r.box[0] : r.box;
          if (box.length === 4) {
            const [yMin, xMin, yMax, xMax] = box;
            top = (yMin / 1000) * 100;
            left = (xMin / 1000) * 100;
            width = ((xMax - xMin) / 1000) * 100;
            height = ((yMax - yMin) / 1000) * 100;
          }
        } else if (r.bbox) {
          const bx = r.bbox.x ?? r.bbox.left ?? 0;
          const by = r.bbox.y ?? r.bbox.top ?? 0;
          const bw = r.bbox.w ?? r.bbox.width ?? 100;
          const bh = r.bbox.h ?? r.bbox.height ?? 50;
          top = (by / imgH) * 100;
          left = (bx / imgW) * 100;
          width = (bw / imgW) * 100;
          height = (bh / imgH) * 100;
        }
        const result = {
          bbox: { top, left, width, height },
          original: r.original || '',
          translated: cleanTranslatedText(r.translated),
          type: r.type || 'speech',
        };
        return result;
      })
      .filter(item => item.bbox.top != null && item.bbox.left != null);
  } catch {
    return [];
  }
}
