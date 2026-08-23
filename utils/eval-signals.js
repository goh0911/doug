// utils/eval-signals.js
// 【一時措置】評価用に「難しかったページ」を拾うための指標。
// tmp/eval-collector ブランチ限定で、master には載せない（リリース対象外）。
//
// 難しいページを人手で探すのが困難なため、日常の読書中に自動で候補を貯める。
// docs/plans/2026-08-17-accuracy-stability-backlog.md の「検証の律速：難しい評価
// ページが無い」に対応する。
//
// 退化検出そのものは backlog で見送っている（標本 2 件・誤検知で正しい翻訳を捨てる）。
// ここは**記録するだけ**で翻訳結果に手を触れないため、誤検知しても失うものが無い。
// したがって閾値は緩く置き、拾いすぎた分は人が捨てる。

// 件数がこれ未満なら異なり比では判定しない（効果音が 2 件並ぶだけで誤検知するため）
const MIN_COUNT_FOR_RATIO = 4;
// 実測では正常が 0.77〜1.00、退化が 0.17／0.20 だった（標本 2 件）。間を取る
const DEGENERATE_RATIO = 0.6;
// 訳文が原文のまま残っている割合
const UNTRANSLATED_RATIO = 0.3;

/** 訳文が ASCII だけで構成されている＝訳されていない疑い */
function looksUntranslated(s) {
  const t = String(s ?? '').trim();
  if (t === '') return false;
  return /^[\x20-\x7E]+$/.test(t);
}

/**
 * 翻訳結果から評価候補の判定に使う指標を出す
 * @param {Array<{original?: string, translated?: string}>} translations
 * @returns {{count: number, distinctRatio: number, untranslatedRatio: number}}
 */
export function computeEvalSignals(translations) {
  const items = Array.isArray(translations) ? translations : [];
  const count = items.length;
  if (count === 0) return { count: 0, distinctRatio: 0, untranslatedRatio: 0 };

  const texts = items.map((t) => String(t?.translated ?? ''));
  const distinctRatio = new Set(texts).size / count;
  const untranslatedRatio = texts.filter(looksUntranslated).length / count;

  return { count, distinctRatio, untranslatedRatio };
}

/**
 * 指標から「あとで見直す価値があるページか」を判定する
 * @returns {{hit: boolean, reasons: string[]}}
 */
export function isEvalCandidate(signals) {
  const s = signals || {};
  const reasons = [];

  if (!s.count) reasons.push('empty');
  if (s.count >= MIN_COUNT_FOR_RATIO && s.distinctRatio < DEGENERATE_RATIO) reasons.push('degenerate');
  if (s.untranslatedRatio >= UNTRANSLATED_RATIO) reasons.push('untranslated');

  return { hit: reasons.length > 0, reasons };
}

/**
 * 候補が増えすぎないよう古いものから捨てる（imageUrl をキーにした素の連想配列）
 * @param {Record<string, {at?: string}>} map
 * @param {number} max
 * @returns {Record<string, object>} 新しい連想配列（引数は変更しない）
 */
export function trimCandidates(map, max) {
  const src = map && typeof map === 'object' ? map : {};
  const keys = Object.keys(src);
  if (keys.length <= max) return { ...src };

  // at が無いものは空文字となり最も古い側に寄る（壊れた記録から捨てられる）
  const sorted = keys.sort((a, b) => String(src[a]?.at ?? '').localeCompare(String(src[b]?.at ?? '')));
  const keep = sorted.slice(sorted.length - max);
  return Object.fromEntries(keep.map((k) => [k, src[k]]));
}
