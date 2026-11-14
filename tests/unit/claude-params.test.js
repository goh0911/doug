// tests/unit/claude-params.test.js
// Claude 5.5 系のモデル別パラメータと、thinking ブロックが先頭に来る応答からの text 取り出し。
// 配線（translate.js が両経路で展開・利用していること）は静的に検査する。
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { claudeThinkingParams, extractClaudeText } from '../../utils/claude-params.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

describe('claudeThinkingParams', () => {
  it('haiku-5-5 は thinking を無効にする', () => {
    expect(claudeThinkingParams('claude-haiku-5-5')).toEqual({ thinking: { type: 'disabled' } });
  });

  it('sonnet-5-5 は between_tools（disabled は 400 になる）', () => {
    expect(claudeThinkingParams('claude-sonnet-5-5')).toEqual({ thinking: { type: 'between_tools' } });
  });

  it('opus-5-5 は thinking を切れないので effort: low', () => {
    expect(claudeThinkingParams('claude-opus-5-5')).toEqual({ output_config: { effort: 'low' } });
  });

  it('未検証のモデル（旧 sonnet-5 / opus-4-8 / haiku-4-5）は何も足さない', () => {
    expect(claudeThinkingParams('claude-sonnet-5')).toEqual({});
    expect(claudeThinkingParams('claude-opus-4-8')).toEqual({});
    expect(claudeThinkingParams('claude-haiku-4-5')).toEqual({});
  });

  it('不正な入力でも落ちず何も足さない', () => {
    expect(claudeThinkingParams(undefined)).toEqual({});
    expect(claudeThinkingParams('')).toEqual({});
    expect(claudeThinkingParams(null)).toEqual({});
  });
});

describe('extractClaudeText', () => {
  it('text だけの応答はそのまま返す', () => {
    expect(extractClaudeText([{ type: 'text', text: '[{"a":1}]' }])).toBe('[{"a":1}]');
  });

  it('先頭が thinking ブロックでも text を取り出す（content[0].text は undefined になる形）', () => {
    const content = [
      { type: 'thinking', thinking: '', signature: 'sig' },
      { type: 'text', text: '[{"a":1}]' },
    ];
    expect(content[0].text).toBeUndefined(); // 旧実装が落ちた形であることの対照
    expect(extractClaudeText(content)).toBe('[{"a":1}]');
  });

  it('text ブロックが複数あれば連結する', () => {
    expect(extractClaudeText([{ type: 'text', text: 'ab' }, { type: 'text', text: 'cd' }])).toBe('abcd');
  });

  it('text が無い・不正な入力は空文字', () => {
    expect(extractClaudeText([{ type: 'thinking', thinking: '' }])).toBe('');
    expect(extractClaudeText([])).toBe('');
    expect(extractClaudeText(undefined)).toBe('');
    expect(extractClaudeText(null)).toBe('');
    expect(extractClaudeText('text')).toBe('');
    expect(extractClaudeText([null, { type: 'text' }])).toBe('');
  });
});

describe('translate.js の配線', () => {
  const source = readFileSync(join(ROOT, 'translate.js'), 'utf8');

  it('画像翻訳とテキスト生成の両方が body に展開している', () => {
    const uses = source.match(/\.\.\.claudeThinkingParams\(/g) || [];
    expect(uses.length).toBe(2);
  });

  it('両経路が extractClaudeText で応答を読み、content[0].text の直読みが残っていない', () => {
    const uses = source.match(/extractClaudeText\(data\.content\)/g) || [];
    expect(uses.length).toBe(2);
    expect(source).not.toMatch(/data\.content\?\.\[0\]/);
  });
});
