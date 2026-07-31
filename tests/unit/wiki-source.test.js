// tests/unit/wiki-source.test.js
import { describe, it, expect } from 'vitest';
import {
  WIKIPEDIA_ORIGIN, buildSearchUrl, parseSearchResponse,
  extractIntro, extractPowers, passesGate, termAppearsIn, isExactTitleMatch, buildPageUrl,
  expectedPublisher, publisherConflicts,
} from '../../utils/wiki-source.js';

describe('buildSearchUrl', () => {
  it('原語とシリーズ名を検索クエリに組み込む', () => {
    const url = buildSearchUrl('Nightcrawler', 'X-Men');
    expect(url).toContain('generator=search');
    expect(url).toContain('gsrlimit=1');
    expect(url).toContain('explaintext=1');
    expect(decodeURIComponent(url)).toContain('"Nightcrawler" X-Men comics');
  });

  it('シリーズ名が無くても comics を付けて検索する', () => {
    expect(decodeURIComponent(buildSearchUrl('Vision', ''))).toContain('"Vision" comics');
  });

  it('原語に含まれる二重引用符を除去してクエリを壊さない', () => {
    expect(decodeURIComponent(buildSearchUrl('He"llo', 'X'))).toContain('"Hello" X comics');
  });

  it('原語が空なら null を返す', () => {
    expect(buildSearchUrl('', 'X-Men')).toBeNull();
    expect(buildSearchUrl('   ', 'X-Men')).toBeNull();
    expect(buildSearchUrl(null, 'X-Men')).toBeNull();
  });
});

describe('parseSearchResponse', () => {
  it('pages の先頭から title と extract を取り出す', () => {
    const json = { query: { pages: { '123': { title: 'Vision (Marvel Comics)', extract: 'body' } } } };
    expect(parseSearchResponse(json)).toEqual({ title: 'Vision (Marvel Comics)', extract: 'body' });
  });

  it('ヒットが無ければ null（検索ミス時 query 自体が無い）', () => {
    expect(parseSearchResponse({ batchcomplete: '' })).toBeNull();
    expect(parseSearchResponse({ query: {} })).toBeNull();
    expect(parseSearchResponse(null)).toBeNull();
  });

  it('extract が欠けていれば null', () => {
    expect(parseSearchResponse({ query: { pages: { '1': { title: 'X' } } } })).toBeNull();
  });
});

const ARTICLE = [
  'The Vision is a superhero appearing in American comic books published by Marvel Comics.',
  '',
  '== Publication history ==',
  'Created by Roy Thomas.',
  '',
  '== Powers and abilities ==',
  "The Vision's android body is a replica of a human body.",
  '',
  '=== Density control ===',
  'He can alter his density at will.',
  '',
  '== In other media ==',
  'Appears in the MCU.',
].join('\n');

describe('extractIntro', () => {
  it('最初の見出しまでを導入節として返す', () => {
    expect(extractIntro(ARTICLE)).toBe(
      'The Vision is a superhero appearing in American comic books published by Marvel Comics.'
    );
  });

  it('見出しが1つも無ければ全文を返す', () => {
    expect(extractIntro('no headings here')).toBe('no headings here');
  });

  it('文字列でなければ空文字', () => {
    expect(extractIntro(null)).toBe('');
  });
});

describe('extractPowers', () => {
  it('能力節を次の同深度見出しまで抽出する', () => {
    const p = extractPowers(ARTICLE);
    expect(p).toContain('android body is a replica');
    expect(p).not.toContain('Appears in the MCU');
  });

  // R-W2''：深さを無視すると小見出しで終端して本文0字になる（Moon Knight / Sentry の実測不具合）
  it('より深い小見出しは終端にせず、その本文を含める（見出し行自体は落とす）', () => {
    const p = extractPowers(ARTICLE);
    // R-W2'': 深い見出しで打ち切らない。本文が残っていることで確認する
    expect(p).toContain('alter his density');
    // 見出しのマークアップは解説に出さない
    expect(p).not.toContain('=== Density control ===');
    expect(p).not.toMatch(/^={2,6}/m);
  });

  it('見出しの揺れ（Powers, abilities, and resources）も拾う', () => {
    const a = '== Powers, abilities, and resources ==\nZatanna speaks backwards.\n\n== Legacy ==\nx';
    expect(extractPowers(a)).toBe('Zatanna speaks backwards.');
  });

  it('能力節の中の小見出しを落とす（実機で "==== ブーリス・バナー ====" が解説に出た）', () => {
    const a = [
      '== Powers and abilities ==',
      '',
      '==== Bruce Banner ====',
      'Bruce is considered one of the greatest minds.',
      '',
      '==== The Hulk ====',
      'The Hulk has limitless strength.',
      '',
      '== Reception ==',
      'Good.',
    ].join('\n');
    const powers = extractPowers(a);
    expect(powers).not.toMatch(/^={2,6}/m);
    expect(powers).toBe('Bruce is considered one of the greatest minds.\n\nThe Hulk has limitless strength.');
  });

  it('能力節が無ければ空文字', () => {
    expect(extractPowers('== History ==\nnothing here')).toBe('');
  });
});

