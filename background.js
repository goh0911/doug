// background.js - Service Worker エントリポイント・イベントリスナー

import { isSiteAllowed as _isSiteAllowedPure, isAllowedImageUrl } from './utils/url-utils.js';
import { SETTINGS_DEFAULTS, invalidateSettingsCache } from './settings.js';
import { CACHE_AFFECTING_KEYS, cleanOldCache } from './cache.js';
import { cropScreenshot } from './image.js';
import { fetchImageAsDataUrl } from './image.js';
import {
  loadWhitelist, getWhitelistedOrigins,
  saveToWhitelist, removeFromWhitelist, injectToTab,
} from './whitelist.js';
import { handleImageTranslation, callTextOnlyProvider } from './translate.js';
import { handlePreloadQueue, resumePreloadQueue } from './preload.js';
import { detectSeries, computeSeriesId } from './utils/series-detect.js';
import {
  getSeries, listSeries, recordSeriesTranslation, deleteSeries,
  updateSeriesField, addGlossaryEntry, removeGlossaryEntry, getStorageUsageInfo,
  addExample, removeExample,
  applyExtractionResult, acquireExtractionLock, rejectGlossaryCandidate,
  getGlossDefs, putGlossDefs,
} from './series-store.js';
import { derivePathPrefix } from './utils/url-pattern.js';
import { buildSeriesDetectionPrompt, parseSeriesDetectionResponse } from './utils/series-nano.js';
import {
  WIKIPEDIA_ORIGIN, SOURCE_ID, buildSearchUrl, parseSearchResponse,
  extractIntro, extractPowers, passesGate, buildPageUrl,
} from './utils/wiki-source.js';
import { buildGlossPrompt, parseGlossResponse } from './utils/gloss-summary.js';
import { sanitizePairForNano, parseCandidatesJson, buildExtractionPrompt } from './utils/nano-extract.js';
import { isUsable } from './utils/gloss-cache.js';

// ============================================================
// マイグレーション: sync → local への移行
// ============================================================
chrome.runtime.onInstalled.addListener(async (details) => {
  await loadWhitelist();
  createContextMenu();
  if (details.reason === 'install') {
    chrome.tabs.create({ url: chrome.runtime.getURL('welcome/index.html') })
      .catch(err => console.error('ウェルカムページを開けませんでした:', err));
  }
  if (details.reason === 'install' || details.reason === 'update') {
    try {
      const syncData = await chrome.storage.sync.get(['apiKey', 'apiProvider', 'targetLang']);
      if (syncData.apiKey || syncData.apiProvider || syncData.targetLang) {
        // 旧 apiKey → プロバイダーに応じた新キーに変換
        if (syncData.apiKey) {
          const provider = syncData.apiProvider || 'gemini';
          const keyMap = { gemini: 'geminiApiKey', claude: 'claudeApiKey', openai: 'openaiApiKey' };
          syncData[keyMap[provider] || 'geminiApiKey'] = syncData.apiKey;
          delete syncData.apiKey;
        }
        await chrome.storage.local.set(syncData);
        await chrome.storage.sync.remove(['apiKey', 'apiProvider', 'targetLang']);
      }
    } catch (err) {
      console.error('設定の移行に失敗:', err);
    }
  }
});

chrome.runtime.onStartup.addListener(async () => {
  await loadWhitelist();
  createContextMenu();
});

// SW再起動後の先読みキュー復元（preload.js の alarm-based queue persistence）
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'doug-preload') resumePreloadQueue();
});

// 設定変更時にキャッシュを無効化
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local') {
    const settingKeys = Object.keys(SETTINGS_DEFAULTS);
    if (settingKeys.some(key => key in changes)) {
      invalidateSettingsCache();
    }
    // プロバイダー・モデル・言語が変わったら古い翻訳キャッシュを整理
    if (CACHE_AFFECTING_KEYS.some(key => key in changes)) {
      cleanOldCache().catch(() => {});
    }
  }
});

// ============================================================
// Port通信ハンドラー（TRANSLATE_IMAGE: 長時間処理のためタイムアウトなしのPortを使用）
// ============================================================
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'translate') return;
  const sender = port.sender;
  if (sender.id !== chrome.runtime.id) { port.disconnect(); return; }

  let portDisconnected = false;
  port.onDisconnect.addListener(() => { portDisconnected = true; void chrome.runtime.lastError; });

  // onMessage.addListenerを同期的に登録する（awaitの前に登録しないと、
  // Service Worker再起動直後にメッセージが届いた場合にリスナー未登録で
  // メッセージが失われ、永久ハングする race condition を防ぐため）
  port.onMessage.addListener(async (message) => {
    if (message.type !== 'TRANSLATE_IMAGE') return;
    // ホワイトリスト確認はメッセージ受信後に実施（最新状態を取得）
    await loadWhitelist();
    if (sender.tab && !_isSiteAllowedPure(sender.tab.url, getWhitelistedOrigins())) {
      if (!portDisconnected) {
        port.postMessage({ error: 'このサイトはホワイトリスト未登録です。ポップアップから登録してください。' });
        port.disconnect();
      }
      return;
    }
    try {
      const result = await handleImageTranslation(
        message.imageData,
        message.imageUrl,
        message.imageDims,
        { forceRefresh: !!message.forceRefresh, seriesId: message.seriesId ?? null }
      );
      if (!portDisconnected) port.postMessage(result);
    } catch (err) {
      if (!portDisconnected) port.postMessage({ error: err.message });
    }
  });
});

