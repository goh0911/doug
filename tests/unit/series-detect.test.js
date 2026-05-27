// tests/unit/series-detect.test.js
import { describe, it, expect } from 'vitest';
import {
  detectSeriesFromTitle,
  detectSeriesFromUrl,
  normalizeSeriesName,
  computeSeriesId,
  detectSeries,
} from '../../utils/series-detect.js';

// ============================================================
// detectSeriesFromTitle: hash-num パターン
// ============================================================
describe('detectSeriesFromTitle: hash-num', () => {
  it('標準的なタイトル: "Immortal Hulk #20"', () => {
    const r = detectSeriesFromTitle('Immortal Hulk #20');
    expect(r).not.toBeNull();
    expect(r.series).toBe('Immortal Hulk');
    expect(r.issueNumber).toBe(20);
    expect(r.matchedPattern).toBe('hash-num');
    expect(r.confidence).toBe(0.95);
  });

  it('小数話数: "Spider-Man #1.5"', () => {
    const r = detectSeriesFromTitle('Spider-Man #1.5');
    expect(r).not.toBeNull();
    expect(r.series).toBe('Spider-Man');
    expect(r.issueNumber).toBe(1.5);
    expect(r.matchedPattern).toBe('hash-num');
  });

  it('余分な空白: "Amazing Spider-Man  #  10"', () => {
    const r = detectSeriesFromTitle('Amazing Spider-Man  #  10');
    expect(r).not.toBeNull();
    expect(r.series).toBe('Amazing Spider-Man');
    expect(r.issueNumber).toBe(10);
    expect(r.matchedPattern).toBe('hash-num');
  });

  it('末尾にサフィックスがあっても series を正しく取得: "Wonder Man (2026) #3 | Comic Issues | Marvel"', () => {
    const r = detectSeriesFromTitle('Wonder Man (2026) #3 | Comic Issues | Marvel');
    expect(r).not.toBeNull();
    expect(r.issueNumber).toBe(3);
    expect(r.matchedPattern).toBe('hash-num');
  });

  it('大文字小文字を区別しない: "THE BATMAN #50"', () => {
    const r = detectSeriesFromTitle('THE BATMAN #50');
    expect(r).not.toBeNull();
    expect(r.series).toBe('THE BATMAN');
    expect(r.issueNumber).toBe(50);
    expect(r.matchedPattern).toBe('hash-num');
  });
});

// ============================================================
// detectSeriesFromTitle: keyword-num パターン
// ============================================================
describe('detectSeriesFromTitle: keyword-num', () => {
  it('"Chapter" キーワード: "One Piece Chapter 1100"', () => {
    const r = detectSeriesFromTitle('One Piece Chapter 1100');
    expect(r).not.toBeNull();
    expect(r.series).toBe('One Piece');
    expect(r.issueNumber).toBe(1100);
    expect(r.matchedPattern).toBe('keyword-num');
    expect(r.confidence).toBe(0.9);
  });

  it('"Ch." キーワード: "Manga Series Ch. 5"', () => {
    const r = detectSeriesFromTitle('Manga Series Ch. 5');
    expect(r).not.toBeNull();
    expect(r.series).toBe('Manga Series');
    expect(r.issueNumber).toBe(5);
    expect(r.matchedPattern).toBe('keyword-num');
  });

  it('"Vol." キーワード: "Dragon Ball Vol.42"', () => {
    const r = detectSeriesFromTitle('Dragon Ball Vol.42');
    expect(r).not.toBeNull();
    expect(r.series).toBe('Dragon Ball');
    expect(r.issueNumber).toBe(42);
    expect(r.matchedPattern).toBe('keyword-num');
  });

  it('"Volume" キーワード: "Berserk Volume 41"', () => {
    const r = detectSeriesFromTitle('Berserk Volume 41');
    expect(r).not.toBeNull();
    expect(r.series).toBe('Berserk');
    expect(r.issueNumber).toBe(41);
    expect(r.matchedPattern).toBe('keyword-num');
  });

  it('"Episode" キーワード: "Attack on Titan Episode 139"', () => {
    const r = detectSeriesFromTitle('Attack on Titan Episode 139');
    expect(r).not.toBeNull();
    expect(r.series).toBe('Attack on Titan');
    expect(r.issueNumber).toBe(139);
    expect(r.matchedPattern).toBe('keyword-num');
  });

  it('"Issue" キーワード: "X-Men Issue 200"', () => {
    const r = detectSeriesFromTitle('X-Men Issue 200');
    expect(r).not.toBeNull();
    expect(r.series).toBe('X-Men');
    expect(r.issueNumber).toBe(200);
    expect(r.matchedPattern).toBe('keyword-num');
  });
});

