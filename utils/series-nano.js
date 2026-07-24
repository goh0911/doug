// utils/series-nano.js — Nano シリーズ検出 pure 関数（chrome.* / LanguageModel 非依存）
// Phase 5: Regex/URL で検出できないページのシリーズ推定を Nano で補う

// ============================================================
// 内部 helper
// ============================================================

// 制御文字・方向制御・タグ文字を除去し、改行/タブを空白化する
function cleanControlChars(s) {
  s = s.replace(/[\r\n\t]+/g, ' ');
  s = s.replace(/[\x00-\x1F\x7F]/g, '');
  s = s.replace(/[‪-‮]/g, '');
  s = s.replace(/[⁦-⁩]/g, '');
  s = s.replace(/[​-‏]/g, '');
  s = s.replace(/[\u{E0000}-\u{E007F}]/gu, '');
  return s;
}

// 区切り記号を無害化する（インジェクション対策）
function escapeDelimiters(s) {
  s = s.split('<<<<').join('_');
  s = s.split('>>>>').join('_');
  s = s.split('[SYSTEM]').join('_');
  s = s.split('[DATA]').join('_');
  return s;
}

// ============================================================
// 公開 API
// ============================================================

/**
 * Nano に渡す入力フィールドをサニタイズする
 * @param {string} s
 * @returns {string} 200字切り詰め・サニタイズ済み文字列（非文字列は ''）
 */
export function sanitizeDetectionInput(s) {
  if (typeof s !== 'string') return '';
  let out = s.slice(0, 200);
  out = cleanControlChars(out);
  out = escapeDelimiters(out);
  return out.trim();
}
