# Panel Retranslation Phase 4 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** パネル再翻訳ボタンのクリック時に、パネル領域をcropしてAIに送信し、結果を既存オーバーレイにマージする。

**Architecture:** Pure functions（座標変換・マージ）は `utils/panel-utils.js` に抽出してユニットテストを書き、content.js にもコピーを保持（IIFE制約のため）。DOM操作系（crop・overlay追加）は content.js 内に追加。

**Tech Stack:** Vanilla JS（Chrome Extension MV3）、Vitest（ユニットテスト）

---

## ファイル構成

| ファイル | 変更種別 | 内容 |
|---|---|---|
| `utils/panel-utils.js` | 新規作成 | `transformBboxToFullPage` / `mergeTranslations`（pure functions、テスト用） |
| `tests/unit/panel-utils.test.js` | 新規作成 | 上記2関数のユニットテスト |
| `content.js` | 修正 | 1) `renderOverlays`に`data-index`付与、2) 新関数5本追加、3) クリックハンドラー変更 |
| `content.css` | 修正 | `.mut-retranslated` ハイライトスタイル追加 |

---

## Task 1: `transformBboxToFullPage` — テスト先行実装

**Files:**
- Create: `utils/panel-utils.js`
- Create: `tests/unit/panel-utils.test.js`

- [ ] **Step 1: テストファイルを作成（失敗状態）**

`tests/unit/panel-utils.test.js` を作成:

```js
import { describe, it, expect } from 'vitest';
import { transformBboxToFullPage } from '../../utils/panel-utils.js';

describe('transformBboxToFullPage', () => {
  it('crop中央の吹き出しをフルページ座標に変換する', () => {
    // フルページ 400×400、cropBox がページ左半分 (0,0)-(200,400)、パディングなし
    const cropBbox = { left: 25, top: 25, width: 50, height: 50 }; // crop空間の中央
    const cropBox  = { x1: 0, y1: 0, x2: 200, y2: 400 };
    const result = transformBboxToFullPage(cropBbox, cropBox, 400, 400);
    // cropW=200, cropH=400
    // full_left   = (0 + 25/100 * 200) / 400 * 100 = 50/400*100 = 12.5
    // full_top    = (0 + 25/100 * 400) / 400 * 100 = 100/400*100 = 25
    // full_width  = 50/100 * 200 / 400 * 100 = 25
    // full_height = 50/100 * 400 / 400 * 100 = 50
    expect(result.left).toBeCloseTo(12.5);
    expect(result.top).toBeCloseTo(25);
    expect(result.width).toBeCloseTo(25);
    expect(result.height).toBeCloseTo(50);
  });

  it('crop が画像右下の場合に正しく変換する', () => {
    // フルページ 1000×1000、cropBox が右下 (500,500)-(1000,1000)
    const cropBbox = { left: 0, top: 0, width: 100, height: 100 }; // crop全体
    const cropBox  = { x1: 500, y1: 500, x2: 1000, y2: 1000 };
    const result = transformBboxToFullPage(cropBbox, cropBox, 1000, 1000);
    // フルページ座標でも右下 50,50 始まり 50×50
    expect(result.left).toBeCloseTo(50);
    expect(result.top).toBeCloseTo(50);
    expect(result.width).toBeCloseTo(50);
    expect(result.height).toBeCloseTo(50);
  });

  it('crop の一部の吹き出し座標を変換する', () => {
    // フルページ 1000×500、cropBox (100,50)-(600,450)（cropW=500, cropH=400）
    const cropBbox = { left: 10, top: 20, width: 30, height: 40 };
    const cropBox  = { x1: 100, y1: 50, x2: 600, y2: 450 };
    const result = transformBboxToFullPage(cropBbox, cropBox, 1000, 500);
    // full_left   = (100 + 10/100*500) / 1000 * 100 = 150/1000*100 = 15
    // full_top    = (50  + 20/100*400) / 500  * 100 = 130/500*100  = 26
    // full_width  = 30/100*500/1000*100 = 15
    // full_height = 40/100*400/500*100  = 32
    expect(result.left).toBeCloseTo(15);
    expect(result.top).toBeCloseTo(26);
    expect(result.width).toBeCloseTo(15);
    expect(result.height).toBeCloseTo(32);
  });
});
```

- [ ] **Step 2: テストが失敗することを確認**

```bash
npm run test:unit -- panel-utils
```

期待: `Cannot find module '../../utils/panel-utils.js'`

- [ ] **Step 3: `utils/panel-utils.js` を作成して実装**

