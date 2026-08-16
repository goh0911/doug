// tests/unit/capture-format.test.js
//
// 送信画像の形式は Ollama のローカルモデルが読めるものに限る。llama.cpp 経路は
// WebP をデコードできず、翻訳が HTTP 400 で落ちる（実測: Ollama 0.32.13 /
// qwen3.6:35b-a3b、同一画像で 3/3 再現。server.log に
// "mtmd_helper_bitmap_init_from_buf: failed to decode buffer"）。
//
// canvas への書き出しは content.js の IIFE 内にあり単体テストから呼べないので、
// ソースを機械的に検査する（copy-sync.test.js と同じ方針）。
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

/** コメントを落とす。解説文中の "image/webp" を誤検出しないため */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, ''))
    .join('\n');
}

describe('送信画像の形式', () => {
  it('content.js は WebP で書き出さない（llama.cpp がデコードできない）', () => {
    const src = stripComments(read('content.js'));
    expect(src).not.toMatch(/toDataURL\(\s*['"]image\/webp['"]/);
    expect(src).not.toMatch(/convertToBlob\(\s*\{[^}]*image\/webp/);
  });

  it('image.js も WebP で書き出さない', () => {
    const src = stripComments(read('image.js'));
    expect(src).not.toMatch(/image\/webp/);
  });

  it('content.js のキャプチャ形式は JPEG で、品質を image.js と揃えている', () => {
    const src = stripComments(read('content.js'));
    expect(src).toMatch(/CAPTURE_MIME\s*=\s*['"]image\/jpeg['"]/);
    expect(src).toMatch(/CAPTURE_QUALITY\s*=\s*0\.92/);
    // 定数を定義しただけで使っていない、という取り違えを防ぐ
    const uses = src.match(/toDataURL\(CAPTURE_MIME,\s*CAPTURE_QUALITY\)/g) || [];
    expect(uses.length).toBeGreaterThanOrEqual(2);
  });

  it('image.js の変換品質も 0.92（両経路で揃える）', () => {
    expect(stripComments(read('image.js'))).toMatch(/image\/jpeg['"]\s*,\s*quality:\s*0\.92/);
  });
});
