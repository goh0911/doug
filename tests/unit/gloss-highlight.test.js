// tests/unit/gloss-highlight.test.js
import { describe, it, expect } from 'vitest';
import { splitByTerms } from '../../utils/gloss-highlight.js';

const T = (match, key) => ({ match, key });

describe('splitByTerms', () => {
  it('用語の前後をテキスト片に分ける', () => {
    const r = splitByTerms('これはハルクだ', [T('ハルク', 'Hulk')]);
    expect(r).toEqual([
      { text: 'これは', key: null },
      { text: 'ハルク', key: 'Hulk' },
      { text: 'だ', key: null },
    ]);
  });

  it('原語キーを返す（訳語ではなく）', () => {
    const r = splitByTerms('ハルク', [T('ハルク', 'Hulk')]);
    expect(r[0].key).toBe('Hulk');
  });

  it('同じ用語が複数回現れても全て分割する', () => {
    const r = splitByTerms('ハルク対ハルク', [T('ハルク', 'Hulk')]);
    expect(r.filter((p) => p.key === 'Hulk')).toHaveLength(2);
  });

  // 長い順に走査しないと ハルクバスター が ハルク で誤爆する
  it('部分一致の誤爆を避け、長い用語を優先する', () => {
    const r = splitByTerms('ハルクバスター登場', [T('ハルク', 'Hulk'), T('ハルクバスター', 'Hulkbuster')]);
    expect(r[0]).toEqual({ text: 'ハルクバスター', key: 'Hulkbuster' });
    expect(r[1]).toEqual({ text: '登場', key: null });
  });

  it('正規表現メタ文字を含む用語をリテラルとして扱う', () => {
    const r = splitByTerms('A.B が来た', [T('A.B', 'A.B')]);
    expect(r[0]).toEqual({ text: 'A.B', key: 'A.B' });
    expect(splitByTerms('AXB が来た', [T('A.B', 'A.B')])[0].key).toBeNull();
  });

  it('用語が 0 件なら全文を 1 片で返す', () => {
    expect(splitByTerms('本文', [])).toEqual([{ text: '本文', key: null }]);
  });

  it('用語が本文に現れなければ全文を 1 片で返す', () => {
    expect(splitByTerms('本文', [T('ハルク', 'Hulk')])).toEqual([{ text: '本文', key: null }]);
  });

  it('空文字・非文字列は空配列', () => {
    expect(splitByTerms('', [T('A', 'A')])).toEqual([]);
    expect(splitByTerms(null, [T('A', 'A')])).toEqual([]);
  });

  it('不正な terms を無視する', () => {
    const r = splitByTerms('ハルク', [null, T('', 'X'), { match: 'ハルク' }, T('ハルク', 'Hulk')]);
    expect(r).toEqual([{ text: 'ハルク', key: 'Hulk' }]);
  });

  it('分割結果を連結すると元の文字列に戻る', () => {
    const src = 'ハルクとソーとハルクバスター';
    const terms = [T('ハルク', 'Hulk'), T('ソー', 'Thor'), T('ハルクバスター', 'Hulkbuster')];
    expect(splitByTerms(src, terms).map((p) => p.text).join('')).toBe(src);
  });
});
