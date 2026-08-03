// tests/unit/ollama.test.js
import { describe, it, expect } from 'vitest';
import {
  ollamaCleanText, ollamaParseResponse,
  OLLAMA_TRANSLATION_SCHEMA, supportsThinking, buildOllamaChatBody,
} from '../../utils/ollama.js';

describe('ollamaCleanText', () => {
  it('「」で囲まれた文字列の括弧を除去する', () => {
    expect(ollamaCleanText('「こんにちは」')).toBe('こんにちは');
  });
  it('末尾の。を除去する', () => {
    expect(ollamaCleanText('こんにちは。')).toBe('こんにちは');
  });
  it('null/falsy はそのまま返す', () => {
    expect(ollamaCleanText(null)).toBe(null);
    expect(ollamaCleanText('')).toBeFalsy();
  });
});

describe('ollamaParseResponse', () => {
  it('box 形式を % に変換する（Ollama は固定 1000x1000 スケール）', () => {
    const input = JSON.stringify([{
      original: 'BOOM',
      translated: 'ドーン',
      type: 'sfx',
      box: [500, 250, 750, 750],
    }]);
    const result = ollamaParseResponse(input);
    expect(result).toHaveLength(1);
    expect(result[0].bbox.top).toBeCloseTo(50);
    expect(result[0].bbox.left).toBeCloseTo(25);
    expect(result[0].bbox.width).toBeCloseTo(50);
    expect(result[0].bbox.height).toBeCloseTo(25);
  });
  it('bbox 形式（Ollama フォールバック）も動作する', () => {
    const input = JSON.stringify([{
      original: 'Hi',
      translated: 'やあ',
      type: 'speech',
      bbox: { x: 100, y: 150, w: 200, h: 100 },
    }]);
    const result = ollamaParseResponse(input);
    expect(result[0].bbox.left).toBeCloseTo(10);
  });
  it('不正 JSON は [] を返す', () => {
    expect(ollamaParseResponse('broken')).toEqual([]);
  });
  it('translated が空の要素は除外される', () => {
    const input = JSON.stringify([
      { original: 'A', translated: '', box: [0, 0, 100, 100] },
      { original: 'B', translated: 'ビー', box: [100, 0, 200, 100] },
    ]);
    expect(ollamaParseResponse(input)).toHaveLength(1);
  });
  it('translated テキストに ollamaCleanText が適用される', () => {
    const input = JSON.stringify([{
      original: 'Hello',
      translated: '「こんにちは」',
      box: [0, 0, 100, 100],
    }]);
    expect(ollamaParseResponse(input)[0].translated).toBe('こんにちは');
  });
});


// ============================================================
// think / format
// 実測（qwen3.5:9b・Ollama 0.32.5・アイコン画像 1 枚）:
//   既定（thinking 有効）        539.7 秒  content は配列
//   think:false のみ              1.2 秒   content が **オブジェクト** になりパース不能
//   think:false + format(Schema)  0.57 秒  配列・スキーマ準拠
// thinking を止めないと実用にならず、止めるだけだと形式が壊れるので両方要る
// ============================================================
describe('supportsThinking', () => {
  it('capabilities に thinking があれば true', () => {
    expect(supportsThinking({ capabilities: ['completion', 'vision', 'tools', 'thinking'] })).toBe(true);
  });

  it('thinking が無ければ false', () => {
    expect(supportsThinking({ capabilities: ['completion', 'vision'] })).toBe(false);
  });

  // /api/show が失敗・想定外の形なら think を送らない（現状維持＝安全側）。
  // 非対応モデルに think を送るとエラーになる可能性があり、gemma3 利用者を壊せない
  it.each([[null], [undefined], [{}], [{ capabilities: null }], [{ capabilities: 'thinking' }], ['thinking']])(
    '想定外の入力は false: %s', (input) => {
      expect(supportsThinking(input)).toBe(false);
    });
});

describe('buildOllamaChatBody', () => {
  const base = { model: 'qwen3.5:9b', prompt: 'PROMPT', base64: 'BASE64' };

  it('画像とプロンプトを messages に載せる', () => {
    const b = buildOllamaChatBody({ ...base, thinking: false });
    expect(b.model).toBe('qwen3.5:9b');
    expect(b.messages).toEqual([{ role: 'user', content: 'PROMPT', images: ['BASE64'] }]);
    expect(b.stream).toBe(false);
  });

  it('format は常に付ける（モデル非依存の Ollama 機能）', () => {
    expect(buildOllamaChatBody({ ...base, thinking: false }).format).toEqual(OLLAMA_TRANSLATION_SCHEMA);
    expect(buildOllamaChatBody({ ...base, thinking: true }).format).toEqual(OLLAMA_TRANSLATION_SCHEMA);
  });

  it('thinking 対応モデルにだけ think:false を送る', () => {
    expect(buildOllamaChatBody({ ...base, thinking: true }).think).toBe(false);
  });

  it('非対応モデルには think を一切含めない', () => {
    expect('think' in buildOllamaChatBody({ ...base, thinking: false })).toBe(false);
    expect('think' in buildOllamaChatBody(base)).toBe(false);
  });
});

describe('OLLAMA_TRANSLATION_SCHEMA', () => {
  it('配列を強制し、パーサが必要とする 4 フィールドを必須にする', () => {
    expect(OLLAMA_TRANSLATION_SCHEMA.type).toBe('array');
    const props = OLLAMA_TRANSLATION_SCHEMA.items.properties;
    expect(Object.keys(props).sort()).toEqual(['box', 'original', 'translated', 'type']);
    expect(OLLAMA_TRANSLATION_SCHEMA.items.required).toContain('translated');
    expect(OLLAMA_TRANSLATION_SCHEMA.items.required).toContain('box');
  });

  it('box は 4 要素の配列（ollamaParseResponse が length===4 を要求する）', () => {
    const box = OLLAMA_TRANSLATION_SCHEMA.items.properties.box;
    expect(box.minItems).toBe(4);
    expect(box.maxItems).toBe(4);
  });
});
