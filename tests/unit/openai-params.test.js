// tests/unit/openai-params.test.js
// GPT-6.1 系だけ reasoning_effort を low にする。それ以外（保存値に残った旧 gpt-5.6-* を含む）は未検証なので送らない。
// 配線（translate.js が両経路で展開していること）は静的に検査する。
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { openaiReasoningParams, OPENAI_TRANSLATION_RESPONSE_FORMAT } from '../../utils/openai-params.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

describe('openaiReasoningParams', () => {
  it('GPT-6.1 系は reasoning_effort: low', () => {
    expect(openaiReasoningParams('gpt-6.1-terra')).toEqual({ reasoning_effort: 'low' });
    expect(openaiReasoningParams('gpt-6.1-sol')).toEqual({ reasoning_effort: 'low' });
  });

  it('6.1 系以外（旧 gpt-5.6-* の保存値）は何も足さない', () => {
    expect(openaiReasoningParams('gpt-5.6-sol')).toEqual({});
    expect(openaiReasoningParams('gpt-5.6-terra')).toEqual({});
    expect(openaiReasoningParams('gpt-5.6-luna')).toEqual({});
  });

  it('不正な入力でも落ちず何も足さない', () => {
    expect(openaiReasoningParams(undefined)).toEqual({});
    expect(openaiReasoningParams('')).toEqual({});
    expect(openaiReasoningParams(null)).toEqual({});
  });
});

describe('translate.js の配線', () => {
  const source = readFileSync(join(ROOT, 'translate.js'), 'utf8');

  it('画像翻訳とテキスト生成の両方が body に展開している', () => {
    const uses = source.match(/\.\.\.openaiReasoningParams\(/g) || [];
    expect(uses.length).toBe(2);
  });
  it('画像翻訳は名前付き座標のプロンプトと response_format を使う（テキスト生成には付けない）', () => {
    expect((source.match(/response_format: OPENAI_TRANSLATION_RESPONSE_FORMAT/g) || []).length).toBe(1);
    expect(source).toMatch(/provider === 'openai'[\s\S]{0,400}namedCoords: true/);
  });
});

describe('OPENAI_TRANSLATION_RESPONSE_FORMAT', () => {
  const fmt = OPENAI_TRANSLATION_RESPONSE_FORMAT;
  const item = fmt.json_schema.schema.properties.translations.items;

  it('strict json_schema で、ルートは object（配列ルートは strict で使えない）', () => {
    expect(fmt.type).toBe('json_schema');
    expect(fmt.json_schema.strict).toBe(true);
    expect(fmt.json_schema.schema.type).toBe('object');
    expect(fmt.json_schema.schema.additionalProperties).toBe(false);
    expect(fmt.json_schema.schema.required).toEqual(['translations']);
  });

  it('strict の規則: 全プロパティが required で additionalProperties:false', () => {
    expect(item.additionalProperties).toBe(false);
    expect([...item.required].sort()).toEqual(Object.keys(item.properties).sort());
  });

  it('座標は box 配列ではなく名前付き 4 フィールド（順序の取り違えを構造で防ぐ）', () => {
    expect(item.properties.box).toBeUndefined();
    for (const k of ['x_min', 'y_min', 'x_max', 'y_max']) expect(item.properties[k]).toEqual({ type: 'integer' });
    expect(item.properties.type.enum).toEqual(['speech', 'caption', 'sfx']);
  });
});