// ============================================================
// detectSeriesFromTitle: ja-num パターン
// ============================================================
describe('detectSeriesFromTitle: ja-num', () => {
  it('"巻" パターン: "ベルセルク 第41巻"', () => {
    const r = detectSeriesFromTitle('ベルセルク 第41巻');
    expect(r).not.toBeNull();
    expect(r.series).toBe('ベルセルク');
    expect(r.issueNumber).toBe(41);
    expect(r.matchedPattern).toBe('ja-num');
    expect(r.confidence).toBe(0.9);
  });

  it('"話" パターン: "ワンピース 第1100話"', () => {
    const r = detectSeriesFromTitle('ワンピース 第1100話');
    expect(r).not.toBeNull();
    expect(r.series).toBe('ワンピース');
    expect(r.issueNumber).toBe(1100);
    expect(r.matchedPattern).toBe('ja-num');
  });

  it('"章" パターン: "進撃の巨人 第100章"', () => {
    const r = detectSeriesFromTitle('進撃の巨人 第100章');
    expect(r).not.toBeNull();
    expect(r.series).toBe('進撃の巨人');
    expect(r.issueNumber).toBe(100);
    expect(r.matchedPattern).toBe('ja-num');
  });
});

// ============================================================
// detectSeriesFromTitle: trailing-num パターン
// ============================================================
describe('detectSeriesFromTitle: trailing-num', () => {
  it('標準: "Naruto 700"', () => {
    const r = detectSeriesFromTitle('Naruto 700');
    expect(r).not.toBeNull();
    expect(r.series).toBe('Naruto');
    expect(r.issueNumber).toBe(700);
    expect(r.matchedPattern).toBe('trailing-num');
    expect(r.confidence).toBe(0.5);
  });

  it('コロン付きサブタイトル: "Naruto 700: The End"', () => {
    const r = detectSeriesFromTitle('Naruto 700: The End');
    expect(r).not.toBeNull();
    expect(r.series).toBe('Naruto');
    expect(r.issueNumber).toBe(700);
    expect(r.matchedPattern).toBe('trailing-num');
  });

  it('余分なスペース: "My Hero Academia  100 "', () => {
    const r = detectSeriesFromTitle('My Hero Academia  100 ');
    expect(r).not.toBeNull();
    expect(r.issueNumber).toBe(100);
    expect(r.matchedPattern).toBe('trailing-num');
  });
});

// ============================================================
// detectSeriesFromTitle: 全パターン非マッチ
// ============================================================
describe('detectSeriesFromTitle: 全パターン非マッチ', () => {
  it('URLのような文字列は null', () => {
    expect(detectSeriesFromTitle('https://example.com/comics')).toBeNull();
  });

  it('空文字列は null', () => {
    expect(detectSeriesFromTitle('')).toBeNull();
  });

  it('数字のみは null', () => {
    expect(detectSeriesFromTitle('12345')).toBeNull();
  });

  it('null は null', () => {
    expect(detectSeriesFromTitle(null)).toBeNull();
  });
});

// ============================================================
// detectSeriesFromUrl: URL fallback ヒット
// ============================================================
describe('detectSeriesFromUrl: ヒット', () => {
  it('標準パス: "/comics/immortal-hulk/"', () => {
    const r = detectSeriesFromUrl('https://example.com/comics/immortal-hulk/');
    expect(r).not.toBeNull();
    expect(r.series).toBe('immortal hulk');
  });

  it('数字末尾セグメントを除外: "/comics/immortal-hulk/20/"', () => {
    const r = detectSeriesFromUrl('https://example.com/comics/immortal-hulk/20/');
    expect(r).not.toBeNull();
    expect(r.series).toBe('immortal hulk');
  });

  it('ハイフン区切りをスペースに変換: "/manga/one-piece"', () => {
    const r = detectSeriesFromUrl('https://example.com/manga/one-piece');
    expect(r).not.toBeNull();
    expect(r.series).toBe('one piece');
  });

  it('末尾に数字が埋め込まれているセグメントを除去: "/series/dragon-ball-42"', () => {
    const r = detectSeriesFromUrl('https://example.com/series/dragon-ball-42');
    expect(r).not.toBeNull();
    expect(r.series).toBe('dragon ball');
  });
});

