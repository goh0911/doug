# Canvas Color Sampling Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** AI プロンプトから色指示を削除し、Canvas ピクセルサンプリングで吹き出しの背景色・枠線色を正確に取得する。

**Architecture:** 翻訳レスポンス受信後・オーバーレイ描画前に `sampleBubbleColors(imageDataUrl, items)` を呼び出す。imageDataUrl を Canvas に描画し、各 bbox のピクセルを読み取って `item.background` / `item.border` を付与する。既存の描画ロジック（`sanitizeCssValue` / `getContrastColor` / `darkenColor`）はそのまま流用。

**Tech Stack:** Vanilla JS, Canvas API（content.js IIFE 内）, Vitest（単体テスト）

---

### Task 1: プロンプトから color フィールドを削除

**Files:**
- Modify: `translate.js:119-125` (buildTranslationPrompt 内)
- Modify: `content.js:116-120` (translateWithOllamaDirect 内の inline プロンプト)
- Modify: `content.js:133-134` (JSON例)
- Modify: `content.js:76-81` (ollamaParseResponse の background/border 処理)
- Modify: `utils/ollama.js:69-76` (ollamaParseResponse の background/border 処理)

**Step 1: translate.js の buildTranslationPrompt を編集**

`translate.js` の `buildTranslationPrompt` 関数内、以下の行を削除する：

```
- background: 吹き出し/キャプションの背景色情報（白い吹き出しは省略可）
  - 単色の場合: 文字列で返す（例: "#ffe082"）
  - グラデーションの場合: オブジェクトで上端と下端の色を返す
    例: {"top": "#d4edda", "bottom": "#ffffff"}
    - top: 吹き出しの上端の色
    - bottom: 吹き出しの下端の色
- border: 吹き出し/キャプションの枠線の色（例: "#4a7c59"）。枠線がある場合のみ返す
```

JSON例（最終行）も色なしに更新：
```
変更前:
[{"original":"FIVE...?","translated":"5人…？","type":"speech","box":[20,30,80,180]},{"original":"ROYAL CONSUL...","translated":"王室顧問…","type":"caption","box":[5,10,120,480],"background":{"top":"#d4edda","bottom":"#f0f8e8"},"border":"#4a7c59"}]

変更後:
[{"original":"FIVE...?","translated":"5人…？","type":"speech","box":[20,30,80,180]},{"original":"ROYAL CONSUL...","translated":"王室顧問…","type":"caption","box":[5,10,120,480]}]
```

**Step 2: content.js の Ollama inline プロンプトを同様に編集**

`content.js` の `translateWithOllamaDirect` 内の inline プロンプトから、translate.js と同様の background/border 行と JSON 例中の色フィールドを削除する。

**Step 3: content.js と utils/ollama.js の パーサー から background/border 処理を削除**

content.js（line 76-81）と utils/ollama.js（line 69-76）の以下のコードを削除：

```javascript
// 削除対象（両ファイルの同一箇所）
if (r.background) {
  result.background = typeof r.background === 'string'
    ? r.background
    : (r.background.top && r.background.bottom ? `linear-gradient(to bottom, ${r.background.bottom}, ${r.background.top})` : undefined);
}
if (r.border) result.border = r.border;
```

**Step 4: コミット**

```bash
git add translate.js content.js utils/ollama.js
git commit -m "refactor: remove color fields from AI prompt (will use canvas sampling)"
```

---

### Task 2: sampleBubbleColors 関数を content.js に追加

**Files:**
- Modify: `content.js`（`darkenColor` 関数の直後に追加）

**Step 1: `toHex` ヘルパー関数を追加**

`darkenColor` 関数の直後に追加：

```javascript
// 0-255 の数値を 2桁 hex 文字列に変換
function toHex(n) { return Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0'); }
```

**Step 2: `sampleBackground` 関数を追加**

`toHex` の直後に追加：

