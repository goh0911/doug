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
  extractIntro, extractPowers, passesGate, buildPageUrl, isExactTitleMatch, expectedPublisher,
  isTransientHttpStatus, isTransientApiError,
} from './utils/wiki-source.js';
import * as CV from './utils/comicvine-source.js';
import { buildGlossPrompt, parseGlossResponse } from './utils/gloss-summary.js';
import { sanitizePairForNano, parseCandidatesJson, buildExtractionPrompt } from './utils/nano-extract.js';
import { isUsable } from './utils/gloss-cache.js';
import { planGlossGeneration, seriesNameAttempts, acceptsNonExactTitle, retryAfterMs } from './utils/gloss-policy.js';
import { createSemaphore } from './utils/semaphore.js';

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
      // create() にも signal を渡す（渡さないとウォームアップで固まったとき中断できない）
      signal: controller.signal,
    });
    responseText = await session.prompt(prompt, { signal: controller.signal });
  } catch {
    return null;
  } finally {
    clearTimeout(timeoutId);
    if (session) { try { session.destroy(); } catch { /* destroy 失敗は無視 */ } }
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

// 1 回の抽出で Nano に渡すペア数の上限。
//
// 長らく 10 だった。20 ペアで「固有名詞ではなく台詞を丸ごと返す」破綻を再現した
// ためだが、あの破綻の真因はペア数ではなく訳ゆれ検出の出力スキーマだった
// （utils/nano-extract.js の buildExtractionPrompt 参照）。プロンプトを直したあと
// 測り直すと、ペア数を増やしても破綻しない（2026-08-05 実機実測）:
//   10 ペア → 14.5s / 丸写し 0 件 / 新規 0 件
//   20 ペア →  2.5s / 丸写し 0 件 / 新規 3 件
//   33 ペア →  2.3s / 丸写し 0 件 / 新規 1 件
// 増やすほど良いわけではなく 20 前後が頭打ち（33 では逆に減る）。
//
// 10 のままだと recentPairs が減らない。1 翻訳で 10 件積まれ（PAIRS_PER_TRANSLATION）
// 1 抽出で 10 件消えるので出入りが釣り合い、実機で 33 件まで滞留していた。消費は
// 古い側からなので、いま読んでいるページのペアには順番が回らず、RECENT_PAIRS_MAX（50）
// に達すると一度も抽出されないまま捨てられる。20 にすると毎回 10 件ずつ減って捌ける。
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
  if (!seriesId || extractionInFlight.has(seriesId)) return 0;
  if (!(await isNanoAvailableBg())) return 0;

  extractionInFlight.add(seriesId);
  try {
    const lockResult = await acquireExtractionLock(seriesId);
    if (!lockResult || lockResult.status !== 'ok') return 0; // locked / not-found

    const series = lockResult.series;
    if (!series || !Array.isArray(series.recentPairs) || series.recentPairs.length === 0) {
      // ペアが無ければロックだけ解放する（success:true, candidates:[]）
      await applyExtractionResult({ seriesId, candidates: [], success: true });
      return 0;
    }

    // 渡すペア数は EXTRACTION_PAIRS_PER_RUN で絞る（根拠と実測はその定義を参照）。
    // recentPairs 全件（上限 50）を渡すのは今でも多すぎる。
    //
    // 古い側から FIFO で消費する。成功時に消したのは「渡したぶんだけ」でなければ
    // ならないので、件数を applyExtractionResult に伝える（全消去だと渡していない
    // 新しい側のペアが一度も抽出されないまま消える）。
    // FIFO のままにしているのは、新しい側から取ると読むのが速いときに古いペアが
    // 一度も評価されずに RECENT_PAIRS_MAX で捨てられるため。消費数を 20 に上げて
    // 滞留が捌けるようになったので、新しいページには 1〜2 回の翻訳で順番が回る
    const consumedPairs = Math.min(series.recentPairs.length, EXTRACTION_PAIRS_PER_RUN);
    const sanitizedPairs = series.recentPairs
      .slice(0, consumedPairs)
      .map(sanitizePairForNano)
      .filter(Boolean);
    // series.js の runExtraction と同じく 'ja' 固定（両者の挙動を揃えるため）
    const targetLang = 'ja';
    const glossaryLangMap = (series.glossary && series.glossary[targetLang]) || {};
    // addedAt の新しい順で渡す。Object.keys() をそのまま渡すと辞書順になり
    // （chrome.storage がキーをソートして保持するため）、除外リストの 10 枠が
    // 毎回アルファベット末尾の語で埋まる。詳細は buildExtractionPrompt のコメント
    const recentOriginals = Object.entries(glossaryLangMap)
      .sort(([, a], [, b]) => (b?.addedAt ?? 0) - (a?.addedAt ?? 0))
      .map(([k]) => k);
    const prompt = buildExtractionPrompt(
      sanitizedPairs,
      recentOriginals,
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
      // signal は create() にも渡す。prompt() だけに渡していると、モデルの
      // ダウンロード／ウォームアップで create() が固まったときタイムアウトが効かず、
      // in-flight ロックが Service Worker の生存期間中ずっと解放されない
      session = await self.LanguageModel.create({
        temperature: 0,
        topK: 1,
        expectedInputs: [{ type: 'text', languages: ['en', 'ja'] }],
        expectedOutputs: [{ type: 'text', languages: ['ja', 'en'] }],
        signal: controller.signal,
      });
      const startedAt = Date.now();
      const responseText = await session.prompt(prompt, { signal: controller.signal });
      const elapsed = Date.now() - startedAt;
      candidates = parseCandidatesJson(responseText);
      // 「候補 0 件」は AbortError と違って例外にならないため、記録しないと
      // 「固有名詞が無かった」のか「出力が破綻した」のか永久に区別できない。
      // 実機で 15 ペア 37 秒・0 件という不可解な結果に当たったので常時ログにする
      const raw = String(responseText ?? '');
      // 既定では見えない debug に置く（0 件のときだけ下の warn で目立たせる）
      console.debug(
        '[gloss] 用語抽出:', `${sanitizedPairs.length}ペア`, `${elapsed}ms`,
        `応答${raw.length}字`, `候補${candidates.length}件`
      );
      if (candidates.length === 0) {
        console.warn('[gloss] 候補 0 件。Nano の生応答(先頭800字):', raw.slice(0, 800));
      }
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
    // consumedPairs は success:true の経路でしか使われない（失敗時にペアを捨てない）
    const applied = await applyExtractionResult({ seriesId, candidates, success, consumedPairs });
    return (applied && applied.added) || 0;
  } catch {
    /* 抽出の失敗は翻訳結果に影響させない */
    return 0;
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
// 先読み（非対話）で付ける maxlag（秒）。MediaWiki が非対話処理に推奨
const GLOSS_PREFETCH_MAXLAG = 5;

// 同一 (seriesId, lang) の先読みを二重に走らせないためのロック
const glossInFlight = new Map();

/** Api-User-Agent を組み立てる（User-Agent は Fetch の禁止ヘッダで送れない・R-W1） */
function glossUserAgent() {
  const v = chrome.runtime.getManifest().version;
  return `Doug-Comic-Translator/${v} (https://github.com/goh0911/doug; chrome-extension)`;
}

// 検索 1 本の結果。'miss'（その語には記事が無い）と 'transient'（レート制限・通信断）を
// 区別する。区別しないと一時的失敗が 24 時間の「解説なし」として焼き付く
// （実測: 別プロセスのレート制限に巻き込まれ、17 語中 14 語が丸一日失敗扱いになった）
const QUERY_MISS = { status: 'miss', hit: null };
const QUERY_TRANSIENT = { status: 'transient', hit: null };

// レート制限に当たったあと、この時刻までは Wikipedia へ投げない。
// 一時的失敗をキャッシュしなくなった分、待機が無いと 1 バッチ最大 30 語が
// 一斉に再試行して同じ origin を再度圧迫する（Codex 指摘 #4）
let glossFetchCooldownUntil = 0;

// Wikipedia への同時接続を Service Worker 全体で絞る。GLOSS_CONCURRENCY は
// 1 回の resolveGlossDefs 内の上限でしかなく、別シリーズ・別言語の解説生成が
// 同時に走ると合算されて同じ origin を圧迫する（Codex 指摘 #4）
const glossFetchSemaphore = createSemaphore(GLOSS_CONCURRENCY);

/** 検索クエリ 1 本を実行する。@returns {{status:'ok'|'miss'|'transient', hit:object|null}} */
async function tryWikipediaQuery(term, seriesName, publisher, opts = {}) {
  const url = buildSearchUrl(term, seriesName, opts);
  if (!url) return QUERY_MISS;
  // クールダウン中は投げない。失敗ではなく「今回は試さなかった」なのでキャッシュもしない
  if (Date.now() < glossFetchCooldownUntil) return QUERY_TRANSIENT;

  // 待っている間にクールダウンへ入ることがあるので、スロット取得後にもう一度見る
  await glossFetchSemaphore.acquire();
  if (Date.now() < glossFetchCooldownUntil) {
    glossFetchSemaphore.release();
    return QUERY_TRANSIENT;
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), GLOSS_FETCH_TIMEOUT_MS);
  let json = null;
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'Api-User-Agent': glossUserAgent() },
    });
    if (!res.ok) {
      // ステータスを捨てると 429 と 404 の区別が後から一切つかない
      console.debug('[gloss] Wikipedia HTTP', res.status, term);
      if (!isTransientHttpStatus(res.status)) return QUERY_MISS;
      glossFetchCooldownUntil = Date.now() + retryAfterMs(res.headers.get('Retry-After'));
      return QUERY_TRANSIENT;
    }
    json = await res.json();
  } catch {
    // 通信断・タイムアウト（AbortError）はいずれも一時的
    return QUERY_TRANSIENT;
  } finally {
    clearTimeout(timeoutId);
    glossFetchSemaphore.release();
  }

  // maxlag / readonly / ratelimited は HTTP 200 で返るため res.ok を素通りする
  if (isTransientApiError(json)) {
    console.debug('[gloss] Wikipedia API error', json.error.code, term);
    // maxlag は DB 遅延の解消を待つだけでよいので、レート制限より短く見積もる
    glossFetchCooldownUntil = Date.now() + retryAfterMs(null, 5_000);
    return QUERY_TRANSIENT;
  }

  const page = parseSearchResponse(json);
  if (!page) return QUERY_MISS;

  const intro = extractIntro(page.extract);
  const powers = extractPowers(page.extract);
  // 誤ったページを黙って採用しないための唯一の関門（設計書 §1.2）。
  // term / title を渡さないと記事の同一性を検証できない（別人の解説が出る）
  if (!passesGate({ term, title: page.title, intro, powers, publisher })) return QUERY_MISS;

  return { status: 'ok', hit: { title: page.title, url: buildPageUrl(page.title), intro, powers } };
}