// ============================================================
// Phase 5: Nano シリーズ検出 fallback
// ============================================================
// SW での LanguageModel 可用性チェック（series.js の isNanoAvailable と同型）
async function isNanoAvailableBg() {
  if (typeof self.LanguageModel === 'undefined') return false;
  try {
    const cap = await self.LanguageModel.availability();
    return cap !== 'unavailable';
  } catch {
    return false;
  }
}

// 同一 url の Nano 検出を集約する in-flight ロック（url -> Promise）
const nanoDetectionInFlight = new Map();

// title/url/h1/ogTitle から Nano でシリーズを検出する
async function detectSeriesWithNano({ title, url, h1, ogTitle } = {}) {
  if (!(await isNanoAvailableBg())) return null;

  const prompt = buildSeriesDetectionPrompt({ title, url, h1, ogTitle });
  const controller = new AbortController();
  // 初回推論はモデルのウォームアップで十数秒かかる（実測 ≈18s）ため 30 秒
  const timeoutId = setTimeout(() => controller.abort(), 30000);
  let responseText = null;
  let session = null;
  try {
    // topK と temperature は両方指定が必須（片方だけは NotSupportedError）
    session = await self.LanguageModel.create({
      temperature: 0,
      topK: 1,
      expectedInputs: [{ type: 'text', languages: ['en', 'ja'] }],
      expectedOutputs: [{ type: 'text', languages: ['ja', 'en'] }],
    });
    responseText = await session.prompt(prompt, { signal: controller.signal });
  } catch {
    return null;
  } finally {
    clearTimeout(timeoutId);
    if (session) session.destroy();
  }

  const parsed = parseSeriesDetectionResponse(responseText);
  if (!parsed || !parsed.series) return null;

  const seriesId = await computeSeriesId(parsed.series);
  return {
    seriesId,
    series: parsed.series,
    issueNumber: parsed.issueNumber,
    source: 'nano',
    confidence: 0.5,
  };
}

// ============================================================
// Phase 7: 用語候補の自動抽出
// ============================================================
// 従来 extractionDue を消費するのは series.js だけで、シリーズ管理画面を開いて
// バナーの「実行する」を押したときにしか抽出が走らなかった（series.js:503）。
// そのため翻訳を重ねても用語集が空のままになり、解説ポップアップも機能しなかった。
// ここでは翻訳記録の直後に同じ処理を裏で走らせる。ロジックは series.js の
// runExtraction と同型だが、メッセージ往復を挟まず store を直接呼ぶ。

// 同一シリーズの抽出を二重起動しないための in-flight ロック
// （series-store 側の extractionRunning ロックとは別に、SW 内での多重起動を防ぐ）
const extractionInFlight = new Set();

const EXTRACTION_NANO_TIMEOUT_MS = 60_000;

// 1 回の抽出で Nano に渡すペア数の上限（実機実測で 10〜20 が最適域・下の詳細コメント参照）
const EXTRACTION_PAIRS_PER_RUN = 20;

// responseConstraint（JSON スキーマ）は使わない。
// 一度導入したが実機比較で不利と判明したため撤回した（本番プロンプト・同一ペアでの実測）:
//   制約あり 18,070ms → RED HULK / GAMMA TERRORIST / TONY STARK / AVENGE / DOC GREEN
//   制約なし  2,076ms → RED HULK / GAMMA TERRORIST / TONY STARK / DOC GREEN
// 制約付きデコードは約9倍遅いうえ、動詞 AVENGE を混入させて質もむしろ落ちた。
// 本番プロンプトは元から ```json で囲んだ配列を返しており、parseCandidatesJson /
// parseGlossResponse がフェンス付き・素の JSON・前置きありのいずれも処理できる。
//
// 「Nano は JSON を返さない」という当初の診断は、本番プロンプトではなく
// 簡略化した検証用プロンプトで測ったことによる誤りだった。

