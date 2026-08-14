// tests/unit/bubble-color.test.js
// 吹き出しの塗り色検知。content.js は IIFE で import できないため、関数本体を抜き出して評価する。
// ここは「壊れても画面が真っ白になるわけではない」ぶん退行に気付きにくいので、
// 実測で確認した 3 つの条件（暗い塗り・圧縮ノイズ・文字過多）を固定しておく。
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const source = readFileSync(join(ROOT, 'content.js'), 'utf8');

/** `function 名(...) { ... }` を波括弧の対応で切り出す */
function extractFunction(src, name) {
  const start = src.indexOf(`function ${name}(`);
  if (start === -1) throw new Error(`${name} が content.js に見つからない`);
  const open = src.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error(`${name} の終端が見つからない`);
}

const body = ['toHex', 'dominantColor', 'sampleBackground'].map(n => extractFunction(source, n)).join('\n');
const { dominantColor, sampleBackground } = new Function(
  `${body}\nreturn { dominantColor, sampleBackground };`
)();

/** getImageData だけを持つ最小の ctx。sampleBackground は data しか見ない */
const ctxOf = (data) => ({ getImageData: () => ({ data }) });

function makeData(w, h, pick) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const { r, g, b } = pick(x, y);
      const i = (y * w + x) * 4;
      data[i] = r; data[i + 1] = g; data[i + 2] = b; data[i + 3] = 255;
    }
  }
  return data;
}

/** 決定的な擬似乱数（テストを再現可能にするため Math.random は使わない） */
function lcg(seed) {
  let s = seed;
  return () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
}

const hexToRgb = (hex) => ({
  r: parseInt(hex.slice(1, 3), 16),
  g: parseInt(hex.slice(3, 5), 16),
  b: parseInt(hex.slice(5, 7), 16),
});

/** 文字の帯を持つ吹き出し。inkRows で文字の占有率を変える */
const bubble = (fill, ink, inkRows, jitter = null) => (x, y) => {
  const isInk = (y % 12) < inkRows && Math.floor(x / 5) % 3 !== 2;
  const base = isInk ? ink : fill;
  if (!jitter) return base;
  const n = () => Math.round((jitter() - 0.5) * 20); // ±10 の圧縮ノイズを模す
  return { r: base.r + n(), g: base.g + n(), b: base.b + n() };
};

const WHITE = { r: 255, g: 255, b: 255 };
const BLACK_INK = { r: 20, g: 20, b: 20 };

describe('dominantColor / sampleBackground', () => {
  // 黒地キャプションの文字は白。暗いピクセルを一律に「文字」として捨てると、
  // 塗りが消えて白文字のほうを塗りと誤認する（修正前は #f6f5fa を返していた）
  it('黒地に白文字のキャプションで、塗り（黒）を取れる', () => {
    const fill = { r: 18, g: 18, b: 24 };
    const data = makeData(200, 60, bubble(fill, WHITE, 3));

    const got = sampleBackground(ctxOf(data), 0, 0, 200, 60);
    expect(got).not.toBeNull();
    const { r, g, b } = hexToRgb(got);
    expect(Math.abs(r - fill.r)).toBeLessThanOrEqual(20);
    expect(Math.abs(g - fill.g)).toBeLessThanOrEqual(20);
    expect(Math.abs(b - fill.b)).toBeLessThanOrEqual(20);

    // 面積の広いほう（塗り）が勝つ。明暗それぞれの最頻色は両方とも取れている
    expect(dominantColor(data, 200, 60, true).n).toBeGreaterThan(dominantColor(data, 200, 60, false).n);
  });

  it('圧縮ノイズで色が散っても色付きの塗りを拾える', () => {
    const fill = { r: 245, g: 210, b: 70 }; // 黄色
    const data = makeData(200, 60, bubble(fill, BLACK_INK, 2, lcg(42)));

    const got = sampleBackground(ctxOf(data), 0, 0, 200, 60);
    expect(got).not.toBeNull();
    const { r, g, b } = hexToRgb(got);
    // 量子化を粗くしてもビン内平均を返すので、実際の塗りから大きくは外れない
    expect(Math.abs(r - fill.r)).toBeLessThanOrEqual(12);
    expect(Math.abs(g - fill.g)).toBeLessThanOrEqual(12);
    expect(Math.abs(b - fill.b)).toBeLessThanOrEqual(12);
  });

  it('現実的な文字量（インク 2〜3 割）なら白地の塗りを取れる', () => {
    for (const inkRows of [2, 4, 5]) { // 約 11% / 22% / 28%
      const data = makeData(200, 60, bubble(WHITE, BLACK_INK, inkRows));
      const got = sampleBackground(ctxOf(data), 0, 0, 200, 60);
      expect(got).not.toBeNull();
      const { r, g, b } = hexToRgb(got);
      const lum = 0.299 * r + 0.587 * g + 0.114 * b;
      expect(lum).toBeGreaterThan(200); // 白い塗り（文字色なら 20 前後）
    }
  });

  // 既知の限界（意図的なトレードオフ）。面積で塗りを決めるため、文字が過半を占めると
  // 文字色が勝つ。実際のレタリングのインク比率は 15〜35% 程度なのでこの領域には入らない。
  // 「暗い側を捨てる」旧実装ならここは耐えたが、代わりに黒地キャプションが常に外れていた
  it('【既知の限界】文字が過半を占めると文字色を拾う', () => {
    const data = makeData(200, 60, bubble(WHITE, BLACK_INK, 11)); // 約 61%
    const { r, g, b } = hexToRgb(sampleBackground(ctxOf(data), 0, 0, 200, 60));
    const lum = 0.299 * r + 0.587 * g + 0.114 * b;
    expect(lum).toBeLessThan(60); // 現状は文字色を拾う。改善したらこのテストを更新する
  });

  it('幅・高さが不正なら null（NaN 座標での例外を防ぐ）', () => {
    const data = makeData(10, 10, () => WHITE);
    expect(sampleBackground(ctxOf(data), 5, 5, 5, 5)).toBeNull();
    expect(sampleBackground(ctxOf(data), 0, 0, NaN, 10)).toBeNull();
  });
});
