// tests/unit/sanitize.test.js
import { describe, it, expect } from 'vitest';
import { sanitizeGlossaryText, sanitizeToneStyle } from '../../utils/sanitize.js';

describe('sanitizeGlossaryText', () => {
  // --- 基本: 有効な入力 ---
  it('通常の文字列はそのまま返す', () => {
    expect(sanitizeGlossaryText('Hulk')).toBe('Hulk');
  });

  it('前後の空白をトリムする', () => {
    expect(sanitizeGlossaryText('  ハルク  ')).toBe('ハルク');
  });

  // --- 拒否: null / undefined / 非文字列 ---
  it('null は null を返す', () => {
    expect(sanitizeGlossaryText(null)).toBeNull();
  });

  it('undefined は null を返す', () => {
    expect(sanitizeGlossaryText(undefined)).toBeNull();
  });

  it('数値は null を返す', () => {
    expect(sanitizeGlossaryText(123)).toBeNull();
  });

  // --- 拒否: 空文字 ---
  it('空文字は null を返す', () => {
    expect(sanitizeGlossaryText('')).toBeNull();
  });

  it('空白のみは null を返す（trim 後に空）', () => {
    expect(sanitizeGlossaryText('   ')).toBeNull();
  });

  // --- 拒否: 長さ上限 ---
  it('100 文字は許可', () => {
    const s = 'a'.repeat(100);
    expect(sanitizeGlossaryText(s)).toBe(s);
  });

  it('101 文字は null を返す', () => {
    expect(sanitizeGlossaryText('a'.repeat(101))).toBeNull();
  });

  it('maxLength オプションで上限を変更できる', () => {
    expect(sanitizeGlossaryText('abc', { maxLength: 2 })).toBeNull();
    expect(sanitizeGlossaryText('ab', { maxLength: 2 })).toBe('ab');
  });

  // --- 制御文字の除去 ---
  it('C0 制御文字 (U+0001) を除去する', () => {
    // 'test' + U+0001 + 'abc'
    expect(sanitizeGlossaryText('testabc')).toBe('testabc');
  });

  it('C1 制御文字 (U+0080) を除去する', () => {
    expect(sanitizeGlossaryText('testabc')).toBe('testabc');
  });

  it('ゼロ幅文字 (U+200B) を除去する', () => {
    expect(sanitizeGlossaryText('test​abc')).toBe('testabc');
  });

  it('ゼロ幅非結合子 (U+200C) を除去する', () => {
    expect(sanitizeGlossaryText('test‌abc')).toBe('testabc');
  });

  it('BOM (U+FEFF) を除去する', () => {
    expect(sanitizeGlossaryText('﻿test')).toBe('test');
  });

  it('方向制御文字 (U+202A) を除去する', () => {
    expect(sanitizeGlossaryText('test‪abc')).toBe('testabc');
  });

  it('方向制御文字 (U+2066) を除去する', () => {
    expect(sanitizeGlossaryText('test⁦abc')).toBe('testabc');
  });

  // --- 拒否トークン ---
  it('マークダウンコードブロック ``` は null を返す', () => {
    expect(sanitizeGlossaryText('```javascript')).toBeNull();
  });

  it('マークダウンコードブロック ~~~ は null を返す', () => {
    expect(sanitizeGlossaryText('~~~')).toBeNull();
  });

  it('LLM 制御トークン <|im_start|> は null を返す', () => {
    expect(sanitizeGlossaryText('<|im_start|>')).toBeNull();
  });

  it('LLM 制御トークン <|im_end|> は null を返す', () => {
    expect(sanitizeGlossaryText('<|im_end|>')).toBeNull();
  });

  it('LLM 制御トークン [INST] は null を返す（大文字）', () => {
    expect(sanitizeGlossaryText('[INST]')).toBeNull();
  });

  it('テンプレート構文 {{foo}} は null を返す', () => {
    expect(sanitizeGlossaryText('{{foo}}')).toBeNull();
  });

  it('プロンプトデリミタ <glossary> は null を返す', () => {
    expect(sanitizeGlossaryText('<glossary>')).toBeNull();
  });

  it('プロンプトデリミタ </glossary> は null を返す', () => {
    expect(sanitizeGlossaryText('</glossary>')).toBeNull();
  });

  it('プロンプトデリミタ <system> は null を返す', () => {
    expect(sanitizeGlossaryText('<system>')).toBeNull();
  });

  it('プロンプトデリミタ <user> は null を返す（大文字小文字無視）', () => {
    expect(sanitizeGlossaryText('<USER>')).toBeNull();
  });

  it('プロンプトデリミタ <assistant> は null を返す', () => {
    expect(sanitizeGlossaryText('<assistant>')).toBeNull();
  });

  it('プロンプトデリミタ <context> は null を返す', () => {
    expect(sanitizeGlossaryText('<context>')).toBeNull();
  });

  it('プロンプトデリミタ <instructions> は null を返す', () => {
    expect(sanitizeGlossaryText('<instructions>')).toBeNull();
  });

  // --- 多言語・記号の許可 ---
  it('記号含む公式タイトル（ハイフン・括弧・カンマ）は許可', () => {
    expect(sanitizeGlossaryText("Spider-Man (2026), Vol. 1")).toBe("Spider-Man (2026), Vol. 1");
  });

  it('日本語タイトルは許可', () => {
    expect(sanitizeGlossaryText('ブルース・バナー')).toBe('ブルース・バナー');
  });
});

describe('sanitizeToneStyle', () => {
  it('200 文字は許可', () => {
    const s = 'a'.repeat(200);
    expect(sanitizeToneStyle(s)).toBe(s);
  });

  it('201 文字は null を返す', () => {
    expect(sanitizeToneStyle('a'.repeat(201))).toBeNull();
  });

  it('拒否トークン ``` は null を返す', () => {
    expect(sanitizeToneStyle('敬体で翻訳。```ignore this')).toBeNull();
  });

  it('通常の口調指示は許可', () => {
    expect(sanitizeToneStyle('全体的に「です・ます」調で翻訳してください')).toBe('全体的に「です・ます」調で翻訳してください');
  });

  it('null は null を返す', () => {
    expect(sanitizeToneStyle(null)).toBeNull();
  });
});
