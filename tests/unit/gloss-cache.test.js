// tests/unit/gloss-cache.test.js
import { describe, it, expect } from 'vitest';
import {
  GLOSSDEFS_SERIES_MAX_BYTES, FAILED_TTL_MS, isUsable, trimGlossDefs,
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

  it('成功エントリは指紋の影響を受けない', () => {
    expect(isUsable(ok(NOW - FAILED_TTL_MS * 100), NOW, BOTH)).toBe(true);
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
