// tests/unit/glossary-union.test.js
import { describe, it, expect } from 'vitest';
import { mergeGlossaries, mergeGlossDefs, findDef } from '../../utils/glossary-union.js';

const CUR = 'hulk';
const term = (translated, addedAt = 1) => ({ translated, approved: false, addedAt });
const def = (identity, at = 1) => ({ identity, powers: 'P。', url: 'https://x/', source: 'en-wikipedia', at });

describe('mergeGlossaries', () => {
  it('別シリーズの語も引けるようにする（これが機能の目的）', () => {
    const r = mergeGlossaries([
      { seriesId: 'hulk', seriesName: 'Immortal Hulk', map: { HULK: term('ハルク') } },
      { seriesId: 'cw', seriesName: 'Civil War', map: { 'TONY STARK': term('トニー・スターク') } },
    ], CUR);
    expect(Object.keys(r).sort()).toEqual(['HULK', 'TONY STARK']);
  });

  it('出どころのシリーズを保持する（解説生成で作品名を使うため）', () => {
    const r = mergeGlossaries([
      { seriesId: 'cw', seriesName: 'Civil War', map: { 'TONY STARK': term('トニー・スターク') } },
    ], CUR);
    expect(r['TONY STARK'].seriesId).toBe('cw');
    expect(r['TONY STARK'].seriesName).toBe('Civil War');
  });

  it('衝突したらいま読んでいるシリーズが勝つ', () => {
    const r = mergeGlossaries([
      { seriesId: 'cw', map: { HULK: term('ハルク（他作品訳）', 999) } },
      { seriesId: 'hulk', map: { HULK: term('ハルク', 1) } },
    ], CUR);
    expect(r.HULK.translated).toBe('ハルク');
    expect(r.HULK.seriesId).toBe('hulk');
  });

  it('どちらも他シリーズなら addedAt が新しい方', () => {
    const r = mergeGlossaries([
      { seriesId: 'a', map: { DOOM: term('古い訳', 100) } },
      { seriesId: 'b', map: { DOOM: term('新しい訳', 200) } },
    ], CUR);
    expect(r.DOOM.translated).toBe('新しい訳');
  });

  it('大文字小文字だけ違う原語は 1 つに畳む', () => {
    const r = mergeGlossaries([
      { seriesId: 'a', map: { ROXXON: term('ロクソン', 100) } },
      { seriesId: 'b', map: { Roxxon: term('ロクソン', 200) } },
    ], CUR);
    expect(Object.keys(r)).toHaveLength(1);
  });

  it('入力順が変わっても結果が変わらない（下線の揺れを防ぐ）', () => {
    const a = { seriesId: 'a', map: { X: term('えっくす', 5) } };
    const b = { seriesId: 'b', map: { Y: term('わい', 5) } };
    const c = { seriesId: 'c', map: { X: term('エックス', 5) } };
    expect(mergeGlossaries([a, b, c], CUR)).toEqual(mergeGlossaries([c, b, a], CUR));
  });

  it('訳語が空・不正なエントリは落とす', () => {
    const r = mergeGlossaries([
      { seriesId: 'a', map: { A: { translated: '' }, B: null, C: term('しー') } },
    ], CUR);
    expect(Object.keys(r)).toEqual(['C']);
  });

  it('不正な入力でも例外を投げない', () => {
    expect(mergeGlossaries(null, CUR)).toEqual({});
    expect(mergeGlossaries([null, {}, { seriesId: 'a' }], CUR)).toEqual({});
  });
});

