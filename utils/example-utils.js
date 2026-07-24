// utils/example-utils.js — few-shot 例文サニタイズ pure 関数（chrome.* 非依存）
// Phase 6: 例文はプロンプトに注入されるため保存時に多層防御を施す

function cleanControlChars(s) {
  s = s.replace(/[\r\n\t]+/g, ' ');
  s = s.replace(/[\x00-\x1F\x7F]/g, '');
  s = s.replace(/[‪-‮]/g, '');
  s = s.replace(/[⁦-⁩]/g, '');
  s = s.replace(/[​-‏]/g, '');
  s = s.replace(/[\u{E0000}-\u{E007F}]/gu, '');
  return s;
}

function escapeDelimiters(s) {
  s = s.split('<<<<').join('_');
  s = s.split('>>>>').join('_');
  s = s.split('[SYSTEM]').join('_');
  s = s.split('[DATA]').join('_');
  return s;
}

/**
 * few-shot 例文をサニタイズする（保存前）
 * @param {{ original: string, translated: string }} pair
 * @returns {{ original: string, translated: string } | null}
 */
export function sanitizeExample({ original, translated } = {}) {
  if (typeof original !== 'string' || typeof translated !== 'string') return null;
  const clean = (s) => escapeDelimiters(cleanControlChars(s.slice(0, 150))).trim();
  const o = clean(original);
  const t = clean(translated);
  if (o === '' || t === '') return null;
  return { original: o, translated: t };
}
