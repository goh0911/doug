// tests/unit/glossary-substitute.test.js
import { describe, it, expect } from 'vitest';
import { substituteGlossaryTerms, applyGlossaryPostProcess } from '../../utils/glossary-substitute.js';

const G = (obj) => obj; // 可読性のためのヘルパ

describe('substituteGlossaryTerms - 基本', () => {
  it('原文に在席する approved 用語を訳語へ置換する', () => {
    const glossary = { Hulk: { translated: 'ハルク', approved: true } };
    const r = substituteGlossaryTerms('The Hulk smashed', 'The Hulk smashed', glossary);
    expect(r.text).toBe('The ハルク smashed');
    expect(r.hits).toBe(1);
  });

  it('同一語が複数回あれば全て置換し hits も増える', () => {
    const glossary = { Hulk: { translated: 'ハルク', approved: true } };
    const r = substituteGlossaryTerms('Hulk vs Hulk', 'Hulk vs Hulk', glossary);
    expect(r.text).toBe('ハルク vs ハルク');
    expect(r.hits).toBe(2);
  });
});

describe('substituteGlossaryTerms - ガード（逆翻訳衝突防止）', () => {
  it('原文に用語が無ければ訳文に出現しても置換しない', () => {
    const glossary = { Hulk: { translated: 'ハルク', approved: true } };
    // 原文に Hulk が無い → 置換対象にしない
    const r = substituteGlossaryTerms('a Hulk appears', 'something else', glossary);
    expect(r.text).toBe('a Hulk appears');
    expect(r.hits).toBe(0);
  });
});

describe('substituteGlossaryTerms - approved フィルタ', () => {
  it('approved:false は置換しない（エスケープハッチ）', () => {
    const glossary = { Hulk: { translated: 'ハルク', approved: false } };
    const r = substituteGlossaryTerms('The Hulk', 'The Hulk', glossary);
    expect(r.text).toBe('The Hulk');
    expect(r.hits).toBe(0);
  });

  it('approved 未指定は置換しない', () => {
    const glossary = { Hulk: { translated: 'ハルク' } };
    const r = substituteGlossaryTerms('The Hulk', 'The Hulk', glossary);
    expect(r.hits).toBe(0);
  });
});

describe('substituteGlossaryTerms - 部分一致と長い順ソート', () => {
  it('長い用語を優先し短い用語で壊さない', () => {
    const glossary = {
      Hulk: { translated: 'ハルク', approved: true },
      Hulkbuster: { translated: 'ハルクバスター', approved: true },
    };
    const src = 'Hulkbuster fights Hulk';
    const r = substituteGlossaryTerms(src, src, glossary);
    expect(r.text).toBe('ハルクバスター fights ハルク');
    expect(r.hits).toBe(2);
  });
});

describe('substituteGlossaryTerms - 冪等性（cache hit 再適用）', () => {
  it('2回適用しても結果が変わらない', () => {
    const glossary = { Hulk: { translated: 'ハルク', approved: true } };
    const src = 'The Hulk smashed Hulk';
    const r1 = substituteGlossaryTerms(src, src, glossary);
    // 2回目: 1回目の出力(訳文)を入力に。ガードは元の原文を使う想定だが冪等性のため同条件で再適用
    const r2 = substituteGlossaryTerms(r1.text, src, glossary);
    expect(r2.text).toBe(r1.text);
    expect(r2.hits).toBe(0); // 既に置換済みなので原文字列は残っていない
  });

  it('訳語が別用語の原文を含んでも連鎖置換しない', () => {
    // hero→ヒーロー, ヒー→X  : 1パスなので ヒーロー が ヒー で壊れない
    const glossary = {
      hero: { translated: 'ヒーロー', approved: true },
      'ヒー': { translated: 'X', approved: true },
    };
    const src = 'the hero ヒー';
    const r = substituteGlossaryTerms(src, src, glossary);
    // hero→ヒーロー（1パス）, 既存の ヒー→X。置換結果の「ヒーロー」内の「ヒー」は再走査されない
    expect(r.text).toBe('the ヒーロー X');
  });
});

describe('substituteGlossaryTerms - 正規表現エスケープ', () => {
  it('メタ文字を含む原文でも正しく置換する', () => {
    const glossary = { 'Dr.': { translated: '博士', approved: true } };
    const src = 'Dr. Banner';
    const r = substituteGlossaryTerms(src, src, glossary);
    expect(r.text).toBe('博士 Banner');
    expect(r.hits).toBe(1);
  });

  it('括弧等のメタ文字を含む原文', () => {
    const glossary = { 'A(B)': { translated: '訳', approved: true } };
    const src = 'A(B) here';
    const r = substituteGlossaryTerms(src, src, glossary);
    expect(r.text).toBe('訳 here');
  });
});

describe('substituteGlossaryTerms - case-sensitive', () => {
  it('大文字小文字を区別する', () => {
    const glossary = { Hulk: { translated: 'ハルク', approved: true } };
    const src = 'the hulk';
    const r = substituteGlossaryTerms(src, src, glossary);
    expect(r.text).toBe('the hulk'); // 'hulk' は 'Hulk' と一致しない
    expect(r.hits).toBe(0);
  });
});

describe('substituteGlossaryTerms - 境界条件', () => {
  it('glossary が空/undefined ならそのまま返す', () => {
    expect(substituteGlossaryTerms('abc', 'abc', {})).toEqual({ text: 'abc', hits: 0 });
    expect(substituteGlossaryTerms('abc', 'abc', undefined)).toEqual({ text: 'abc', hits: 0 });
  });

  it('translated が文字列でないならそのまま返す', () => {
    expect(substituteGlossaryTerms(null, 'abc', { x: { translated: 'y', approved: true } }))
      .toEqual({ text: null, hits: 0 });
  });
});

describe('applyGlossaryPostProcess', () => {
  it('translations 配列の各 translated に適用し totalHits を集計する', () => {
    const glossary = { Hulk: { translated: 'ハルク', approved: true } };
    const translations = [
      { original: 'Hulk!', translated: 'Hulk!', bbox: {}, type: 'speech' },
      { original: 'Bruce', translated: 'ブルース', bbox: {}, type: 'speech' },
    ];
    const r = applyGlossaryPostProcess(translations, glossary);
    expect(r.translations[0].translated).toBe('ハルク!');
    expect(r.translations[1].translated).toBe('ブルース'); // 変化なし
    expect(r.totalHits).toBe(1);
    // bbox/type など他フィールドは保持
    expect(r.translations[0].type).toBe('speech');
  });

  it('置換が無い要素は元のオブジェクト参照を保つ', () => {
    const glossary = { Zzz: { translated: 'X', approved: true } };
    const translations = [{ original: 'a', translated: 'b' }];
    const r = applyGlossaryPostProcess(translations, glossary);
    expect(r.translations[0]).toBe(translations[0]);
    expect(r.totalHits).toBe(0);
  });

  it('translations が配列でないならそのまま返す', () => {
    expect(applyGlossaryPostProcess(null, {})).toEqual({ translations: null, totalHits: 0 });
  });
});
