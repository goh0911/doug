import { describe, it, expect } from 'vitest';
import { sanitizeExample } from '../../utils/example-utils.js';

describe('sanitizeExample', () => {
  it('通常の文ペアはそのまま（trim）', () => {
    expect(sanitizeExample({ original: '  WHO ARE YOU?!  ', translated: ' お前は誰だ！？ ' }))
      .toEqual({ original: 'WHO ARE YOU?!', translated: 'お前は誰だ！？' });
  });

  it('非文字列は null', () => {
    expect(sanitizeExample({ original: 1, translated: 'x' })).toBeNull();
    expect(sanitizeExample({ original: 'x', translated: null })).toBeNull();
    expect(sanitizeExample()).toBeNull();
  });

  it('どちらかが空になったら null', () => {
    expect(sanitizeExample({ original: '   ', translated: 'x' })).toBeNull();
    expect(sanitizeExample({ original: 'x', translated: '' })).toBeNull();
  });

  it('150文字に切り詰める', () => {
    const long = 'a'.repeat(200);
    const r = sanitizeExample({ original: long, translated: long });
    expect(r.original.length).toBe(150);
    expect(r.translated.length).toBe(150);
  });

  it('制御文字・方向制御・タグ文字を除去し改行/タブを空白化', () => {
    expect(sanitizeExample({ original: 'a\n\tb\x00', translated: 'c‮d' }))
      .toEqual({ original: 'a b', translated: 'cd' });
  });

  it('区切り記号を無害化', () => {
    expect(sanitizeExample({ original: 'a<<<<b>>>>c', translated: 'd[SYSTEM]e[DATA]f' }))
      .toEqual({ original: 'a_b_c', translated: 'd_e_f' });
  });
});
