// tests/unit/prompt-builder.test.js
import { describe, it, expect } from 'vitest';
import { buildSeriesPromptSection } from '../../utils/prompt-builder.js';

describe('buildSeriesPromptSection - 用語集', () => {
  it('approved 用語を count 降順で列挙する', () => {
    const section = buildSeriesPromptSection({
      seriesName: 'Immortal Hulk',
      glossaryLangMap: {
        Hulk: { translated: 'ハルク', count: 5, approved: true },
        Bruce: { translated: 'ブルース', count: 10, approved: true },
      },
    });
    expect(section).toContain('このコミックは「Immortal Hulk」シリーズです。');
    expect(section).toContain('【用語集】');
    // count 降順: Bruce(10) が先
    const idxBruce = section.indexOf('ブルース');
    const idxHulk = section.indexOf('ハルク');
    expect(idxBruce).toBeLessThan(idxHulk);
    expect(section).toContain('1. Bruce → ブルース');
    expect(section).toContain('2. Hulk → ハルク');
  });

  it('approved:false は除外する', () => {
    const section = buildSeriesPromptSection({
      glossaryLangMap: {
        Hulk: { translated: 'ハルク', count: 5, approved: true },
        Thing: { translated: 'シング', count: 9, approved: false },
      },
    });
    expect(section).toContain('Hulk → ハルク');
    expect(section).not.toContain('シング');
  });

  it('上位 30 件に cap する', () => {
    const glossaryLangMap = {};
    for (let i = 0; i < 50; i++) {
      glossaryLangMap[`term${i}`] = { translated: `訳${i}`, count: i, approved: true };
    }
    const section = buildSeriesPromptSection({ glossaryLangMap });
    // count 降順上位30 = term49..term20。term19 以下は含まれない
    expect(section).toContain('term49 → 訳49');
    expect(section).toContain('term20 → 訳20');
    expect(section).not.toContain('term19 → 訳19');
    // 行番号は 30 まで
    expect(section).toContain('30. ');
    expect(section).not.toContain('31. ');
  });
});

describe('buildSeriesPromptSection - 口調', () => {
  it('プリセット口調を指示文に変換する', () => {
    const section = buildSeriesPromptSection({ toneStyle: '敬体' });
    expect(section).toContain('【訳文の口調】全体的に「です・ます」調で翻訳してください。');
  });

  it('auto は口調指示を出さない', () => {
    const section = buildSeriesPromptSection({
      glossaryLangMap: { Hulk: { translated: 'ハルク', count: 1, approved: true } },
      toneStyle: 'auto',
    });
    expect(section).not.toContain('【訳文の口調】');
  });

  it('カスタム口調はそのまま指示として埋め込む', () => {
    const section = buildSeriesPromptSection({ toneStyle: '落ち着いた敬語で' });
    expect(section).toContain('【訳文の口調】落ち着いた敬語で');
  });
});

describe('buildSeriesPromptSection - 空のとき', () => {
  it('用語集が空かつ口調が auto なら空文字を返す', () => {
    expect(buildSeriesPromptSection({ glossaryLangMap: {}, toneStyle: 'auto' })).toBe('');
  });

  it('引数なしでも空文字を返す', () => {
    expect(buildSeriesPromptSection()).toBe('');
  });

  it('用語集はあるが seriesName が無い場合は用語集だけ返す', () => {
    const section = buildSeriesPromptSection({
      glossaryLangMap: { Hulk: { translated: 'ハルク', count: 1, approved: true } },
    });
    expect(section).not.toContain('シリーズです');
    expect(section).toContain('【用語集】');
  });
});