describe('termAppearsIn', () => {
  it('記号の違いを吸収してタイトルと照合する（S.H.I.E.L.D. / SHIELD）', () => {
    expect(termAppearsIn('S.H.I.E.L.D.', 'S.H.I.E.L.D.', 'x')).toBe(true);
    expect(termAppearsIn('SPIDER-MAN', 'Spider-Man', 'x')).toBe(true);
  });

  it('曖昧さ回避の括弧を無視する（Vision → Vision (Marvel Comics)）', () => {
    expect(termAppearsIn('VISION', 'Vision (Marvel Comics)', 'x')).toBe(true);
  });

  it('タイトルが別名でも導入節に語があれば通す（Red Hulk → Thunderbolt Ross）', () => {
    const intro = 'Thunderbolt Ross is a character who later became the Red Hulk.';
    expect(termAppearsIn('RED HULK', 'Thunderbolt Ross', intro)).toBe(true);
  });

  // 実機で取得した Absorbing Man の導入節そのもの。2 段落目の
  // "Agents of S.H.I.E.L.D."（映像化作品）に一致して素通りしていた
  const ABSORBING_MAN_INTRO = [
    'Absorbing Man (Carl "Crusher" Creel) is a character appearing in American comic books published by Marvel Comics. Carl Creel has the power to absorb and become any material he touched.',
    'He appears in the Marvel Cinematic Universe TV series Agents of S.H.I.E.L.D., portrayed by Brian Patrick Wade.',
  ].join('\n');

  it('無関係な記事は落とす（実測: S.H.I.E.L.D. → Absorbing Man）', () => {
    expect(termAppearsIn('S.H.I.E.L.D.', 'Absorbing Man', ABSORBING_MAN_INTRO)).toBe(false);
  });

  it('2 段落目の関連作品に一致しない（照合は最初の段落まで）', () => {
    expect(termAppearsIn('AGENTS OF SHIELD', 'Absorbing Man', ABSORBING_MAN_INTRO)).toBe(false);
  });

  it('最初の段落にある別名は拾う', () => {
    expect(termAppearsIn('CRUSHER CREEL', 'Absorbing Man', ABSORBING_MAN_INTRO)).toBe(true);
  });

  it('語境界を要求する（shield が shielded に一致しない）', () => {
    const intro = 'The hero is heavily shielded against comic book radiation in this story.';
    expect(termAppearsIn('S.H.I.E.L.D.', 'Some Hero', intro)).toBe(false);
  });

  it('無関係な記事は落とす（実測: Gamma Base → Betty Ross）', () => {
    const intro = 'Betty Ross is a character appearing in American comic books published by Marvel.';
    expect(termAppearsIn('GAMMA BASE', 'Betty Ross', intro)).toBe(false);
  });

  it('記号を落とすと一般名詞に化ける語は元表記で照合する（リリース前レビュー指摘）', () => {
    // S.H.I.E.L.D. を shield に正規化して導入節と照合すると、盾の記述に一致してしまう
    const capAm = 'Captain America is a superhero appearing in American comic books. '
      + 'He uses a nearly indestructible shield.';
    expect(termAppearsIn('S.H.I.E.L.D.', 'Captain America', capAm)).toBe(false);

    const shield = 'S.H.I.E.L.D. is a fictional espionage agency appearing in American comic books.';
    expect(termAppearsIn('S.H.I.E.L.D.', 'S.H.I.E.L.D.', shield)).toBe(true);
  });

  it('ハイフンを含む語も元表記で導入節と照合する', () => {
    const spidey = 'Peter Parker, also known as Spider-Man, is a superhero in American comic books.';
    expect(termAppearsIn('SPIDER-MAN', 'Peter Parker', spidey)).toBe(true);
    expect(termAppearsIn('SPIDER-MAN', 'Peter Parker', 'Peter Parker is a photographer.')).toBe(false);
  });

  it('空の語は照合しない', () => {
    expect(termAppearsIn('', 'Anything', 'anything')).toBe(false);
    expect(termAppearsIn(null, 'Anything', 'anything')).toBe(false);
  });
});