/**
 * en Wikipedia から 1 語ぶんの素材を取る。検証ゲートを通らなければ null。
 *
 * シリーズ名をクエリに混ぜると曖昧さ回避が効く（Vision → Vision (Marvel Comics)）反面、
 * 用語がシリーズ名に含まれる場合は出版物・一覧記事に引っ張られる（実測）:
 *   "Hulk" Immortal Hulk comics → The Incredible Hulk (comic book)  能力節なし
 *   "Daredevil" Daredevil comics → Karen Page                       能力節なし
 * そこで 1 本目が素材を返さなかったときにシリーズ名を外して 1 回だけ再試行する。
 * 「返さなかった」にはゲート却下だけでなく 0 件ヒット・通信失敗・タイムアウトも含む
 * （tryWikipediaQuery はいずれも 'miss' を返す）。再試行は 1 回だけなので上限は 2 コール。
 * ただし一時的失敗（'transient'）のときは再試行せず即座に打ち切る。レート制限中に
 * 2 本目を撃っても状況を悪化させるだけで、しかも失敗としてキャッシュしてはいけない。
 *
 * 順序が逆だと危険なので入れ替えないこと。シリーズ名無しの単独検索は
 * "Vision" comics → Scarlet Witch のように **ゲートを通る別人** を引くことがあり、
 * シリーズ名付きを先に試すからこそフォールバックが安全に成立する。
 */
