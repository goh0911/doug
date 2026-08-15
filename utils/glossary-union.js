// utils/glossary-union.js — 複数シリーズの用語集・解説キャッシュを読み取り用に畳む pure 関数
//
// 用語集はシリーズ単位で育つため、別の作品を開くと 0 語から始まる。実測（実ページ 3 枚）
// では本文に出た固有名詞 12 個のうち用語集にあったのは 4 個で、しかも 3 個は用語集と
// 同じ作品のページに出たものだった。X-MEN・アイアンマン・エマ・フロスト・ハンマーヘッドは
// どれも未登録。マーベル世界の固有名詞は作品をまたいで共通なので、**読み取りだけ**横断させる。
//
// 書き込み（抽出・承認）と層B置換はシリーズ単位のまま。前者は「どの作品で覚えたか」の
// 情報を保つため、後者は訳文を書き換える危険な経路で、承認の粒度を崩さないため。

/** 大文字小文字だけの違いを吸収する（utils/nano-extract.js の統合規則と揃える） */
function foldKey(original) {
  return String(original).toLowerCase();
}

/**
 * 入力順に依存しない安定した並びを作る。
 * 順序が揺れると splitByTerms の「先勝ち」が読み込みごとに変わり、同じページでも
 * 下線の付く語が入れ替わって見える。
 */
function stableSources(sources) {
  return (Array.isArray(sources) ? sources : [])
    .filter((s) => s && typeof s === 'object' && s.map && typeof s.map === 'object')
    .slice()
    .sort((a, b) => String(a.seriesId).localeCompare(String(b.seriesId)));
}

/**
 * 勝ち負けを決める。いま読んでいるシリーズが最優先、次に新しいもの。
 * @param {object} prev 採用中
 * @param {object} next 候補
 * @param {string} currentSeriesId
 * @param {string} stampField 新しさを比べるフィールド（用語集は addedAt、解説は at）
 */
function beats(prev, next, currentSeriesId, stampField) {
  const prevCurrent = prev.seriesId === currentSeriesId;
  const nextCurrent = next.seriesId === currentSeriesId;
  if (prevCurrent !== nextCurrent) return nextCurrent;
  const p = typeof prev[stampField] === 'number' ? prev[stampField] : -Infinity;
  const n = typeof next[stampField] === 'number' ? next[stampField] : -Infinity;
  if (n !== p) return n > p;
  return false; // 完全同点は先着を維持（stableSources により決定的）
}

/**
 * 複数シリーズの用語集を 1 つに畳む（下線と解説要求の照合用）。
 *
 * @param {Array<{seriesId: string, seriesName?: string, map: object}>} sources
 * @param {string} currentSeriesId いま読んでいるシリーズ
 * @returns {object} original -> { ...entry, seriesId, seriesName }
 */
export function mergeGlossaries(sources, currentSeriesId) {
  const out = {};
  const chosen = new Map(); // foldKey -> 採用中の original

  for (const src of stableSources(sources)) {
    for (const original of Object.keys(src.map).sort()) {
      const entry = src.map[original];
      if (!entry || typeof entry.translated !== 'string' || entry.translated === '') continue;
      const next = { ...entry, seriesId: src.seriesId, seriesName: src.seriesName };
      const key = foldKey(original);
      const prevOriginal = chosen.get(key);
      if (prevOriginal === undefined) {
        chosen.set(key, original);
        out[original] = next;
        continue;
      }
      if (!beats(out[prevOriginal], next, currentSeriesId, 'addedAt')) continue;
      delete out[prevOriginal];
      chosen.set(key, original);
      out[original] = next;
    }
  }
  return out;
}

/**
 * 他シリーズの解説キャッシュを 1 つに畳む。
 *
 * 失敗エントリも対象にする。あるシリーズで「Wikipedia に記事が無い」と分かった語を、
 * 別のシリーズで 24 時間おきに引き直しても結果は同じで、取得と課金が無駄になるだけ。
 *
 * 注意: 戻り値をそのまま putGlossDefs に渡してはいけない。他シリーズの解説が現在の
 * シリーズへ複製され、容量を食ったうえ同じ解説が何本も残る。照合と表示にだけ使い、
 * 保存は自シリーズぶんだけを書き戻すこと。
 *
 * @param {Array<{seriesId: string, map: object}>} sources
 * @param {string} currentSeriesId
 * @returns {object} term -> { ...entry, seriesId }
 */
export function mergeGlossDefs(sources, currentSeriesId) {
  const out = {};
  for (const src of stableSources(sources)) {
    for (const term of Object.keys(src.map).sort()) {
      const entry = src.map[term];
      if (!entry || typeof entry !== 'object' || typeof entry.at !== 'number') continue;
      const next = { ...entry, seriesId: src.seriesId };
      const prev = out[term];
      if (prev === undefined || beats(prev, next, currentSeriesId, 'at')) out[term] = next;
    }
  }
  return out;
}
