// tests/unit/gloss-policy.test.js
import { describe, it, expect } from 'vitest';
import { planGlossGeneration, seriesNameAttempts, acceptsNonExactTitle } from '../../utils/gloss-policy.js';

describe('planGlossGeneration — 課金ゲート', () => {
  it('先読み（nanoOnly）では有料 API を呼ばない', () => {
    // 設計書 §4.1。ユーザー操作なしに走る経路なので、ここが破れると
    // ページを開いただけで課金される（実装中に一度この事故を作っている）
    for (const glossEngine of ['auto', 'nano', 'api']) {
      expect(planGlossGeneration({ glossEngine, nanoOnly: true }).allowApiFallback).toBe(false);
    }
  });

  it('hover・翻訳完了時（nanoOnly:false）は auto なら API に落とせる', () => {
    expect(planGlossGeneration({ glossEngine: 'auto', nanoOnly: false }))
      .toEqual({ tryNano: true, allowApiFallback: true });
  });

  it('エンジン nano 固定なら、hover 経路でも API に落とさない', () => {
    expect(planGlossGeneration({ glossEngine: 'nano', nanoOnly: false }))
      .toEqual({ tryNano: true, allowApiFallback: false });
  });

  it('エンジン api 固定なら Nano を試さない', () => {
    expect(planGlossGeneration({ glossEngine: 'api', nanoOnly: false }))
      .toEqual({ tryNano: false, allowApiFallback: true });
  });

  it('既定は auto かつ非先読み扱い', () => {
    expect(planGlossGeneration()).toEqual({ tryNano: true, allowApiFallback: true });
    expect(planGlossGeneration({})).toEqual({ tryNano: true, allowApiFallback: true });
  });
});

describe('seriesNameAttempts — 検索の試行順', () => {
  it('シリーズ名つきを先に試す（順序を入れ替えると別人を引く）', () => {
    // "Vision" comics 単独だと Scarlet Witch を引き、しかもゲートを通ってしまう（実測）
    expect(seriesNameAttempts('Immortal Hulk')).toEqual(['Immortal Hulk', '']);
  });

  it('シリーズ名が空なら 1 回だけ試す', () => {
    expect(seriesNameAttempts('')).toEqual(['']);
    expect(seriesNameAttempts('   ')).toEqual(['']);
    expect(seriesNameAttempts(null)).toEqual(['']);
    expect(seriesNameAttempts(undefined)).toEqual(['']);
  });

  it('引用符だけのシリーズ名は同一クエリになるので 1 回に畳む', () => {
    // buildSearchUrl が二重引用符を除去するため、trim だけでは非空と誤判定する
    expect(seriesNameAttempts('"')).toEqual(['']);
    expect(seriesNameAttempts('""')).toEqual(['']);
  });
});


// ============================================================
// 非完全一致の記事を採用してよい検索はどれか
// 実測（2026-07-31）:
//   "BANNER" Immortal Hulk (2018) comics → Brian Banner [ゲート通過] ＝ ブルースの父（誤り）
//   "BANNER" comics                      → Hulk         [ゲート却下]
//   "ROSS"   Immortal Hulk (2018) comics → The Incredible Hulk (comic book) [却下]
//   "ROSS"   comics                      → Thunderbolt Ross [通過] ＝ 正しい
// シリーズ名つき検索は「作品の文脈で関連する記事」を返すため、タイトルが検索語
// そのものでない結果は信用できない。シリーズ名なし検索の結果はその語の代表的存在に近い
// ============================================================
describe('acceptsNonExactTitle', () => {
  it('シリーズ名なし検索の結果なら採用してよい', () => {
    expect(acceptsNonExactTitle('')).toBe(true);
  });

  it('シリーズ名つき検索の結果は採用しない', () => {
    expect(acceptsNonExactTitle('Immortal Hulk (2018)')).toBe(false);
  });

  it('null / undefined はシリーズ名なしとみなす', () => {
    expect(acceptsNonExactTitle(null)).toBe(true);
    expect(acceptsNonExactTitle(undefined)).toBe(true);
  });

  it('空白・引用符だけのシリーズ名も「なし」とみなす（buildSearchUrl と同じ正規化）', () => {
    expect(acceptsNonExactTitle('   ')).toBe(true);
    expect(acceptsNonExactTitle('""')).toBe(true);
  });
});