async function runExtractionBg(seriesId) {
  if (!seriesId || extractionInFlight.has(seriesId)) return;
  if (!(await isNanoAvailableBg())) return;

  extractionInFlight.add(seriesId);
  try {
    const lockResult = await acquireExtractionLock(seriesId);
    if (!lockResult || lockResult.status !== 'ok') return; // locked / not-found

    const series = lockResult.series;
    if (!series || !Array.isArray(series.recentPairs) || series.recentPairs.length === 0) {
      // ペアが無ければロックだけ解放する（success:true, candidates:[]）
      await applyExtractionResult({ seriesId, candidates: [], success: true });
      return;
    }

    // recentPairs 全件（上限50）を渡すと Nano が「固有名詞を抜く」に失敗して台詞を
    // 丸写しし始め、出力トークンが爆発して 60 秒でも終わらない（実機実測）:
    //   ペア 5件 → 76.7秒 / 台詞まるごと     ペア10件 →  6.4秒 / 固有名詞 ✅
    //   ペア20件 →  5.4秒 / 固有名詞 ✅      ペア50件 → 65.1秒 / 台詞まるごと
    // 遅さは原因ではなく出力破綻の症状。10〜20 件が最適域なので上限を設ける。
    // （保存側は既に sampleRecentPairs(pairs, 5) で絞っており、抽出側だけ全件だった）
    const sanitizedPairs = series.recentPairs
      .slice(0, EXTRACTION_PAIRS_PER_RUN)
      .map(sanitizePairForNano)
      .filter(Boolean);
    // series.js の runExtraction と同じく 'ja' 固定（両者の挙動を揃えるため）
    const targetLang = 'ja';
    const glossaryLangMap = (series.glossary && series.glossary[targetLang]) || {};
    const prompt = buildExtractionPrompt(
      sanitizedPairs,
      Object.keys(glossaryLangMap),
      series.rejectedOriginals || []
    );

    let candidates = [];
    let success = false;
    let session = null;
    const controller = new AbortController();
    // 冷えた状態ではウォームアップ ≈18s + 生成 ≈8s ≒ 26s かかる（実測）。
    // 30 秒では余裕が無く実機で abort していたため 60 秒にする
    const timeoutId = setTimeout(() => controller.abort(), EXTRACTION_NANO_TIMEOUT_MS);
    try {
      // topK と temperature は両方指定が必須（片方だけは NotSupportedError）
      session = await self.LanguageModel.create({
        temperature: 0,
        topK: 1,
        expectedInputs: [{ type: 'text', languages: ['en', 'ja'] }],
        expectedOutputs: [{ type: 'text', languages: ['ja', 'en'] }],
      });
      const responseText = await session.prompt(prompt, { signal: controller.signal });
      candidates = parseCandidatesJson(responseText);
      success = true;
    } catch (err) {
      // 握り潰すと原因が一切追えなくなる（実機でこれに嵌った）。失敗理由は残す
      console.warn('[gloss] 用語抽出に失敗:', err && err.name, err && err.message);
      success = false;
    } finally {
      clearTimeout(timeoutId);
      if (session) { try { session.destroy(); } catch { /* destroy 失敗は無視 */ } }
    }

    // success:false でも呼ぶ（extractionRunning の解放と失敗回数の記録を store 側が行う）
    await applyExtractionResult({ seriesId, candidates, success });
  } catch {
    /* 抽出の失敗は翻訳結果に影響させない */
  } finally {
    extractionInFlight.delete(seriesId);
  }
}

// ============================================================
// Phase 7: 固有名詞解説の取得・生成
// ============================================================

const GLOSS_FETCH_TIMEOUT_MS = 10_000;
// 冷えた状態のウォームアップは実測 ≈18s。30 秒だと初回の 1 語が abort しやすく、
// 失敗は 24 時間キャッシュされる（FAILED_TTL_MS）ため代償が大きい。抽出側と揃えて 60 秒
const GLOSS_NANO_TIMEOUT_MS = 60_000;
const GLOSS_CONCURRENCY = 3;            // R-W10: 1 記事平均 35 KB のため絞る
// glossary は 2KB 上限で実質 30 語弱に収まる。1 リクエストあたりの fetch/LLM 呼び出し回数の上限（レビュー Important 1）
const GLOSS_MAX_TERMS_PER_RUN = 30;

// 同一 (seriesId, lang) の先読みを二重に走らせないためのロック
const glossInFlight = new Map();

/** Api-User-Agent を組み立てる（User-Agent は Fetch の禁止ヘッダで送れない・R-W1） */
function glossUserAgent() {
  const v = chrome.runtime.getManifest().version;
  return `Doug-Comic-Translator/${v} (https://github.com/; chrome-extension)`;
}