```js
// utils/panel-utils.js
// content.js の IIFE 内にもコピーを保持する（IIFE 制約のため import 不可）
// content.js 側を変更した場合はこのファイルも必ず同期すること

/**
 * crop空間の bbox（%）をフルページ座標（%）に変換する
 * @param {{ left: number, top: number, width: number, height: number }} cropBbox - AI が返す crop 空間の %値
 * @param {{ x1: number, y1: number, x2: number, y2: number }} cropBox - padded crop box のピクセル座標
 * @param {number} W - フル画像の幅（px）
 * @param {number} H - フル画像の高さ（px）
 * @returns {{ left: number, top: number, width: number, height: number }}
 */
export function transformBboxToFullPage(cropBbox, cropBox, W, H) {
  const cropW = cropBox.x2 - cropBox.x1;
  const cropH = cropBox.y2 - cropBox.y1;
  return {
    left:   (cropBox.x1 + cropBbox.left   / 100 * cropW) / W * 100,
    top:    (cropBox.y1 + cropBbox.top    / 100 * cropH) / H * 100,
    width:  cropBbox.width  / 100 * cropW / W * 100,
    height: cropBbox.height / 100 * cropH / H * 100,
  };
}
```

- [ ] **Step 4: テストが通ることを確認**

```bash
npm run test:unit -- panel-utils
```

期待: `3 tests passed`

- [ ] **Step 5: コミット**

```bash
git add utils/panel-utils.js tests/unit/panel-utils.test.js
git commit -m "feat: add transformBboxToFullPage pure function with tests"
```

---

## Task 2: `mergeTranslations` — テスト先行実装

**Files:**
- Modify: `utils/panel-utils.js`
- Modify: `tests/unit/panel-utils.test.js`

- [ ] **Step 1: テストを追加（失敗状態）**

`tests/unit/panel-utils.test.js` に追加:

```js
import { transformBboxToFullPage, mergeTranslations } from '../../utils/panel-utils.js';

describe('mergeTranslations', () => {
  const base = (left, top, w, h) => ({ left, top, width: w, height: h });

  it('IoU >= 0.3 の既存アイテムを incoming で置き換える', () => {
    const existing = [
      { original: 'A', translated: '日本語A', bbox: base(10, 10, 20, 20) },
    ];
    const incoming = [
      { original: 'A2', translated: '日本語A2', bbox: base(12, 12, 20, 20) }, // 大きく重なる
    ];
    const { translations, changedIndices } = mergeTranslations(existing, incoming);
    expect(translations).toHaveLength(1); // 置き換えなので合計1件
    expect(translations[0].original).toBe('A2');
    expect(changedIndices.has(0)).toBe(true);
  });

  it('IoU < 0.3 の incoming は末尾に追加する', () => {
    const existing = [
      { original: 'A', translated: '日本語A', bbox: base(10, 10, 20, 20) },
    ];
    const incoming = [
      { original: 'B', translated: '日本語B', bbox: base(80, 80, 10, 10) }, // 離れている
    ];
    const { translations, changedIndices } = mergeTranslations(existing, incoming);
    expect(translations).toHaveLength(2);
    expect(translations[1].original).toBe('B');
    expect(changedIndices.has(1)).toBe(true);
  });

  it('既存配列を変更せず新配列を返す（pure function）', () => {
    const existing = [
      { original: 'A', translated: '日本語A', bbox: base(10, 10, 20, 20) },
    ];
    const incoming = [
      { original: 'A2', translated: '日本語A2', bbox: base(12, 12, 20, 20) },
    ];
    const { translations } = mergeTranslations(existing, incoming);
    expect(existing[0].original).toBe('A'); // 元配列は変更されない
    expect(translations).not.toBe(existing); // 新配列
  });

  it('incoming が空の場合は既存をそのまま返す', () => {
    const existing = [
      { original: 'A', translated: '日本語A', bbox: base(10, 10, 20, 20) },
    ];
    const { translations, changedIndices } = mergeTranslations(existing, []);
    expect(translations).toHaveLength(1);
    expect(changedIndices.size).toBe(0);
  });

  it('複数 incoming が同じ既存にマッチした場合、後の incoming が勝つ', () => {
    const existing = [
      { original: 'A', translated: '日本語A', bbox: base(10, 10, 20, 20) },
    ];
    const incoming = [
      { original: 'A2', translated: '日本語A2', bbox: base(11, 11, 18, 18) },
      { original: 'A3', translated: '日本語A3', bbox: base(12, 12, 16, 16) },
    ];
    const { translations } = mergeTranslations(existing, incoming);
    // 両方が既存の index 0 に高IoUでマッチ。後の A3 が最終的に勝つ
    expect(translations).toHaveLength(1);
    expect(translations[0].original).toBe('A3');
  });
});
```