async function fetchWikipediaEntry(term, seriesName, publisher, opts = {}) {
  // 試す順序は utils/gloss-policy.js の seriesNameAttempts が決める（テスト可能にするため）。
  // 先勝ちにせず、タイトルが検索語そのものの結果を優先する。1 語の姓は曖昧で、
  // シリーズ名つきの検索が同姓の別人を 1 位に返すことがある
  // （実測: "BANNER" Immortal Hulk comics → Brian Banner＝ブルースの父）。
  // 完全一致でない結果を採用してよいのはシリーズ名なし検索のときだけ
  // （acceptsNonExactTitle。この条件が無いと上の Brian Banner がそのまま採用される）
  let fallback = null;
  for (const attempt of seriesNameAttempts(seriesName)) {
    const r = await tryWikipediaQuery(term, attempt, publisher, opts);
    // レート制限中に 2 本目を撃っても状況を悪化させるだけなので即座に打ち切る
    if (r.status === 'transient') return { material: null, transient: true };
    if (r.status !== 'ok') continue;
    if (isExactTitleMatch(term, r.hit.title)) return { material: r.hit, transient: false };
    if (!fallback && acceptsNonExactTitle(attempt)) fallback = r.hit;
  }
  return { material: fallback, transient: false };
}

/** Nano で解説を生成する。不可・失敗は null */
// モデルを温める処理が二重に走らないようにする
let nanoWarmUpInFlight = null;
let nanoWarmedAt = 0;
const NANO_WARM_TTL_MS = 5 * 60 * 1000;

