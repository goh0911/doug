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
import { handleImageTranslation } from './translate.js';
import { handlePreloadQueue, resumePreloadQueue } from './preload.js';

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
        { forceRefresh: !!message.forceRefresh }
      );
      if (!portDisconnected) port.postMessage(result);
    } catch (err) {
      if (!portDisconnected) port.postMessage({ error: err.message });
    }
  });
});

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
