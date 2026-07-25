# 再翻訳ボタン & API使用量カウンター 実装計画

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** オーバーレイホバーで再翻訳ボタンを表示し、オプションページにAPI使用回数を表示する

**Architecture:**
- 再翻訳: `forceRefresh` フラグをPort経由でbackground.jsに渡しキャッシュスキップ。ボタンはoverlayContainer右下に配置し、`document.mousemove` でtargetEl範囲内か判定して表示/非表示切替
- APIカウンター: background.jsでAPI成功時に `chrome.storage.local` の `apiStats` をインクリメント。options.jsで読み込み表示＋リセット

**Tech Stack:** Chrome Extension MV3, vanilla JS, content.css

---

## Task 1: 再翻訳ボタン — CSS追加

**Files:**
- Modify: `content.css`

**Step 1: スタイルをcontent.cssの末尾に追加する**

```css
/* 再翻訳ボタン（オーバーレイコンテナ右下・ホバーで表示） */
.mut-reload-btn {
  position: absolute;
  bottom: 8px;
  right: 8px;
  width: 32px;
  height: 32px;
  border-radius: 50%;
  border: none;
  background: rgba(26, 26, 46, 0.85);
  color: #fff;
  font-size: 16px;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  opacity: 0;
  transition: opacity 0.2s, background 0.15s;
  pointer-events: none;
  z-index: 1;
}
.mut-reload-btn.mut-reload-visible {
  opacity: 1;
  pointer-events: auto;
}
.mut-reload-btn:hover {
  background: rgba(26, 26, 46, 1);
}
```

**Step 2: 確認**

content.cssをブラウザで読み込みエラーがないこと（拡張機能リロードで確認）

---

## Task 2: 再翻訳ボタン — content.js の `translateCurrentPage` に `forceRefresh` 引数追加

**Files:**
- Modify: `content.js`

**Step 1: 関数シグネチャを変更する**

`async function translateCurrentPage()` を `async function translateCurrentPage(forceRefresh = false)` に変更。

**Step 2: `translateImage` 呼び出しに `forceRefresh` を渡す**

現在の該当行:
```js
const response = await translateImage(imageData, imageUrl);
```
変更後:
```js
const response = await translateImage(imageData, imageUrl, forceRefresh);
```

**Step 3: `translateImage` 関数シグネチャを変更する**

現在:
```js
async function translateImage(imageDataUrl, imageUrl) {
```
変更後:
```js
async function translateImage(imageDataUrl, imageUrl, forceRefresh = false) {
```

**Step 4: Ollamaルートのコメント追加（Ollamaはキャッシュなしのため forceRefresh 不要）**

Ollamaブロックは変更不要（content.js内で直接呼び出し、キャッシュ非対象）。

**Step 5: Portメッセージに `forceRefresh` を含める**

現在:
```js
port.postMessage({ type: 'TRANSLATE_IMAGE', imageData: imageDataUrl, imageUrl: imageUrl });
```
変更後:
```js
port.postMessage({ type: 'TRANSLATE_IMAGE', imageData: imageDataUrl, imageUrl: imageUrl, forceRefresh });
```

---

## Task 3: 再翻訳ボタン — background.js のキャッシュスキップ対応

**Files:**
- Modify: `background.js`

**Step 1: Portメッセージハンドラで `forceRefresh` を `options` に渡す**

現在の `port.onMessage.addListener` 内の `handleImageTranslation` 呼び出し:
```js
const result = await handleImageTranslation(message.imageData, message.imageUrl, message.imageDims);
```
変更後:
```js
const result = await handleImageTranslation(
  message.imageData,
  message.imageUrl,
  message.imageDims,
  { forceRefresh: !!message.forceRefresh }
);
```

**Step 2: `handleImageTranslation` のキャッシュ読み込みを `forceRefresh` でスキップする**

