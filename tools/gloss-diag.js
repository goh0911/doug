// tools/gloss-diag.js — 解説ポップアップの実機診断（開発用。拡張には同梱しない）
//
// 実行場所: 拡張機能の「オプション」ページの DevTools Console
//   chrome://extensions/ → Doug の「詳細」→「拡張機能のオプション」→ F12 → Console
//
// Service Worker の Console では動的 import() が仕様で禁止されているため使えない。
// オプションページは通常のドキュメントなので import() も LanguageModel も使える。
//
// 毎回コピペしないで済ませる方法:
//   DevTools → Sources → Snippets → New snippet → 本ファイルを貼って保存。
//   以降はスニペット名をダブルクリック（または Ctrl+Enter）で実行できる。
//
// 使い方:
//   await dougDiag()            状態だけ見る（通信なし・書き込みなし）
//   await dougDiag.nano()       Nano の用語抽出を実パイプラインと同じ条件で 1 回試す
//   await dougDiag.purge()      失敗キャッシュを消す（成功した解説は残す）

(() => {
  const SERIES_PREFIX = 'series:';
  const LANG = 'ja';
  const DAY = 24 * 60 * 60 * 1000;

  /** 用語集か解説キャッシュを持つシリーズを全部返す */
  async function loadSeries() {
    const all = await chrome.storage.local.get(null);
    return Object.keys(all)
      .filter((k) => k.startsWith(SERIES_PREFIX))
      .map((k) => ({ key: k, s: all[k] }))
      .filter(({ s }) => s && (s.glossary?.[LANG] || s.glossDefs?.[LANG]));
  }

  /**
   * 用語集のキーを addedAt 降順で返す。background.js の runExtractionBg と同じ並び。
   * Object.keys() をそのまま使うと辞書順になり（chrome.storage がキーをソートして
   * 保持するため）、実パイプラインと違う除外リストで測ることになる
   */
  function recentOriginals(glossaryLangMap) {
    return Object.entries(glossaryLangMap)
      .sort(([, a], [, b]) => (b?.addedAt ?? 0) - (a?.addedAt ?? 0))
      .map(([k]) => k);
  }

  /** 対象シリーズを 1 つ選ぶ。id 未指定なら用語集が最も多いもの */
  async function pickSeries(id) {
    const list = await loadSeries();
    if (list.length === 0) throw new Error('シリーズが 1 件も見つかりません');
    if (id) {
      const hit = list.find(({ key }) => key === id || key === SERIES_PREFIX + id);
      if (!hit) throw new Error(`${id} が見つかりません。候補: ${list.map((x) => x.key).join(', ')}`);
      return hit;
    }
    return list.reduce((a, b) =>
      Object.keys(b.s.glossary?.[LANG] || {}).length > Object.keys(a.s.glossary?.[LANG] || {}).length ? b : a);
  }

  async function dougDiag(id) {
    const { key, s } = await pickSeries(id);
    const g = s.glossary?.[LANG] || {};
    const d = s.glossDefs?.[LANG] || {};
    const now = Date.now();

    console.group(`${s.meta?.name ?? '(名前なし)'}  ${key}`);

    // --- ソースの可用性 ---
    const cvGranted = await chrome.permissions.contains({ origins: ['https://comicvine.gamespot.com/*'] }).catch(() => false);
    const { comicvineApiKey = '' } = await chrome.storage.local.get('comicvineApiKey');
    console.log('Comic Vine: 権限', cvGranted, '/ キー', comicvineApiKey.trim() !== '');

    // --- 抽出の進捗 ---
    const pairs = s.recentPairs || [];
    console.log(`recentPairs ${pairs.length} 件 / 抽出予約 ${s.extractionDue} / 空振り連続 ${s.extractionBarrenRuns ?? 0} / 失敗 ${s.extractionFailures ?? 0}`);

    // --- 解説キャッシュの内訳 ---
    const succeeded = Object.entries(d).filter(([, e]) => !e?.failed);
    const failed = Object.entries(d).filter(([, e]) => e?.failed);
    console.log(`用語集 ${Object.keys(g).length} 語 / 解説 ${Object.keys(d).length} 件（成功 ${succeeded.length} / 失敗 ${failed.length}）`);

    const bySource = {};
    for (const [t, e] of succeeded) (bySource[e.source || '(なし)'] ??= []).push(t);
    console.log('成功のソース内訳:', bySource);

    if (failed.length) {
      const stamps = {};
      for (const [, e] of failed) stamps[e.sources ?? '(指紋なし)'] = (stamps[e.sources ?? '(指紋なし)'] || 0) + 1;
      console.log('失敗の指紋内訳:', stamps, '← 現在の指紋と違うものは次回引き直される');
      const ages = failed.map(([, e]) => e.at).sort();
      console.log('失敗の最古:', new Date(ages[0]).toLocaleString(), '/ 最新:', new Date(ages.at(-1)).toLocaleString());
    }

    // --- 用語集にあるのに解説が無い語 ---
    const noDef = Object.keys(g).filter((t) => !d[t]);
    if (noDef.length) console.log(`解説が未生成の語 ${noDef.length} 件:`, noDef);

    // --- 直近の翻訳ペア（抽出の材料）---
    console.groupCollapsed(`recentPairs の中身 ${pairs.length} 件`);
    pairs.forEach((p, i) => console.log(i, p.original));
    console.groupEnd();

    console.groupEnd();
    return { key, series: s };
  }

  /** 語を指定して所在を追う: dougDiag.term('ABOMINATION', 'DOC DOOM') */
  dougDiag.term = async (...terms) => {
    const { s } = await pickSeries();
    const g = s.glossary?.[LANG] || {};
    const d = s.glossDefs?.[LANG] || {};
    const now = Date.now();
    for (const t of terms) {
      const e = d[t];
      const state = !e ? '未生成'
        : e.failed ? `失敗 [指紋 ${e.sources ?? 'なし'}] (あと ${Math.round((DAY - (now - e.at)) / 60000)} 分)`
        : `成功 [${e.source || '不明'}] ${e.identity ?? ''}`;
      console.log(`${t.padEnd(16)} 用語集:${g[t] ? `有 → ${g[t].translated}` : '無'}  ${state}`);
    }
  };

  /** 実パイプラインと同じプロンプトで Nano の用語抽出を 1 回試す（保存はしない） */
  dougDiag.nano = async (id) => {
    const N = await import(chrome.runtime.getURL('utils/nano-extract.js'));
    const { s } = await pickSeries(id);

    const pairs = (s.recentPairs || []).slice(0, 10).map(N.sanitizePairForNano).filter(Boolean);
    if (pairs.length === 0) return console.warn('recentPairs が空です');
    const glossary = s.glossary?.[LANG] || {};
    const prompt = N.buildExtractionPrompt(pairs, recentOriginals(glossary), s.rejectedOriginals || []);

    console.log(`プロンプト ${prompt.length} 字 / ペア ${pairs.length} 件`);
    console.log('除外リスト:', prompt.match(/「既存用語集」 \(除外対象\) (.*)/)?.[1]);

    if (typeof LanguageModel === 'undefined') return console.error('このページでは LanguageModel が使えません');
    const session = await LanguageModel.create({
      temperature: 0,
      topK: 1,
      expectedInputs: [{ type: 'text', languages: ['en', 'ja'] }],
      expectedOutputs: [{ type: 'text', languages: ['ja', 'en'] }],
    });
    try {
      const t0 = Date.now();
      const raw = await session.prompt(prompt);
      console.log(`--- 生応答 (${Date.now() - t0}ms / ${raw.length}字) ---`);
      console.log(raw);

      const parsed = N.parseCandidatesJson(raw);
      console.log(`--- パース後 ${parsed.length} 件 ---`);
      for (const c of parsed) {
        const clean = N.sanitizeCandidate(c);
        console.log(`  ${clean ? '通過' : '却下'}  ${JSON.stringify(c.original)} → ${JSON.stringify(c.translated)}${glossary[c.original] ? ' ← 既存' : ''}`);
      }
      return { raw, parsed };
    } finally {
      session.destroy();
    }
  };

  /**
   * 抽出プロンプトの A/B 比較。
   *
   * 実機で Nano が「台詞を丸ごと original に写す」モードに落ちることを確認したため、
   * 何がそれを誘発しているかを切り分ける。
   *   A = 現行プロンプト（対照）
   *   B = 訳ゆれ検出（variants/inconsistent）を外したプロンプト
   *   C = A + responseConstraint（JSON Schema で original を 30 字に制限）
   *   D = B + responseConstraint
   */
  dougDiag.nanoAB = async (id) => {
    const N = await import(chrome.runtime.getURL('utils/nano-extract.js'));
    const { s } = await pickSeries(id);
    const pairs = (s.recentPairs || []).slice(0, 10).map(N.sanitizePairForNano).filter(Boolean);
    if (pairs.length === 0) return console.warn('recentPairs が空です');
    const glossary = s.glossary?.[LANG] || {};
    const base = N.buildExtractionPrompt(pairs, Object.keys(glossary), s.rejectedOriginals || []);

    // 訳ゆれ検出の指示と、出力テンプレートの variants/inconsistent を落とす
    const noVariants = base
      .replace(/^「訳ゆれ検出」.*\n/m, '')
      .replace(/\[\{"original":"\.\.\.","translated":"\.\.\.".*\]/, '[{"original":"...","translated":"..."}]');

    const schema = {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          original: { type: 'string', maxLength: 30 },
          translated: { type: 'string', maxLength: 30 },
        },
        required: ['original', 'translated'],
        additionalProperties: false,
      },
    };

    const runs = [
      { name: 'A 現行', prompt: base, opts: {} },
      { name: 'B 訳ゆれなし', prompt: noVariants, opts: {} },
      { name: 'C 現行+制約', prompt: base, opts: { responseConstraint: schema } },
      { name: 'D 訳ゆれなし+制約', prompt: noVariants, opts: { responseConstraint: schema } },
    ];

    const summary = [];
    for (const run of runs) {
      const session = await LanguageModel.create({
        temperature: 0,
        topK: 1,
        expectedInputs: [{ type: 'text', languages: ['en', 'ja'] }],
        expectedOutputs: [{ type: 'text', languages: ['ja', 'en'] }],
      });
      try {
        const t0 = Date.now();
        const raw = await session.prompt(run.prompt, run.opts);
        const ms = Date.now() - t0;
        const parsed = N.parseCandidatesJson(raw);
        // 「台詞丸写し」の指標: 原語に空白が 4 つ以上ある候補の割合
        let arr = [];
        try { arr = JSON.parse(raw.match(/\[[\s\S]*\]/)?.[0] ?? '[]'); } catch { /* 破綻 */ }
        const verbatim = arr.filter((x) => String(x?.original ?? '').split(/\s+/).length >= 5).length;

        console.group(`${run.name}  ${ms}ms / 生${raw.length}字 / JSON ${arr.length}件 / 丸写し ${verbatim}件 / 採用 ${parsed.length}件`);
        console.log(raw);
        parsed.forEach((c) => console.log(`  ${JSON.stringify(c.original)} → ${JSON.stringify(c.translated)}${glossary[c.original] ? ' ← 既存' : ''}`));
        console.groupEnd();
        summary.push({ 条件: run.name, ms, JSON件数: arr.length, 丸写し: verbatim, 採用: parsed.length, 新規: parsed.filter((c) => !glossary[c.original]).length });
      } catch (err) {
        console.warn(`${run.name} 失敗:`, err?.name, err?.message);
        summary.push({ 条件: run.name, ms: -1, JSON件数: -1, 丸写し: -1, 採用: -1, 新規: -1 });
      } finally {
        session.destroy();
      }
    }
    console.table(summary);
    return summary;
  };

  /**
   * 解説の生成を強制的に走らせる（ページを再翻訳せずに済ませるため）。
   *   await dougDiag.refetch()                     用語集の全語
   *   await dougDiag.refetch('DOC DOOM', 'DOOM')   指定した語だけ
   *
   * 注意: オプションページから送ると sender.tab が無いため background 側の host が
   * 空になり、expectedPublisher が null になる。つまり**出版社ゲートが効かない**
   * 条件での結果になる。実際の閲覧経路より緩いので、ここで通っても実機で通るとは
   * 限らない（逆は言える）。最終確認は必ずページの再翻訳で行うこと。
   */
  dougDiag.refetch = async (...terms) => {
    const { key, s } = await pickSeries();
    const seriesId = key.slice(SERIES_PREFIX.length);
    const wanted = terms.length > 0 ? terms : Object.keys(s.glossary?.[LANG] || {});
    console.log(`${wanted.length} 語の解説を要求します（出版社ゲート無効の条件）`);

    const res = await chrome.runtime.sendMessage({
      type: 'GET_GLOSS_DEFS',
      seriesId,
      seriesName: s.meta?.name ?? '',
      terms: wanted,
      targetLang: LANG,
      langLabel: '日本語',
    });
    const defs = (res && res.defs) || {};
    console.log(`解説が返った語 ${Object.keys(defs).length} 件:`, Object.keys(defs));
    return defs;
  };

  /** 失敗キャッシュだけ消す。成功した解説は残す */
  dougDiag.purge = async (id) => {
    const { key, s } = await pickSeries(id);
    const d = s.glossDefs?.[LANG] || {};
    const kept = Object.fromEntries(Object.entries(d).filter(([, e]) => !e?.failed));
    const removed = Object.keys(d).length - Object.keys(kept).length;
    await chrome.storage.local.set({ [key]: { ...s, glossDefs: { ...s.glossDefs, [LANG]: kept } } });
    console.log(`失敗 ${removed} 件を削除 / 成功 ${Object.keys(kept).length} 件を維持`);
  };

  globalThis.dougDiag = dougDiag;
  console.log('dougDiag() / dougDiag.term(...) / dougDiag.nano() / dougDiag.purge() が使えます');
})();
