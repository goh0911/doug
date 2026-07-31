// utils/semaphore.js — 同時実行数を絞るセマフォ（chrome.* / fetch 非依存）
//
// mapWithConcurrency は「1 回の呼び出しの中」の上限しか決められない。
// 別シリーズ・別言語の解説生成が同時に走ると上限が合算され、同じ origin へ
// 想定の何倍もの接続が飛ぶ（Codex レビュー指摘）。プロセス全体で 1 個の
// セマフォを共有してそれを防ぐ。

/**
 * 同時実行数を limit 個に制限するセマフォを作る。
 * acquire した回数だけ release すること（呼び出し側で try/finally を使う）。
 *
 * @param {number} limit 1 以上の整数。不正値は 1 に丸める
 * @returns {{ acquire: () => Promise<void>, release: () => void, active: () => number, waiting: () => number }}
 */
export function createSemaphore(limit) {
  const max = Number.isFinite(limit) && limit >= 1 ? Math.floor(limit) : 1;
  let active = 0;
  const waiters = [];

  async function acquire() {
    // 起こされた後にもう一度確認する。release は待ち行列の先頭を 1 つ起こすだけなので、
    // if で書くと同時に起きた複数の待ち手が上限を超えて通過する
    while (active >= max) {
      await new Promise((resolve) => { waiters.push(resolve); });
    }
    active += 1;
  }

  function release() {
    // 二重 release で負にしない（負になると上限が事実上増える）
    if (active > 0) active -= 1;
    const next = waiters.shift();
    if (next) next();
  }

  return {
    acquire,
    release,
    active: () => active,
    waiting: () => waiters.length,
  };
}
