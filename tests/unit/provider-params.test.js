// tests/unit/provider-params.test.js
// OpenAI の Chat Completions と Anthropic の /v1/messages は、出力上限のパラメータ名が違う。
// GPT-5 系（推論モデル）は max_tokens を 400 で拒否し、max_completion_tokens を要求する。
// 一方 Claude は max_tokens が正で、一括置換すると今度は Claude が壊れる。
// 実 API を叩けない環境でも取り違えを検出できるよう、リクエストボディを静的に検査する。
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const source = readFileSync(join(ROOT, 'translate.js'), 'utf8');

/**
 * コメント（// 行・ブロック）を落とす。説明文中の語をパラメータ名と誤検出しないため。
 * `https://` の `//` を巻き込まないよう、直前が `:` のものは残す
 */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/**
 * 指定 URL を含む fetch 呼び出しの直後から、JSON.stringify で組み立てるボディを
 * 波括弧の対応で切り出す。translate.js は URL とボディが隣接して書かれている前提。
 */
function extractBodiesNear(src, urlFragment) {
  const clean = stripComments(src);
  const bodies = [];
  let searchFrom = 0;

  for (;;) {
    const hit = clean.indexOf(urlFragment, searchFrom);
    if (hit === -1) break;
    searchFrom = hit + urlFragment.length;

    const stringify = clean.indexOf('JSON.stringify({', hit);
    if (stringify === -1) continue;
    // 同じ呼び出しに属するボディだけを見る（次の URL 出現より手前）
    const nextHit = clean.indexOf(urlFragment, searchFrom);
    if (nextHit !== -1 && stringify > nextHit) continue;

    const open = clean.indexOf('{', stringify);
    let depth = 0;
    for (let i = open; i < clean.length; i++) {
      if (clean[i] === '{') depth++;
      else if (clean[i] === '}') {
        depth--;
        if (depth === 0) {
          bodies.push(clean.slice(open, i + 1));
          break;
        }
      }
    }
  }
  return bodies;
}

describe('プロバイダごとの出力上限パラメータ名', () => {
  it('OpenAI のリクエストボディは max_completion_tokens を使う（max_tokens は 400 になる）', () => {
    const bodies = extractBodiesNear(source, 'api.openai.com/v1/chat/completions');
    expect(bodies.length).toBe(2); // 画像翻訳と解説生成フォールバック

    for (const body of bodies) {
      expect(body).toMatch(/\bmax_completion_tokens\s*:/);
      expect(body).not.toMatch(/\bmax_tokens\s*:/);
    }
  });

  it('Anthropic のリクエストボディは max_tokens を使う（一括置換の巻き添えを防ぐ）', () => {
    const bodies = extractBodiesNear(source, 'api.anthropic.com/v1/messages');
    expect(bodies.length).toBe(2); // 画像翻訳と解説生成フォールバック

    for (const body of bodies) {
      expect(body).toMatch(/\bmax_tokens\s*:/);
      expect(body).not.toMatch(/\bmax_completion_tokens\s*:/);
    }
  });
});

/** callTextOnlyProvider の関数本体を波括弧の対応で切り出す */
function extractCallTextOnlyProvider(src) {
  const start = src.indexOf('function callTextOnlyProvider(');
  if (start === -1) return null;
  const open = src.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  return null;
}

describe('解説生成（callTextOnlyProvider）の応答処理', () => {
  const fn = extractCallTextOnlyProvider(source);

  it('関数を抽出できる（以降の検査の前提）', () => {
    expect(fn).toBeTruthy();
  });

  // 上限に達したプロバイダは本文を空文字で返すことがある。?? は空文字を素通りさせるため、
  // JSDoc の「失敗時は null」を破って空文字が解説パーサに流れ込む
  it('空文字を null に倒す（?? null が残っていない）', () => {
    expect(stripComments(fn)).not.toMatch(/\?\?\s*null/);
  });

  // 既定の qwen3.6 を含む thinking 対応モデルは答えを message.thinking に入れ、
  // content を空文字で返すことがある。content だけ見ると解説が一度も取れない
  it('Ollama は content だけでなく thinking も拾う', () => {
    expect(fn).toMatch(/pickOllamaResponseText\(\s*data\.message\s*\)/);
    expect(stripComments(fn)).not.toMatch(/data\.message\?\.content/);
  });

  // 解説は identity 110 字 + powers 150 字の日本語 JSON。本文だけで 512 をほぼ使い切るうえ、
  // Gemini Flash 系は thinking（既定 medium）もこの上限に乗る
  it('出力上限が 512 に戻っていない', () => {
    const limits = [...stripComments(fn).matchAll(/(?:maxOutputTokens|max_tokens|max_completion_tokens)\s*:\s*(\d+)/g)]
      .map(m => Number(m[1]));
    expect(limits.length).toBeGreaterThanOrEqual(3); // Gemini / Claude / OpenAI
    for (const n of limits) expect(n).toBeGreaterThan(512);
  });
});
