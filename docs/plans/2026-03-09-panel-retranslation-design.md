# パネル別再翻訳機能 設計書

作成日: 2026-03-09

## 概要

既存の「ページ全体翻訳」はそのままに、翻訳済みオーバーレイにパネル単位の再翻訳ボタンを追加する。
Canvasピクセル解析（Flood Fill）でパネルbboxを推定し、そのパネルのみcropしてAIに再送信することで再翻訳コストを削減する。

---

## 実装フェーズ（必ず順守）

| フェーズ | 内容 | 完了基準 |
|---|---|---|
| 1 | パネルbbox推定 + **可視化のみ** | seed座標・panel bbox・bubble bboxがデバッグ表示できる |
| 2 | 同一パネルグルーピング | グルーピング結果の色分けオーバーレイで視認できる |
| 3 | パネル再翻訳ボタン追加 | 各パネルにホバーでボタンが表示される |
| 4 | crop送信 → 座標変換 → overlay追加 | 再翻訳結果が既存overlayにマージされる |

**フェーズ1完了後に実データで閾値調整してからフェーズ2に進む。**

---

## チューニング対象定数（ファイル先頭に集約）

```js
const FLOOD_COLOR_THRESHOLD  = 120;  // Flood Fill停止判定・色距離（マンハッタン）
const FILL_AREA_RATIO        = 20;   // 上限: bubbleBboxArea × k
const PAGE_AREA_MAX_RATIO    = 0.4;  // 上限: pageArea × ratio
const PANEL_IOU_THRESHOLD    = 0.35; // 同一パネル主判定（要調整）
const BBOX_STABLE_STEPS      = 30;   // 安定判定のステップ数
const BBOX_STABLE_GROWTH_MAX = 0.01; // bbox面積増加率の安定閾値（1%）
const PANEL_CROP_PADDING     = 0.07; // crop時のpanel bbox拡張率（7%）
const SEED_SAMPLE_SIZE       = 5;    // 起点サンプル（5×5固定）
```

---

## 1. Flood Fill — 起点決定

### アルゴリズム

1. bbox中心周辺 **5×5サンプル**（SEED_SAMPLE_SIZE固定、拡大不可）を取得
2. 輝度上位50%を候補として絞り込む
3. 候補25点のうち **medoid的代表色** を内部色として採用
   - 各候補ピクセルと他全候補とのマンハッタン距離合計を計算（O(n²)、n=25固定なので許容）
   - 距離合計が最小のピクセルの色 = 内部色
4. 内部色に最も近いピクセルをFlood Fill起点座標として使用
5. 起点ピクセルの輝度 < 20（黒文字上）なら次点に移行

### デバッグ表示（フェーズ1で必須）

- seed座標（点）
- 内部色（色見本）
- flood fill後のpanel bbox（矩形）
- bubble bbox（矩形）
- グルーピング後のパネル色分け（フェーズ2）

---

## 2. Flood Fill — アルゴリズム仕様

### 実装方式

**イテレーティブBFS必須（再帰禁止）**
スタックオーバーフロー防止のため、キューベースで実装する。

### キュー安全装置

```
- visited bitmap を必ず使用（重複処理防止）
- push前に visited チェック
- キューサイズ上限 = pageArea × 0.5（膨張防止）
```

### 停止条件

```
colorDist = |r - r₀| + |g - g₀| + |b - b₀|   // マンハッタン距離
colorDist > FLOOD_COLOR_THRESHOLD → 境界と判定、展開しない
```

固定輝度閾値は廃止。色距離のみで判定することで、
白・黄・暗背景など任意の塗りのパネルに対応。

---

## 3. Flood Fill — 上限条件（二段構成）

### 条件1（早期終了）: 境界囲み安定検出

以下の両方が成立したら終了：
- **3辺以上**で境界ピクセルを検出済み（4辺必須は廃止。枠なし・斜めコマ対応）
- **直近BBOX_STABLE_STEPS回（30ステップ）でbbox面積増加率 < BBOX_STABLE_GROWTH_MAX（1%）**

### 条件2（強制終了）: 面積上限

```
maxFillPixels = min(bubbleBboxArea × FILL_AREA_RATIO, pageArea × PAGE_AREA_MAX_RATIO)
             = min(bubbleBboxArea × 20, pageArea × 0.4)
```

- 小吹き出し×大パネルの過早終了を防ぐため `pageArea` ベース上限を併用
- 大吹き出し×小パネルの過大展開を防ぐため `bubbleArea` ベース上限も維持

---

## 4. 同一パネル判定

### Primary: IoU

```
IoU = intersection_area / union_area
IoU ≥ PANEL_IOU_THRESHOLD（0.35）→ 同一パネル
```

PANEL_IOU_THRESHOLDは定数化、実データで調整前提。

### Fallback: 複合判定（IoU 0.15〜0.35 のグレーゾーン）

```
centerDist < min(w1, w2) × 0.5
AND overlapArea / min(area1, area2) > 0.3
→ 同一パネル
```

---

## 5. 座標変換

crop画像に対してAIが返す bbox（%）をフルページ座標に変換：

```
full_left% = (panelPx_left + crop_left%  × panelPx_width)  / W × 100
full_top%  = (panelPx_top  + crop_top%   × panelPx_height) / H × 100
```

### crop時のパディング

panel bboxをそのままcropするとテキストが端に近すぎてAI検出が失敗するため、
crop前にpanel bboxを **PANEL_CROP_PADDING（7%）拡張**してからcropする。

---

## 6. 再翻訳動作

- 既存overlayは **そのまま保持**、新規アイテムを追加（マージ）
- 追加分は軽くハイライト表示（視認性向上、具体的なスタイルは実装時に決定）
- 通知：「N件のテキストを追加しました」

---

## 7. UI

- パネルのoverlay領域の右上に小アイコン（ページ再翻訳ボタンと同形）
- ホバーで表示、クリックでそのパネルのみ再翻訳
- ページ全体の再翻訳ボタンは変更なし

---

## 既知の限界・注意事項

- Flood Fillの安定性は画像依存。必ず実データでの閾値チューニングが必要
- アメコミの変形コマ・はみ出し演出・枠なしコマは誤検出の可能性あり
- 初回から本番品質を期待しない。フェーズ1の可視化で失敗ケースを収集してから調整する
- colorDist閾値の動的化（seed周辺の局所分散ベース）は将来の改善候補