/**
 * Nano を短いプロンプトで 1 回叩き、モデルをロードさせておく。
 * コールドスタートは実測 18.3 秒で、2 回目以降は約 0.66 秒（オプションページ実測）。
 * 解説生成の最初の 1 語がこれをまるごと被るのを避ける。
 */
function warmUpNano() {
  if (nanoWarmUpInFlight) return nanoWarmUpInFlight;
  if (Date.now() - nanoWarmedAt < NANO_WARM_TTL_MS) return Promise.resolve();

  nanoWarmUpInFlight = (async () => {
    if (!(await isNanoAvailableBg())) return;
    let session = null;
    try {
      session = await self.LanguageModel.create({
        temperature: 0,
        topK: 1,
        expectedInputs: [{ type: 'text', languages: ['en', 'ja'] }],
        expectedOutputs: [{ type: 'text', languages: ['ja', 'en'] }],
      });
      await session.prompt('ok');
      nanoWarmedAt = Date.now();
    } catch {
      /* 温めの失敗は無視する。対話経路が自前でコールドスタートを被るだけ */
    } finally {
      if (session) { try { session.destroy(); } catch { /* destroy 失敗は無視 */ } }
      nanoWarmUpInFlight = null;
    }
  })();
  return nanoWarmUpInFlight;
}

async function generateWithNano(prompt, term) {
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
      // create() にも signal を渡す（渡さないとウォームアップで固まったとき中断できない）
      signal: controller.signal,
    });
    text = await session.prompt(prompt, { signal: controller.signal });
  } catch (err) {
    console.warn('[gloss] 解説生成に失敗:', err && err.name, err && err.message);
    return null;
  } finally {
    clearTimeout(timeoutId);
    if (session) { try { session.destroy(); } catch { /* destroy 失敗は無視 */ } }
  }
  return parseGlossResponse(text, term);
}

/**
 * Nano が使えない / 失敗した場合のフォールバック。
 * エンジン設定が nano 固定なら呼ばない。
 */
async function generateGlossWithApi(prompt, term) {
  // エンジン判定は呼び出し側の planGlossGeneration に一本化した（二重に持たない）
  const text = await callTextOnlyProvider(prompt);
  return text ? parseGlossResponse(text, term) : null;
}

