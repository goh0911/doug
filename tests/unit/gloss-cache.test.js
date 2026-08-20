// tests/unit/gloss-cache.test.js
import { describe, it, expect } from 'vitest';
import {
  GLOSSDEFS_SERIES_MAX_BYTES, FAILED_TTL_MS, FAILED_MAX_TTL_MS,
  isUsable, nextFailCount, trimGlossDefs,
} from '../../utils/gloss-cache.js';

const NOW = 1_800_000_000_000;
const ok = (at = NOW) => ({ identity: 'A', powers: 'B。', url: 'https://x/', source: 'en-wikipedia', at });
const failed = (at = NOW) => ({ failed: true, at });

describe('定数', () => {
  it('1 シリーズ 16 KB', () => expect(GLOSSDEFS_SERIES_MAX_BYTES).toBe(16 * 1024));
  it('失敗の TTL は 24 時間', () => expect(FAILED_TTL_MS).toBe(24 * 60 * 60 * 1000));
});

describe('isUsable', () => {
  it('成功エントリは期限切れしない', () => {
    expect(isUsable(ok(NOW - FAILED_TTL_MS * 100), NOW)).toBe(true);
  });

  it('失敗エントリは 24 時間以内なら「使える」（再試行しない）', () => {
    expect(isUsable(failed(NOW - 1000), NOW)).toBe(true);
  });

  it('失敗エントリは 24 時間を超えたら使えない（再試行する）', () => {
    expect(isUsable(failed(NOW - FAILED_TTL_MS - 1), NOW)).toBe(false);
  });

  it('不正な値は使えない', () => {
    expect(isUsable(null, NOW)).toBe(false);
    expect(isUsable({}, NOW)).toBe(false);
    expect(isUsable({ identity: 'A' }, NOW)).toBe(false); // at が無い
  });
});

describe('isUsable — ソース構成の指紋', () => {
  const WIKI = '2:en-wikipedia';
  const BOTH = '2:en-wikipedia+comicvine';
  const failedWith = (sources, at = NOW) => ({ failed: true, at, sources });

  it('指紋が一致する失敗は 24 時間有効のまま', () => {
    expect(isUsable(failedWith(WIKI, NOW - 1000), NOW, WIKI)).toBe(true);
  });

  it('指紋が変わった失敗は即座に無効（新ソース追加を待たずに反映する）', () => {
    // Comic Vine 導入前に Wikipedia だけで失敗した語は、導入後は引き直す
    expect(isUsable(failedWith(WIKI, NOW - 1000), NOW, BOTH)).toBe(false);
  });

  it('世代（epoch）だけ変わった場合も無効', () => {
    expect(isUsable(failedWith('1:en-wikipedia', NOW - 1000), NOW, WIKI)).toBe(false);
  });

  it('指紋を持たない旧エントリは無効（いつの構成か分からないため引き直す）', () => {
    expect(isUsable(failed(NOW - 1000), NOW, WIKI)).toBe(false);
  });

  it('指紋を渡さなければ従来どおり時間だけで判定する', () => {
    expect(isUsable(failedWith(WIKI, NOW - 1000), NOW)).toBe(true);
    expect(isUsable(failed(NOW - 1000), NOW)).toBe(true);
  });

  it('指紋が一致していても 24 時間を超えれば無効', () => {
    expect(isUsable(failedWith(WIKI, NOW - FAILED_TTL_MS - 1), NOW, WIKI)).toBe(false);
  });

  // 以前は成功エントリだけ指紋を見ていなかった。成功は TTL を持たず無期限に残るため、
  // プロンプトや素材の取り方を直しても既存の解説が居座り、改善が実機に永久に届かない
  // （実測: 解説 38 件のうち成功 36 件が、手でキャッシュを消さない限り古い文面のまま）
  const okWith = (sources, at = NOW) => ({ ...ok(at), sources });

  it('指紋が一致する成功はそのまま使える（期限切れしない）', () => {
    expect(isUsable(okWith(BOTH, NOW - FAILED_TTL_MS * 100), NOW, BOTH)).toBe(true);
  });

  // 成功は「どの作り方で作ったか」だけを見る。ソース構成まで一致を求めると、先読み
  // （primaryOnly: Wikipedia のみ）で作った解説が通常経路で毎回作り直されてしまう
  it('世代が同じならソース構成が違う成功も使える（先読み分を作り直さない）', () => {
    expect(isUsable(okWith(WIKI), NOW, BOTH)).toBe(true);
    expect(isUsable(okWith(BOTH), NOW, WIKI)).toBe(true);
  });

  it('失敗はソース構成まで見る（増えた先で引き直したいため）', () => {
    expect(isUsable(failedWith(WIKI, NOW - 1000), NOW, BOTH)).toBe(false);
  });

  it('世代（epoch）が変わった成功は無効。プロンプト改善を既存の解説へ届ける経路', () => {
    expect(isUsable(okWith('1:en-wikipedia+comicvine'), NOW, BOTH)).toBe(false);
  });

  it('指紋を持たない旧い成功エントリは無効（いつの作り方か分からないため作り直す）', () => {
    expect(isUsable(ok(NOW - 1000), NOW, BOTH)).toBe(false);
  });

  it('指紋を渡さなければ成功は従来どおり無期限に有効', () => {
    expect(isUsable(ok(NOW - FAILED_TTL_MS * 100), NOW)).toBe(true);
  });
});

