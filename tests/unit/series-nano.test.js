import { describe, it, expect } from 'vitest';
import { sanitizeDetectionInput } from '../../utils/series-nano.js';

describe('sanitizeDetectionInput', () => {
  it('通常の文字列はそのまま（trim される）', () => {
    expect(sanitizeDetectionInput('  Immortal Hulk  ')).toBe('Immortal Hulk');
  });

  it('非文字列は空文字を返す', () => {
    expect(sanitizeDetectionInput(null)).toBe('');
    expect(sanitizeDetectionInput(undefined)).toBe('');
    expect(sanitizeDetectionInput(42)).toBe('');
  });

  it('200文字に切り詰める', () => {
    const long = 'a'.repeat(300);
    expect(sanitizeDetectionInput(long).length).toBe(200);
  });

  it('改行・タブを空白に変換する', () => {
    expect(sanitizeDetectionInput('a\n\tb')).toBe('a b');
  });

  it('制御文字を除去する', () => {
    expect(sanitizeDetectionInput('a\x00\x1Fb')).toBe('ab');
  });

  it('Unicode 方向制御文字を除去する', () => {
    expect(sanitizeDetectionInput('a‮b⁦c')).toBe('abc');
  });

  it('区切り記号を無害化する', () => {
    expect(sanitizeDetectionInput('x<<<<y>>>>z')).toBe('x_y_z');
    expect(sanitizeDetectionInput('a[SYSTEM]b[DATA]c')).toBe('a_b_c');
  });
});
