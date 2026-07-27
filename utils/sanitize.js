// utils/sanitize.js — 用語集・口調入力のサニタイズ（Phase 2C プロンプトインジェクション対策）
// chrome.* を使わない pure モジュール

// 除去対象: C0 制御文字 / C1 制御文字(U+0085 NEL 含む) / 行・段落分離子(U+2028/U+2029) /
//           ゼロ幅文字 / 方向制御文字（unicode escape で明示）
// ※ U+2028/U+2029 を追加（2026-07-25 セキュリティ監査 F-1/F-2: 行分離子による注入対策）
const STRIP_REGEX = new RegExp(
  '[\\u0000-\\u001F\\u007F-\\u009F\\u200B-\\u200D\\u2028\\u2029\\uFEFF\\u202A-\\u202E\\u2066-\\u2069]',
  'g'
);

// 拒否対象: マッチしたら null を返す
//   - マークダウンコード境界: ``` / ~~~
//   - LLM 制御トークン形: <|...|> / [INST] / {{...}}
//   - プロンプトデリミタ: <glossary> </glossary> <system> <user> <assistant> <context> <instructions>
const REJECT_REGEX = /```|~~~|<\|[^>]*\|>|\[INST\]|\{\{[^}]*\}\}|<\/?(?:glossary|system|user|assistant|context|instructions)\b/i;

/**
 * 用語集テキスト（原文・訳語）のサニタイズ
 * @param {*} text
 * @param {{ maxLength?: number }} options
 * @returns {string|null} サニタイズ済み文字列、拒否時は null
 */
export function sanitizeGlossaryText(text, { maxLength = 100 } = {}) {
  if (typeof text !== 'string') return null;
  if (REJECT_REGEX.test(text)) return null;
  const t = text.replace(STRIP_REGEX, '').trim();
  if (t.length === 0 || t.length > maxLength) return null;
  return t;
}

/**
 * tone.style（口調カスタム文字列）のサニタイズ（上限 200 文字）
 * @param {*} text
 * @returns {string|null}
 */
export function sanitizeToneStyle(text) {
  return sanitizeGlossaryText(text, { maxLength: 200 });
}

// ============================================================
// 共有サニタイザ（Phase 7: nano-extract.js / series-nano.js から集約）
// ============================================================

/**
 * 制御文字・方向制御・タグ文字・改行正規化を施す
 * @param {string} s
 * @returns {string}
 */
export function cleanControlChars(s) {
  // 連続改行・タブ・行分離子(U+2028/U+2029/U+0085 NEL)を単一空白に（制御文字除去より先に処理）
  // ※ U+2028/U+2029/U+0085 追加（2026-07-25 監査 F-1/F-2: 行分離子による多行注入対策）
  s = s.replace(/[\r\n\t\u2028\u2029\u0085]+/g, ' ');
  // 残余の制御文字 C0(U+0000-U+001F) / DEL(U+007F) / C1(U+0080-U+009F) を除去（改行系は上で空白化済み）
  s = s.replace(/[\x00-\x1F\x7F-\x9F]/g, '');
  // Unicode 方向制御 U+202A-U+202E を除去
  s = s.replace(/[‪-‮]/g, '');
  // Unicode 方向制御 U+2066-U+2069 を除去
  s = s.replace(/[⁦-⁩]/g, '');
  // Unicode 方向制御 U+200B-U+200F を除去
  s = s.replace(/[​-‏]/g, '');
  // タグ文字 U+E0000-U+E007F を除去
  s = s.replace(/[\u{E0000}-\u{E007F}]/gu, '');
  return s;
}

/**
 * 区切り記号をエスケープする（インジェクション対策）
 * @param {string} s
 * @returns {string}
 */
export function escapeDelimiters(s) {
  s = s.split('<<<<').join('_');
  s = s.split('>>>>').join('_');
  s = s.split('[SYSTEM]').join('_');
  s = s.split('[DATA]').join('_');
  return s;
}