- [ ] **Step 2: テストが失敗することを確認**

```bash
npm run test:unit -- panel-utils
```

期待: `mergeTranslations is not a function`

- [ ] **Step 3: `mergeTranslations` を `utils/panel-utils.js` に追加**

```js
/**
 * IoU ベースで既存翻訳と新翻訳をマージする
 * IoU >= 0.3: 既存を incoming で置き換え（最後にマッチした incoming が勝つ）
 * IoU < 0.3:  配列末尾に追加
 * @param {Array} existing - 現在の translations 配列
 * @param {Array} incoming - 新しい translations 配列（フルページ座標に変換済み）
 * @returns {{ translations: Array, changedIndices: Set<number> }}
 */
export function mergeTranslations(existing, incoming) {
  const result = existing.slice(); // shallow copy
  const changedIndices = new Set();

  for (const newItem of incoming) {
    if (!newItem.bbox) { result.push(newItem); changedIndices.add(result.length - 1); continue; }

    let bestIdx = -1;
    let bestIou = 0;
    for (let i = 0; i < result.length; i++) {
      if (!result[i].bbox) continue;
      const iou = calcIou(result[i].bbox, newItem.bbox);
      if (iou >= 0.3 && iou > bestIou) { bestIou = iou; bestIdx = i; }
    }

    if (bestIdx >= 0) {
      result[bestIdx] = newItem;
      changedIndices.add(bestIdx);
    } else {
      result.push(newItem);
      changedIndices.add(result.length - 1);
    }
  }

  return { translations: result, changedIndices };
}

/**
 * 2つの bbox（left/top/width/height の % 形式）の IoU を計算する
 */
function calcIou(a, b) {
  const ax2 = a.left + a.width,  ay2 = a.top + a.height;
  const bx2 = b.left + b.width,  by2 = b.top + b.height;
  const ix1 = Math.max(a.left, b.left), iy1 = Math.max(a.top, b.top);
  const ix2 = Math.min(ax2, bx2),       iy2 = Math.min(ay2, by2);
  const inter = Math.max(0, ix2 - ix1) * Math.max(0, iy2 - iy1);
  if (inter === 0) return 0;
  const union = a.width * a.height + b.width * b.height - inter;
  return union <= 0 ? 0 : inter / union;
}
```

- [ ] **Step 4: テストが通ることを確認**

```bash
npm run test:unit -- panel-utils
```

期待: `8 tests passed`（Task 1 の3件 + Task 2 の5件）

- [ ] **Step 5: コミット**

```bash
git add utils/panel-utils.js tests/unit/panel-utils.test.js
git commit -m "feat: add mergeTranslations pure function with tests"
```

---

## Task 3: `renderOverlays` に `data-index` 属性付与

**Files:**
- Modify: `content.js:1486-1591`

- [ ] **Step 1: `layoutItems` の生成で原配列インデックスを保持する**

`content.js` の line 1486 付近の `.filter().map()` を以下に変更:

```js
// 変更前:
const layoutItems = translations
  .filter(item => item.bbox && item.bbox.top != null && item.bbox.left != null && item.type !== 'sfx')
  .map(item => {

// 変更後:
const layoutItems = translations
  .map((item, origIndex) => ({ ...item, origIndex }))
  .filter(item => item.bbox && item.bbox.top != null && item.bbox.left != null && item.type !== 'sfx')
  .map(item => {
```

- [ ] **Step 2: overlay 生成時に `data-index` を付与する**

`content.js` の line 1540 付近（`overlay.className = ...` の直後）に1行追加:

```js
overlay.className = `mut-overlay mut-type-${safeType}`;
overlay.dataset.index = item.origIndex;  // ← 追加
```

- [ ] **Step 3: 動作確認**

Chrome で拡張機能をリロードしてコミックページを翻訳。DevTools で `.mut-overlay` 要素を確認し、`data-index` 属性が付いていることを検証。

- [ ] **Step 4: コミット**

```bash
git add content.js
git commit -m "feat: add data-index attribute to overlay elements"
```

---

## Task 4: `cropPanelImage` の実装

**Files:**
- Modify: `content.js`（新関数を line 1458 の `addPanelRetranslateButtons` 末尾の後に追加）

