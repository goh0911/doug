// utils/mask-secrets.js — APIエラー本文から機密情報を伏せる pure 関数（chrome.* 非依存）
// 2026-07-25 監査 F-3: JSON/生テキスト両分岐でマスクし、Gemini キー(AIza...)/Bearer も伏せる

/**
 * 文字列中の API キー・トークンをマスクする
 * @param {string} s
 * @returns {string}
 */
export function maskSecrets(s) {
  if (typeof s !== 'string') return s;
  return s
    .replace(/key=[^&\s"]+/gi, 'key=***')
    .replace(/sk-[^\s"]+/g, 'sk-***')
    .replace(/AIza[0-9A-Za-z\-_]+/g, 'AIza***')
    .replace(/Bearer\s+\S+/gi, 'Bearer ***');
}
