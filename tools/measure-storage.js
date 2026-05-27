// Doug v2 Phase 2 ストレージ実測スクリプト
// 使い方:
//   chrome-extension://<DOUG_ID>/tools/measure-storage.html を開くだけ
//   または Service Worker DevTools の Console にペースト

(async () => {
  const out = (line, cls) => {
    const el = typeof document !== 'undefined' && document.getElementById('output');
    if (el) {
      const span = document.createElement('span');
      if (cls) span.className = cls;
      span.textContent = line + '\n';
      el.appendChild(span);
    }
    console.log(line);
  };
  const clearOut = () => {
    const el = typeof document !== 'undefined' && document.getElementById('output');
    if (el) el.textContent = '';
  };

  clearOut();
  out('[doug-measure] start');

  if (typeof chrome === 'undefined' || !chrome.storage) {
    out('❌ chrome.storage が見つかりません。extension context で実行してください', 'err');
    return;
  }

  const N_SERIES = 100;
  const N_TERMS_PER_SERIES = 50;
  const MEASURE_PREFIX = '__doug_measure:';

  const baselineBytes = await chrome.storage.local.getBytesInUse(null);
  out(`baseline used : ${(baselineBytes / 1024).toFixed(1)} KB`);

  function makeDummySeries(i) {
    const glossary = { ja: {} };
    for (let j = 0; j < N_TERMS_PER_SERIES; j++) {
      const orig = `OriginalTerm_${i}_${j}_padded_to_average`;
      glossary.ja[orig] = {
        translated: `翻訳語${i}_${j}_15文字程度`,
        count: j,
        lastSeenAt: Date.now() - j * 1000,
        source: j % 3 === 0 ? 'auto' : 'manual',
        approved: true,
      };
    }
    return {
      meta: {
        name: `Test Series Volume ${i} (2026)`,
        detectedAt: Date.now(),
        lastVisitedAt: Date.now(),
        issueCount: 12,
        detectionSource: 'regex',
      },
      urlPatterns: [
        { origin: 'https://example.com', pathPrefix: `/comics/series-${i}/`, lastSeenAt: Date.now() },
      ],
      overrides: { provider: null, model: null, targetLang: null },
      glossary,
      tone: { style: 'auto' },
      stats: { translationCount: 12, lastTranslatedAt: Date.now() },
    };
  }

  const batch = {};
  for (let i = 0; i < N_SERIES; i++) {
    batch[`${MEASURE_PREFIX}${i.toString().padStart(4, '0')}`] = makeDummySeries(i);
  }

  out(`writing ${N_SERIES} dummy series...`);
  await chrome.storage.local.set(batch);

  const afterBytes = await chrome.storage.local.getBytesInUse(null);
  const dummyBytes = afterBytes - baselineBytes;
  const avgPerSeries = dummyBytes / N_SERIES;
  const quotaBytes = chrome.storage.local.QUOTA_BYTES; // 5242880
  const dummyPctOfQuota = (dummyBytes / quotaBytes) * 100;

  out('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  out('実測結果');
  out('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  out(`  N シリーズ × N 用語         : ${N_SERIES} × ${N_TERMS_PER_SERIES}`);
  out(`  dummy 総使用量              : ${(dummyBytes / 1024).toFixed(1)} KB`);
  out(`  1 シリーズあたり平均        : ${(avgPerSeries / 1024).toFixed(2)} KB`);
  out(`  クォータ (QUOTA_BYTES)      : ${(quotaBytes / 1024 / 1024).toFixed(1)} MB`);
  out(`  dummy / クォータ            : ${dummyPctOfQuota.toFixed(2)} %`);
  out(`  推定収容数 (クォータ 80%)   : ${Math.floor((quotaBytes * 0.8) / avgPerSeries)} シリーズ`);
  out('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  if (dummyPctOfQuota <= 5) {
    out(`✅ 合格基準A: dummy が 5% 以下 → 閾値 warn 4MB / archive 4.5MB のまま 2A 着手 GO`, 'ok');
  } else if (dummyPctOfQuota <= 10) {
    const warn = Math.floor(avgPerSeries * 800);
    const archive = Math.floor(avgPerSeries * 900);
    out(`⚠️ 合格基準B: 5〜10% → 閾値を warn ${(warn / 1024 / 1024).toFixed(2)}MB / archive ${(archive / 1024 / 1024).toFixed(2)}MB に再設定`, 'warn');
  } else {
    const warn = Math.floor(avgPerSeries * 500);
    out(`⚠️ 合格基準C: 10% 超 → 閾値を warn ${(warn / 1024 / 1024).toFixed(2)}MB 以下に下げて収容数縮小`, 'warn');
  }

  out('cleaning up dummy data...');
  const keys = Object.keys(batch);
  await chrome.storage.local.remove(keys);
  const finalBytes = await chrome.storage.local.getBytesInUse(null);
  out(`post-cleanup  : ${(finalBytes / 1024).toFixed(1)} KB (baseline was ${(baselineBytes / 1024).toFixed(1)} KB)`);
  if (Math.abs(finalBytes - baselineBytes) > 100) {
    out('⚠️ cleanup may have left residue', 'warn');
  } else {
    out('✅ cleanup OK', 'ok');
  }
})();