// ============================================================
// detectSeriesFromUrl: URL fallback 失敗
// ============================================================
describe('detectSeriesFromUrl: 失敗', () => {
  it('ルートのみ: "/" は null', () => {
    expect(detectSeriesFromUrl('https://example.com/')).toBeNull();
  });

  it('クエリのみ（パスなし）: "https://example.com?q=test" は null', () => {
    expect(detectSeriesFromUrl('https://example.com?q=test')).toBeNull();
  });
});

// ============================================================
// normalizeSeriesName
// ============================================================
describe('normalizeSeriesName', () => {
  it('全角英数を半角に変換', () => {
    expect(normalizeSeriesName('ＨＵＬＫ')).toBe('hulk');
  });

  it('ASCII 記号を除去', () => {
    // "#" は ASCII 記号 (0x23) なので除去される
    expect(normalizeSeriesName('Spider-Man!')).toBe('spiderman');
  });

  it('連続空白を1個に', () => {
    expect(normalizeSeriesName('One  Piece')).toBe('one  piece'.replace(/  /, ' '));
  });

  it('NFKC 正規化（半角カナ→全角）', () => {
    const result = normalizeSeriesName('ﾜﾝﾋﾟｰｽ');
    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
  });

  it('日本語記号を除去', () => {
    expect(normalizeSeriesName('ベルセルク【完全版】')).toBe('ベルセルク完全版');
  });
});

// ============================================================
// computeSeriesId
// ============================================================
describe('computeSeriesId', () => {
  it('同じ入力で常に同じ出力を返す', async () => {
    const id1 = await computeSeriesId('Immortal Hulk');
    const id2 = await computeSeriesId('Immortal Hulk');
    expect(id1).toBe(id2);
  });

  it('origin に依存しない（同じシリーズ名なら同じ ID）', async () => {
    const id1 = await computeSeriesId('One Piece');
    const id2 = await computeSeriesId('One Piece');
    expect(id1).toBe(id2);
    expect(id1).toHaveLength(16);
  });

  it('大文字小文字を無視（正規化後に同一になる）', async () => {
    const id1 = await computeSeriesId('Immortal Hulk');
    const id2 = await computeSeriesId('immortal hulk');
    expect(id1).toBe(id2);
  });
});

// ============================================================
// detectSeries: 統合テスト
// ============================================================
describe('detectSeries: 統合', () => {
  it('title が優先されて Regex で検出', async () => {
    const r = await detectSeries({
      title: 'Immortal Hulk #20',
      url: 'https://example.com/comics/something/1',
      h1: 'Some Other Title',
      ogTitle: 'Yet Another Title',
    });
    expect(r).not.toBeNull();
    expect(r.series).toBe('Immortal Hulk');
    expect(r.issueNumber).toBe(20);
    expect(r.source).toBe('regex');
    expect(r.confidence).toBe(0.95);
    expect(r.seriesId).toHaveLength(16);
  });

  it('title が非マッチでも ogTitle から検出', async () => {
    const r = await detectSeries({
      title: 'Read Comics Online',
      url: 'https://example.com/something',
      ogTitle: 'Spider-Man #50',
    });
    expect(r).not.toBeNull();
    expect(r.series).toBe('Spider-Man');
    expect(r.issueNumber).toBe(50);
    expect(r.source).toBe('regex');
  });

  it('title / ogTitle が非マッチでも h1 から検出', async () => {
    const r = await detectSeries({
      title: 'Read Comics Online',
      url: 'https://example.com/something',
      h1: 'One Piece Chapter 1100',
    });
    expect(r).not.toBeNull();
    expect(r.series).toBe('One Piece');
    expect(r.source).toBe('regex');
  });

  it('Regex 全失敗時に URL fallback で検出', async () => {
    const r = await detectSeries({
      title: 'Read Comics Online',
      url: 'https://example.com/comics/immortal-hulk/20',
    });
    expect(r).not.toBeNull();
    expect(r.series).toBe('immortal hulk');
    expect(r.source).toBe('url');
    expect(r.confidence).toBe(0.4);
    expect(r.issueNumber).toBeNull();
  });

  it('すべて失敗したら null を返す', async () => {
    const r = await detectSeries({
      title: 'Welcome to My Site',
      url: 'https://example.com/',
    });
    expect(r).toBeNull();
  });

  it('title > ogTitle > h1 の優先順位を確認', async () => {
    const r = await detectSeries({
      title: 'Daredevil #100',
      ogTitle: 'Spider-Man #50',
      h1: 'One Piece Chapter 1',
    });
    expect(r).not.toBeNull();
    expect(r.series).toBe('Daredevil');
    expect(r.issueNumber).toBe(100);
  });
});