// ソース契約（設計書 §3）。他ソースを足すときはこの配列に 1 要素増やすだけにする。
// 実装は utils/wiki-source.js の純関数を組み合わせた薄い層に留める。
const wikipediaSource = {
  id: SOURCE_ID,
  origin: WIKIPEDIA_ORIGIN,
  // (term, seriesName, publisher) => { material: {title,url,intro,powers}|null, transient: boolean }
  fetchEntry: fetchWikipediaEntry,
};

/**
 * Comic Vine から 1 語ぶんの素材を取る。サブソース（Wikipedia が記事を持たない
 * 作品固有の施設・組織・脇役を補う）。API キー未設定なら何もせず miss を返す。
 *
 * Wikipedia と違いシリーズ名は使わない。Comic Vine の検索はシリーズ名を足すと
 * ノイズになるうえ、出版社が構造化フィールドで返るため曖昧さ回避が別途効く。
 */
// Comic Vine のレート制御。公式は「1 秒に 1 リクエスト」かつ「リソースあたり
// 1 時間 200 件」。前者を守るための最小間隔、後者に当たったときの待避が下の 2 つ。
const COMICVINE_MIN_INTERVAL_MS = 1100;
const COMICVINE_RATE_LIMIT_COOLDOWN_MS = 60_000;
let comicVineNextAllowedAt = 0;
let comicVineCooldownUntil = 0;

/** 直前の Comic Vine リクエストから最小間隔が空くまで待つ（呼び出し順に直列化される） */
async function comicVineThrottle() {
  const now = Date.now();
  const startAt = Math.max(now, comicVineNextAllowedAt);
  comicVineNextAllowedAt = startAt + COMICVINE_MIN_INTERVAL_MS;
  const wait = startAt - now;
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
}

async function fetchComicVineEntry(term, _seriesName, publisher) {
  const { comicvineApiKey = '' } = await chrome.storage.local.get('comicvineApiKey').catch(() => ({}));
  const url = CV.buildSearchUrl(term, comicvineApiKey);
  if (!url) return { material: null, transient: false }; // キー未設定＝この経路は使わない

  if (Date.now() < glossFetchCooldownUntil) return { material: null, transient: true };
  if (Date.now() < comicVineCooldownUntil) return { material: null, transient: true };
  // Comic Vine は「1 秒に 1 リクエスト」を求めている。同時実行 3 で無間隔に叩くと
  // HTTP 420（Enhance Your Calm）で全滅する（実測 2026-08-05・30 語すべて 420）
  await comicVineThrottle();

  await glossFetchSemaphore.acquire();
  if (Date.now() < glossFetchCooldownUntil) {
    glossFetchSemaphore.release();
    return { material: null, transient: true };
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), GLOSS_FETCH_TIMEOUT_MS);
  let json = null;
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) {
      console.debug('[gloss] ComicVine HTTP', res.status, term);
      if (!isTransientHttpStatus(res.status)) return { material: null, transient: false };
      // レート超過は Comic Vine だけ待避させる。glossFetchCooldownUntil を触ると
      // Wikipedia まで止まる（そちらは制限に掛かっていない）
      comicVineCooldownUntil = Date.now() + Math.max(
        COMICVINE_RATE_LIMIT_COOLDOWN_MS,
        retryAfterMs(res.headers.get('Retry-After'))
      );
      return { material: null, transient: true };
    }
    json = await res.json();
  } catch {
    return { material: null, transient: true };
  } finally {
    clearTimeout(timeoutId);
    glossFetchSemaphore.release();
  }

  // Comic Vine は HTTP 200 のまま status_code でエラーを返す（107 = レート制限）
  const parsed = CV.parseSearchResponse(json);
  if (parsed.status === 'transient') {
    console.debug('[gloss] ComicVine rate limited', term);
    glossFetchCooldownUntil = Date.now() + retryAfterMs(null);
    return { material: null, transient: true };
  }
  if (parsed.status !== 'ok') return { material: null, transient: false };

  // 素の検索は 12 語中 5 語が誤答する（Voltron の Abomination 等）。
  // ゲートを通さずに採用してはいけない
  const hit = CV.pickBestResult(parsed.results, term, publisher);
  return { material: hit ? CV.toMaterial(hit) : null, transient: false };
}