- [ ] **Step 1: `content.js` に `cropPanelImage` を追加**

`addPanelRetranslateButtons` 関数の直後（line 1458 付近）に以下を挿入:

```js
// ============================================================
// フェーズ4: パネル crop / 座標変換 / マージ / 再翻訳
// ============================================================

// パネル bbox を PANEL_CROP_PADDING 分拡張して canvas で crop する（非同期）
// img.onload を待ってから drawImage する必要があるため Promise を返す
// 返値: Promise<{ dataUrl: string, cropBox: {x1,y1,x2,y2} } | null>
function cropPanelImage(imageDataUrl, group, W, H) {
  return new Promise((resolve) => {
    if (!imageDataUrl || !group || !group.unionBboxPx) { resolve(null); return; }
    const { x1, y1, x2, y2 } = group.unionBboxPx;
    const panelW = x2 - x1;
    const panelH = y2 - y1;
    const padX = panelW * PANEL_CROP_PADDING;
    const padY = panelH * PANEL_CROP_PADDING;
    const cropX1 = Math.max(0, Math.round(x1 - padX));
    const cropY1 = Math.max(0, Math.round(y1 - padY));
    const cropX2 = Math.min(W, Math.round(x2 + padX));
    const cropY2 = Math.min(H, Math.round(y2 + padY));
    const cropW  = cropX2 - cropX1;
    const cropH  = cropY2 - cropY1;
    if (cropW <= 0 || cropH <= 0) { resolve(null); return; }

    const img = new Image();
    img.onload = () => {
      try {
        const canvas = document.createElement('canvas');
        canvas.width  = cropW;
        canvas.height = cropH;
        canvas.getContext('2d').drawImage(img, cropX1, cropY1, cropW, cropH, 0, 0, cropW, cropH);
        resolve({ dataUrl: canvas.toDataURL('image/jpeg', 0.92), cropBox: { x1: cropX1, y1: cropY1, x2: cropX2, y2: cropY2 } });
      } catch { resolve(null); }
    };
    img.onerror = () => resolve(null);
    img.src = imageDataUrl;
  });
}
```

- [ ] **Step 2: `transformBboxToFullPage` を content.js にコピー**

`cropPanelImage` の直後に追加（utils/panel-utils.js と同一内容、コメント同期注記付き）:

```js
// transformBboxToFullPage — utils/panel-utils.js と同一内容（IIFE制約のためコピー）
// utils/panel-utils.js 側を変更した場合はこちらも必ず同期すること
function transformBboxToFullPage(cropBbox, cropBox, W, H) {
  const cropW = cropBox.x2 - cropBox.x1;
  const cropH = cropBox.y2 - cropBox.y1;
  return {
    left:   (cropBox.x1 + cropBbox.left   / 100 * cropW) / W * 100,
    top:    (cropBox.y1 + cropBbox.top    / 100 * cropH) / H * 100,
    width:  cropBbox.width  / 100 * cropW / W * 100,
    height: cropBbox.height / 100 * cropH / H * 100,
  };
}
```

- [ ] **Step 3: `mergeTranslations` と `calcIou` を content.js にコピー**

```js
// mergeTranslations / calcIou — utils/panel-utils.js と同一内容（IIFE制約のためコピー）
function mergeTranslations(existing, incoming) {
  const result = existing.slice();
  const changedIndices = new Set();
  for (const newItem of incoming) {
    if (!newItem.bbox) { result.push(newItem); changedIndices.add(result.length - 1); continue; }
    let bestIdx = -1, bestIou = 0;
    for (let i = 0; i < result.length; i++) {
      if (!result[i].bbox) continue;
      const iou = calcIou(result[i].bbox, newItem.bbox);
      if (iou >= 0.3 && iou > bestIou) { bestIou = iou; bestIdx = i; }
    }
    if (bestIdx >= 0) {
      result[bestIdx] = newItem; changedIndices.add(bestIdx);
    } else {
      result.push(newItem); changedIndices.add(result.length - 1);
    }
  }
  return { translations: result, changedIndices };
}

function calcIou(a, b) {
  const ax2 = a.left + a.width,  ay2 = a.top + a.height;
  const bx2 = b.left + b.width,  by2 = b.top + b.height;
  const ix1 = Math.max(a.left, b.left), iy1 = Math.max(a.top, b.top);
  const ix2 = Math.min(ax2, bx2),       iy2 = Math.min(ay2, by2);
  const inter = Math.max(0, ix2 - ix1) * Math.max(0, iy2 - iy1);
  if (inter === 0) return 0;
  const union = a.width * a.height + b.width * b.height - inter;
  return union <= 0 ? 0 : inter / union;
}
```