```javascript
// bbox 内 8点のピクセルをサンプリングして背景色を返す（hex 文字列 or null）
function sampleBackground(ctx, x1, y1, x2, y2, W, H) {
  const bboxW = x2 - x1;
  const bboxH = y2 - y1;
  if (bboxW < 4 || bboxH < 4) return null;
  const INSET = Math.max(2, Math.round(Math.min(bboxW, bboxH) * 0.08));
  const cx = Math.round((x1 + x2) / 2);
  const cy = Math.round((y1 + y2) / 2);
  const pts = [
    [x1 + INSET, y1 + INSET], [cx, y1 + INSET], [x2 - INSET, y1 + INSET],
    [x1 + INSET, cy],                             [x2 - INSET, cy],
    [x1 + INSET, y2 - INSET], [cx, y2 - INSET], [x2 - INSET, y2 - INSET],
  ].filter(([px, py]) => px >= 0 && py >= 0 && px < W && py < H);

  const colors = pts.map(([px, py]) => {
    const d = ctx.getImageData(px, py, 1, 1).data;
    return d[3] > 10 ? { r: d[0], g: d[1], b: d[2], lum: 0.299 * d[0] + 0.587 * d[1] + 0.114 * d[2] } : null;
  }).filter(Boolean);

  if (colors.length < 3) return null;
  colors.sort((a, b) => a.lum - b.lum);
  const mid = colors[Math.floor(colors.length / 2)];
  return `#${toHex(mid.r)}${toHex(mid.g)}${toHex(mid.b)}`;
}
```

**Step 3: `sampleBorder` 関数を追加**

`sampleBackground` の直後に追加：

```javascript
// bbox 外縁 3px をサンプリングして枠線色を返す（背景と輝度差40以上の場合のみ）
function sampleBorder(ctx, x1, y1, x2, y2, W, H, bgHex) {
  const bgR = parseInt(bgHex.slice(1, 3), 16);
  const bgG = parseInt(bgHex.slice(3, 5), 16);
  const bgB = parseInt(bgHex.slice(5, 7), 16);
  const bgLum = 0.299 * bgR + 0.587 * bgG + 0.114 * bgB;
  const SCAN = 3;
  const edgePts = [];
  for (let px = x1; px <= x2; px += 4) {
    for (let dy = 0; dy < SCAN; dy++) {
      edgePts.push([px, y1 + dy], [px, y2 - dy]);
    }
  }
  for (let py = y1 + SCAN; py <= y2 - SCAN; py += 4) {
    for (let dx = 0; dx < SCAN; dx++) {
      edgePts.push([x1 + dx, py], [x2 - dx, py]);
    }
  }
  const candidates = edgePts
    .filter(([px, py]) => px >= 0 && py >= 0 && px < W && py < H)
    .map(([px, py]) => {
      const d = ctx.getImageData(px, py, 1, 1).data;
      if (d[3] < 10) return null;
      const lum = 0.299 * d[0] + 0.587 * d[1] + 0.114 * d[2];
      return Math.abs(lum - bgLum) > 40 ? { r: d[0], g: d[1], b: d[2], lum } : null;
    })
    .filter(Boolean);
  if (candidates.length < 3) return null;
  candidates.sort((a, b) => a.lum - b.lum);
  const dark = candidates.slice(0, Math.ceil(candidates.length / 3));
  const n = dark.length;
  const avg = dark.reduce((acc, c) => ({ r: acc.r + c.r, g: acc.g + c.g, b: acc.b + c.b }), { r: 0, g: 0, b: 0 });
  return `#${toHex(avg.r / n)}${toHex(avg.g / n)}${toHex(avg.b / n)}`;
}
```

**Step 4: `sampleBubbleColors` メイン関数を追加**

`sampleBorder` の直後に追加：

```javascript
// imageDataUrl の Canvas から各 item の bbox ピクセルをサンプリングして
// item.background / item.border を付与する
async function sampleBubbleColors(imageDataUrl, items) {
  if (!imageDataUrl || !items || items.length === 0) return;
  let img;
  try {
    img = await new Promise((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = reject;
      i.src = imageDataUrl;
    });
  } catch { return; }

  const canvas = document.createElement('canvas');
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0);
  const W = canvas.width;
  const H = canvas.height;

  for (const item of items) {
    if (!item.bbox || item.type === 'sfx') continue;
    // bbox は % 単位（0–100）→ ピクセル座標に変換
    const x1 = Math.round((item.bbox.left / 100) * W);
    const y1 = Math.round((item.bbox.top / 100) * H);
    const x2 = Math.round(((item.bbox.left + item.bbox.width) / 100) * W);
    const y2 = Math.round(((item.bbox.top + item.bbox.height) / 100) * H);

    const bg = sampleBackground(ctx, x1, y1, x2, y2, W, H);
    if (bg) {
      item.background = bg;
      item.border = sampleBorder(ctx, x1, y1, x2, y2, W, H, bg) || darkenColor(bg) || undefined;
    }
  }
}
```

**Step 5: コミット（関数追加のみ、まだフローに組み込まない）**

```bash
git add content.js
git commit -m "feat: add sampleBubbleColors canvas pixel sampling functions"
```

---

### Task 3: 翻訳フローへの組み込み

**Files:**
- Modify: `content.js:512-515`（`response.translations` 確認後・`renderOverlays` 呼び出し前）

**Step 1: `sampleBubbleColors` 呼び出しを追加**

content.js の以下の箇所を変更する：

```javascript
// 変更前（line ~512-515）
if (fill) fill.style.width = '90%';
const adjustments = imageUrl ? await loadAdjustments(imageUrl) : {};
const onAdjusted = imageUrl ? (idx, style) => saveAdjustment(imageUrl, idx, style) : null;
renderOverlays(getOverlayTarget(comicInfo), response.translations, adjustments, onAdjusted, capturedRect);

// 変更後
if (fill) fill.style.width = '90%';
await sampleBubbleColors(imageData, response.translations);
const adjustments = imageUrl ? await loadAdjustments(imageUrl) : {};
const onAdjusted = imageUrl ? (idx, style) => saveAdjustment(imageUrl, idx, style) : null;
renderOverlays(getOverlayTarget(comicInfo), response.translations, adjustments, onAdjusted, capturedRect);
```

**Step 2: Chrome を再読み込みして動作確認**

1. `chrome://extensions/` でドウグを再読み込み
2. テストページ（Comic Book Plus 等）でコミック画像を翻訳
3. 吹き出しオーバーレイの色が正しく検出されているか目視確認
4. DevTools Console にエラーがないか確認

**Step 3: コミット**

```bash
git add content.js
git commit -m "feat: integrate canvas color sampling into translation flow"
```

---

### Task 4: バージョン更新

**Files:**
- Modify: `manifest.json`
- Modify: `package.json`

**Step 1: バージョンを 1.5.6 に更新**

```json
// manifest.json
"version": "1.5.6"

// package.json
"version": "1.5.6"
```

**Step 2: コミット**

```bash
git add manifest.json package.json
git commit -m "chore: bump version to 1.5.6"
```

---

## 確認ポイント

- [ ] 白い吹き出し（デフォルト）→ background が null → 従来通り白背景
- [ ] カラーキャプション（黄/緑等）→ background が hex 値 → 正しい色で表示
- [ ] 黒い吹き出し → background が暗色 → `getContrastColor` が白文字を選択
- [ ] sfx タイプはサンプリングをスキップ
- [ ] キャプチャ失敗（CORS フォールバック）でも imageData は dataURL として渡るため動作に影響なし
