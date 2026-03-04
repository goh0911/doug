// preload.js - 先読み翻訳（キュー制御）

import { getSettings } from './settings.js';
import { PROVIDER_KEY_MAP, handleImageTranslation } from './translate.js';
import { getCachedTranslation } from './cache.js';
import { fetchImageAsDataUrl } from './image.js';
import { isAllowedImageUrl } from './utils/url-utils.js';

let preloadQueue = [];         // 翻訳待ちURL配列
let preloadProcessing = false; // 処理ループ実行中フラグ
let preloadTabId = null;       // 先読みリクエスト元のタブID
let preloadTotal = 0;          // キュー全体の件数
let preloadProcessed = 0;      // 処理済み件数
const prefetchedImages = new Map(); // 先行fetch済み画像 Map<url, dataUrl>
const PRELOAD_CONCURRENCY = 1;      // 並列翻訳数（Gemini無料枠15RPM対応のため直列）
const PRELOAD_MAX_QUEUE = 50;       // キュー上限
const PRELOAD_SESSION_KEY = 'doug-preload-session'; // SW再起動跨ぎのセッション保存キー
const PRELOAD_ALARM = 'doug-preload';               // chrome.alarms キー
let preloadDebounceTimer = null;    // デバウンス用タイマー

// SW再起動に備えてキュー状態をセッションストレージに保存
async function savePreloadSession() {
  try {
    await chrome.storage.session.set({
      [PRELOAD_SESSION_KEY]: {
        queue: preloadQueue.slice(),
        tabId: preloadTabId,
        total: preloadTotal,
        processed: preloadProcessed,
      },
    });
  } catch { /* 無視 */ }
}

// セッション保存とバックアップアラームをクリア
async function clearPreloadSession() {
  try {
    await chrome.storage.session.remove(PRELOAD_SESSION_KEY);
    await chrome.alarms.clear(PRELOAD_ALARM);
  } catch { /* 無視 */ }
}

// SW再起動後にアラームから呼び出され、セッション状態を復元して再開する
export async function resumePreloadQueue() {
  try {
    const data = await chrome.storage.session.get(PRELOAD_SESSION_KEY);
    const session = data[PRELOAD_SESSION_KEY];
    if (!session || !session.queue || session.queue.length === 0) return;
    preloadQueue = session.queue;
    preloadTabId = session.tabId;
    preloadTotal = session.total;
    preloadProcessed = session.processed;
    prefetchedImages.clear();
    if (!preloadProcessing) {
      preloadProcessing = true;
      processPreloadQueue();
    }
  } catch { /* 無視 */ }
}

export async function handlePreloadQueue(imageUrls, tabId) {
  if (!imageUrls || imageUrls.length === 0) return;
  // prefetch OFF なら何もしない（進捗バーも表示しない）
  const settings = await getSettings();
  if (!settings.prefetch) {
    clearTimeout(preloadDebounceTimer);
    return;
  }
  // Blob URLはbackground.jsからfetchできないため除外
  const normalUrls = imageUrls.filter(u => isAllowedImageUrl(u));
  if (normalUrls.length === 0) return;
  // キュー上限を超えるURLは切り捨て
  const clampedUrls = normalUrls.slice(0, PRELOAD_MAX_QUEUE);
  // デバウンス: 短時間の連続呼び出しを抑制（最後の呼び出しから500ms後に実行）
  clearTimeout(preloadDebounceTimer);
  preloadDebounceTimer = setTimeout(() => {
    // キューを置換 + 進捗リセット + 先行fetchキャッシュクリア + 古いセッションをクリア
    preloadQueue = clampedUrls;
    preloadTabId = tabId;
    preloadTotal = clampedUrls.length;
    preloadProcessed = 0;
    prefetchedImages.clear();
    clearPreloadSession();
    sendPreloadProgress('active');
    // 処理ループ未実行なら開始（実行中なら既存ループが新キューを処理）
    if (!preloadProcessing) {
      preloadProcessing = true; // 二重起動を確実に防ぐため呼び出し前にセット
      processPreloadQueue();
    }
  }, 500);
}

