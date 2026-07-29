// utils/gloss-policy.js — 解説生成の方針を決める pure 関数（chrome.* / fetch 非依存）
//
// この 2 つは設計上いちばん重い不変条件でありながら、background.js に埋め込まれていて
// 自動テストの対象外だった（v2.0.0 リリース前レビューの指摘）。
//   - 先読み経路では絶対に有料 API を呼ばない（課金）
//   - Wikipedia 検索はシリーズ名つきを先に試す（誤った記事の採用防止）
// 判断だけを切り出してテストできるようにする。実行（fetch / LLM 呼び出し）は
// 呼び出し側に残す。

/**
 * 解説生成でどのエンジンを試してよいかを決める。
 *
 * @param {{ glossEngine?: 'auto'|'nano'|'api', nanoOnly?: boolean }} opts
 *   nanoOnly: 先読み経路（ユーザー操作なしに走る）かどうか
 * @returns {{ tryNano: boolean, allowApiFallback: boolean }}
 */
export function planGlossGeneration({ glossEngine = 'auto', nanoOnly = false } = {}) {
  return {
    // 'api' 固定のときだけ Nano を飛ばす
    tryNano: glossEngine !== 'api',
    // 先読みは有料 API を呼ばない（設計書 §4.1）。'nano' 固定でも呼ばない
    allowApiFallback: !nanoOnly && glossEngine !== 'nano',
  };
}

/**
 * Wikipedia 検索で試すシリーズ名の並びを返す。
 *
 * シリーズ名つきを **先に** 試すこと。順序が逆だと、シリーズ名無しの単独検索が
 * "Vision" comics → Scarlet Witch のように「ゲートを通る別人」を引く（実測）。
 * シリーズ名つきを先に試すからこそ、フォールバックが安全に成立する。
 *
 * 空・引用符のみのシリーズ名は buildSearchUrl 側で除去されて同一クエリになるため、
 * 2 回投げないよう 1 要素に畳む。
 *
 * @param {string} seriesName
 * @returns {string[]} 試す順の seriesName（1〜2 要素）
 */
export function seriesNameAttempts(seriesName) {
  // buildSearchUrl と同じ正規化（二重引用符除去 → trim）
  const s = String(seriesName ?? '').split('"').join('').trim();
  return s === '' ? [''] : [seriesName, ''];
}
