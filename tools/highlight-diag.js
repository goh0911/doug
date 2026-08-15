// tools/highlight-diag.js — 「下線が出ない」を関門ごとに切り分ける実機診断（開発用。拡張には同梱しない）
//
// 実行場所: コミックを表示して翻訳を終えたあとの、そのページの DevTools Console。
//   ただし Console 左上のコンテキスト切替を "Doug" 相当（拡張の isolated world）にすること。
//   ページ既定のコンテキスト（top）では chrome.storage が無く動かない。
//   ※ tools/gloss-diag.js はオプションページ用。こちらはコミックページ用で、用途が違う。
//
// 使い方:
//   dougHl()                最も用語集が多いシリーズで診断する
//   dougHl('series:xxx')    シリーズを指定する
//
// 通信も書き込みも行わない（storage は読むだけ）。
//
// 下線が出るには 3 つの関門を全部通る必要がある:
//   関門1 訳語が本文に現れる  … loadGlossDefs の visible フィルタ
//   関門2 解説の生成に成功    … buildGlossTermList が defs のキーだけを見る
//   関門3 splitByTerms が拾う … 実際に <span class="doug-gloss-term"> になる
// どこで落ちているかを数で出す。

(() => {
  const SERIES_PREFIX = 'series:';
  const LANG = 'ja';

  /** 表記ゆれを吸収した比較用の形。中黒・長音・全角半角・ヴ を潰す */
  function norm(s) {
    return String(s)
      .normalize('NFKC')
      .replace(/[・･\s]/g, '')
      .replace(/[ーｰ－―‐−]/g, 'ー')
      .replace(/ヴァ/g, 'バ').replace(/ヴィ/g, 'ビ').replace(/ヴェ/g, 'ベ')
      .replace(/ヴォ/g, 'ボ').replace(/ヴ/g, 'ブ')
      .toUpperCase();
  }

  async function pickSeries(id) {
    const all = await chrome.storage.local.get(null);
    const list = Object.keys(all)
      .filter((k) => k.startsWith(SERIES_PREFIX))
      .map((k) => ({ key: k, s: all[k] }))
      .filter(({ s }) => s && (s.glossary?.[LANG] || s.glossDefs?.[LANG]));
    if (list.length === 0) throw new Error('シリーズが 1 件も見つかりません');
    if (id) {
      const hit = list.find(({ key }) => key === id || key === SERIES_PREFIX + id);
      if (!hit) throw new Error(`${id} が見つかりません。候補: ${list.map((x) => x.key).join(', ')}`);
      return hit;
    }
    return list.reduce((a, b) =>
      Object.keys(b.s.glossary?.[LANG] || {}).length > Object.keys(a.s.glossary?.[LANG] || {}).length ? b : a);
  }

  /** content.js の renderedOverlayText と同じ集め方 */
  function pageTextOf() {
    const nodes = document.querySelectorAll('#mut-overlay-container .mut-overlay-text');
    let out = '';
    nodes.forEach((el) => { out += el.textContent || ''; out += '\n'; });
    return { text: out, count: nodes.length };
  }

  async function dougHl(id) {
    const { key, s } = await pickSeries(id);
    // 拡張の実経路（GET_PAGE_GLOSSARY / 解説のシリーズ横断参照）に合わせて差し替える。
    // storage を直接読むだけだと自シリーズしか見えず、横断の効果を測れない
    let g = s.glossary?.[LANG] || {};
    let d = s.glossDefs?.[LANG] || {};
    const ownGlossaryCount = Object.keys(g).length;

    const { text: pageText, count: overlayCount } = pageTextOf();
    console.group(`下線ファネル  ${s.meta?.name ?? '(名前なし)'}  ${key}`);

    if (overlayCount === 0) {
      console.warn('オーバーレイが 0 個です。先にページを翻訳してから実行してください。');
      console.groupEnd();
      return;
    }

    // どのシリーズの用語集で見ているかを確かめる。id 未指定だと「用語集が最大の
    // シリーズ」を選ぶため、別作品のページを他作品の用語集で測ってしまうことがある。
    // 本文に当たる語数を全シリーズで出して、選択が妥当かを見えるようにする
    if (!id) {
      const all = await chrome.storage.local.get(null);
      const scores = Object.keys(all)
        .filter((k) => k.startsWith(SERIES_PREFIX) && all[k]?.glossary?.[LANG])
        .map((k) => {
          const gm = all[k].glossary[LANG];
          const hit = Object.keys(gm).filter((t) => gm[t]?.translated && pageText.includes(gm[t].translated));
          return { key: k, name: all[k].meta?.name ?? '(名前なし)', total: Object.keys(gm).length, hit: hit.length };
        })
        .sort((a, b) => b.hit - a.hit);
      console.log('シリーズ別の本文一致数:', scores.map((x) => `${x.name}[${x.key.slice(0, 14)}…] ${x.hit}/${x.total}`));
      if (scores.length > 1 && scores[0].key !== key) {
        console.warn(`★選択中の ${key} より ${scores[0].key}（${scores[0].name}）の方が一致数が多い。`
          + ` dougHl('${scores[0].key}') で測り直してください`);
      }
    }

    // 本文はそのまま貼れるように出す（解析はこちらでもやる）
    console.log(`オーバーレイ ${overlayCount} 個 / 本文 ${pageText.length} 字`);
    console.log('----- 本文ここから -----\n' + pageText + '----- 本文ここまで -----');

    // --- 関門0: 訳語を持つ用語 ---
    //
    // 拡張が実際に使うのは「全シリーズを畳んだ用語集」（background の GET_PAGE_GLOSSARY）。
    // 取れなければ自シリーズだけで続ける（拡張の縮退動作と同じ）
    try {
      const res = await chrome.runtime.sendMessage({
        type: 'GET_PAGE_GLOSSARY', seriesId: key.slice(SERIES_PREFIX.length), targetLang: LANG,
      });
      if (res && res.langMap && Object.keys(res.langMap).length > 0) {
        g = res.langMap;
        const bySeries = {};
        for (const e of Object.values(g)) {
          const n = e.seriesName || e.seriesId || '(不明)';
          bySeries[n] = (bySeries[n] || 0) + 1;
        }
        console.log(`用語集はシリーズ横断で ${Object.keys(g).length} 語`
          + `（このシリーズ単体では ${ownGlossaryCount} 語）`, bySeries);
      }
    } catch { /* 旧版の拡張では未実装 */ }
    if (g === s.glossary?.[LANG]) {
      console.warn('★GET_PAGE_GLOSSARY が使えません。拡張が未リロードか古い版です'
        + '（chrome://extensions/ で Doug を再読み込みしてください）。自シリーズのみで測ります');
    }

    // 解説キャッシュも横断参照になったので、他シリーズぶんを重ねて見る
    // （自シリーズを優先、同点なら at が新しい方。background の buildDefsLookup と同じ規則）
    {
      const all = await chrome.storage.local.get(null);
      const merged = {};
      for (const k of Object.keys(all).filter((x) => x.startsWith(SERIES_PREFIX)).sort()) {
        const map = all[k]?.glossDefs?.[LANG] || {};
        const isCurrent = k === key;
        for (const [t, e] of Object.entries(map)) {
          if (!e || typeof e.at !== 'number') continue;
          const prev = merged[t];
          if (!prev || (isCurrent && !prev._cur) || (!prev._cur && e.at > prev.at)) {
            merged[t] = { ...e, _cur: isCurrent };
          }
        }
      }
      const foreign = Object.keys(merged).length - Object.keys(d).length;
      if (foreign > 0) console.log(`解説キャッシュは横断で ${Object.keys(merged).length} 件（他シリーズから +${foreign}）`);
      d = merged;
    }

    const terms = Object.keys(g).filter((k) => {
      const e = g[k];
      return e && typeof e.translated === 'string' && e.translated !== '';
    });

    // --- 関門1: 訳語が本文に現れるか（loadGlossDefs の visible と同じ判定）---
    //
    // 素の includes ではなく、拡張と同じカタカナ境界ガードを掛ける
    // （utils/gloss-highlight.js の splitByTerms / findVisibleTerms）。
    // includes だけだと「ロス」が「エマ・フロスト」に当たり、実際には下線にならない語を
    // 「出ている」と数えてしまう
    const KATA_RE = /[ァ-ヺーヽヾ]/;
    const occursStandalone = (text, t) => {
      if (!KATA_RE.test(t)) return text.includes(t);
      for (let i = text.indexOf(t); i !== -1; i = text.indexOf(t, i + 1)) {
        if (!KATA_RE.test(text[i - 1] || '') && !KATA_RE.test(text[i + t.length] || '')) return true;
      }
      return false;
    };
    const visible = terms.filter((k) => occursStandalone(pageText, g[k].translated));

    // --- 関門2: 解説の生成状態 ---
    const okDefs = visible.filter((k) => d[k] && !d[k].failed);
    const failedDefs = visible.filter((k) => d[k] && d[k].failed);
    const noDefs = visible.filter((k) => !d[k]);

    // --- 関門3: 実際に描画された下線 ---
    const spans = document.querySelectorAll('.doug-gloss-term');
    const spanCount = {};
    spans.forEach((el) => {
      const k = el.dataset.glossKey || '(キーなし)';
      spanCount[k] = (spanCount[k] || 0) + 1;
    });

    console.log(
      `関門0 訳語あり ${terms.length} 語\n` +
      `関門1 本文に出ている ${visible.length} 語\n` +
      `関門2 解説 成功 ${okDefs.length} / 失敗 ${failedDefs.length} / 未生成 ${noDefs.length}\n` +
      `関門3 実際の下線 ${spans.length} 箇所（異なり ${Object.keys(spanCount).length} 語）`
    );
    console.log('本文に出ている語:', visible.map((k) => `${k} → ${g[k].translated}`));
    if (failedDefs.length) console.log('  ↳ 失敗で下線にならない語:', failedDefs);
    if (noDefs.length) console.log('  ↳ 未生成で下線にならない語:', noDefs);
    console.log('下線の内訳:', spanCount);

    // 関門2を通ったのに下線が無い語。ただし splitByTerms は訳語をキーに先勝ちで
    // 引くため、同じ訳語を持つ別エントリがあると後続は必ず消える（下線自体は出て
    // いるので実害は無い）。本当に説明のつかない消失と区別する
    const lost = okDefs.filter((k) => !spanCount[k]);
    const winnerOf = {};
    for (const k of okDefs) if (spanCount[k]) (winnerOf[g[k].translated] ??= []).push(k);
    const shadowed = lost.filter((k) => (winnerOf[g[k].translated] || []).length > 0);
    const unexplained = lost.filter((k) => !shadowed.includes(k));
    if (shadowed.length) {
      console.log('  ↳ 訳語が同じ別エントリに吸収された語（下線は出ている／解説生成が重複）:',
        shadowed.map((k) => `${k} ≡ ${winnerOf[g[k].translated].join('/')}（${g[k].translated}）`));
    }
    if (unexplained.length) console.warn('★関門3で消えた語（想定外）:', unexplained);

    // ================= 取りこぼしの分析 =================
    console.group('取りこぼしの分析');

    // 【A】原語（英語）なら本文にある語。訳文に英語のまま残る名前（S.H.I.E.L.D. 等）を拾う
    const byOriginal = terms.filter((k) => !pageText.includes(g[k].translated) && pageText.includes(k));
    console.log(`【A】訳語では一致しないが、原語（英語）なら本文にある: ${byOriginal.length} 語`);
    if (byOriginal.length) console.log('  ', byOriginal.map((k) => `${k}（登録訳語: ${g[k].translated}）`));

    // 【B】正規化すれば一致した可能性のある語（中黒・長音・ヴ の揺れ）
    const nPage = norm(pageText);
    const byNorm = terms.filter((k) => !pageText.includes(g[k].translated)
      && !pageText.includes(k)
      && g[k].translated.length >= 2
      && nPage.includes(norm(g[k].translated)));
    console.log(`【B】表記を正規化すれば一致した: ${byNorm.length} 語`);
    if (byNorm.length) console.log('  ', byNorm.map((k) => `${k} → ${g[k].translated}`));

    // 【C】本文中の固有名詞らしい連続のうち、どの一致語にも覆われていないもの。
    //      用語集にそもそも無い語を見つけるため（＝抽出側の問題かを切り分ける）
    const matchedStrings = [
      ...visible.map((k) => g[k].translated),
      ...byOriginal.map((k) => k),
    ];
    const covered = (run) => matchedStrings.some((m) => m.includes(run) || run.includes(m));
    const runs = {};
    const KATAKANA = /[ァ-ヺー・]{2,}/g;
    const LATIN = /[A-Za-z][A-Za-z.'’\-]{1,}/g;
    for (const re of [KATAKANA, LATIN]) {
      let m;
      re.lastIndex = 0;
      while ((m = re.exec(pageText)) !== null) {
        const run = m[0];
        if (covered(run)) continue;
        runs[run] = (runs[run] || 0) + 1;
      }
    }
    const runList = Object.entries(runs).sort((a, b) => b[1] - a[1] || b[0].length - a[0].length);
    console.log(`【C】本文中の未カバーのカタカナ／英字連続: ${runList.length} 種`);
    console.log('  ', runList.map(([r, n]) => `${r}(${n})`).join(' '));
    console.log('  ↑ この中に固有名詞が多ければ抽出側、一般語ばかりなら照合は妥当という判断材料');

    // 【E】部分一致の誤爆。短いカタカナ語が、より長いカタカナ語の内側に当たっている
    //      場合を拾う（実機で ROSS→「ロス」が「エマ・フロスト」に一致した）。
    //      splitByTerms は長い順に並べるが、それが防げるのは用語集どうしの包含だけで、
    //      用語集に無い語（フロスト）に食い込むのは防げない
    const KATA = /[ァ-ヺーヽヾ]/;
    const falseHits = [];
    for (const k of visible) {
      const t = g[k].translated;
      if (!KATA.test(t)) continue;
      for (let i = pageText.indexOf(t); i !== -1; i = pageText.indexOf(t, i + 1)) {
        const before = pageText[i - 1] || '';
        const after = pageText[i + t.length] || '';
        if (!KATA.test(before) && !KATA.test(after)) continue;
        const ctx = pageText.slice(Math.max(0, i - 5), i + t.length + 5).replace(/\n/g, ' ');
        falseHits.push(`${k} → ${t} … 「${ctx}」`);
      }
    }
    console.log(`【E】より長いカタカナ語に食い込んでいる疑いのある一致: ${falseHits.length} 箇所`);
    if (falseHits.length) console.log('  ', falseHits);

    // 【D】用語集そのものの重複（ページに依らない全体の指標）。
    //      同じ訳語に複数の原語が割り当たると、下線は 1 語ぶんしか出ないのに
    //      解説は原語の数だけ生成される＝ Wikipedia 取得と API 課金が重複する
    const byTranslated = {};
    for (const k of terms) (byTranslated[g[k].translated] ??= []).push(k);
    const dupTrans = Object.entries(byTranslated).filter(([, ks]) => ks.length > 1);
    // 原語が大小文字・前後の記号だけ違うもの（ROXXON と Roxxon）
    const byOriginalNorm = {};
    for (const k of terms) (byOriginalNorm[norm(k)] ??= []).push(k);
    const dupOrig = Object.entries(byOriginalNorm).filter(([, ks]) => ks.length > 1);
    console.log(`【D】用語集の重複（全 ${terms.length} 語中）: 訳語が同じ ${dupTrans.length} 組 / 原語が実質同じ ${dupOrig.length} 組`);
    if (dupTrans.length) console.log('   訳語重複:', dupTrans.map(([t, ks]) => `${t} ← ${ks.join(' / ')}`));
    if (dupOrig.length) console.log('   原語重複:', dupOrig.map(([, ks]) => ks.join(' / ')));

    console.groupEnd();
    console.groupEnd();
    return { key, pageText, visible, okDefs, failedDefs, noDefs, byOriginal, byNorm, runs };
  }

  globalThis.dougHl = dougHl;
  console.log('dougHl() が使えます（コミックページを翻訳したあとに実行してください）');
})();
