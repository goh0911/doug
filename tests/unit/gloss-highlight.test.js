// tests/unit/gloss-highlight.test.js
import { describe, it, expect } from 'vitest';
import { splitByTerms, findVisibleTerms } from '../../utils/gloss-highlight.js';

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

// 長い順の並べ替えが防げるのは「用語集どうしの包含」だけで、用語集に無い語への
// 食い込みは防げない。実測（Immortal Hulk 2018 の実ページ）で ROSS の訳語「ロス」が
// 「エマ・フロスト」に一致し、無関係な人物の解説が出る状態だった
describe('splitByTerms — より長いカタカナ語への食い込みを防ぐ', () => {
  it('用語集に無いカタカナ語の内側には一致しない（ロス が フロスト を割らない）', () => {
    const r = splitByTerms('エマ・フロスト、共同校長。', [T('ロス', 'ROSS')]);
    expect(r).toEqual([{ text: 'エマ・フロスト、共同校長。', key: null }]);
  });

  it('前がカタカナでも後ろがカタカナでも弾く', () => {
    expect(splitByTerms('スーパーハルク', [T('ハルク', 'Hulk')])[0].key).toBeNull();
    expect(splitByTerms('ハルクバスター', [T('ハルク', 'Hulk')])[0].key).toBeNull();
  });

  it('カタカナ以外に囲まれた正当な一致は従来どおり拾う', () => {
    expect(splitByTerms('ロクソン社の炉', [T('ロクソン', 'ROXXON')])[0].key).toBe('ROXXON');
    expect(splitByTerms('ハルクは強い', [T('ハルク', 'Hulk')])[0].key).toBe('Hulk');
    expect(splitByTerms('ソーよ、戻れ', [T('ソー', 'Thor')])[0].key).toBe('Thor');
    expect(splitByTerms('ハルク', [T('ハルク', 'Hulk')])[0].key).toBe('Hulk');
  });

  it('中黒で区切られた複合語は食い込みとみなさない', () => {
    expect(splitByTerms('エマ・フロスト', [T('エマ', 'EMMA')])[0].key).toBe('EMMA');
    expect(splitByTerms('トニー・スターク、別名', [T('トニー・スターク', 'TONY STARK')])[0].key).toBe('TONY STARK');
  });

  // 長い用語が登録されていれば従来どおりそちらが勝つ（既存の挙動を壊さない）
  it('用語集にある長い語は引き続き優先される', () => {
    const r = splitByTerms('ハルクバスター登場', [T('ハルク', 'Hulk'), T('ハルクバスター', 'Hulkbuster')]);
    expect(r[0]).toEqual({ text: 'ハルクバスター', key: 'Hulkbuster' });
  });

  // カタカナ以外（英字・漢字）の用語は対象外。S.H.I.E.L.D. のような語を巻き込まない
  it('カタカナを含まない用語には適用しない', () => {
    expect(splitByTerms('ROXXONCORP', [T('ROXXON', 'ROXXON')])[0].key).toBe('ROXXON');
  });

  it('弾いた場合も連結すると元の文字列に戻る', () => {
    const src = 'エマ・フロストとハルクバスター';
    expect(splitByTerms(src, [T('ロス', 'ROSS'), T('ハルク', 'Hulk')]).map((p) => p.text).join('')).toBe(src);
  });
});

// 「解説を要求する語」と「下線になる語」がずれると、表示されない解説の生成に
// Wikipedia 取得と API 課金だけが発生する。両者を同じ物差しに固定する
describe('findVisibleTerms', () => {
  it('訳文に現れた用語の key を返す', () => {
    const found = findVisibleTerms('ハルクとソーが戦う', [T('ハルク', 'Hulk'), T('ソー', 'Thor'), T('エルフ', 'Elves')]);
    expect([...found].sort()).toEqual(['Hulk', 'Thor']);
  });

  it('splitByTerms が弾く食い込みは要求しない（ロス／フロスト）', () => {
    expect(findVisibleTerms('エマ・フロスト、共同校長。', [T('ロス', 'ROSS')]).size).toBe(0);
  });

  it('splitByTerms の結果と必ず一致する', () => {
    const text = 'エマ・フロストとハルクバスターとロクソン社';
    const terms = [T('ロス', 'ROSS'), T('ハルク', 'Hulk'), T('ロクソン', 'ROXXON')];
    const fromSplit = new Set(splitByTerms(text, terms).map((p) => p.key).filter(Boolean));
    expect(findVisibleTerms(text, terms)).toEqual(fromSplit);
  });

  it('訳語が重複する用語は 1 つに畳まれる（解説の二重生成を防ぐ）', () => {
    const found = findVisibleTerms('ロクソン社', [T('ロクソン', 'ROXXON'), T('ロクソン', 'Roxxon')]);
    expect(found.size).toBe(1);
  });

  it('空文字・一致なしは空集合', () => {
    expect(findVisibleTerms('', [T('ハルク', 'Hulk')]).size).toBe(0);
    expect(findVisibleTerms('本文', [T('ハルク', 'Hulk')]).size).toBe(0);
  });
});