describe('trimGlossDefs', () => {
  it('上限以下ならそのまま返す', () => {
    const m = { A: ok(), B: ok() };
    expect(Object.keys(trimGlossDefs(m, GLOSSDEFS_SERIES_MAX_BYTES))).toEqual(['A', 'B']);
  });

  it('失敗エントリを成功エントリより先に落とす', () => {
    const m = { keep: ok(NOW - 5000), drop: failed(NOW) };
    // 成功1件ぶんしか入らない極小上限
    const r = trimGlossDefs(m, 120);
    expect(r).toHaveProperty('keep');
    expect(r).not.toHaveProperty('drop');
  });

  it('成功エントリ同士では at の古い順に落とす', () => {
    const m = { old: ok(NOW - 10_000), mid: ok(NOW - 5_000), fresh: ok(NOW) };
    const r = trimGlossDefs(m, 250);
    expect(r).toHaveProperty('fresh');
    expect(r).toHaveProperty('mid');
    expect(r).not.toHaveProperty('old');
  });

  it('1 件も入らない上限なら空オブジェクト', () => {
    expect(trimGlossDefs({ A: ok() }, 1)).toEqual({});
  });

  it('不正な入力でも例外を投げない', () => {
    expect(trimGlossDefs(null, 100)).toEqual({});
    expect(trimGlossDefs({ A: null }, 100)).toEqual({});
  });
});

// ------------------------------------------------------------------
// A-6: 素材が存在しない語の再試行バックオフ
// ------------------------------------------------------------------
describe('isUsable — 失敗の再試行バックオフ', () => {
  const KEY = '2:en-wikipedia';
  const failedN = (failCount, at) => ({ failed: true, at, sources: KEY, failCount });

  it('failCount を持たない旧エントリは従来どおり 24 時間', () => {
    expect(isUsable({ failed: true, at: NOW - FAILED_TTL_MS - 1, sources: KEY }, NOW, KEY)).toBe(false);
  });

  it('1 回目の失敗は 24 時間で再試行する', () => {
    expect(isUsable(failedN(1, NOW - FAILED_TTL_MS - 1), NOW, KEY)).toBe(false);
  });

  it('2 回目の失敗は 24 時間経っても再試行しない', () => {
    expect(isUsable(failedN(2, NOW - FAILED_TTL_MS - 1), NOW, KEY)).toBe(true);
  });

  it('2 回目の失敗は 48 時間を超えたら再試行する', () => {
    expect(isUsable(failedN(2, NOW - FAILED_TTL_MS * 2 - 1), NOW, KEY)).toBe(false);
  });

  it('失敗が続いても待機は 7 日で頭打ちになる', () => {
    // 2^9 * 24h = 12 日ぶんに相当する failCount でも 7 日で再試行する
    expect(isUsable(failedN(10, NOW - FAILED_MAX_TTL_MS - 1), NOW, KEY)).toBe(false);
    expect(isUsable(failedN(10, NOW - FAILED_MAX_TTL_MS + 1000), NOW, KEY)).toBe(true);
  });

  it('ソース構成が変われば failCount によらず即座に再試行する', () => {
    // 新しいソースを足した効果を、伸びた待機時間で潰さない
    expect(isUsable(failedN(10, NOW - 1000), NOW, '2:en-wikipedia+comicvine')).toBe(false);
  });

  it('成功エントリは failCount を見ない', () => {
    expect(isUsable({ ...ok(NOW - FAILED_MAX_TTL_MS * 10), sources: KEY, failCount: 10 }, NOW, KEY)).toBe(true);
  });
});

describe('nextFailCount', () => {
  it('初めての失敗は 1', () => {
    expect(nextFailCount(undefined)).toBe(1);
    expect(nextFailCount(null)).toBe(1);
  });

  it('失敗が続くと増える', () => {
    expect(nextFailCount({ failed: true, at: NOW, failCount: 1 })).toBe(2);
    expect(nextFailCount({ failed: true, at: NOW, failCount: 3 })).toBe(4);
  });

  it('failCount を持たない旧い失敗エントリは 2 として続きから数える', () => {
    expect(nextFailCount({ failed: true, at: NOW })).toBe(2);
  });

  it('直前が成功なら 1 に戻る', () => {
    // 一度でも引けた語は「素材が無い」わけではないので待機を伸ばさない
    expect(nextFailCount(ok(NOW))).toBe(1);
  });

  it('エントリでない値は 1 を返す', () => {
    expect(nextFailCount('x')).toBe(1);
  });

  it('failCount が壊れている失敗エントリは 2（直前が失敗である事実は動かない）', () => {
    expect(nextFailCount({ failed: true, at: NOW, failCount: -5 })).toBe(2);
    expect(nextFailCount({ failed: true, at: NOW, failCount: 'x' })).toBe(2);
  });
});

describe('定数（バックオフ）', () => {
  it('待機の上限は 7 日', () => expect(FAILED_MAX_TTL_MS).toBe(7 * 24 * 60 * 60 * 1000));
});
