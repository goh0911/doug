# パネル別再翻訳 フェーズ4 設計書

作成日: 2026-03-24

## 概要

フェーズ1〜3で実装済みのパネル検出・グルーピング・ホバーボタンに対して、
フェーズ4ではボタンクリック時の実際の再翻訳処理を実装する。
パネル領域をcropしてAIに送信し、結果を既存オーバーレイにマージする。

---

## 前提（実装済み）

- フェーズ1: Flood Fill によるパネル bbox 推定
- フェーズ2: 同一パネルグルーピング（Union-Find）
- フェーズ3: ホバーで再翻訳ボタン表示（クリックはプレースホルダーのみ）
- `_lastImageDataUrl`, `_lastTranslations`, `_lastPanelGroups` にページ状態を保持済み
- `_lastPanelGroups` の形式: `{ W, H, groups: [{ groupId, members, unionBboxPx, unionBboxPct }] }`
  - `W`, `H` はフル画像のピクセルサイズ
  - `group` 単体には `W`/`H` が含まれない点に注意

---

## データフロー

```
ボタンクリック（group, W, H を受け取る）
  → retranslatePanel(group, W, H)
      ├─ isTranslating チェック → true なら即リターン
      ├─ isTranslating = true（finally で必ず false に戻す）
      │
      ├─ cropPanelImage(_lastImageDataUrl, group, W, H)
      │     └─ panel bbox を PANEL_CROP_PADDING（7%）拡張して canvas で crop
      │     └─ 失敗時: 「パネルの切り抜きに失敗しました」通知 → finally で終了
      │
      ├─ translateImage(cropDataUrl, null, forceRefresh=true)
      │     └─ 既存の翻訳パイプライン（Gemini/Claude 等）をそのまま再利用
      │     └─ 失敗時: 「翻訳に失敗: {err.message}」通知 → finally で終了
      │
      ├─ 0件: 「このパネルにはテキストが見つかりませんでした」通知 → finally で終了
      │       （既存オーバーレイはそのまま保持）
      │
      ├─ transformBboxToFullPage(bbox, cropBox, W, H) × N件
      │     └─ crop 座標（%）→ フルページ座標（%）に変換
      │
      ├─ mergeTranslations(_lastTranslations, incoming)
      │     └─ IoU ≥ 0.3: 既存を新しい結果で置き換え
      │     └─ IoU < 0.3: 末尾に追加
      │     └─ { translations, changedIndices } を返す
      │
      ├─ _lastTranslations = translations（マージ後の新配列で更新）
      │
      ├─ renderOverlays を使わず overlayContainer 上に新規オーバーレイを追加
      │   └─ addRetranslatedOverlays(overlayContainer, translations, changedIndices)
      │
      └─ finally: isTranslating = false
```

---

## 座標変換

crop 時にパディングを付与するため、変換には padded crop box の座標を使用する。

```
panelW = panelBboxPx.x2 - panelBboxPx.x1
panelH = panelBboxPx.y2 - panelBboxPx.y1
padX   = panelW × PANEL_CROP_PADDING   // 0.07
padY   = panelH × PANEL_CROP_PADDING

cropX1 = max(0, panelBboxPx.x1 - padX)
cropY1 = max(0, panelBboxPx.y1 - padY)
cropX2 = min(W, panelBboxPx.x2 + padX)
cropY2 = min(H, panelBboxPx.y2 + padY)
cropW  = cropX2 - cropX1
cropH  = cropY2 - cropY1

// AI が返す crop 空間の % → フルページの %
full_left%   = (cropX1 + crop_left%   / 100 × cropW) / W × 100
full_top%    = (cropY1 + crop_top%    / 100 × cropH) / H × 100
full_width%  = crop_width%  / 100 × cropW / W × 100
full_height% = crop_height% / 100 × cropH / H × 100
```

---

## 関数設計

### `cropPanelImage(imageDataUrl, group, W, H)`

- `group.unionBboxPx` からパネルのピクセル座標を取得
- PANEL_CROP_PADDING（0.07）分 x/y それぞれ拡張し、画像境界（W×H）内にクランプ
- canvas で crop して JPEG（quality 0.92）の data URL を返す
  - 既存の `captureRasterElement` が WebP を使うが、`translateImage` は data URL の MIME を問わず
    background.js に渡すため JPEG でも WebP でも動作する。JPEG を採用することで互換性を高める
- 失敗時は `null` を返す（例外はスローしない）
- `cropBox = { x1: cropX1, y1: cropY1, x2: cropX2, y2: cropY2 }` も返す（座標変換に使用）
- 返値: `{ dataUrl, cropBox }` または `null`

### `transformBboxToFullPage(cropBbox, cropBox, W, H)`