/** 検索クエリ 1 本を実行し、ゲートを通れば素材を返す。通らなければ null */
async function tryWikipediaQuery(term, seriesName) {
  const url = buildSearchUrl(term, seriesName);
  if (!url) return null;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), GLOSS_FETCH_TIMEOUT_MS);
  let json = null;
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'Api-User-Agent': glossUserAgent() },
    });
    if (!res.ok) return null;
    json = await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timeoutId);
  }

  const page = parseSearchResponse(json);
  if (!page) return null;

  const intro = extractIntro(page.extract);
  const powers = extractPowers(page.extract);
  // 誤ったページを黙って採用しないための唯一の関門（設計書 §1.2）
  if (!passesGate({ intro, powers })) return null;

  return { title: page.title, url: buildPageUrl(page.title), intro, powers };
}

/**
 * en Wikipedia から 1 語ぶんの素材を取る。検証ゲートを通らなければ null。
 *
 * シリーズ名をクエリに混ぜると曖昧さ回避が効く（Vision → Vision (Marvel Comics)）反面、
 * 用語がシリーズ名に含まれる場合は出版物・一覧記事に引っ張られる（実測）:
 *   "Hulk" Immortal Hulk comics → The Incredible Hulk (comic book)  能力節なし
 *   "Daredevil" Daredevil comics → Karen Page                       能力節なし
 * そこでゲートに落ちたときだけシリーズ名を外して 1 回だけ再試行する。
 *
 * 順序が逆だと危険なので入れ替えないこと。シリーズ名無しの単独検索は
 * "Vision" comics → Scarlet Witch のように **ゲートを通る別人** を引くことがあり、
 * シリーズ名付きを先に試すからこそフォールバックが安全に成立する。
 */
async function fetchWikipediaEntry(term, seriesName) {
  const first = await tryWikipediaQuery(term, seriesName);
  if (first) return first;

  // シリーズ名を渡していない場合は再試行しても同じクエリになるので打ち切る
  const s = String(seriesName ?? '').trim();
  if (s === '') return null;

  return tryWikipediaQuery(term, '');
}

/** Nano で解説を生成する。不可・失敗は null */
async function generateWithNano(prompt) {
  if (!(await isNanoAvailableBg())) return null;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), GLOSS_NANO_TIMEOUT_MS);
  let session = null;
  let text = null;
  try {
    // topK と temperature は両方指定が必須（片方だけは NotSupportedError）
    session = await self.LanguageModel.create({
      temperature: 0,
      topK: 1,
      expectedInputs: [{ type: 'text', languages: ['en', 'ja'] }],
      expectedOutputs: [{ type: 'text', languages: ['ja', 'en'] }],
    });
    text = await session.prompt(prompt, { signal: controller.signal });
  } catch (err) {
    console.warn('[gloss] 解説生成に失敗:', err && err.name, err && err.message);
    return null;
  } finally {
    clearTimeout(timeoutId);
    if (session) session.destroy();
  }
  return parseGlossResponse(text);
}

/**
 * Nano が使えない / 失敗した場合のフォールバック。
 * エンジン設定が nano 固定なら呼ばない。
 */
async function generateGlossWithApi(prompt) {
  const { glossEngine = 'auto' } = await chrome.storage.local.get('glossEngine');
  if (glossEngine === 'nano') return null;
  const text = await callTextOnlyProvider(prompt);
  return text ? parseGlossResponse(text) : null;
}

// ソース契約（設計書 §3）。他ソースを足すときはこの配列に 1 要素増やすだけにする。
// 実装は utils/wiki-source.js の純関数を組み合わせた薄い層に留める。
const wikipediaSource = {
  id: SOURCE_ID,
  origin: WIKIPEDIA_ORIGIN,
  fetchEntry: fetchWikipediaEntry,   // (term, seriesName) => { title, url, intro, powers } | null
};

const GLOSS_SOURCES = [wikipediaSource];

/** 全ソースを順に試し、最初に素材を返したものを採用する */
async function fetchFromSources(term, seriesName) {
  for (const source of GLOSS_SOURCES) {
    const granted = await chrome.permissions.contains({ origins: [source.origin] }).catch(() => false);
    if (!granted) continue;
    const material = await source.fetchEntry(term, seriesName);
    if (material) return { ...material, sourceId: source.id };
  }
  return null;
}

/**
 * 1 語ぶんの解説を作る。成功時はエントリ、失敗時は失敗エントリを返す。
 * R-SEC-1a: 翻訳とは独立した LLM 呼び出しにする（buildSeriesPromptSection に合流させない）
 *
 * @param {boolean} nanoOnly true のとき Nano のみを試し、有料 API へは絶対にフォールバックしない。
 *   設計書 §4.1「API フォールバック時は先読みしない」を満たすための先読み専用ゲート（最終レビュー Critical 1）。
 *   Nano が使えず生成できなかった場合は null を返す（=「失敗」としてキャッシュしない。
 *   hover 時に nanoOnly=false で再試行できるようにするため。cf. isUsable の 24h 失敗キャッシュ）
 */
