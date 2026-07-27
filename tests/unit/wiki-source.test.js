// tests/unit/wiki-source.test.js
import { describe, it, expect } from 'vitest';
import {
  WIKIPEDIA_ORIGIN, buildSearchUrl, parseSearchResponse,
  extractIntro, extractPowers, passesGate, buildPageUrl,
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
  it('より深い小見出しは終端にせず内容に含める', () => {
    const p = extractPowers(ARTICLE);
    expect(p).toContain('=== Density control ===');
    expect(p).toContain('alter his density');
  });

  it('見出しの揺れ（Powers, abilities, and resources）も拾う', () => {
    const a = '== Powers, abilities, and resources ==\nZatanna speaks backwards.\n\n== Legacy ==\nx';
    expect(extractPowers(a)).toBe('Zatanna speaks backwards.');
  });

  it('能力節が無ければ空文字', () => {
    expect(extractPowers('== History ==\nnothing here')).toBe('');
  });
});

describe('passesGate（設計書 §1.2 の実測 6 ケース）', () => {
  const comicIntro = 'X is a character appearing in American comic books published by Marvel.';

  it('能力節あり＋導入に comic → 通す', () => {
    expect(passesGate({ intro: comicIntro, powers: 'teleports' })).toBe(true);
  });

  it('能力節なし → 落とす（Xavier Institute / Sokovia の失敗様式）', () => {
    expect(passesGate({ intro: comicIntro, powers: '' })).toBe(false);
  });

  it('導入に comic が無い → 落とす（無関係な記事を引いた場合）', () => {
    expect(passesGate({ intro: 'A city in Europe.', powers: 'something' })).toBe(false);
  });

  it('引数が不正でも例外を投げず false', () => {
    expect(passesGate({})).toBe(false);
    expect(passesGate(null)).toBe(false);
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
