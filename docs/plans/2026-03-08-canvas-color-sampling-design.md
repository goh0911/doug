# Canvas ピクセルサンプリングによる吹き出し色検出 — 設計書

日付: 2026-03-08

## 背景・目的

現状は AI（Vision API）に吹き出しの背景色・枠線色を hex で返させているが、AI の色認識は不正確で精度に欠ける。Canvas ピクセルサンプリングに切り替えることで実ピクセル値から正確な色を取得する。

## 方針

- AI プロンプトから `background` / `border` フィールドの指示を削除（プロンプト簡略化・トークン削減）
- content.js で翻訳レスポンス受信後、オーバーレイ描画前に Canvas でサンプリング
- サンプリング結果を `item.background` / `item.border` にセット → 既存の描画ロジックはそのまま流用

## データフロー

```
captureComic() → imageData (dataURL)
    ↓
translateImage(imageData) → AI レスポンス（bbox + 翻訳のみ、色なし）
    ↓
sampleBubbleColors(imageData, translations) ← 新規追加
    ↓ item.background / item.border を付与
renderOverlays(imageEl, translations)
```

## サンプリング仕様

### 座標変換

AI の `box` は 0–1000 正規化座標。Canvas 実ピクセル座標への変換:

```
pixelX = (xNorm / 1000) * canvas.width
pixelY = (yNorm / 1000) * canvas.height
```

### 背景色の取得

bbox 内側に 5px オフセットした 8 点（四隅 + 各辺中点）のピクセルを取得し、輝度の中央値に最も近い色を採用する。

### 枠線色の取得

bbox の各辺に沿った外縁 3px ライン上のピクセルをサンプリングし、背景色との輝度差が 40 以上の色を採用する。差が小さい場合は `darkenColor(background)` で代替（既存関数を流用）。

### エッジケース

- サンプル点が bbox 外に出る場合はクランプして対処
- 有効なサンプル点が 3 点未満の場合は背景色なし（デフォルト白）
- グラデーション背景はサンプル点の平均色で近似（単色扱い）

## 変更ファイル

| ファイル | 変更内容 |
|---------|---------|
| `translate.js` | プロンプトから `background` / `border` フィールドの指示を削除 |
| `content.js` | `sampleBubbleColors(imageData, items)` 関数を追加、翻訳フローに組み込み |
| `utils/ollama.js` | Ollama 用プロンプトからも同様に削除 |

## バージョン

パッチ変更（精度改善）→ `1.5.6`
