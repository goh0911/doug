// tests/unit/gemini-params.test.js
// Gemini 4 系だけ thinkingLevel を low にする。3.x に送ると挙動が変わるので送らない。
// 配線（translate.js が両経路で展開していること）は静的に検査する。
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { geminiThinkingConfig } from '../../utils/gemini-params.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

describe('geminiThinkingConfig', () => {
  it('Gemini 4 系は thinkingLevel: low（generationConfig.thinkingConfig の形）', () => {
    expect(geminiThinkingConfig('gemini-4-hydrogen')).toEqual({ thinkingConfig: { thinkingLevel: 'low' } });
    expect(geminiThinkingConfig('gemini-4-argon')).toEqual({ thinkingConfig: { thinkingLevel: 'low' } });
  });

  it('Gemini 3.x は何も足さない', () => {
    expect(geminiThinkingConfig('gemini-3.6-flash')).toEqual({});
    expect(geminiThinkingConfig('gemini-3.8-flash')).toEqual({});
  });

  it('不正な入力でも落ちず何も足さない', () => {
    expect(geminiThinkingConfig(undefined)).toEqual({});
    expect(geminiThinkingConfig('')).toEqual({});
    expect(geminiThinkingConfig(null)).toEqual({});
  });

  it('minimal は使わない（Gemini 4 は 400 で拒否する）', () => {
    expect(JSON.stringify(geminiThinkingConfig('gemini-4-hydrogen'))).not.toContain('minimal');
  });
});

describe('translate.js の配線', () => {
  const source = readFileSync(join(ROOT, 'translate.js'), 'utf8');

  it('画像翻訳とテキスト生成の両方が generationConfig に展開している', () => {
    const uses = source.match(/\.\.\.geminiThinkingConfig\(/g) || [];
    expect(uses.length).toBe(2);
  });

  it('docs 由来の誤った書式（snake_case）を使っていない', () => {
    expect(source).not.toMatch(/thinking_level/);
  });
});