- `cropBox = { x1, y1, x2, y2 }` : padded crop box のピクセル座標
- `cropBbox = { left, top, width, height }` : AI が返す %値
- 上記変換式を適用して `{ left, top, width, height }` を返す
- Pure function（副作用なし）

### `mergeTranslations(existing, incoming)`

- `incoming` の各アイテムについて `existing` 全件と IoU を計算（bbox は % 形式）
- IoU ≥ 0.3 の既存アイテムが存在する場合: 最大 IoU の既存を `incoming` で置き換え
- 対応なしの場合: 配列末尾に追加
- 変更・追加されたインデックスのセット `changedIndices: Set<number>` も返す
  （インデックスは返値の `translations` 配列基準）
- 返値: `{ translations: Array, changedIndices: Set<number> }`
- Pure function（元の配列は変更しない、新配列を返す）

### `addRetranslatedOverlays(container, translations, changedIndices)`

- `changedIndices` に含まれるインデックスのオーバーレイを処理
- 既存の `.mut-overlay` 要素には `data-index` 属性が付与されている前提
  （`renderOverlays` 実装時に `data-index` を付与する修正が必要 ← 下記 UI 統合参照）
- `data-index` で既存 DOM 要素を特定し、置き換え対象はそのまま背景ハイライトを付与
- 新規追加分（配列末尾）はオーバーレイ要素を新たに生成して `container` に追加
- 背景色 `rgba(255, 230, 0, 0.35)` を `.mut-retranslated` クラスで適用
- 3秒後に CSS transition で背景色をフェードアウト（`opacity` ではなく `background-color` を変化）
- `transitionend` イベントで `.mut-retranslated` クラスを除去してDOMをクリーンアップ
- CSS 定義:
  ```css
  .mut-overlay.mut-retranslated {
    background-color: rgba(255, 230, 0, 0.35) !important;
    transition: background-color 1s ease 3s;  /* 3秒後から1秒かけてフェード */
  }
  /* transition完了後はJSで .mut-retranslated を除去してリセット */
  ```

### `retranslatePanel(group, W, H)`

- 上記4関数のオーケストレーター
- `isTranslating` が `true` の場合は何もしない（重複防止）
- `try/finally` 構造で `isTranslating` を確実にリセット:
  ```
  isTranslating = true
  try {
    // crop → translate → merge → addRetranslatedOverlays
  } catch (err) {
    showNotification('翻訳に失敗: ' + err.message, 'error')
  } finally {
    isTranslating = false
  }
  ```
- `_lastTranslations` を merge 後の新配列で更新（`addRetranslatedOverlays` 呼び出し前）

---

## UIへの統合

**クリックハンドラー変更箇所**
`addPanelRetranslateButtons(pgResult)` 内で `pgResult.W` / `pgResult.H` をクロージャで閉じ込め、
クリック時に `retranslatePanel(group, pgResult.W, pgResult.H)` を呼び出す。

```js
// 変更前（プレースホルダー）
btn.addEventListener('click', (e) => {
  e.stopPropagation();
  showNotification('パネル再翻訳（フェーズ4で実装予定）', 'info');
});

// 変更後
btn.addEventListener('click', (e) => {
  e.stopPropagation();
  retranslatePanel(group, pgResult.W, pgResult.H);
});
```

**`renderOverlays` への最小修正**
`addRetranslatedOverlays` が既存オーバーレイを `data-index` で特定できるよう、
`renderOverlays` 内でオーバーレイ要素生成時に `data-index` 属性を付与する。
この修正は1行追加のみで既存動作に影響しない。

---

## エラーハンドリング一覧

| 状況 | 動作 | isTranslating | _lastTranslations |
|---|---|---|---|
| `isTranslating = true` | 即リターン（何もしない） | 変化なし | 変化なし |
| crop 失敗（`null` 返却） | 「パネルの切り抜きに失敗しました」通知、finally で終了 | finally で false | 変化なし |
| `translateImage` 失敗 | 「翻訳に失敗: {err.message}」通知、finally で終了 | finally で false | 変化なし |
| 翻訳結果 0 件 | 「このパネルにはテキストが見つかりませんでした」通知、既存保持 | finally で false | **変化なし**（更新しない） |
| 正常完了 | 「N件のテキストを追加しました」通知 | finally で false | マージ後の新配列で更新 |

---

## 変更対象ファイル

- `content.js`: 新関数5本（cropPanelImage / transformBboxToFullPage / mergeTranslations / addRetranslatedOverlays / retranslatePanel）+ クリックハンドラー変更 + `renderOverlays` に `data-index` 付与
- `content.css`: `.mut-retranslated` のフェードアニメーション追加

---

## 既知の制約

- フェーズ4では `renderOverlays` への変更は `data-index` 付与の1行追加のみに留める
- パネル crop の画像は現時点でキャッシュしない（再クリックで再翻訳）
- IoU 0.3 の重複判定閾値は実データでの調整が必要な場合がある
