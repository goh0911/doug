import { describe, it, expect } from 'vitest';
import { transformBboxToFullPage, mergeTranslations } from '../../utils/panel-utils.js';

describe('transformBboxToFullPage', () => {
  it('crop中央の吹き出しをフルページ座標に変換する', () => {
    // フルページ 400×400、cropBox がページ左半分 (0,0)-(200,400)、パディングなし
    const cropBbox = { left: 25, top: 25, width: 50, height: 50 }; // crop空間の中央
    const cropBox  = { x1: 0, y1: 0, x2: 200, y2: 400 };
    const result = transformBboxToFullPage(cropBbox, cropBox, 400, 400);
    // cropW=200, cropH=400
    // full_left   = (0 + 25/100 * 200) / 400 * 100 = 50/400*100 = 12.5
    // full_top    = (0 + 25/100 * 400) / 400 * 100 = 100/400*100 = 25
    // full_width  = 50/100 * 200 / 400 * 100 = 25
    // full_height = 50/100 * 400 / 400 * 100 = 50
    expect(result.left).toBeCloseTo(12.5);
    expect(result.top).toBeCloseTo(25);
    expect(result.width).toBeCloseTo(25);
    expect(result.height).toBeCloseTo(50);
  });

  it('crop が画像右下の場合に正しく変換する', () => {
    // フルページ 1000×1000、cropBox が右下 (500,500)-(1000,1000)
    const cropBbox = { left: 0, top: 0, width: 100, height: 100 }; // crop全体
    const cropBox  = { x1: 500, y1: 500, x2: 1000, y2: 1000 };
    const result = transformBboxToFullPage(cropBbox, cropBox, 1000, 1000);
    // フルページ座標でも右下 50,50 始まり 50×50
    expect(result.left).toBeCloseTo(50);
    expect(result.top).toBeCloseTo(50);
    expect(result.width).toBeCloseTo(50);
    expect(result.height).toBeCloseTo(50);
  });

  it('crop の一部の吹き出し座標を変換する', () => {
    // フルページ 1000×500、cropBox (100,50)-(600,450)（cropW=500, cropH=400）
    const cropBbox = { left: 10, top: 20, width: 30, height: 40 };
    const cropBox  = { x1: 100, y1: 50, x2: 600, y2: 450 };
    const result = transformBboxToFullPage(cropBbox, cropBox, 1000, 500);
    // full_left   = (100 + 10/100*500) / 1000 * 100 = 150/1000*100 = 15
    // full_top    = (50  + 20/100*400) / 500  * 100 = 130/500*100  = 26
    // full_width  = 30/100*500/1000*100 = 15
    // full_height = 40/100*400/500*100  = 32
    expect(result.left).toBeCloseTo(15);
    expect(result.top).toBeCloseTo(26);
    expect(result.width).toBeCloseTo(15);
    expect(result.height).toBeCloseTo(32);
  });
});

describe('mergeTranslations', () => {
  const base = (left, top, w, h) => ({ left, top, width: w, height: h });

  it('IoU >= 0.3 の既存アイテムを incoming で置き換える', () => {
    const existing = [
      { original: 'A', translated: '日本語A', bbox: base(10, 10, 20, 20) },
    ];
    const incoming = [
      { original: 'A2', translated: '日本語A2', bbox: base(12, 12, 20, 20) }, // 大きく重なる
    ];
    const { translations, changedIndices } = mergeTranslations(existing, incoming);
    expect(translations).toHaveLength(1); // 置き換えなので合計1件
    expect(translations[0].original).toBe('A2');
    expect(changedIndices.has(0)).toBe(true);
  });

  it('IoU < 0.3 の incoming は末尾に追加する', () => {
    const existing = [
      { original: 'A', translated: '日本語A', bbox: base(10, 10, 20, 20) },
    ];
    const incoming = [
      { original: 'B', translated: '日本語B', bbox: base(80, 80, 10, 10) }, // 離れている
    ];
    const { translations, changedIndices } = mergeTranslations(existing, incoming);
    expect(translations).toHaveLength(2);
    expect(translations[1].original).toBe('B');
    expect(changedIndices.has(1)).toBe(true);
  });

  it('既存配列を変更せず新配列を返す（pure function）', () => {
    const existing = [
      { original: 'A', translated: '日本語A', bbox: base(10, 10, 20, 20) },
    ];
    const incoming = [
      { original: 'A2', translated: '日本語A2', bbox: base(12, 12, 20, 20) },
    ];
    const { translations } = mergeTranslations(existing, incoming);
    expect(existing[0].original).toBe('A'); // 元配列は変更されない
    expect(translations).not.toBe(existing); // 新配列
  });

  it('incoming が空の場合は既存をそのまま返す', () => {
    const existing = [
      { original: 'A', translated: '日本語A', bbox: base(10, 10, 20, 20) },
    ];
    const { translations, changedIndices } = mergeTranslations(existing, []);
    expect(translations).toHaveLength(1);
    expect(changedIndices.size).toBe(0);
  });

  it('複数 incoming が同じ既存にマッチした場合、後の incoming が勝つ', () => {
    const existing = [
      { original: 'A', translated: '日本語A', bbox: base(10, 10, 20, 20) },
    ];
    const incoming = [
      { original: 'A2', translated: '日本語A2', bbox: base(11, 11, 18, 18) },
      { original: 'A3', translated: '日本語A3', bbox: base(12, 12, 16, 16) },
    ];
    const { translations } = mergeTranslations(existing, incoming);
    // 両方が既存の index 0 に高IoUでマッチ。後の A3 が最終的に勝つ
    expect(translations).toHaveLength(1);
    expect(translations[0].original).toBe('A3');
  });
});
