// tools/unreject-case-variants.js — 【一時】大小文字変種を却下記憶から外す
//
// 背景:
//   却下記憶（rejectedOriginals）は 1fb00b7 から大小文字を畳んで照合する。
//   一方 tools/reject-noise.js は「変種を却下して正規形を残す」掃除をした。
//   この 2 つが噛み合っておらず、Roxxon を却下したことで ROXXON まで
//   「却下済み」と見なされている。
//
//   実害は訳ゆれ検出（variants の記録）が効かないことだけで、既存エントリは
//   消えず下線も解説も出る。ただし将来この語が用語集から消えると二度と自動
//   登録されない。ROXXON や HULK は主要な語なので直しておく。
//
//   そもそも大小文字重複の再登録は mergeCandidates の existKey が防いでいる
//   （3886701）。却下記憶に入れる必要が最初から無かった。
//
// 使い方:
//   series.html?id=... を開き、DevTools のコンソールにこのファイルを貼る。
//
// 注意:
//   却下スクリプトと違い、これは storage を直接書き換える（rejectedOriginals を
//   編集するメッセージが無いため。updateSeriesField の許可パスにも入っていない）。
//   読書中は用語抽出が同じレコードを書くことがあるので、実行は一瞬で終わらせ、
//   終わったら必ず表示される件数を確認すること。

const REMOVE = [
  'Hulk',                   // 正規形 HULK
  'Roxxon',                 // 正規形 ROXXON
  'Richard',                // 正規形 RICHARD
  'Thunderbolt Ross',       // 正規形 THUNDERBOLT ROSS
  'Breaker of Worlds',      // 正規形 BREAKER OF WORLDS
  'United States military', // 正規形 UNITED STATES MILITARY
];

const seriesId = new URLSearchParams(location.search).get('id');
if (!seriesId) throw new Error('series.html?id=... で開いてから実行すること');

const KEY = `series:${seriesId}`;
const series = (await chrome.storage.local.get(KEY))[KEY];
if (!series) throw new Error(`${KEY} が見つからない`);

const glossary = (series.glossary && series.glossary.ja) || {};
const rejected = Array.isArray(series.rejectedOriginals) ? series.rejectedOriginals : [];

// 安全装置: 正規形（大小文字を畳んで同じ語）が用語集に実在するものだけ外す。
// 実在しないまま外すと、その語が次の抽出でノイズのまま再登録される
const fold = (s) => String(s).toLowerCase();
const glossaryFolded = new Set(Object.keys(glossary).map(fold));

const safe = [], unsafe = [];
for (const term of REMOVE) {
  if (!rejected.includes(term)) continue;          // そもそも却下記憶に無い
  (glossaryFolded.has(fold(term)) ? safe : unsafe).push(term);
}

if (unsafe.length) {
  console.warn('正規形が用語集に無いので外さない（外すとノイズが戻る）:', unsafe);
}

const next = rejected.filter((o) => !safe.includes(o));
series.rejectedOriginals = next;
await chrome.storage.local.set({ [KEY]: series });

console.log('却下記憶', rejected.length, '→', next.length, '語');
console.log('外した:', safe);
console.table(safe.map((t) => [t, Object.keys(glossary).find((k) => fold(k) === fold(t))]));
console.log('※ 右列が用語集に残っている正規形。空欄があれば直ちに知らせること');
