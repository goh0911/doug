// tests/unit/ollama.test.js
import { describe, it, expect } from 'vitest';
import {
  ollamaCleanText, ollamaParseResponse,
  OLLAMA_TRANSLATION_SCHEMA, supportsThinking, buildOllamaChatBody, pickOllamaResponseText,
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
  it('配列を強制する', () => {
    expect(OLLAMA_TRANSLATION_SCHEMA.type).toBe('array');
    expect(OLLAMA_TRANSLATION_SCHEMA.items.required).toContain('translated');
  });
});


// ============================================================
// 応答本文の取り出し
// 実測: qwen3-vl:8b は think:false を送っても答えを message.thinking に入れ、
// message.content は空文字で返す。content だけを見ていると常に 0 件になる
// ============================================================
describe('pickOllamaResponseText', () => {
  it('content があればそれを使う', () => {
    expect(pickOllamaResponseText({ content: '[1]', thinking: 'X' })).toBe('[1]');
  });

  it('content が空なら thinking を使う（qwen3-vl の実挙動）', () => {
    expect(pickOllamaResponseText({ content: '', thinking: '[{"a":1}]' })).toBe('[{"a":1}]');
  });

  it('content が空白だけでも thinking を使う', () => {
    expect(pickOllamaResponseText({ content: '   \n ', thinking: '[2]' })).toBe('[2]');
  });

  it('どちらも無ければ空文字', () => {
    expect(pickOllamaResponseText({})).toBe('');
    expect(pickOllamaResponseText(null)).toBe('');
    expect(pickOllamaResponseText(undefined)).toBe('');
  });
});

// ============================================================
// 名前付き座標
// 実測: qwen3-vl は box を [x_min, y_min, x_max, y_max] で返すが、
// プロンプトは [y_min, x_min, y_max, x_max] を要求しており軸が入れ替わっていた。
// 位置引数をやめてフィールド名で受け渡せば、モデルごとの流儀に左右されない
// ============================================================
describe('ollamaParseResponse — 名前付き座標', () => {
  const item = (o) => JSON.stringify([{ original: 'A', translated: 'あ', type: 'speech', ...o }]);

  it('x_min / y_min / x_max / y_max を解釈する', () => {
    const r = ollamaParseResponse(item({ x_min: 100, y_min: 200, x_max: 500, y_max: 300 }));
    expect(r).toHaveLength(1);
    expect(r[0].bbox).toEqual({ left: 10, top: 20, width: 40, height: 10 });
  });

  it('左上と右下が逆でも正しい矩形にする', () => {
    const r = ollamaParseResponse(item({ x_min: 500, y_min: 300, x_max: 100, y_max: 200 }));
    expect(r[0].bbox).toEqual({ left: 10, top: 20, width: 40, height: 10 });
  });

  it('名前付き座標は box より優先する（両方あっても取り違えない）', () => {
    const r = ollamaParseResponse(item({ x_min: 100, y_min: 200, x_max: 500, y_max: 300, box: [900, 900, 950, 950] }));
    expect(r[0].bbox.left).toBe(10);
    expect(r[0].bbox.top).toBe(20);
  });

  it('従来の box 形式も引き続き解釈する（後方互換）', () => {
    const r = ollamaParseResponse(item({ box: [200, 100, 300, 500] }));
    expect(r[0].bbox).toEqual({ left: 10, top: 20, width: 40, height: 10 });
  });
});

describe('OLLAMA_TRANSLATION_SCHEMA — 名前付き座標', () => {
  it('box ではなく x_min / y_min / x_max / y_max を必須にする', () => {
    const props = OLLAMA_TRANSLATION_SCHEMA.items.properties;
    expect(Object.keys(props).sort()).toEqual(
      ['original', 'translated', 'type', 'x_max', 'x_min', 'y_max', 'y_min'].sort());
    for (const k of ['x_min', 'y_min', 'x_max', 'y_max']) {
      expect(OLLAMA_TRANSLATION_SCHEMA.items.required).toContain(k);
    }
    expect(props.box).toBeUndefined();
  });
});
