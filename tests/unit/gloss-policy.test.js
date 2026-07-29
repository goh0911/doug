// tests/unit/gloss-policy.test.js
import { describe, it, expect } from 'vitest';
import { planGlossGeneration, seriesNameAttempts } from '../../utils/gloss-policy.js';

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