const comicVineSource = {
  id: CV.SOURCE_ID,
  origin: CV.COMICVINE_ORIGIN,
  fetchEntry: fetchComicVineEntry,
  // 権限があってもキーが無ければ何も引けない。失敗キャッシュの指紋に効かせるため、
  // 「使えるか」を権限と分けて表現する
  isConfigured: async () => {
    const { comicvineApiKey = '' } = await chrome.storage.local.get('comicvineApiKey').catch(() => ({}));
    return String(comicvineApiKey).trim() !== '';
  },
};

// 順序が意味を持つ。Wikipedia を先に引く（百科事典的な通史が書かれており、
// 主要キャラでは Comic Vine より記述が厚い）。Comic Vine は Wikipedia が
// 記事を持たない語だけを拾うサブソースとして後ろに置く
const GLOSS_SOURCES = [wikipediaSource, comicVineSource];

/**
 * 解説パイプラインの世代。検証ゲート・プロンプト・素材の取り方を変えたら手で上げる。
 * 上げると既存の失敗キャッシュが失効し、次のホバーで引き直される。
 * ソース構成が変わらない改修（passesGate の緩和など）を実機に届かせる唯一の手段。
 */
// 2: 敬称・階級の略記を正式表記として扱うようにした（DOC DOOM → Doctor Doom）
// 3: Comic Vine の HTTP 420 を一時的失敗として扱う（それ以前は失敗として焼き付いていた）
const GLOSS_PIPELINE_EPOCH = 3;

/**
 * いま実際に引けるソースの id（権限があり、必要な設定も済んでいるもの）
 * @param {{ primaryOnly?: boolean }} [opts] true なら先頭のソース（Wikipedia）だけを使う
 */
async function availableSourceIds({ primaryOnly = false } = {}) {
  const ids = [];
  for (const source of GLOSS_SOURCES) {
    if (primaryOnly && source.id !== SOURCE_ID) continue;
    const granted = await chrome.permissions.contains({ origins: [source.origin] }).catch(() => false);
    if (!granted) continue;
    if (typeof source.isConfigured === 'function' && !(await source.isConfigured().catch(() => false))) continue;
    ids.push(source.id);
  }
  return ids;
}

/**
 * 失敗キャッシュの指紋。「どの世代の・どのソース構成で失敗したか」を表す。
 * これが現在の値と違う失敗エントリは信用しない（utils/gloss-cache.js の isUsable）
 */
async function glossSourcesKey(opts) {
  return `${GLOSS_PIPELINE_EPOCH}:${(await availableSourceIds(opts)).join('+')}`;
}

/** URL からホスト名を取り出す（取れなければ空文字） */
function hostOf(url) {
  try { return new URL(url).hostname; } catch { return ''; }
}

/** シリーズの urlPatterns から最後に見たホスト名を取り出す（無ければ空文字） */
function seriesHost(series) {
  const patterns = Array.isArray(series && series.urlPatterns) ? series.urlPatterns : [];
  if (patterns.length === 0) return '';
  const latest = patterns.reduce((a, b) => ((b.lastSeenAt ?? 0) > (a.lastSeenAt ?? 0) ? b : a));
  try { return new URL(latest.origin).hostname; } catch { return ''; }
}

/**
 * 全ソースを順に試し、最初に素材を返したものを採用する。
 * 素材が無い場合、それが一時的失敗だったかを transient で伝える（失敗キャッシュの判断に使う）
 * @returns {{ material: object|null, transient: boolean }}
 */