describe('passesGate（設計書 §1.2）', () => {
  const comicIntro = 'Vision is a superhero appearing in American comic books published by Marvel Comics.';

  it('能力節あり＋導入に comic ＋記事が一致 → 通す', () => {
    expect(passesGate({
      term: 'VISION', title: 'Vision (Marvel Comics)', intro: comicIntro, powers: 'teleports',
    })).toBe(true);
  });

  it('能力節が無くても通す（組織・場所を解説するため）', () => {
    const shieldIntro = 'S.H.I.E.L.D. is a fictional espionage agency appearing in American comic books.';
    expect(passesGate({
      term: 'S.H.I.E.L.D.', title: 'S.H.I.E.L.D.', intro: shieldIntro, powers: '',
    })).toBe(true);
  });

  it('記事が検索語と対応しない → 落とす（実測の誤取得を再現）', () => {
    const absorbing = 'The Absorbing Man is a supervillain appearing in American comic books published by Marvel.';
    expect(passesGate({
      term: 'S.H.I.E.L.D.', title: 'Absorbing Man', intro: absorbing, powers: 'absorbs matter',
    })).toBe(false);
  });

  it('導入に comic が無い → 落とす（実在の地名などを引いた場合）', () => {
    const valley = 'Death Valley is a desert valley in Eastern California, in the northern Mojave Desert.';
    expect(passesGate({
      term: 'DEATH VALLEY', title: 'Death Valley', intro: valley, powers: '',
    })).toBe(false);
  });

  it('導入節が短すぎるスタブ記事 → 落とす', () => {
    expect(passesGate({
      term: 'X', title: 'X', intro: 'X is a comic.', powers: 'y',
    })).toBe(false);
  });

  // 実機（Immortal Hulk #21）で誤採用された組み合わせ。すべて落とすこと
  it.each([
    ['RED HULK', 'List of Hulk titles',
      'This is a list of comics titles featuring the Hulk, published by Marvel Comics. The Red Hulk appears in several.'],
    ['UNITED STATES MILITARY', 'Father Time (Marvel Comics)',
      'Father Time is a fictional character appearing in American comic books published by Marvel Comics, who served in the United States military.'],
    ['HULK', 'The Incredible Hulk (comic book)',
      'The Incredible Hulk is an ongoing comic book series featuring the Marvel Comics character the Hulk.'],
  ])('実測の誤採用を落とす: %s → %s', (term, title, intro) => {
    expect(passesGate({ term, title, intro, powers: 'x' })).toBe(false);
  });

  it.each([
    ['S.H.I.E.L.D.', 'S.H.I.E.L.D.',
      'S.H.I.E.L.D. is a fictional espionage agency appearing in American comic books published by Marvel Comics.'],
    ['ROSS', 'Thunderbolt Ross',
      'Lieutenant General Thaddeus E. "Thunderbolt" Ross is a character appearing in American comic books published by Marvel Comics.'],
    ['VISION', 'Vision (Marvel Comics)',
      'Vision is a superhero appearing in American comic books published by Marvel Comics. He is an android.'],
  ])('正しい記事は通す: %s → %s', (term, title, intro) => {
    expect(passesGate({ term, title, intro, powers: 'x' })).toBe(true);
  });

  it('引数が不正でも例外を投げず false', () => {
    expect(passesGate({})).toBe(false);
    expect(passesGate(null)).toBe(false);
  });
});

describe('isExactTitleMatch（同姓の別人を避けるための優先度判定）', () => {
  it('タイトルが検索語そのものなら true', () => {
    expect(isExactTitleMatch('S.H.I.E.L.D.', 'S.H.I.E.L.D.')).toBe(true);
    expect(isExactTitleMatch('VISION', 'Vision (Marvel Comics)')).toBe(true);
  });

  it('姓だけ一致する別人は false（実機: BANNER → Brian Banner）', () => {
    expect(isExactTitleMatch('BANNER', 'Brian Banner')).toBe(false);
    expect(isExactTitleMatch('ROSS', 'Thunderbolt Ross')).toBe(false);
  });

  it('空の語は false', () => {
    expect(isExactTitleMatch('', 'Anything')).toBe(false);
  });
});