現在:
```js
if (cacheKey) {
  const cached = await getCachedTranslation(cacheKey, settings.targetLang);
  if (cached) {
    return { translations: cached, fromCache: true };
  }
}
```
変更後:
```js
if (cacheKey && !options?.forceRefresh) {
  const cached = await getCachedTranslation(cacheKey, settings.targetLang);
  if (cached) {
    return { translations: cached, fromCache: true };
  }
}
```

---

## Task 4: 再翻訳ボタン — content.js の `renderOverlays` にボタンを追加

**Files:**
- Modify: `content.js`

**Step 1: `renderOverlays` 関数内、`overlayContainer` を `getUIParent().appendChild(overlayContainer)` する直前にボタン要素を追加する**

```js
// 再翻訳ボタン（右下にホバーで表示）
const reloadBtn = document.createElement('button');
reloadBtn.className = 'mut-reload-btn';
reloadBtn.title = '再翻訳（キャッシュをスキップ）';
reloadBtn.insertAdjacentHTML('afterbegin',
  '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">' +
  '<path d="M23 4v6h-6"/>' +
  '<path d="M1 20v-6h6"/>' +
  '<path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>' +
  '</svg>');
reloadBtn.addEventListener('click', () => translateCurrentPage(true));
overlayContainer.appendChild(reloadBtn);
```

**Step 2: `observePosition` 内のクリーンアップを拡張してmousemoveリスナーも削除する**

`observePosition` 関数内、`overlayContainer._cleanup = ...` より前に以下を追加する:

```js
// マウス位置でリロードボタンを表示/非表示
let reloadHideTimer = null;
const mouseMoveHandler = (e) => {
  if (!overlayContainer) return;
  const btn = overlayContainer.querySelector('.mut-reload-btn');
  if (!btn) return;
  const r = targetEl.getBoundingClientRect();
  const inRect = e.clientX >= r.left && e.clientX <= r.right &&
                 e.clientY >= r.top  && e.clientY <= r.bottom;
  if (inRect) {
    clearTimeout(reloadHideTimer);
    btn.classList.add('mut-reload-visible');
  } else {
    clearTimeout(reloadHideTimer);
    reloadHideTimer = setTimeout(() => btn.classList.remove('mut-reload-visible'), 300);
  }
};
document.addEventListener('mousemove', mouseMoveHandler, { passive: true });
```

**Step 3: 既存の `overlayContainer._cleanup` に mousemove 削除を追加する**

現在の `overlayContainer._cleanup`:
```js
overlayContainer._cleanup = () => {
  resizeObserver.disconnect();
  window.removeEventListener('scroll', scrollHandler);
  window.removeEventListener('resize', scrollHandler);
};
```
変更後:
```js
overlayContainer._cleanup = () => {
  resizeObserver.disconnect();
  window.removeEventListener('scroll', scrollHandler);
  window.removeEventListener('resize', scrollHandler);
  document.removeEventListener('mousemove', mouseMoveHandler);
  clearTimeout(reloadHideTimer);
};
```

---

## Task 5: APIカウンター — background.js に `incrementApiStats` 追加

**Files:**
- Modify: `background.js`

**Step 1: `incrementApiStats` 関数を追加する（`handleImageTranslation` の直前あたり）**

```js
async function incrementApiStats(provider) {
  try {
    const { apiStats = {} } = await chrome.storage.local.get('apiStats');
    apiStats[provider] = (apiStats[provider] || 0) + 1;
    if (!apiStats.lastReset) apiStats.lastReset = Date.now();
    await chrome.storage.local.set({ apiStats });
  } catch { /* storage エラーは無視 */ }
}
```

**Step 2: `handleImageTranslation` の翻訳成功後（`return { translations }` の直前）に呼び出す**

```js
// 翻訳成功時のみカウント（キャッシュヒット時・エラー時はカウントしない）
await incrementApiStats(provider);
return { translations };
```

---

## Task 6: APIカウンター — options.html にセクション追加

**Files:**
- Modify: `options.html`

**Step 1: 保存ボタンの `<div class="actions">` の直前に以下を挿入する**