async function buildGlossEntry(term, seriesName, langLabel, nanoOnly = false) {
  const now = Date.now();
  const material = await fetchFromSources(term, seriesName);
  if (!material) return { failed: true, at: now };

  const prompt = buildGlossPrompt({
    term,
    intro: material.intro,
    powers: material.powers,
    langLabel,
  });

  const { glossEngine = 'auto' } = await chrome.storage.local.get('glossEngine');
  let parsed = glossEngine === 'api' ? null : await generateWithNano(prompt);
  if (!parsed) {
    if (nanoOnly) return null; // 先読みでは有料 API を呼ばない。失敗としてキャッシュもしない
    parsed = await generateGlossWithApi(prompt);
  }
  if (!parsed) return { failed: true, at: now };

  // R-W18: 記事本文・抽出テキストは保存しない
  return {
    identity: parsed.identity,
    powers: parsed.powers,
    url: material.url,
    source: material.sourceId,
    at: now,
  };
}

/** 並列度を絞って順に処理する（R-W10） */
async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const i = cursor++;
      results[i] = await worker(items[i], i);
    }
  });
  await Promise.all(runners);
  return results;
}

/**
 * 未生成の語だけ生成してキャッシュに書き戻し、表示可能な解説を返す。
 * @param {boolean} nanoOnly true のとき先読み専用モード（Nano のみ・有料 API 不可）で生成する
 * @returns {Promise<object>} { 原語: { identity, powers, url } }。失敗語は含めない
 */
async function resolveGlossDefs({ seriesId, seriesName, terms, targetLang, langLabel, nanoOnly = false }) {
  const lockKey = `${seriesId}:${targetLang}`;
  // 直前の実行が入れ替わる直前まで Map から見えるようにチェーンする。
  // await の後に別呼び出しが割り込んでも、同じ prev を待った全員が
  // 同一の新しい run に乗る（3 者以上の同時呼び出しでの上書き・多重生成を防ぐ）
  const prev = glossInFlight.get(lockKey);

  const run = (async () => {
    if (prev) await prev.catch(() => {}); // 直前の実行の失敗は無視して続行
    try {
      const now = Date.now();
      const cached = await getGlossDefs(seriesId, targetLang);
      const wanted = Array.isArray(terms) ? [...new Set(terms.filter((t) => typeof t === 'string' && t))] : [];
      let missing = wanted.filter((t) => !isUsable(cached[t], now));

      // 1 リクエストあたりの fetch/LLM 呼び出し回数に上限を設ける（レビュー Important 1）。
      // 超過分は今回は処理しない（黙って落とさず記録だけ残す）
      if (missing.length > GLOSS_MAX_TERMS_PER_RUN) {
        console.debug(`[gloss] missing terms capped: ${missing.length} -> ${GLOSS_MAX_TERMS_PER_RUN}`, seriesId, targetLang);
        missing = missing.slice(0, GLOSS_MAX_TERMS_PER_RUN);
      }

      if (missing.length > 0) {
        // series レコードが無いと putGlossDefs は何も保存せず false を返す（isUsable の失敗抑制が
        // 効かなくなり、毎回同じ語を再フェッチし続ける）。先にレコードの有無を確認し、無ければ
        // そもそも fetch/LLM を開始しない（レビュー Important 2）
        const seriesExists = await getSeries(seriesId);
        if (!seriesExists) {
          console.debug('[gloss] series record not found, skip generation:', seriesId);
        } else {
          // 1 語の失敗（chrome.storage の reject 等）でバッチ全体を巻き添えにしない。
          // 失敗語は failed エントリとして扱い、他の語の結果とキャッシュ書き込みを守る（レビュー Important 3）
          //
          // 語 1 件が完成するたびに即座に putGlossDefs で永続化する。バッチ完了を待って
          // 1 回だけ書き込むと、Service Worker が途中で停止したとき完了済み分まで全て失われる
          // （最終レビュー Important 3）。nanoOnly（先読み）で Nano が使えず生成できなかった語は
          // buildGlossEntry が null を返す。これは「失敗」ではなく「今回は試さなかった」なので
          // キャッシュに書かず missing のまま残し、hover 時の nanoOnly=false な再試行に委ねる
          await mapWithConcurrency(missing, GLOSS_CONCURRENCY, async (term) => {
            const entry = await buildGlossEntry(term, seriesName, langLabel, nanoOnly)
              .catch(() => ({ failed: true, at: now }));
            if (entry === null) return;
            cached[term] = entry;
            const stored = await putGlossDefs(seriesId, targetLang, cached);
            if (!stored) {
              // 直前の存在確認から書き込みまでの間に series が削除された等のレース。戻り値を捨てず記録する
              console.debug('[gloss] putGlossDefs failed after existence check (race?):', seriesId, targetLang);
            }
          });
        }
      }

      // 表示可能なものだけ返す（失敗エントリは content.js に渡さない）
      const out = {};
      for (const term of wanted) {
        const e = cached[term];
        if (!e || e.failed === true) continue;
        out[term] = { identity: e.identity, powers: e.powers, url: e.url };
      }
      return out;
    } catch {
      // chrome.storage 等の予期しない失敗も「ポップアップ無し」に落とす（設計書 §10）
      return {};
    }
  })();

  glossInFlight.set(lockKey, run);
  try {
    return await run;
  } finally {
    // 自分より後に入った新しい run のエントリを誤って消さない
    if (glossInFlight.get(lockKey) === run) glossInFlight.delete(lockKey);
  }
}