describe('mergeGlossDefs', () => {
  it('別シリーズで作った解説を引ける（作り直さないための土台）', () => {
    const r = mergeGlossDefs([
      { seriesId: 'cw', map: { 'TONY STARK': def('トニー・スタークは…') } },
    ], CUR);
    expect(r['TONY STARK'].identity).toBe('トニー・スタークは…');
  });

  it('いま読んでいるシリーズの解説が優先される', () => {
    const r = mergeGlossDefs([
      { seriesId: 'cw', map: { HULK: def('他作品版', 999) } },
      { seriesId: 'hulk', map: { HULK: def('自作品版', 1) } },
    ], CUR);
    expect(r.HULK.identity).toBe('自作品版');
  });

  it('どちらも他シリーズなら at が新しい方', () => {
    const r = mergeGlossDefs([
      { seriesId: 'a', map: { DOOM: def('古い', 100) } },
      { seriesId: 'b', map: { DOOM: def('新しい', 200) } },
    ], CUR);
    expect(r.DOOM.identity).toBe('新しい');
  });

  // 失敗を横断させないと、記事が存在しない語を作品ごとに 24 時間おきに引き直すことになる
  it('失敗エントリも畳む（別シリーズでの再試行を抑えるため）', () => {
    const r = mergeGlossDefs([
      { seriesId: 'a', map: { 'SHOCK ROXX RADIO': { failed: true, at: 500, sources: '4:en-wikipedia' } } },
    ], CUR);
    expect(r['SHOCK ROXX RADIO'].failed).toBe(true);
    expect(r['SHOCK ROXX RADIO'].sources).toBe('4:en-wikipedia');
  });

  // 自シリーズ優先を無条件にすると、「自シリーズでは失敗・他シリーズでは成功」の語で
  // 失敗が勝ち、良い解説があるのにポップアップが出なくなる。成功を先に見る
  it('成功は失敗より優先される（シリーズより先に見る）', () => {
    const r = mergeGlossDefs([
      { seriesId: 'hulk', map: { DOOM: { failed: true, at: 999 } } },      // 自シリーズ・新しい失敗
      { seriesId: 'cw', map: { DOOM: def('ドゥームは…', 1) } },            // 他シリーズ・古い成功
    ], CUR);
    expect(r.DOOM.identity).toBe('ドゥームは…');
    expect(r.DOOM.failed).toBeUndefined();
  });

  it('どちらも失敗なら従来どおり自シリーズが勝つ', () => {
    const r = mergeGlossDefs([
      { seriesId: 'hulk', map: { X: { failed: true, at: 1, sources: '4:own' } } },
      { seriesId: 'cw', map: { X: { failed: true, at: 999, sources: '4:foreign' } } },
    ], CUR);
    expect(r.X.sources).toBe('4:own');
  });

  it('at を持たないエントリは無視する（isUsable が判定できないため）', () => {
    const r = mergeGlossDefs([{ seriesId: 'a', map: { X: { identity: 'あ' } } }], CUR);
    expect(r).toEqual({});
  });

  it('入力順が変わっても結果が変わらない', () => {
    const a = { seriesId: 'a', map: { X: def('あ', 5) } };
    const b = { seriesId: 'b', map: { X: def('い', 5) } };
    expect(mergeGlossDefs([a, b], CUR)).toEqual(mergeGlossDefs([b, a], CUR));
  });

  it('不正な入力でも例外を投げない', () => {
    expect(mergeGlossDefs(undefined, CUR)).toEqual({});
    expect(mergeGlossDefs([{ seriesId: 'a', map: { X: null } }], CUR)).toEqual({});
  });
});

// mergeGlossaries は大小文字を畳むのに mergeGlossDefs は完全一致でしか引かない、という
// 食い違いがあった（Codex 指摘）。用語集が ROXXON に畳まれた一方で解説が Roxxon に
// 紐づいていると再利用できず、既にある解説を作り直す（取得と課金の無駄）
describe('findDef — 用語集の畳み方と解説の引き方を揃える', () => {
  const e = (identity) => ({ identity, at: 1 });

  it('完全一致はそのまま引ける', () => {
    expect(findDef({ ROXXON: e('ロクソン') }, 'ROXXON').identity).toBe('ロクソン');
  });

  it('★大小文字だけ違う解説も引ける（用語集は畳まれるため）', () => {
    expect(findDef({ Roxxon: e('ロクソン') }, 'ROXXON').identity).toBe('ロクソン');
    expect(findDef({ ROXXON: e('ロクソン') }, 'roxxon').identity).toBe('ロクソン');
  });

  it('完全一致を大小文字違いより優先する', () => {
    const defs = { Roxxon: e('小文字側'), ROXXON: e('完全一致側') };
    expect(findDef(defs, 'ROXXON').identity).toBe('完全一致側');
  });

  it('候補が複数あるときも決定的に選ぶ', () => {
    const a = findDef({ Roxxon: e('A'), roxxon: e('B') }, 'ROXXON');
    const b = findDef({ roxxon: e('B'), Roxxon: e('A') }, 'ROXXON');
    expect(a.identity).toBe(b.identity);
  });

  it('失敗エントリも引ける（別シリーズでの再試行抑制に必要）', () => {
    expect(findDef({ Roxxon: { failed: true, at: 1 } }, 'ROXXON').failed).toBe(true);
  });

  it('無ければ undefined。不正な入力でも例外を投げない', () => {
    expect(findDef({ A: e('あ') }, 'B')).toBeUndefined();
    expect(findDef(null, 'A')).toBeUndefined();
    expect(findDef({ A: e('あ') }, null)).toBeUndefined();
  });
});