```html
<div class="section" id="apiStatsSection">
  <label>API使用回数</label>
  <table class="whitelist-table">
    <thead>
      <tr>
        <th>プロバイダー</th>
        <th style="text-align:right">回数</th>
      </tr>
    </thead>
    <tbody id="apiStatsItems"></tbody>
  </table>
  <div style="display:flex;align-items:center;gap:8px;margin-top:8px">
    <span id="apiStatsResetDate" class="field-hint"></span>
    <button id="apiStatsResetBtn" class="btn-secondary" style="margin-left:auto">リセット</button>
  </div>
</div>
```

---

## Task 7: APIカウンター — options.js に表示・リセットロジック追加

**Files:**
- Modify: `options.js`

**Step 1: `loadApiStats` 関数を追加する（`loadWhitelistUI` の直後あたり）**

```js
async function loadApiStats() {
  const { apiStats = {} } = await chrome.storage.local.get('apiStats');
  const tbody = document.getElementById('apiStatsItems');
  tbody.innerHTML = '';
  const providers = ['gemini', 'claude', 'openai', 'ollama'];
  const labels = { gemini: 'Gemini', claude: 'Claude', openai: 'ChatGPT', ollama: 'Ollama' };
  let total = 0;
  for (const p of providers) {
    const count = apiStats[p] || 0;
    total += count;
    const tr = document.createElement('tr');
    const tdName = document.createElement('td');
    tdName.className = 'whitelist-origin';
    tdName.textContent = labels[p];
    const tdCount = document.createElement('td');
    tdCount.style.textAlign = 'right';
    tdCount.textContent = count + ' 回';
    tr.appendChild(tdName);
    tr.appendChild(tdCount);
    tbody.appendChild(tr);
  }
  // 合計行
  const trTotal = document.createElement('tr');
  trTotal.style.fontWeight = 'bold';
  const tdLabel = document.createElement('td');
  tdLabel.textContent = '合計';
  const tdTotal = document.createElement('td');
  tdTotal.style.textAlign = 'right';
  tdTotal.textContent = total + ' 回';
  trTotal.appendChild(tdLabel);
  trTotal.appendChild(tdTotal);
  tbody.appendChild(trTotal);

  const resetDate = apiStats.lastReset
    ? new Date(apiStats.lastReset).toLocaleDateString('ja-JP')
    : null;
  document.getElementById('apiStatsResetDate').textContent = resetDate
    ? `リセット日: ${resetDate}`
    : '';
}
```

**Step 2: `DOMContentLoaded` ハンドラ内の `loadWhitelistUI()` 呼び出しの直後に `loadApiStats()` を追加する**

```js
await loadWhitelistUI();
await loadApiStats(); // ← 追加
```

**Step 3: リセットボタンのイベントリスナーを `DOMContentLoaded` ハンドラ内に追加する（保存ボタンのイベントリスナーの前）**

```js
$('apiStatsResetBtn').addEventListener('click', async () => {
  await chrome.storage.local.set({ apiStats: { lastReset: Date.now() } });
  await loadApiStats();
  showStatus('API使用回数をリセットしました', 'ok');
});
```

---

## Task 8: バージョン更新 & コミット

**Files:**
- Modify: `manifest.json`

**Step 1: バージョンを 1.5.2 → 1.5.3 に更新する**

```json
"version": "1.5.3",
```

**Step 2: 動作確認**

1. 拡張機能をリロード（chrome://extensions → 更新ボタン）
2. ホワイトリスト済みのコミックサイトで翻訳ボタンを押す
3. オーバーレイが表示されたら画像エリアにマウスを移動 → 右下に🔄ボタンが出ることを確認
4. 🔄クリックで再翻訳が実行されること（API呼び出しが発生すること）を確認
5. 設定ページを開き、API使用回数が表示されていることを確認
6. リセットボタンで0になることを確認

**Step 3: コミット**

```bash
git add content.js content.css background.js options.html options.js manifest.json
git commit -m "feat: 再翻訳ボタン（ホバー表示）とAPI使用量カウンターを追加"
```
