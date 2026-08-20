// tools/reject-noise.js — 【一時】用語集のノイズを一括で却下する（A-2 / A-4）
//
// 使い方:
//   1. 拡張の管理ページ series.html を対象シリーズで開く
//      （chrome-extension://<id>/series.html?id=5754b0720763b89c）
//   2. DevTools のコンソールにこのファイルの中身を貼って実行する
//
// なぜ series.html のコンソールなのか:
//   REJECT_GLOSSARY_CANDIDATE は onMessage の送信元検証（sender.id）を通る必要がある。
//   Service Worker が自分宛に送ったメッセージは自分の onMessage に届かないため、
//   拡張ページから送る。既存の却下ボタンと**まったく同じ経路**を通るので、
//   storage を直接書き換えるより安全（rejectedOriginals への記録・stats の更新も同じ）。
//
// 効果:
//   glossaryLangMap から削除し、rejectedOriginals に記録する。以後 mergeCandidates が
//   同じ語の再登録を拒否するため、抽出側に新しい判定規則を足さなくても再発しない。
//
// 取り消しについて（誤解しやすいので明記する）:
//   - 解説キャッシュ（glossDefs）は消えない。用語集から参照されなくなるだけで、
//     いずれ容量トリムで落ちる
//   - series.html から手で再追加はできるが、addGlossaryEntry は approved:true で
//     登録する（source:'manual'）。つまり再追加は「承認」でもあり、層A に載って
//     訳文へ影響する
//   - 自動抽出からは二度と入らない（rejectedOriginals に残るため）

const REJECT = {
  // ── クレジット頁・出版社・実在の制作者（作品世界の外側） ──
  credits: [
    'AL EWING', 'ALEX ROSS', 'ALAN FINE', 'C.B. CEBULSKI', 'CORY PETIT',
    'JOE QUESADA', 'TOM BREVOORT', 'SARAH BRUNSTAD', 'JOE BENNETT', 'PAUL MOUNTS',
    'RYAN BODENHEIM', 'BELARDINO BRABO', 'MATT MILL', 'GABE FLORES',
    'HAPPY HOWARD PURCELL', 'EWING BODENHEIM MOUNTS',
    'VC', 'MARVEL', 'Marvel', 'C.E.O.',
    "STAN'S SOAPBOX", 'Mighty Marvel Missive',
  ],

  // ── 効果音（訳語がカタカナなので既存の 1 語フィルタを通り抜けている） ──
  sfx: [
    'B-GOW', 'FLAK', 'KRAK-K-KOOM', 'KRAKK', 'KROOMM', 'SKTCH', 'THAP',
  ],

  // ── 一般名詞・ふつうの句（固有名詞ではない） ──
  common: [
    'BUSINESS', 'RISK', 'PEACEFUL', 'PROFESSOR', 'DOC', 'ELVES',
    'BLACK BUDGET', 'NINE-FOOT', 'NO HUMAN CASUALTIES', 'GAMMA-FREE',
    "WORLD'S GREATEST DAD", 'FACE OF THE ENEMY', 'GAMMA GUY', 'HULK RAMPAGE',
    'GREEN TECHNOLOGIES', 'GAMMA TERRORIST',
  ],

  // ── 壊れた訳・誤訳（残すと A-1 の一括承認で全訳文へ波及する） ──
  //
  // ここに入れてよいのは「語ごと消えても困らないもの」だけ。訳語だけが壊れていて
  // 語そのものは正当なもの（CREEL＝Carl Creel / SAMSON＝Doc Samson）は入れない。
  // 却下すると rejectedOriginals に残り、正しい解説ごと二度と戻せなくなる。
  broken: [
    'Hulk',            // → ウルヴァリン（完全な誤り。正しい HULK が残る）
    'DR. MCGOWAN',     // → マ高ワン博士（誤変換。CHARLENE MCGOWAN が残る）
    'DR. McGOWAN',     // → Mcgowan博士（未訳混じり。同上）
    'GENERAL FORTEAN', // → フォートーアń将軍（文字が壊れている。FORTEAN が残る）
    'CREAL',           // → クール（CREEL の綴り誤り。CREEL が残る）
    'MCGOWAN',         // → マゴワン（表記ゆれ。CHARLENE MCGOWAN が残る）
  ],

  // ── 訳語が原語のまま（層A に載せても「X を X と訳せ」で意味がない） ──
  // ※ B.E.R.S.E.R.K.E.R. と S.H.I.E.L.D. は作中の正当な用語なので残す
  untranslated: [
    'Breaker-Apart', 'Hir', 'Reg', 'IMMORTAL HULK', 'ABSOLUTE CARNAGE', 'THE IMM',
    'MTN', // 未訳の略記（2026-08-20 の読書で入った）
  ],

  // ── 大文字小文字だけ違う重複の残骸（3886701 以前に登録されたもの） ──
  // 残す側: MARVEL / RICHARD / ROXXON / THUNDERBOLT ROSS / BREAKER OF WORLDS /
  //         UNITED STATES MILITARY
  caseDupes: [
    'Richard', 'Roxxon', 'Thunderbolt Ross', 'Breaker of Worlds', 'United States military',
  ],

  // ── 別綴りの重複（A-4 本体）──
  spellingDupes: [
    'WALT',                 // WALTER を残す
    'THE HULK',             // HULK を残す（どちらも解説あり）
    'SHADOW BASE SITE B.',  // SHADOW BASE SITE B を残す（末尾ピリオドだけの差）
    'SHIELD',               // S.H.I.E.L.D. を残す
    // PHOEN は PHOENIX が切れたもの。isTruncationOf は長さ比 0.8 以上を条件に
    // するので 5/7=0.71 の これは素通りする。閾値を下げると HULK と HULKBUSTER の
    // ような別語を巻き添えにするため、規則ではなく個別の却下で落とす
    'PHOEN',
  ],

  // ── 同一人物が 6 エントリ（CHARLENE MCGOWAN を正規形として残す） ──
  // ※ DR. MCGOWAN / DR. McGOWAN / MCGOWAN は broken 側で却下済み
  mcgowan: [
    'DOCTOR MCGOWAN', 'DR. CHARLENE MCGOWAN',
  ],
};

