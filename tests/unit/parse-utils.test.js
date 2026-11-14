// tests/unit/parse-utils.test.js
import { describe, it, expect } from 'vitest';
import { cleanTranslatedText, parseVisionResponse } from '../../utils/parse-utils.js';

describe('cleanTranslatedText', () => {
  it('「」で囲まれた文字列の括弧を除去する', () => {
    expect(cleanTranslatedText('「こんにちは」')).toBe('こんにちは');
  });
  it('末尾の。を除去する', () => {
    expect(cleanTranslatedText('こんにちは。')).toBe('こんにちは');
  });
  it('開き括弧のみ・閉じ括弧のみの場合は変換しない', () => {
    expect(cleanTranslatedText('「こんにちは')).toBe('「こんにちは');
    expect(cleanTranslatedText('こんにちは」')).toBe('こんにちは」');
  });
  it('null/undefined/空文字はそのまま返す', () => {
    expect(cleanTranslatedText(null)).toBe(null);
    expect(cleanTranslatedText('')).toBe('');
  });
});

describe('parseVisionResponse', () => {
  it('box 形式（[yMin,xMin,yMax,xMax]）を % に変換する', () => {
    const input = JSON.stringify([{
      original: 'Hello',
      translated: 'こんにちは',
      type: 'speech',
      box: [100, 200, 300, 600],
    }]);
    const result = parseVisionResponse(input, { width: 1000, height: 1000 });
    expect(result).toHaveLength(1);
    expect(result[0].bbox.top).toBeCloseTo(10);
    expect(result[0].bbox.left).toBeCloseTo(20);
    expect(result[0].bbox.width).toBeCloseTo(40);
    expect(result[0].bbox.height).toBeCloseTo(20);
    expect(result[0].translated).toBe('こんにちは');
    expect(result[0].type).toBe('speech');
  });
  it('bbox 形式（ピクセル座標）を % に変換する', () => {
    const input = JSON.stringify([{
      original: 'Hi',
      translated: 'やあ',
      type: 'caption',
      bbox: { x: 100, y: 150, w: 200, h: 100 },
    }]);
    const result = parseVisionResponse(input, { width: 1000, height: 1500 });
    expect(result[0].bbox.left).toBeCloseTo(10);
    expect(result[0].bbox.top).toBeCloseTo(10);
  });
  it('不正 JSON は [] を返す', () => {
    expect(parseVisionResponse('{broken json', {})).toEqual([]);
  });
  it('translated が空の要素は除外される', () => {
    const input = JSON.stringify([
      { original: 'A', translated: '', box: [0, 0, 100, 100] },
      { original: 'B', translated: 'ビー', box: [100, 0, 200, 100] },
    ]);
    const result = parseVisionResponse(input, {});
    expect(result).toHaveLength(1);
    expect(result[0].original).toBe('B');
  });
  it('Markdown コードブロックを取り除く', () => {
    const inner = JSON.stringify([{ original: 'A', translated: 'エー', box: [0,0,100,100] }]);
    const input = '```json\n' + inner + '\n```';
    const result = parseVisionResponse(input, {});
    expect(result).toHaveLength(1);
  });
});

describe('parseVisionResponse: 名前付き座標（OpenAI の json_schema 経路）', () => {
  const named = (o) => JSON.stringify(o);

  it('x_min/y_min/x_max/y_max を % に変換する（軸の順序に依存しない）', () => {
    const input = named([{ original: 'Hi', translated: 'やあ', type: 'speech', x_min: 200, y_min: 100, x_max: 600, y_max: 300 }]);
    const [r] = parseVisionResponse(input, { width: 1000, height: 1000 });
    expect(r.bbox.top).toBeCloseTo(10);
    expect(r.bbox.left).toBeCloseTo(20);
    expect(r.bbox.width).toBeCloseTo(40);
    expect(r.bbox.height).toBeCloseTo(20);
  });

  it('min と max が逆でも幅・高さは正になる', () => {
    const input = named([{ original: 'Hi', translated: 'やあ', type: 'speech', x_min: 600, y_min: 300, x_max: 200, y_max: 100 }]);
    const [r] = parseVisionResponse(input, {});
    expect(r.bbox.left).toBeCloseTo(20);
    expect(r.bbox.top).toBeCloseTo(10);
    expect(r.bbox.width).toBeCloseTo(40);
    expect(r.bbox.height).toBeCloseTo(20);
  });

  it('json_schema の包み {"translations":[...]} からも取り出せる', () => {
    const input = named({ translations: [{ original: 'Hi', translated: 'やあ', type: 'caption', x_min: 0, y_min: 0, x_max: 500, y_max: 100 }] });
    const res = parseVisionResponse(input, {});
    expect(res).toHaveLength(1);
    expect(res[0].type).toBe('caption');
    expect(res[0].bbox.width).toBeCloseTo(50);
  });

  it('OpenAI が実際に返した値で範囲内に収まる（2026-11-14 実測の 1 件）', () => {
    // 「Because Billy Batson…」: 上 3.6% 左 48.6% 右 73.5% 下 11.4%
    const input = named({ translations: [{ original: 'Because Billy', translated: 'ビリー', type: 'caption', x_min: 486, y_min: 36, x_max: 735, y_max: 114 }] });
    const [r] = parseVisionResponse(input, { width: 1200, height: 919 });
    expect(r.bbox.top).toBeCloseTo(3.6);
    expect(r.bbox.left).toBeCloseTo(48.6);
    expect(r.bbox.width).toBeCloseTo(24.9);
    expect(r.bbox.height).toBeCloseTo(7.8);
  });

  it('名前付き座標が欠けていれば従来の box 配列にフォールバックする', () => {
    const input = named([{ original: 'Hi', translated: 'やあ', type: 'speech', box: [100, 200, 300, 600] }]);
    const [r] = parseVisionResponse(input, {});
    expect(r.bbox.top).toBeCloseTo(10);
    expect(r.bbox.width).toBeCloseTo(40);
  });

  it('座標が文字列や欠落のときは名前付きとみなさない（0 件になる）', () => {
    const input = named([{ original: 'Hi', translated: 'やあ', type: 'speech', x_min: '200', y_min: 100, x_max: 600 }]);
    expect(parseVisionResponse(input, {})).toEqual([]);
  });
});