async function fetchFromSources(term, seriesName, publisher, opts = {}) {
  // 指紋の算出と同じ「使えるソース」判定を使う。ここがずれると、
  // 引いてもいないソースの id が指紋に混ざる（＝失効の判断が狂う）
  const available = new Set(await availableSourceIds({ primaryOnly: !!opts.primaryOnly }));
  let transient = false;
  for (const source of GLOSS_SOURCES) {
    if (!available.has(source.id)) continue;
    const r = await source.fetchEntry(term, seriesName, publisher, opts);
    if (r && r.material) return { material: { ...r.material, sourceId: source.id }, transient: false };
    if (r && r.transient) transient = true;
  }
  return { material: null, transient };
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
async function buildGlossEntry(term, seriesName, langLabel, nanoOnly = false, publisher = null, sourcesKey = '') {
  const now = Date.now();
  // 失敗エントリには「どの構成で失敗したか」を必ず残す。これが無いと、
  // ソースやゲートを直しても 24 時間は再試行されない
  const failedEntry = { failed: true, at: now, sources: sourcesKey };
  // 先読み（非対話）だけ maxlag を付ける。hover 経路で付けると DB 遅延時に無応答になる
  const { material, transient } = await fetchFromSources(term, seriesName, publisher,
    nanoOnly ? { maxlag: GLOSS_PREFETCH_MAXLAG, primaryOnly: true } : {});
  if (!material) {
    // 一時的失敗（レート制限・通信断・maxlag）は「今回は試さなかった」扱いにして
    // 24 時間の失敗キャッシュに焼き付けない。null は呼び出し側が保存せず次回再試行する
    if (transient) return null;
    return failedEntry;
  }

  const prompt = buildGlossPrompt({
    term,
    intro: material.intro,
    powers: material.powers,
    langLabel,
  });

  const { glossEngine = 'auto' } = await chrome.storage.local.get('glossEngine');
  const plan = planGlossGeneration({ glossEngine, nanoOnly });
  let parsed = plan.tryNano ? await generateWithNano(prompt, term) : null;
  if (!parsed) {
    // 先読み（nanoOnly）では有料 API を呼ばない。失敗としてキャッシュもしない
    if (!plan.allowApiFallback) return nanoOnly ? null : failedEntry;
    parsed = await generateGlossWithApi(prompt, term);
  }
  if (!parsed) return failedEntry;

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
async function resolveGlossDefs({ seriesId, seriesName, terms, targetLang, langLabel, nanoOnly = false, host = '', tabId = null }) {
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
      const sourcesKey = await glossSourcesKey({ primaryOnly: nanoOnly });
      const wanted = Array.isArray(terms) ? [...new Set(terms.filter((t) => typeof t === 'string' && t))] : [];
      let missing = wanted.filter((t) => !isUsable(cached[t], now, sourcesKey));

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
          // 閲覧中のサイトから期待される出版社を引き、検証ゲートに渡す。
          // 別出版社の同名キャラを落とすため（実測: Immortal Hulk の「レジー」に
          // Archie Comics の Reggie Mantle の解説が出ていた）。未知サイトは null＝条件なし
          // 出版社は「今まさに閲覧しているタブ」から引く。保存済みの urlPatterns は
          // 最後に見たホストでしかなく、ミラーや別ストアで読むと実際の閲覧元とずれる
          // （Codex 指摘）。sender.tab が取れない場合だけ保存済みホストに落とす
          const publisher = expectedPublisher(host || seriesHost(seriesExists));
          await mapWithConcurrency(missing, GLOSS_CONCURRENCY, async (term) => {
            const entry = await buildGlossEntry(term, seriesName, langLabel, nanoOnly, publisher, sourcesKey)
              .catch(() => ({ failed: true, at: now, sources: sourcesKey }));
            if (entry === null) return;
            cached[term] = entry;
            const stored = await putGlossDefs(seriesId, targetLang, cached);
            if (!stored) {
              // 直前の存在確認から書き込みまでの間に series が削除された等のレース。戻り値を捨てず記録する
              console.debug('[gloss] putGlossDefs failed after existence check (race?):', seriesId, targetLang);
            }
            // できた語から順にタブへ流す。1 語あたり約 1.9 秒（Wikipedia 取得 + Nano 要約）
            // かかるため、バッチ全体を待つと 13 語で 8〜9 秒どの下線も出ない。
            // content.js 側で currentGlossDefs にマージして貼り直す
            if (typeof tabId === 'number' && entry.failed !== true) {
              chrome.tabs.sendMessage(tabId, {
                type: 'GLOSS_DEFS_PARTIAL',
                payload: {
                  term,
                  def: { identity: entry.identity, powers: entry.powers, url: entry.url, source: entry.source },
                },
              }).catch(() => { /* タブが閉じた・遷移した場合は黙って諦める */ });
            }
          });
        }
      }

      // 表示可能なものだけ返す（失敗エントリは content.js に渡さない）
      const out = {};
      for (const term of wanted) {
        const e = cached[term];
        if (!e || e.failed === true) continue;
        // source を落とさない。落とすと content.js 側が出典ホスト名とラベルを
        // 直書きするしかなくなり、設計書 §3 の「ソースを 1 つ足すだけ」が成り立たない
        out[term] = { identity: e.identity, powers: e.powers, url: e.url, source: e.source };
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
        // 抽出はここでは起動しない。応答の extractionDue を見た content.js が、
        // 解説の取得を終えてから RUN_EXTRACTION を送ってくる。
        //
        // Nano は内部で直列化しているため（実測: 逐次 6 回 5798ms / 並列 6 回 5846ms）、
        // 用語抽出と解説生成は同じ資源を奪い合う。ここで起動すると抽出が先にロックを
        // 取り、抽出が 16〜19 秒（コールドスタート）かかった場合その間ずっと下線が
        // 出ない。下線に直結する解説を先に通し、抽出は後回しにする。
        // 抽出が次のページまで遅れても実害は無い（recentPairs は最大 50 件保持される）。
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
        const seriesId = message.payload && message.payload.seriesId;
        const added = await runExtractionBg(seriesId);
        // 新語が採れたらタブに知らせる。content.js が解説を取り直して下線を貼り直す。
        // series.js（シリーズ管理画面）から呼ばれた場合は sender.tab が無いので送らない
        const tabId = sender.tab && sender.tab.id;
        if (added && typeof tabId === 'number') {
          chrome.tabs.sendMessage(tabId, {
            type: 'GLOSSARY_UPDATED',
            payload: { seriesId, seriesName: (message.payload && message.payload.seriesName) || '' },
          }).catch(() => { /* タブが閉じた・遷移した場合は黙って諦める */ });
        }
        sendResponse({ status: 'ok', added });
      } catch (err) {
        sendResponse({ status: 'error', message: err && err.message });
      }
      return;
    }

    // ACQUIRE_EXTRACTION_LOCK / EXTRACT_GLOSSARY_CANDIDATES は削除した。
    // series.js が抽出処理を自前で持っていた頃の受け口で、実処理を runExtractionBg に
    // 一本化した時点で送信元が無くなった（ロック取得もマージも runExtractionBg 内で行う）。

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

      // 先読みは「モデルを温める」ことだけを行う。
      //
      // 以前は用語集の全語ぶんの解説を作らせていたが、実測で有害と判明した
      // （2026-08-05）。Nano は内部で直列化しており（逐次 6 回 5798ms / 並列 6 回
      // 5846ms）1 語あたり約 1.9 秒かかる。用語集は巻をまたいで育つため未生成が
      // 50 語あり、上限の 30 語でも約 57 秒。resolveGlossDefs はシリーズ単位で
      // ロックをチェーンする（glossInFlight）ので、翻訳後の要求がその後ろで
      // まるまる待たされていた。実機ログの `missing terms capped: 50 -> 30`。
      //
      // 一方、先読みが本当に前倒しできるコストはモデルのコールドスタートである。
      // 実測: 1 回目の prompt 18,275ms / 2 回目以降 約 660ms。ここを温めておけば
      // 対話経路の最初の 1 語が 18 秒短くなる。語の解説そのものは、いまページに
      // 出ている語だけを翻訳直後に作れば足りる（content.js の loadGlossDefs）。
      warmUpNano();
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
          host: hostOf(sender.tab && sender.tab.url),
          tabId: (sender.tab && sender.tab.id) ?? null,
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
