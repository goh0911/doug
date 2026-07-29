// tests/unit/copy-sync.test.js
// content.js は chrome.scripting.executeScript で注入される Classic Script のため
// ES Module を import できず、pure 関数を「コピー」で持たざるを得ない。
// CLAUDE.md はこの同期を人手のチェックリストに任せているが、それでは食い違いを検出できない。
// ここで機械的に突き合わせ、片方だけ直した状態を CI（単体テスト）で落とす。
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** ソースから `function 名(...) { ... }` を波括弧の対応で切り出す */
function extractFunction(source, name) {
  const start = source.indexOf(`function ${name}(`);
  if (start === -1) return null;
  const open = source.indexOf('{', start);
  if (open === -1) return null;

  let depth = 0;
  for (let i = open; i < source.length; i++) {
    const ch = source[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  return null;
}

/** インデントとコメントの差を無視して比較できる形にする */
function normalize(src) {
  return src
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, '').trim())
    .filter((line) => line !== '')
    .join('\n');
}

// [関数名, モジュール側のパス, コピー側のパス]
const COPIES = [
  ['splitByTerms', 'utils/gloss-highlight.js', 'content.js'],
];

describe('content.js に置いた pure 関数のコピーが元と一致している', () => {
  for (const [name, modulePath, copyPath] of COPIES) {
    it(`${name}（${modulePath} ↔ ${copyPath}）`, () => {
      const moduleSrc = readFileSync(join(ROOT, modulePath), 'utf8');
      const copySrc = readFileSync(join(ROOT, copyPath), 'utf8');

      const original = extractFunction(moduleSrc, name);
      const copy = extractFunction(copySrc, name);

      expect(original, `${modulePath} に ${name} が見つからない`).not.toBeNull();
      expect(copy, `${copyPath} に ${name} のコピーが見つからない`).not.toBeNull();

      // 食い違ったらどちらかを直す。export キーワードの有無だけは差分として許容しない
      // （モジュール側は `export function` だが extractFunction は function から切り出す）
      expect(normalize(copy)).toBe(normalize(original));
    });
  }
});