- [ ] **Step 4: コミット**

```bash
git add content.js
git commit -m "feat: add cropPanelImage, transformBboxToFullPage, mergeTranslations to content.js"
```

---

## Task 5: `addRetranslatedOverlays` と CSS ハイライト

**Files:**
- Modify: `content.js`
- Modify: `content.css`

- [ ] **Step 1: `content.css` に `.mut-retranslated` スタイルを追加**

`content.css` の `.mut-overlay` ブロックの後（line 88〜 付近）に追加:

```css
/* パネル再翻訳ハイライト: .mut-overlay-text の background-color を遷移させる */
/* transition は .mut-overlay-text 自体に定義し、クラス削除時にも動作させる */
.mut-overlay-text {
  transition: background-color 1s ease;
}
.mut-overlay.mut-retranslated .mut-overlay-text {
  background-color: rgba(255, 230, 0, 0.35) !important;
}
```

ハイライトのフロー:
1. JS で `.mut-retranslated` クラスを追加 → 背景が即座に黄色に変わる
2. `setTimeout(3000)` 後にクラスを削除 → `transition: 1s` で元の背景色にフェードバック
3. `transitionend` イベントでクリーンアップ（クラスは既に削除済みのため DOM 汚染なし）

- [ ] **Step 2: `addRetranslatedOverlays` を content.js に追加**

`mergeTranslations` / `calcIou` の直後に追加:

```js
// changedIndices のオーバーレイに黄色ハイライトを付与し、3秒後フェードアウト
// 新規追加分（既存 DOM に対応する data-index がない）はオーバーレイ要素を生成して追加
function addRetranslatedOverlays(container, translations, changedIndices) {
  if (!container || !translations || !changedIndices || changedIndices.size === 0) return;

  for (const idx of changedIndices) {
    const item = translations[idx];
    if (!item || !item.bbox) continue;

    // 既存 DOM 要素を data-index で探す
    const existing = container.querySelector(`.mut-overlay[data-index="${idx}"]`);

    if (existing) {
      // 置き換え対象: テキストを更新してハイライト
      const textEl = existing.querySelector('.mut-overlay-text');
      const origEl = existing.querySelector('.mut-overlay-original');
      if (textEl) textEl.textContent = item.translated;
      if (origEl) origEl.textContent = item.original;
      existing.classList.add('mut-retranslated');
      setTimeout(() => {
        existing.classList.remove('mut-retranslated');
      }, 3000);
    } else {
      // 新規追加: オーバーレイ要素を生成（renderOverlays と同じスタイル適用）
      const overlay = document.createElement('div');
      const safeType = (item.type || 'speech').replace(/[^a-z0-9-]/gi, '') || 'speech';
      overlay.className = `mut-overlay mut-type-${safeType} mut-retranslated`;
      overlay.dataset.index = idx;
      const { left, top, width, height } = item.bbox;
      Object.assign(overlay.style, {
        position: 'absolute',
        top:    top    + '%',
        left:   left   + '%',
        width:  width  + '%',
        height: height + '%',
        pointerEvents: 'auto',
      });
      const textEl = document.createElement('div');
      textEl.className = 'mut-overlay-text';
      textEl.textContent = item.translated;
      // AI が返す background / border を適用（sanitizeCssValue は content.js 内で定義済み）
      const safeBg     = sanitizeCssValue(item.background);
      const safeBorder = sanitizeCssValue(item.border);
      if (safeBg) {
        textEl.style.background = safeBg;
        const contrastColor = getContrastColor(safeBg);
        if (contrastColor) textEl.style.color = contrastColor;
        const borderColor = safeBorder || darkenColor(safeBg);
        if (borderColor) textEl.style.border = `2px solid ${borderColor}`;
      } else if (safeBorder) {
        textEl.style.border = `2px solid ${safeBorder}`;
      }
      overlay.appendChild(textEl);
      const origEl = document.createElement('div');
      origEl.className = 'mut-overlay-original';
      origEl.textContent = item.original;
      overlay.appendChild(origEl);
      container.appendChild(overlay);
      setTimeout(() => {
        overlay.classList.remove('mut-retranslated');
      }, 3000);
    }
  }
}
```

- [ ] **Step 3: コミット**

```bash
git add content.js content.css
git commit -m "feat: add addRetranslatedOverlays with yellow highlight animation"
```

---