// ============================================================
// メッセージハンドラー
// ============================================================
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // 送信元検証: 自拡張IDを確認（同期・高速パス）
  if (sender.id !== chrome.runtime.id) {
    sendResponse({ error: '不正な送信元です' });
    return false;
  }

  // Service Worker再起動後にwhitelistedOriginsが空になる場合を考慮して非同期で処理
  (async () => {
    if (getWhitelistedOrigins().size === 0) await loadWhitelist();
    // タブからのメッセージはホワイトリスト登録済みドメインのみ許可
    // sender.tabがない = popup等の拡張内ページ（自拡張IDチェックで十分）
    // chrome-extension:// URLのタブ = options.html等の拡張内ページ（同上）
    const isWebContentScript = sender.tab && !sender.tab.url.startsWith('chrome-extension://');
    if (isWebContentScript && !_isSiteAllowedPure(sender.tab.url, getWhitelistedOrigins())) {
      sendResponse({ error: '不正な送信元です' });
      return;
    }

    if (message.type === 'KEEP_ALIVE') {
      sendResponse({ ok: true });
      return;
    }

    if (message.type === 'DETECT_SERIES') {
      // whitelist 通過後にのみ実行（isWebContentScript チェック済み）
      try {
        const result = await detectSeries(message.payload);
        sendResponse(result);
      } catch (err) {
        sendResponse(null);
      }
      return;
    }

    if (message.type === 'DETECT_SERIES_NANO') {
      // whitelist 通過後にのみ実行（isWebContentScript チェック済み）
      // Phase 5: Regex/URL で検出できなかったページの Nano fallback
      const url = (message.payload && message.payload.url) || '';
      try {
        let p = nanoDetectionInFlight.get(url);
        if (!p) {
          p = detectSeriesWithNano(message.payload).catch(() => null);
          nanoDetectionInFlight.set(url, p);
          p.finally(() => nanoDetectionInFlight.delete(url));
        }
        const result = await p;
        sendResponse(result);
      } catch (err) {
        sendResponse(null);
      }
      return;
    }

    if (message.type === 'RECORD_SERIES_TRANSLATION') {
      try {
        const payload = message.payload;
        // background.js 側で derivePathPrefix(url) を処理する
        const pathPrefix = derivePathPrefix(payload.url);
        // pairs（Phase 4）が含まれる場合はそのまま転送（pairs が無ければ [] として渡す）
        const result = await recordSeriesTranslation({ ...payload, pathPrefix, pairs: payload.pairs ?? [] });
        sendResponse(result);
        // 抽出が予約されていれば裏で走らせる（応答は待たせない）。
        // これが無いとシリーズ管理画面を開くまで用語集が永久に空のままになる
        if (result && result.extractionDue) {
          runExtractionBg(payload.seriesId).catch(() => { /* 失敗は表示しない */ });
        }
      } catch (err) {
        sendResponse(null);
      }
      return;
    }

    if (message.type === 'GET_SERIES') {
      try {
        const result = await getSeries(message.payload.seriesId);
        sendResponse(result);
      } catch (err) {
        sendResponse(null);
      }
      return;
    }

    if (message.type === 'LIST_SERIES') {
      try {
        const result = await listSeries();
        sendResponse(result);
      } catch (err) {
        sendResponse([]);
      }
      return;
    }

    if (message.type === 'UPDATE_SERIES_FIELD') {
      try {
        const { seriesId, fieldPath, value } = message.payload;
        const result = await updateSeriesField(seriesId, fieldPath, value);
        sendResponse(result);
      } catch (err) {
        sendResponse(false);
      }
      return;
    }

    if (message.type === 'ADD_GLOSSARY_ENTRY') {
      try {
        const { seriesId, targetLang, original, translated } = message.payload;
        const result = await addGlossaryEntry(seriesId, targetLang, original, translated);
        sendResponse(result);
      } catch (err) {
        sendResponse(false);
      }
      return;
    }

    if (message.type === 'REMOVE_GLOSSARY_ENTRY') {
      try {
        const { seriesId, targetLang, original } = message.payload;
        await removeGlossaryEntry(seriesId, targetLang, original);
        sendResponse({ ok: true });
      } catch (err) {
        sendResponse({ error: err.message });
      }
      return;
    }

    if (message.type === 'ADD_EXAMPLE') {
      try {
        const { seriesId, original, translated } = message.payload;
        const result = await addExample(seriesId, { original, translated });
        sendResponse(result);
      } catch (err) {
        sendResponse({ status: 'invalid', examples: [] });
      }
      return;
    }

    if (message.type === 'REMOVE_EXAMPLE') {
      try {
        const { seriesId, index } = message.payload;
        const result = await removeExample(seriesId, index);
        sendResponse(result);
      } catch (err) {
        sendResponse({ examples: [] });
      }
      return;
    }

    if (message.type === 'DELETE_SERIES') {
      try {
        await deleteSeries(message.payload.seriesId);
        sendResponse({ ok: true });
      } catch (err) {
        sendResponse({ error: err.message });
      }
      return;
    }

    // 用語抽出を background 側で実行する（series.js の「実行する」ボタンから使う）。
    // series.js に同じ処理のコピーを持たせると、スキーマ強制・ペア数制限・診断ログの
    // 修正が片方にしか効かなくなるため、実処理は runExtractionBg に一本化する
    if (message.type === 'RUN_EXTRACTION') {
      try {
        await runExtractionBg(message.payload && message.payload.seriesId);
        sendResponse({ status: 'ok' });
      } catch (err) {
        sendResponse({ status: 'error', message: err && err.message });
      }
      return;
    }

    if (message.type === 'ACQUIRE_EXTRACTION_LOCK') {
      try {
        const { seriesId } = message.payload;
        const result = await acquireExtractionLock(seriesId);
        sendResponse(result);
      } catch (err) {
        sendResponse({ status: 'error', error: err.message });
      }
      return;
    }

    if (message.type === 'EXTRACT_GLOSSARY_CANDIDATES') {
      try {
        const { seriesId, candidates, success } = message.payload;
        const result = await applyExtractionResult({ seriesId, candidates, success });
        sendResponse(result);
      } catch (err) {
        sendResponse({ status: 'error', error: err.message });
      }
      return;
    }

    if (message.type === 'REJECT_GLOSSARY_CANDIDATE') {
      try {
        const { seriesId, original } = message.payload;
        const result = await rejectGlossaryCandidate({ seriesId, original });
        sendResponse(result);
      } catch (err) {
        sendResponse({ status: 'error', error: err.message });
      }
      return;
    }

    if (message.type === 'GET_STORAGE_USAGE') {
      try {
        const result = await getStorageUsageInfo();
        sendResponse(result);
      } catch (err) {
        sendResponse(null);
      }
      return;
    }

    if (message.type === 'FETCH_IMAGE') {
      if (!isAllowedImageUrl(message.url)) {
        sendResponse({ error: '許可されていない画像URLです' });
        return;
      }
      try {
        const imageData = await fetchImageAsDataUrl(message.url);
        sendResponse({ imageData });
      } catch (err) {
        sendResponse({ error: err.message });
      }
      return;
    }

    // CAPTURE_REGION: content.js が FETCH_IMAGE で SecurityError を受け取った場合のフォールバック。
    // captureVisibleTab は「<all_urls> 権限」または「能動的な activeTab」が必要。
    // ホスト権限（例: comicbookplus.com/*）だけでは不十分なため、
    // popup.js で *://*/* 権限を取得してからこのハンドラーが有効になる。
    // フロー: content.js SecurityError → CAPTURE_REGION → captureVisibleTab + OffscreenCanvas クロップ
    if (message.type === 'CAPTURE_REGION') {
      if (!sender.tab) {
        sendResponse({ error: 'タブ情報が取得できません' });
        return;
      }
      try {
        const screenshotData = await chrome.tabs.captureVisibleTab(
          sender.tab.windowId,
          { format: 'jpeg', quality: 92 }
        );
        const imageData = message.elementRect
          ? await cropScreenshot(screenshotData, message.elementRect)
          : screenshotData;
        sendResponse({ imageData });
      } catch (err) {
        console.warn('[doug] CAPTURE_REGION 失敗:', err.message);
        sendResponse({ error: `スクリーンキャプチャに失敗しました: ${err.message}` });
      }
      return;
    }

    if (message.type === 'PRELOAD_QUEUE') {
      handlePreloadQueue(message.imageUrls, sender.tab?.id);
      sendResponse({ ok: true });
      return;
    }

    if (message.type === 'ADD_TO_WHITELIST') {
      // chrome.permissions.request は popup.js 側で完了済み
      try {
        await saveToWhitelist(message.origin, message.tabId);
        sendResponse({ ok: true });
      } catch (err) {
        sendResponse({ error: err.message });
      }
      return;
    }

    if (message.type === 'REMOVE_FROM_WHITELIST') {
      try {
        await removeFromWhitelist(message.origin);
        sendResponse({ ok: true });
      } catch (err) {
        sendResponse({ error: err.message });
      }
      return;
    }

    if (message.type === 'GET_WHITELIST') {
      try {
        const { whitelist = [] } = await chrome.storage.sync.get('whitelist');
        sendResponse({ whitelist });
      } catch (err) {
        sendResponse({ error: err.message });
      }
      return;
    }

    if (message.type === 'PREFETCH_GLOSS_DEFS') {
      // 不正なメッセージ（seriesId/targetLang 欠落）は fetch/LLM バッチを始める前に弾く（レビュー Important 2）
      if (!message.seriesId || !message.targetLang) { sendResponse({ started: false }); return; }
      // 先読みは応答を待たせない。結果はキャッシュに入り、後続の GET が拾う
      const { granted } = await chrome.permissions.contains({ origins: [WIKIPEDIA_ORIGIN] })
        .then((ok) => ({ granted: ok }))
        .catch(() => ({ granted: false }));
      if (!granted) { sendResponse({ started: false }); return; }
      // Nano が使えない環境では先読みが Wikipedia を取得しても生成できず（有料APIへは
      // フォールバックしない）、次回の先読みで同じ記事を取り直すだけの無限ループになる
      // （再レビュー Important）。生成できる見込みが無いなら Wikipedia を取りに行かない
      if (!(await isNanoAvailableBg())) { sendResponse({ started: false }); return; }

      // 設計書 §4.1「API フォールバック時は先読みしない」: 先読み経路は Nano のみで生成し、
      // 有料 API へは絶対にフォールバックしない（最終レビュー Critical 1）
      resolveGlossDefs({
        seriesId: message.seriesId,
        seriesName: message.seriesName,
        terms: message.terms,
        targetLang: message.targetLang,
        langLabel: message.langLabel,
        nanoOnly: true,
      }).catch(() => { /* 失敗は表示しない（設計書 §10） */ });
      sendResponse({ started: true });
      return;
    }

    if (message.type === 'GET_GLOSS_DEFS') {
      // 不正なメッセージ（seriesId/targetLang 欠落）は fetch/LLM バッチを始める前に弾く（レビュー Important 2）
      if (!message.seriesId || !message.targetLang) { sendResponse({ defs: {} }); return; }
      const granted = await chrome.permissions.contains({ origins: [WIKIPEDIA_ORIGIN] }).catch(() => false);
      if (!granted) { sendResponse({ defs: {} }); return; }
      try {
        // hover・翻訳完了時の経路は従来どおり API フォールバックを許可する（設計書 §4.1）
        const defs = await resolveGlossDefs({
          seriesId: message.seriesId,
          seriesName: message.seriesName,
          terms: message.terms,
          targetLang: message.targetLang,
          langLabel: message.langLabel,
          nanoOnly: false,
        });
        sendResponse({ defs });
      } catch {
        sendResponse({ defs: {} });
      }
      return;
    }

    // 未知のメッセージタイプ：チャネルを閉じてハングを防ぐ
    sendResponse({});
  })();
  return true; // 非同期応答のためチャネルを保持
});