// ── 訳語だけが壊れている語（却下ではなく修正する）──
//
// 語そのものは正当なので却下してはいけない。ただし放置すると A-1（層A の一括承認）で
// 壊れた訳語が全訳文へ波及する。addGlossaryEntry は approved:true / source:'manual' で
// 登録するため、**この修正はその語を承認することでもある**（層A に載り訳文に影響する）。
// 3 語だけなので影響範囲は限定的で、むしろ訳語が統一される。
const FIX = {
  CREEL: 'クリール',          // Carl Creel（Absorbing Man）。旧: クールさん
  SAMSON: 'サムソン',         // Doc Samson。旧: サムソン君
  FORTEAN: 'フォーティアン',   // Reg Fortean。旧: フォーティーン（REG FORTEAN 側の表記に揃える）
};

// ------------------------------------------------------------------
const seriesId = new URLSearchParams(location.search).get('id');
if (!seriesId) throw new Error('series.html?id=... で開いてから実行すること');

const all = Object.values(REJECT).flat();
console.log(`却下対象 ${all.length} 語 / 訳語修正 ${Object.keys(FIX).length} 語 / seriesId=${seriesId}`);

const result = { ok: [], notFound: [], failed: [] };
for (const original of all) {
  const res = await chrome.runtime.sendMessage({
    type: 'REJECT_GLOSSARY_CANDIDATE',
    payload: { seriesId, original },
  }).catch((e) => ({ status: 'error', e }));
  if (res && res.status === 'ok') result.ok.push(original);
  else if (res && res.status === 'not-found') result.notFound.push(original);
  else result.failed.push([original, res]);
}

console.log('却下できた:', result.ok.length);
console.log('シリーズが見つからない:', result.notFound);
console.log('失敗:', result.failed);
console.log('※ 用語集に無かった語も status:ok になる（rejectedOriginals には記録される）');

// 却下で容量が空いてから修正する（addGlossaryEntry は用語集の上限を見て弾く）
const fixed = [];
for (const [original, translated] of Object.entries(FIX)) {
  const ok = await chrome.runtime.sendMessage({
    type: 'ADD_GLOSSARY_ENTRY',
    payload: { seriesId, targetLang: 'ja', original, translated },
  }).catch(() => false);
  fixed.push([original, translated, ok === true ? 'ok' : 'NG']);
}
console.table(fixed);
console.log('修正した語は approved:true になっている（層A に載る）');
