// utils/url-pattern.js — サイト別アダプタによる URL → pathPrefix 導出（pure）
// chrome.* を使わない pure モジュール

// サイト別アダプタ（新サイト対応時に追加する）
const SITE_ADAPTERS = [
  {
    // Marvel.com: /comics/issue/{id}/{slug} → /comics/issue/
    test: (u) => u.hostname === 'www.marvel.com' && u.pathname.startsWith('/comics/issue/'),
    derive: (_u) => '/comics/issue/',
  },
  // MangaDex / Webtoons 等は実データ採取後に追加
];

/**
 * URL から pathPrefix を導出する
 * @param {string} url
 * @returns {string} pathPrefix（フォールバックは '/'）
 */
export function derivePathPrefix(url) {
  try {
    const u = new URL(url);
    for (const adapter of SITE_ADAPTERS) {
      if (adapter.test(u)) return adapter.derive(u);
    }
    // 汎用フォールバック: ルートのみ
    return '/';
  } catch {
    return '/';
  }
}