// ============================================================
// ホワイトリストサイトへの自動注入（次回訪問時）
// ============================================================
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'complete') return;
  if (!tab.url) return;
  try {
    // Service Worker 中間起動時に whitelistedOrigins が空になる場合を考慮して復元
    if (getWhitelistedOrigins().size === 0) await loadWhitelist();
    const origin = new URL(tab.url).origin;
    if (!getWhitelistedOrigins().has(origin)) return;
    await injectToTab(tabId);
  } catch { /* 無効なURL等は無視 */ }
});

// ============================================================
// コンテキストメニュー（右クリック: このサイトで翻訳 ON/OFF）
// ============================================================
function createContextMenu() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: 'doug-toggle-site',
      title: 'Doug: このサイトで翻訳 ON/OFF',
      contexts: ['page'],
    }, () => { void chrome.runtime.lastError; });
  });
}

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== 'doug-toggle-site') return;
  if (!tab?.url) return;
  try {
    const origin = new URL(tab.url).origin;
    if (['chrome:', 'chrome-extension:', 'about:'].includes(new URL(tab.url).protocol)) return;
    if (getWhitelistedOrigins().has(origin)) {
      await removeFromWhitelist(origin);
    } else {
      const granted = await chrome.permissions.request({ origins: [origin + '/*'] });
      if (granted) {
        // captureVisibleTab のために <all_urls> 権限も取得（CDN画像対応）
        await chrome.permissions.request({ origins: ['*://*/*'] }).catch(() => {});
        await saveToWhitelist(origin, tab.id);
      }
    }
  } catch (err) {
    console.error('[doug] コンテキストメニュー処理エラー:', err.message);
  }
});
