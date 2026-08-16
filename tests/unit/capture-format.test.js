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

// 縮小の上限はプロバイダで出し分ける。クラウドはトークン課金で画素数にほぼ比例して
// 費用が増える一方、Ollama はローカル実行で課金が無く、実測でもプリフィルは 0.1 秒の
// まま変わらなかった（1024→2048 で画像トークン 1127→3239）。
// 1024 への縮小は OCR 精度を落とす（実測: qwen3.6 が 1024px で 6/8、原寸で 8/8）。
describe('送信画像の解像度', () => {
  const src = () => stripComments(read('content.js'));

  it('上限の定義は 1 箇所にまとまっている（以前は 2 箇所に重複していた）', () => {
    expect(src()).not.toMatch(/const\s+MAX_DIM\s*=/);
    expect((src().match(/const MAX_DIM_CLOUD\s*=/g) || []).length).toBe(1);
    expect((src().match(/const MAX_DIM_LOCAL\s*=/g) || []).length).toBe(1);
  });

  it('クラウドは 1024 のまま（トークン課金が画素数に比例するため）', () => {
    expect(src()).toMatch(/MAX_DIM_CLOUD\s*=\s*1024/);
  });

  it('ローカルはモデルの上限 4194304 px を超えない値', () => {
    const m = src().match(/MAX_DIM_LOCAL\s*=\s*(\d+)/);
    expect(m).not.toBeNull();
    const dim = Number(m[1]);
    expect(dim).toBeGreaterThan(1024);
    // Ollama のログにある image_max_pixels: 4194304（＝2048×2048 相当）
    expect(dim * dim).toBeLessThanOrEqual(4194304);
  });

  it('プロバイダで出し分けている（既定はクラウド側に倒す）', () => {
    expect(src()).toMatch(/apiProvider\s*===\s*['"]ollama['"]\s*\?\s*MAX_DIM_LOCAL\s*:\s*MAX_DIM_CLOUD/);
    expect(src()).toMatch(/let captureMaxDim\s*=\s*MAX_DIM_CLOUD/);
  });
});
