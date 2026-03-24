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

---

## データフロー

```
ボタンクリック（group を受け取る）
  → retranslatePanel(group)
      ├─ cropPanelImage(_lastImageDataUrl, group)
      │     └─ panel bbox を PANEL_CROP_PADDING（7%）拡張して canvas で crop
      │     └─ 失敗時: 「パネルの切り抜きに失敗しました」通知で終了
      │
      ├─ translateImage(cropDataUrl, null, forceRefresh=true)
      │     └─ 既存の翻訳パイプライン（Gemini/Claude 等）をそのまま再利用
      │     └─ 失敗時: 「翻訳に失敗: {err.message}」通知で終了
      │
      ├─ 0件: 「このパネルにはテキストが見つかりませんでした」通知で終了
      │       （既存オーバーレイはそのまま保持）
      │
      ├─ transformBboxToFullPage(bbox, cropBox, W, H) × N件
      │     └─ crop 座標（%）→ フルページ座標（%）に変換
      │
      ├─ mergeTranslations(_lastTranslations, incoming)
      │     └─ IoU ≥ 0.3: 既存を新しい結果で置き換え
      │     └─ IoU < 0.3: 末尾に追加
      │     └─ 変更対象インデックスのセットを返す
      │
      └─ addRetranslatedOverlays(container, translations, changedIndices)
            └─ 変更分のオーバーレイを薄い黄色背景でハイライト
            └─ 3秒後に CSS transition でフェードアウト
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

### `cropPanelImage(imageDataUrl, group)`

- `group.unionBboxPx` からパネルのピクセル座標を取得
- PANEL_CROP_PADDING（0.07）分 x/y それぞれ拡張し、画像境界内にクランプ
- canvas で crop して `data:image/webp;base64,...` を返す
- 失敗時は `null` を返す（例外はスローしない）

### `transformBboxToFullPage(cropBbox, cropBox, W, H)`

- `cropBox = { x1, y1, x2, y2 }` : padded crop box のピクセル座標
- `cropBbox = { left, top, width, height }` : AI が返す %値
- 上記変換式を適用して `{ left, top, width, height }` を返す
- Pure function（副作用なし）

### `mergeTranslations(existing, incoming)`

- `incoming` の各アイテムについて `existing` 全件と IoU を計算
- IoU ≥ 0.3 の既存アイテムが存在する場合: 最大 IoU の既存を `incoming` で置き換え
- 対応なしの場合: 配列末尾に追加
- 変更・追加されたインデックスのセット `changedIndices: Set<number>` も返す
- 返値: `{ translations: Array, changedIndices: Set<number> }`
- Pure function（元の配列は変更しない、新配列を返す）

### `addRetranslatedOverlays(container, translations, changedIndices)`

- `changedIndices` に含まれるインデックスのオーバーレイのみ再描画
- 背景色 `rgba(255, 230, 0, 0.35)` を適用
- `.mut-retranslated` クラスを付与し、3秒後に CSS transition でフェードアウト

### `retranslatePanel(group)`

- 上記4関数のオーケストレーター
- `isTranslating` が `true` の場合は何もしない（重複防止）
- 処理中は `isTranslating = true` に設定し、finally で `false` に戻す

---

## UIへの統合

**クリックハンドラー変更箇所**
`addPanelRetranslateButtons` 内 line 1403〜1406 のプレースホルダーを
`retranslatePanel(group)` の呼び出しに置き換える。

---

## エラーハンドリング一覧

| 状況 | 動作 |
|---|---|
| crop 失敗 | 「パネルの切り抜きに失敗しました」通知、処理終了 |
| translateImage 失敗 | 「翻訳に失敗: {err.message}」通知、処理終了 |
| 翻訳結果 0 件 | 「このパネルにはテキストが見つかりませんでした」通知、既存保持 |
| isTranslating = true | 何もしない（サイレント無視） |

---

## 変更対象ファイル

- `content.js`: 新関数4本（cropPanelImage / transformBboxToFullPage / mergeTranslations / addRetranslatedOverlays / retranslatePanel）+ クリックハンドラー変更
- `content.css`: `.mut-retranslated` のフェードアニメーション追加

---

## 既知の制約

- フェーズ4では `renderOverlays` を変更しない。既存の安定性を維持する
- パネル crop の画像は現時点でキャッシュしない（再クリックで再翻訳）
- IoU 0.3 の重複判定閾値は実データでの調整が必要な場合がある
