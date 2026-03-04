// popup.js - ポップアップUI（サイト操作・言語設定）

const $ = (id) => document.getElementById(id);
const _statusTimers = new WeakMap();

let currentOrigin = null;
let currentTabId = null;

async function initCurrentSite() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.url) return;
    const url = new URL(tab.url);
    if (!['http:', 'https:'].includes(url.protocol)) return;
    currentOrigin = url.origin;
    currentTabId = tab.id;

    $('currentSiteHost').textContent = url.hostname;

    const res = await chrome.runtime.sendMessage({ type: 'GET_WHITELIST' });
    const whitelist = res?.whitelist || [];
    const isWhitelisted = whitelist.includes(currentOrigin);
    const btn = $('toggleSiteBtn');
    btn.textContent = isWhitelisted ? 'このサイトを無効化' : 'このサイトで翻訳を有効化';
    btn.className = isWhitelisted ? 'btn-secondary' : 'btn-primary';
    btn.style.display = '';
    $('currentSiteSection').style.display = '';

    // 登録済みサイトでスクリーンキャプチャ権限が未付与の場合はボタンを表示
    if (isWhitelisted) {
      const hasCaptureAccess = await chrome.permissions.contains({ origins: ['*://*/*'] });
      $('capturePermSection').style.display = hasCaptureAccess ? 'none' : '';
    }
  } catch { /* 無効なURLは無視 */ }
}

document.addEventListener('DOMContentLoaded', async () => {
  await initCurrentSite();

  const { targetLang = 'ja' } = await chrome.storage.local.get({ targetLang: 'ja' });
  $('targetLang').value = targetLang;

  // 詳細設定を開く
  $('openOptionsBtn').addEventListener('click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('options.html') });
  });

  // 現在のサイト 有効化/無効化ボタン
  $('toggleSiteBtn').addEventListener('click', async () => {
    if (!currentOrigin) return;
    const wlRes = await chrome.runtime.sendMessage({ type: 'GET_WHITELIST' });
    const whitelist = wlRes?.whitelist || [];
    const isWhitelisted = whitelist.includes(currentOrigin);

    if (isWhitelisted) {
      await chrome.runtime.sendMessage({ type: 'REMOVE_FROM_WHITELIST', origin: currentOrigin });
      showStatus('このサイトを無効化しました', 'ok');
      await initCurrentSite();
      return;
    }

    // 権限取得（ユーザージェスチャー内で直接呼ぶ必要あり）
    let granted = false;
    try {
      granted = await chrome.permissions.request({ origins: [currentOrigin + '/*'] });
    } catch (err) {
      showStatus('権限の取得に失敗しました: ' + err.message, 'err');
      return;
    }
    if (!granted) {
      showStatus('権限が拒否されました', 'err');
      return;
    }

    // captureVisibleTab のために <all_urls> 権限も取得（CDN画像対応）
    const hasCaptureAccess = await chrome.permissions.contains({ origins: ['*://*/*'] });
    if (!hasCaptureAccess) {
      await chrome.permissions.request({ origins: ['*://*/*'] }).catch(() => {});
    }

    await chrome.runtime.sendMessage({ type: 'ADD_TO_WHITELIST', origin: currentOrigin, tabId: currentTabId });
    showStatus('このサイトで翻訳を有効化しました', 'ok');
    await initCurrentSite();
  });

  // 既登録サイトのスクリーンキャプチャ権限を追加
  $('grantCapturePermBtn').addEventListener('click', async () => {
    try {
      const granted = await chrome.permissions.request({ origins: ['*://*/*'] });
      if (granted) {
        $('capturePermSection').style.display = 'none';
        showStatus('権限を追加しました。翻訳を再試行してください。', 'ok');
      } else {
        showStatus('権限が拒否されました', 'err');
      }
    } catch (err) {
      showStatus('権限の取得に失敗: ' + err.message, 'err');
    }
  });

  // 翻訳先言語：変更時に即保存
  $('targetLang').addEventListener('change', async () => {
    await chrome.storage.local.set({ targetLang: $('targetLang').value });
    showStatus('言語を変更しました', 'ok');
  });

  // キャッシュクリアボタン
  $('clearCacheBtn').addEventListener('click', async () => {
    const allData = await chrome.storage.local.get(null);
    const cacheKeys = Object.keys(allData).filter(key => key.startsWith('cache:'));
    if (cacheKeys.length === 0) {
      showStatus('キャッシュはありません', 'ok');
      return;
    }
    await chrome.storage.local.remove(cacheKeys);
    showStatus(`${cacheKeys.length}件のキャッシュを削除しました`, 'ok');
  });
});

function showStatus(msg, type) {
  const el = $('status');
  el.textContent = msg;
  el.style.color = type === 'err' ? '#f44336' : '#4caf50';
  el.classList.add('show');
  clearTimeout(_statusTimers.get(el));
  _statusTimers.set(el, setTimeout(() => el.classList.remove('show'), 5000));
}
