// tests/unit/eval-signals.test.js
// 一時措置（tmp/eval-collector ブランチ限定）。master には載せない。
import { describe, it, expect } from 'vitest';
import { computeEvalSignals, isEvalCandidate, trimCandidates } from '../../utils/eval-signals.js';

const t = (original, translated) => ({ original, translated });

describe('computeEvalSignals', () => {
  it('検出数と異なり訳文の比率を返す', () => {
    const s = computeEvalSignals([t('A', 'あ'), t('B', 'い'), t('C', 'う'), t('D', 'え')]);
    expect(s.count).toBe(4);
    expect(s.distinctRatio).toBe(1);
  });

  it('同じ訳文が並ぶと異なり比が下がる（退化の兆候）', () => {
    const s = computeEvalSignals([t('A', 'あ'), t('B', 'あ'), t('C', 'あ'), t('D', 'あ'), t('E', 'い')]);
    expect(s.distinctRatio).toBeCloseTo(0.4);
  });

  it('訳文が ASCII のみなら未翻訳として数える', () => {
    const s = computeEvalSignals([t('HELLO', 'HELLO'), t('WHAT?', 'なに？')]);
    expect(s.untranslatedRatio).toBeCloseTo(0.5);
  });

  it('検出ゼロでも壊れず 0 を返す', () => {
    const s = computeEvalSignals([]);
    expect(s.count).toBe(0);
    expect(s.distinctRatio).toBe(0);
    expect(s.untranslatedRatio).toBe(0);
  });

  it('配列でない入力でも壊れない（防御的）', () => {
    expect(computeEvalSignals(null).count).toBe(0);
  });
});

describe('isEvalCandidate', () => {
  it('検出ゼロは候補にする', () => {
    expect(isEvalCandidate(computeEvalSignals([])).hit).toBe(true);
  });

  it('正常な訳文は候補にしない', () => {
    const items = ['あ', 'い', 'う', 'え', 'お'].map((x, i) => t(`W${i}`, x));
    expect(isEvalCandidate(computeEvalSignals(items)).hit).toBe(false);
  });

  it('退化（異なり比 0.2）は候補にする', () => {
    const items = Array.from({ length: 5 }, (_, i) => t(`W${i}`, 'ゴゴゴ'));
    const r = isEvalCandidate(computeEvalSignals(items));
    expect(r.hit).toBe(true);
    expect(r.reasons).toContain('degenerate');
  });

  it('件数が少ないうちは異なり比で判定しない（効果音 2 件などの誤検知を避ける）', () => {
    const items = [t('BOOM', 'ドン'), t('BOOM', 'ドン')];
    expect(isEvalCandidate(computeEvalSignals(items)).hit).toBe(false);
  });

  it('未翻訳が多いものは候補にする', () => {
    const items = [t('A', 'AAA'), t('B', 'BBB'), t('C', 'うう'), t('D', 'ええ')];
    const r = isEvalCandidate(computeEvalSignals(items));
    expect(r.hit).toBe(true);
    expect(r.reasons).toContain('untranslated');
  });
});

describe('trimCandidates', () => {
  const mk = (n) => Object.fromEntries(
    Array.from({ length: n }, (_, i) => [`u${i}`, { at: `2026-08-18T00:00:${String(i).padStart(2, '0')}Z` }])
  );

  it('上限以下ならそのまま返す', () => {
    const m = mk(3);
    expect(Object.keys(trimCandidates(m, 5))).toHaveLength(3);
  });

  it('上限を超えたら古いものから捨てる', () => {
    const r = trimCandidates(mk(6), 4);
    const keys = Object.keys(r);
    expect(keys).toHaveLength(4);
    expect(keys).not.toContain('u0');
    expect(keys).not.toContain('u1');
    expect(keys).toContain('u5');
  });

  it('at が無い項目は最も古いものとして扱う（壊れた記録を先に捨てる）', () => {
    const m = { ...mk(2), broken: {} };
    const keys = Object.keys(trimCandidates(m, 2));
    expect(keys).not.toContain('broken');
  });
});