async function processPreloadQueue() {
  preloadProcessing = true;

  try {
    const settings = await getSettings();
    if (!settings.prefetch) return;

    const provider = settings.apiProvider || 'gemini';
    if (provider !== 'ollama') {
      const apiKey = settings[PROVIDER_KEY_MAP[provider]];
      if (!apiKey) return;
    }

    let isFirstBatch = true;

    while (preloadQueue.length > 0) {
      // キューから最大PRELOAD_CONCURRENCY件を取り出す
      const batch = preloadQueue.splice(0, PRELOAD_CONCURRENCY);

      // 次のバッチの画像を先行fetchする（現在処理中でないもの）
      const nextUrls = preloadQueue.slice(0, PRELOAD_CONCURRENCY);
      for (const nextUrl of nextUrls) {
        if (!prefetchedImages.has(nextUrl)) {
          // 先行fetchを非同期で開始（awaitしない）
          fetchImageAsDataUrl(nextUrl)
            .then(dataUrl => { prefetchedImages.set(nextUrl, dataUrl); })
            .catch(() => { /* 先行fetchの失敗は無視 */ });
        }
      }

      // リクエスト間ディレイ（初回以外）: Gemini無料枠15RPM制限に対応（4200ms = 余裕を持って14RPM）
      // SW再起動に備えてセッション保存 + バックアップアラームを設定（4.2s経過後にクリア）
      if (!isFirstBatch) {
        await savePreloadSession();
        chrome.alarms.create(PRELOAD_ALARM, { delayInMinutes: 1 }); // SW再起動時の復帰用バックアップ
        await new Promise(r => setTimeout(r, 4200));
        chrome.alarms.clear(PRELOAD_ALARM).catch(() => {});
      }
      isFirstBatch = false;

      // バッチ内の各アイテムを並列実行
      const promises = batch.map(url => processPreloadItem(url, settings));
      await Promise.allSettled(promises);
    }

  } finally {
    prefetchedImages.clear();
    preloadProcessed = preloadTotal; // キュー置換によるカウントズレを補正して必ず100%で終了
    sendPreloadProgress('done');
    preloadProcessing = false;
    clearPreloadSession().catch(() => {});
  }
}

// 先読みキューの1アイテムを処理
async function processPreloadItem(url, settings) {
  const shortUrl = url.split('/').pop()?.split('?')[0] || url;
  try {
    // キャッシュ済みならスキップ（進捗は進める）
    const preloadProvider = settings.apiProvider || 'gemini';
    const preloadModelMap = {
      gemini: settings.geminiModel || 'gemini-2.5-flash-lite',
      claude: settings.claudeModel || 'claude-sonnet-4-6',
      openai: settings.openaiModel || 'gpt-4o-mini',
      ollama: settings.ollamaModel || 'qwen3-vl:8b',
    };
    const existing = await getCachedTranslation(url, settings.targetLang, preloadProvider, preloadModelMap[preloadProvider] || '');
    if (existing) {
      preloadProcessed++;
      sendPreloadProgress('active');
      return;
    }

    // 先行fetch済みの画像があればそれを使う、なければfetch
    let imageData;
    if (prefetchedImages.has(url)) {
      imageData = prefetchedImages.get(url);
      prefetchedImages.delete(url);
    } else {
      imageData = await fetchImageAsDataUrl(url);
    }

    const dims = getImageDimsFromDataUrl(imageData);
    await handleImageTranslation(imageData, url, dims, { prefetch: true });
  } catch (err) {
    console.warn(`[Doug preload] エラー: ${shortUrl}`, err.message);
  }

  preloadProcessed++;
  sendPreloadProgress('active');
}

function sendPreloadProgress(state) {
  if (!preloadTabId) return;
  chrome.tabs.sendMessage(preloadTabId, {
    type: 'PRELOAD_PROGRESS',
    state,
    current: preloadProcessed,
    total: preloadTotal,
  }).catch(() => {});
}

// base64画像データからサイズを取得（Service Worker用）
// PNG IHDR / JPEG SOF マーカーをバイナリ解析。失敗時はデフォルト値にフォールバック。
function getImageDimsFromDataUrl(dataUrl) {
  try {
    const base64 = dataUrl.split(',')[1];
    if (!base64) return { width: 1024, height: 1536 };
    // 最初の4096 base64文字（≈3KB）のみデコード
    const binStr = atob(base64.substring(0, 4096));
    const bytes = new Uint8Array(binStr.length);
    for (let i = 0; i < binStr.length; i++) bytes[i] = binStr.charCodeAt(i);

    // PNG: シグネチャ後の IHDR チャンクから幅・高さを読み取る
    if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes.length >= 24) {
      const w = (bytes[16] << 24 | bytes[17] << 16 | bytes[18] << 8 | bytes[19]) >>> 0;
      const h = (bytes[20] << 24 | bytes[21] << 16 | bytes[22] << 8 | bytes[23]) >>> 0;
      if (w > 0 && h > 0) return { width: w, height: h };
    }

    // JPEG: SOF マーカー（FF C0〜FF CF、ただし C4/C8/CC を除く）を走査
    if (bytes[0] === 0xFF && bytes[1] === 0xD8) {
      let i = 2;
      while (i + 8 < bytes.length) {
        if (bytes[i] !== 0xFF) break;
        const marker = bytes[i + 1];
        const segLen = (bytes[i + 2] << 8) | bytes[i + 3];
        if (segLen < 2) break; // 不正なセグメント長（無限ループ防止）
        if (marker >= 0xC0 && marker <= 0xCF && marker !== 0xC4 && marker !== 0xC8 && marker !== 0xCC) {
          const h = (bytes[i + 5] << 8) | bytes[i + 6];
          const w = (bytes[i + 7] << 8) | bytes[i + 8];
          if (w > 0 && h > 0) return { width: w, height: h };
        }
        i += 2 + segLen;
      }
    }
  } catch { /* パース失敗時はデフォルト値にフォールバック */ }
  return { width: 1024, height: 1536 };
}
