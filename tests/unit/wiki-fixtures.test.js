// tests/unit/wiki-fixtures.test.js
// 実記事（tests/fixtures/wiki-articles.json）に対する回帰テスト。
// 固定文字列のテストでは移管・共同出版や実際の導入文の揺れを再現できないため、
// en Wikipedia から一度だけ取得した本物の extract を突き合わせる（Codex レビュー指摘）。
// 再取得は不要。記事が書き換わっても、このフィクスチャに対する挙動が仕様。
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  extractIntro, extractPowers, passesGate, termAppearsIn, isExactTitleMatch, publisherConflicts,
  isDisambiguationPage,
} from '../../utils/wiki-source.js';

const F = JSON.parse(readFileSync(
  fileURLToPath(new URL('../fixtures/wiki-articles.json', import.meta.url)), 'utf8'
));

/** フィクスチャ 1 件をゲートに掛ける */
function gate(term, key, publisher) {
  const a = F[key];
  const intro = extractIntro(a.extract);
  const powers = extractPowers(a.extract);
  return passesGate({ term, title: a.title, intro, powers, publisher });
}

function introOf(key) {
  return extractIntro(F[key].extract);
}

describe('実記事フィクスチャ — 採用されるべき記事', () => {
  it.each([
    ['HULK', 'Hulk'],
    ['ROSS', 'Thunderbolt Ross'],
    ['S.H.I.E.L.D.', 'S.H.I.E.L.D.'],
    ['THE IMMORTAL HULK', 'Devil Hulk'],
  ])('%s → %s はゲートを通る（marvel 閲覧中）', (term, key) => {
    expect(gate(term, key, 'marvel')).toBe(true);
  });
});

describe('実記事フィクスチャ — 却下されるべき記事', () => {
  it('REGGIE → Reggie Mantle は別出版社なので却下（実機で誤表示された）', () => {
    expect(gate('REGGIE', 'Reggie Mantle', 'marvel')).toBe(false);
  });

  it('出版社を問わなければ Reggie Mantle は通ってしまう（却下の理由が出版社であることの確認）', () => {
    expect(gate('REGGIE', 'Reggie Mantle', null)).toBe(true);
  });
});

describe('実記事フィクスチャ — 出版社判定', () => {
  it.each([
    ['Hulk', 'marvel'],
    ['Thunderbolt Ross', 'marvel'],
    ['Brian Banner', 'marvel'],
    ['Iron Man', 'marvel'],
    ['S.H.I.E.L.D.', 'marvel'],
  ])('%s は marvel と矛盾しない', (key, pub) => {
    expect(publisherConflicts(introOf(key), pub, F[key].title)).toBe(false);
  });

  it('Reggie Mantle は marvel と矛盾する', () => {
    expect(publisherConflicts(introOf('Reggie Mantle'), 'marvel', 'Reggie Mantle')).toBe(true);
  });

  // Charlton 発 → 後に DC。実記事の導入節は "originally published by Charlton Comics" のみで
  // DC には触れないため、来歴と現在の帰属を区別しないと誤って却下する
  it('Peter Cannon, Thunderbolt は dc と矛盾しない（移管キャラクターの誤却下防止）', () => {
    const key = 'Peter Cannon, Thunderbolt';
    expect(introOf(key)).toContain('originally published by Charlton Comics');
    expect(publisherConflicts(introOf(key), 'dc', key)).toBe(false);
  });

  // 対照: 来歴ではなく現在の帰属として別出版社を名乗る記事は却下したままにする
  it('Reggie Mantle は現在形で Archie を名乗るので却下のまま', () => {
    expect(introOf('Reggie Mantle')).toContain('published by Archie Comics');
    expect(introOf('Reggie Mantle')).not.toContain('originally published by');
  });
});

describe('実記事フィクスチャ — 曖昧さ回避ページ', () => {
  // "Peter Cannon may refer to:" は出版社の記述を含むため /comic/ ゲートを通り得た
  it('曖昧さ回避ページを検出する', () => {
    expect(isDisambiguationPage(introOf('Peter Cannon'))).toBe(true);
    expect(isDisambiguationPage(introOf('Hulk'))).toBe(false);
  });

  it('曖昧さ回避ページはゲートを通らない', () => {
    expect(gate('PETER CANNON', 'Peter Cannon', null)).toBe(false);
  });
});

describe('termAppearsIn — タイトル単独一致を根拠にしない', () => {
  // 指摘（Codex）: タイトルに語が含まれるだけで通ると、記事の同一性の根拠にならない。
  // 実測の結果、タイトル経由で通っていた記事はすべて導入節でも裏付けが取れたため、
  // タイトル単独の一致は根拠から外す
  it.each([
    ['HULK', 'Hulk'],
    ['ROSS', 'Thunderbolt Ross'],
    ['S.H.I.E.L.D.', 'S.H.I.E.L.D.'],
  ])('%s は導入節だけでも裏付けが取れる（タイトルを潰しても通る）', (term, key) => {
    expect(termAppearsIn(term, 'ZZZZ', introOf(key))).toBe(true);
  });

  it('導入節に裏付けが無ければ、タイトルに語が含まれても通さない', () => {
    // 完全一致でないタイトルに語が含まれるだけのケース
    const intro = 'Something entirely unrelated appears in American comic books. '
      + 'It has nothing to do with the searched word at all, and runs long enough to pass the length gate.';
    expect(termAppearsIn('PARKER', 'Peter Parker', intro)).toBe(false);
  });

  it('タイトルが検索語そのものなら導入節の裏付けが無くても通す', () => {
    const intro = 'An entity that appears in American comic books, described here at sufficient length '
      + 'to satisfy the minimum introduction length required by the validation gate.';
    expect(isExactTitleMatch('VISION', 'Vision (Marvel Comics)')).toBe(true);
    expect(termAppearsIn('VISION', 'Vision (Marvel Comics)', intro)).toBe(true);
  });
});