describe('buildPageUrl', () => {
  it('空白をアンダースコアにして出典 URL を作る', () => {
    expect(buildPageUrl('Vision (Marvel Comics)'))
      .toBe('https://en.wikipedia.org/wiki/Vision_(Marvel_Comics)');
  });
});

describe('WIKIPEDIA_ORIGIN', () => {
  it('permissions.request に渡せる形式', () => {
    expect(WIKIPEDIA_ORIGIN).toBe('https://en.wikipedia.org/*');
  });
});


// ============================================================
// 出版社の裏付け
// 実測（2026-07-31）: "REGGIE" comics → Reggie Mantle（Archie Comics）が
// ゲートを通り、Immortal Hulk の「レジー」の解説として表示されていた。
// 別宇宙・別出版社の同名キャラを落とすための条件
// ============================================================
describe('expectedPublisher', () => {
  it('既知のホストから出版社を引く', () => {
    expect(expectedPublisher('www.marvel.com')).toBe('marvel');
    expect(expectedPublisher('marvel.com')).toBe('marvel');
    expect(expectedPublisher('www.dc.com')).toBe('dc');
    expect(expectedPublisher('dcuniverseinfinite.com')).toBe('dc');
  });

  it('未知のホストは null（条件を課さない）', () => {
    expect(expectedPublisher('example.com')).toBeNull();
    expect(expectedPublisher('')).toBeNull();
    expect(expectedPublisher(null)).toBeNull();
  });

  // marvel.com.evil.example のような接尾辞一致で誤判定しないこと
  it('ドメインの部分一致では判定しない', () => {
    expect(expectedPublisher('marvel.com.example.net')).toBeNull();
    expect(expectedPublisher('notmarvel.com')).toBeNull();
  });
});

describe('publisherConflicts', () => {
  const MARVEL = 'Brian David Banner is a character appearing in American comic books '
    + 'published by Marvel Comics.';
  const ARCHIE = 'Reginald "Reggie" Mantle is a fictional character in the Archie Comics '
    + 'universe, published by Archie Comics.';

  it('出版社が一致すれば矛盾しない', () => {
    expect(publisherConflicts(MARVEL, 'marvel')).toBe(false);
  });

  it('別の出版社なら矛盾とみなす', () => {
    expect(publisherConflicts(ARCHIE, 'marvel')).toBe(true);
  });

  // 情報が無いものまで落とすと、組織・場所の記事が軒並み消える
  it('published by の記載が無ければ矛盾としない', () => {
    expect(publisherConflicts('S.H.I.E.L.D. is a fictional espionage organization.', 'marvel')).toBe(false);
  });

  it('期待出版社が無ければ常に矛盾しない', () => {
    expect(publisherConflicts(ARCHIE, null)).toBe(false);
    expect(publisherConflicts(ARCHIE, '')).toBe(false);
  });

  // Marvel の旧社名。Captain America 等の初期キャラ記事で使われる
  it('旧社名（Timely / Atlas）も Marvel とみなす', () => {
    expect(publisherConflicts('... published by Timely Comics.', 'marvel')).toBe(false);
    expect(publisherConflicts('... published by Atlas Comics.', 'marvel')).toBe(false);
  });

  it('DC の傘下レーベルも DC とみなす', () => {
    expect(publisherConflicts('... published by Vertigo, an imprint of DC Comics.', 'dc')).toBe(false);
  });
});

describe('passesGate — 出版社条件', () => {
  const base = {
    term: 'REGGIE',
    title: 'Reggie Mantle',
    intro: 'Reginald "Reggie" Mantle is a fictional character appearing in American comic books '
      + 'published by Archie Comics. He is a recurring rival in the Archie stories.',
    powers: '',
  };

  it('publisher を渡さなければ従来どおり通す（後方互換）', () => {
    expect(passesGate(base)).toBe(true);
  });

  it('別出版社の記事は却下する', () => {
    expect(passesGate({ ...base, publisher: 'marvel' })).toBe(false);
  });

  it('同じ出版社なら通す', () => {
    const marvel = {
      term: 'BANNER',
      title: 'Brian Banner',
      intro: 'Brian David Banner is a character appearing in American comic books '
        + 'published by Marvel Comics. He is the father of Bruce Banner.',
      powers: '',
    };
    expect(passesGate({ ...marvel, publisher: 'marvel' })).toBe(true);
  });
});
