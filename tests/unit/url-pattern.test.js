// tests/unit/url-pattern.test.js
import { describe, it, expect } from 'vitest';
import { derivePathPrefix } from '../../utils/url-pattern.js';

describe('derivePathPrefix - Marvel.com', () => {
  it('Marvel.com の /comics/issue/{id}/{slug} は /comics/issue/ を返す', () => {
    expect(derivePathPrefix('https://www.marvel.com/comics/issue/128949/wonder_man_2026_3'))
      .toBe('/comics/issue/');
  });

  it('Marvel.com の /comics/issue/{id} のみでも /comics/issue/ を返す', () => {
    expect(derivePathPrefix('https://www.marvel.com/comics/issue/128949'))
      .toBe('/comics/issue/');
  });

  it('Marvel.com の /comics/issue/ 末尾でも /comics/issue/ を返す', () => {
    expect(derivePathPrefix('https://www.marvel.com/comics/issue/'))
      .toBe('/comics/issue/');
  });
});

describe('derivePathPrefix - フォールバック', () => {
  it('Marvel.com でも /comics/issue/ 以外のパスは / を返す', () => {
    expect(derivePathPrefix('https://www.marvel.com/characters/hulk'))
      .toBe('/');
  });

  it('未知のサイトは / を返す', () => {
    expect(derivePathPrefix('https://www.mangadex.org/chapter/abc123/1'))
      .toBe('/');
  });

  it('サブドメインが異なる marvel.com は / を返す', () => {
    expect(derivePathPrefix('https://developer.marvel.com/comics/issue/123'))
      .toBe('/');
  });
});

describe('derivePathPrefix - 不正 URL', () => {
  it('不正な URL 文字列は / を返す', () => {
    expect(derivePathPrefix('not-a-url')).toBe('/');
  });

  it('空文字は / を返す', () => {
    expect(derivePathPrefix('')).toBe('/');
  });
});