## Task 6: `retranslatePanel` オーケストレーター

**Files:**
- Modify: `content.js`

- [ ] **Step 1: `retranslatePanel` を content.js に追加**

`addRetranslatedOverlays` の直後に追加:

```js
// パネル再翻訳のオーケストレーター
// group: computePanelGroups の groups[] の1要素
// W, H: フル画像のピクセルサイズ（_lastPanelGroups.W / H）
async function retranslatePanel(group, W, H) {
  if (isTranslating) return;
  if (!_lastImageDataUrl || !_lastTranslations) {
    showNotification('翻訳データがありません。先にページ全体を翻訳してください。', 'warn');
    return;
  }

  isTranslating = true;
  try {
    // 1. crop（Promise を返すため await が必要）
    const cropResult = await cropPanelImage(_lastImageDataUrl, group, W, H);
    if (!cropResult) {
      showNotification('パネルの切り抜きに失敗しました', 'error');
      return;
    }
    const { dataUrl: cropDataUrl, cropBox } = cropResult;

    // 2. 翻訳（既存パイプライン流用、キャッシュ無効）
    const response = await translateImage(cropDataUrl, null, true);
    if (!response || response.error) {
      showNotification(response?.error || '翻訳応答がありません', 'error');
      return;
    }

    // 3. 0件チェック
    const rawItems = response.translations;
    if (!rawItems || rawItems.length === 0) {
      showNotification('このパネルにはテキストが見つかりませんでした', 'info');
      return;
    }

    // 4. 座標変換（crop % → フルページ %）
    const incoming = rawItems.map(item => ({
      ...item,
      bbox: item.bbox ? transformBboxToFullPage(item.bbox, cropBox, W, H) : item.bbox,
    }));

    // 5. マージ
    const { translations: merged, changedIndices } = mergeTranslations(_lastTranslations, incoming);

    // 6. 状態更新
    _lastTranslations = merged;

    // 7. オーバーレイ追加・更新
    if (overlayContainer) {
      addRetranslatedOverlays(overlayContainer, merged, changedIndices);
    }

    // 8. 通知
    showNotification(`${changedIndices.size}件のテキストを追加しました`, 'success');
  } catch (err) {
    showNotification('翻訳に失敗: ' + err.message, 'error');
  } finally {
    isTranslating = false;
  }
}
```

- [ ] **Step 2: コミット**

```bash
git add content.js
git commit -m "feat: add retranslatePanel orchestrator"
```

---

## Task 7: クリックハンドラー接続（統合）

**Files:**
- Modify: `content.js:1403-1406`

- [ ] **Step 1: プレースホルダーを `retranslatePanel` 呼び出しに変更**

`addPanelRetranslateButtons` 内のクリックハンドラー（line 1403〜1406）を変更:

```js
// 変更前:
btn.addEventListener('click', (e) => {
  e.stopPropagation();
  showNotification('パネル再翻訳（フェーズ4で実装予定）', 'info');
});

// 変更後:
btn.addEventListener('click', (e) => {
  e.stopPropagation();
  retranslatePanel(group, pgResult.W, pgResult.H);
});
```

- [ ] **Step 2: 動作確認**

Chrome で拡張機能をリロードしてコミックページを翻訳。パネル上にホバーしてボタンを表示 → クリックして再翻訳が実行されることを確認。

確認項目:
- 翻訳中は「テキストを認識・翻訳中...」通知が出る
- 完了後「N件のテキストを追加しました」通知が出る
- 再翻訳されたオーバーレイが黄色くハイライトされ、3秒後にフェードする
- テキストが 0件の場合「このパネルにはテキストが見つかりませんでした」通知が出る

- [ ] **Step 3: 全ユニットテスト通過を確認**

```bash
npm run test:unit
```

期待: 全テスト通過（既存35件 + 新規8件 = 43件）

- [ ] **Step 4: バージョン更新**

`manifest.json` と `package.json` の version を `1.5.6` → `1.5.7` に更新（パッチ）

- [ ] **Step 5: 最終コミット**

```bash
git add content.js manifest.json package.json
git commit -m "feat: connect panel retranslation button (phase 4 complete)"
```

---

## 参照

- 設計書: `docs/superpowers/specs/2026-03-24-panel-retranslation-phase4-design.md`
- 既存パネル関連コード: `content.js` line 944〜1458
- 既存ユニットテスト: `tests/unit/parse-utils.test.js`（テスト記法の参考）
- CLAUDE.md: `content.js` の IIFE 制約、utils/ との同期ルール
