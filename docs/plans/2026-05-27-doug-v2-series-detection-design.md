# Doug v2 シリーズ状態管理 設計書

作成日: 2026-05-27

## 概要

Doug v1 は画像URL単位のステートレスな翻訳ツールである。v2 では同一シリーズの連続話を「ひとつの作品」として認識し、用語集と訳文の口調を引き継ぐ。

例：`Immortal Hulk #20` と `Immortal Hulk #21` を同一シリーズとして識別し、用語集（Hulk → ハルク 等）と口調（粗暴な常体 等）を共有する。

Gemini Nano（Chrome 内蔵 Prompt API）は、シリーズ検出と用語集の自動構築を補助する**任意機能**として位置付ける。Nano 非対応環境でも主要機能（手動用語集・口調設定）は動作する。

---

## 1. 確定要件

| # | 要件 |
|---|---|
| R1 | 同一シリーズの異なる話を自動で同一作品として認識する（**サイト横断含む**） |
| R2 | 作品単位で用語集（固有名詞・キャラ名等の訳）を保持する |
| R3 | 作品単位で訳文の口調（敬体/常体 等の全体トーン）を保持する |
| R4 | シリーズ識別はユーザー操作なしで動作する（手動修正は可能） |
| R5 | Gemini Nano は補助的に利用、無くても R2/R3 は機能する |
| R6 | 既存の v1.6 ユーザーがマイグレーションでデータを失わない |
| R7 | 用語集の追加・修正で既存翻訳キャッシュを失わない |

---

## 1.5 代替案の比較と棄却理由

設計を「シリーズ」概念で組む前に、もっと軽い案を検討する。

| 案 | 概要 | メリット | デメリット | 棄却理由 |
|---|---|---|---|---|
| **A. シリーズベース**（本設計） | URL/タイトルでシリーズ識別、永続化 | サイト跨ぎ・長期保持、R1 達成 | 識別ロジックと UI が必要 | — |
| **B. セッションスコープ用語集** | 直近 N 件の翻訳から自動で用語集生成、識別不要 | 実装超軽量、Phase 5/6 不要 | タブ閉じで消える、サイト跨ぎ不可、R1 を満たせない | **R1 を満たさない**ため棄却 |
| **C. ハイブリッド**（A+B） | シリーズ識別失敗時のみセッションスコープに退避 | フォールバック強化 | 二重実装、状態が増える | Phase 5 で Nano fallback を入れれば B 部分は不要、過剰 |

**結論：A 案で進めるが、識別失敗時の挙動を「セッション内のみで用語学習」とする最小フォールバックは Phase 4 に含める。**

---

## 2. アーキテクチャ概観

```
┌───────────────────────────────────────────────────────────────┐
│ content.js（ページ側）                                           │
│  ├─ detectSeries(document.title, location.href) → seriesId      │
│  ├─ loadSeriesContext(seriesId) → { glossary, tone, overrides } │
│  └─ translateImage(image, seriesContext) ────┐                  │
└──────────────────────────────────────────────┼──────────────────┘
                                               │ message
┌──────────────────────────────────────────────▼──────────────────┐
│ background.js（Service Worker）                                  │
│  ├─ series-store.js   作品単位ステートのCRUD                     │
│  ├─ series-detect.js  検出ロジック（Regex → Nano fallback）       │
│  ├─ prompt-builder.js 用語集・口調をプロンプトに織り込む           │
│  └─ glossary-extract.js Nano による用語抽出（Phase 4）            │
└─────────────────────────────────────────────────────────────────┘
```

### 新規ファイル
- `utils/series-detect.js` — pure 関数（Regex 抽出・SeriesId 生成）
- `series-store.js` — `chrome.storage.local` の `series:*` レイヤー操作
- `prompt-builder.js` — 翻訳プロンプトへの用語集・口調インジェクト
- `glossary-extract.js` — Nano 連携（Phase 4 以降）

### 既存ファイル変更
- `content.js` — detectSeries 呼び出し、翻訳時に seriesContext を同梱
- `background.js` — メッセージハンドラー追加、prompt 構築呼び出し
- `translate.js` — 各プロバイダー呼び出しで system prompt 拡張
- `options.html`/`options.js` — シリーズ一覧・用語集・口調の編集UI

---

## 3. シリーズ識別パイプライン

### 入力ソース（優先度順）
1. `document.title`
2. `<h1>` テキスト
3. `og:title` / `<meta name="title">`
4. URL パス末端セグメント

### 検出フロー

```
[1] Regex マッチ試行（パターン優先度順）
    └─ ヒット → {series, num} 取得
    └─ 失敗 ↓
[2] Nano 利用可？
    └─ Yes → Nano にタイトル+URL 投入 → JSON 取得
    └─ No / 失敗 ↓
[3] URL パスからシリーズ slug 抽出
    └─ origin + pathname.split('/')[1] を fallback として使用
```

### Regex パターン（順次試行）

```js
const SERIES_PATTERNS = [
  // "Immortal Hulk #20"
  /^(.+?)\s*#\s*(\d+(?:\.\d+)?)/i,
  // "One Piece Chapter 1100" / "Ch. 5" / "Vol.3"
  /^(.+?)\s+(?:Chapter|Ch\.?|Vol\.?|Volume|Episode|Ep\.?)\s*(\d+(?:\.\d+)?)/i,
  // "ベルセルク 第41巻" / "ワンピース 第1100話"
  /^(.+?)\s+第\s*(\d+(?:\.\d+)?)\s*[巻話章]/,
  // "Naruto 700: The End" / "進撃の巨人 100"
  /^(.+?)\s+(\d+(?:\.\d+)?)(?:\s*[:：].*)?$/,
];
```

不一致時は次のパターンへ。すべて失敗したら Nano または URL fallback。

### Nano プロンプト（フォールバック）

```
あなたはコミックページのメタデータ抽出器です。
以下のページ情報から、シリーズ名と話数を JSON で返してください。

タイトル: {title}
URL: {url}

出力形式（JSON のみ、説明文不要）:
{"series": "シリーズ名", "issueNumber": 数値またはnull, "confidence": 0.0-1.0}

シリーズ名と話数が判別できない場合は series: null を返してください。
```

`confidence < 0.6` の場合は URL fallback を採用。

### SeriesId 算出

```js
function computeSeriesId(seriesName) {
  const normalized = normalizeSeriesName(seriesName);
  return sha256(normalized).slice(0, 16);
}
```

**origin は意図的に含めない**。R1（サイト横断同シリーズ認識）を満たすため。
代償として「別作品が偶然同名」のケースで誤マージが起きうるが、これは設定 UI の分離操作（Phase 2）で対処する。

シリーズが検出されたサイトは `series:${id}.urlPatterns` に追記して可視化する。
誤マージ時に「このサイトだけ別シリーズに分離」操作が可能な構造とする。

---

## 4. ステート構造

### `chrome.storage.local` レイアウト

```
settings              （既存・グローバル設定）
cache:${imgHash}:...  （既存・触らない／Phase 3 以降も維持）
adj:${imgHash}        （既存・触らない）
apiStats              （既存・グローバル統計）
series:${seriesId}    （v2 新規）
```

`seriesIndex`（軽量メタの二重持ち）は **YAGNI のため導入しない**。
シリーズ一覧は `chrome.storage.local.get(null)` から `series:*` 抽出で構築する。
件数が増えて UI が遅くなったら Phase 2 完了後に計測して導入を再検討する。

### `series:${seriesId}` の内部構造

```js
{
  meta: {
    name: "Immortal Hulk",
    detectedAt: 1748376000000,
    lastVisitedAt: 1748376000000,
    issueCount: 12,                  // このシリーズで翻訳した話数
    detectionSource: "regex" | "nano" | "url" | "manual",
  },
  urlPatterns: [                     // 検出元サイトを記録（誤マージ時の分離操作用）
    { origin: "https://example.com", pattern: "/comics/immortal-hulk/*" }
  ],
  overrides: {
    provider: null,                  // null = グローバル設定を使用
    model: null,
    targetLang: null,
  },
  glossary: {
    // 言語ペアごとに分離（同シリーズを英→日と英→中で読むユーザーに対応）
    "ja": {
      "Hulk":         { translated: "ハルク",         count: 87, lastSeenAt: ..., source: "auto",   approved: true },
      "Bruce Banner": { translated: "ブルース・バナー", count: 23, lastSeenAt: ..., source: "manual", approved: true },
    },
  },
  tone: {
    style: "auto",                   // "敬体" | "常体" | "硬め" | "柔らかめ" | "auto" | カスタム文字列
    // Phase 3 ではここまで。
    // キャラ別口調（characters）と few-shot 例文（examples）は将来拡張枠として Phase 4 以降に退避。
  },
  stats: {
    translationCount: 156,
    lastTranslatedAt: ...,
  }
}
```

### 容量見積

- 用語50件・言語ペア1個のシリーズ ≈ 4KB
- `chrome.storage.local` 上限 5MB → 約 1200 シリーズまで安全
- 容量警告は 4MB 到達時にユーザー通知（Phase 2）
- LRU で `lastVisitedAt` が古いシリーズを自動アーカイブする処理を Phase 2 で実装

---

## 5. 翻訳プロンプトへのインジェクトとキャッシュ戦略

### 5.1 二層アプローチ（R7 のため）

| 層 | タイミング | 役割 |
|---|---|---|
| **層A: プロンプトインジェクト** | API 呼び出し時（cache miss 時のみ） | LLM の文脈一貫性を高める。新規翻訳の精度向上 |
| **層B: 出力後の用語置換（post-processing）** | API 応答 + キャッシュヒット両方 | 用語集追加後も既存翻訳に反映できる |

**キャッシュキーは変更しない**。`cache:${imgHash}:${lang}:${provider}:${model}` のまま。
これにより、用語1語の追加・修正で**全キャッシュが消える事故を回避**する（R7）。

代償：層 A は cache hit 時に効かない。これは「過去翻訳の文体・訳語選びは変わらない、ただし表記揺れは層 B で修正される」という妥協として受容。

### 5.2 層 A: システム指示の追加部分

```
このコミックは「{seriesName}」シリーズです。

【用語集】以下の固有名詞は必ずこの訳語を使用してください:
1. Hulk → ハルク
2. Bruce Banner → ブルース・バナー
... （登場頻度上位 N=30 件まで）

【訳文の口調】{toneStyle}
（例: "敬体" → "全体的に「です・ます」調で翻訳してください"）
```

### 5.3 層 B: 出力後の用語置換

```js
function applyGlossaryPostProcess(translations, glossary) {
  return translations.map(t => ({
    ...t,
    translated: substituteGlossaryTerms(t.translated, glossary),
  }));
}
```

- 単純な文字列置換（前方一致・大文字小文字感度はあり）
- **逆翻訳衝突の防止**：`original` フィールドを参照し、対象用語が原文にあった場合のみ置換を試行
- 置換ログを `series.stats.glossaryHits` に蓄積（誤置換検出のため）

### 5.4 注入の制御

| パラメータ | 値 | 理由 |
|---|---|---|
| 用語集 cap（層A） | 上位 30 件 | プロンプト肥大化抑制 |
| 並び順 | `count` 降順 | 重要語を優先 |
| 口調指示の長さ上限 | 200 文字 | 同上 |
| 層 B の適用範囲 | `approved: true` のみ | 自動候補での誤置換を避ける |

---

## 6. Gemini Nano 統合

### 可用性チェック

```js
async function isNanoAvailable() {
  if (!('LanguageModel' in self)) return false;
  const cap = await LanguageModel.availability();
  return cap === 'available' || cap === 'downloadable';
}
```

### 主な用途

| 用途 | フェーズ | 入力 | 出力 |
|---|---|---|---|
| シリーズ検出 fallback | Phase 5 | title + url | `{series, issueNumber, confidence}` |
| 用語集自動構築 | Phase 4 | 翻訳済テキスト群 | 固有名詞リスト + 訳語候補 |
| 用語整合化（任意） | Phase 6 | 既存用語集 + 新訳 | ブレ警告リスト |

### Nano が使えない場合の挙動

- シリーズ検出 → Regex / URL fallback で動作継続
- 用語集自動構築 → 機能 OFF（手動編集のみ）
- ユーザーへの通知：設定ページで Nano 状態を可視化、無効時はその旨表示

### Manifest 要件

Nano を使う Phase 4 以降では `manifest.json` に以下を追加検討：

```json
"trial_tokens": [ "..." ],
"minimum_chrome_version": "138"
```

ただし拡張機能では Prompt API は Origin Trial 不要で利用可能（要 Chrome 138+）。

---

## 7. ロードマップ

| Phase | 内容 | 既存挙動への影響 | Nano依存 | バージョン |
|---|---|---|---|---|
| **1** | シリーズ検出パイプライン（Regex のみ）+ デバッグ UI | なし | × | 1.7.0 |
| **2** | `series:` ストレージ層 + 設定 UI（口調・用語集の手動編集・シリーズ分離操作） | なし | × | 1.8.0 |
| **3** | 翻訳プロンプトへの用語集・口調インジェクト（層A）+ 出力後置換（層B） | **新規翻訳の結果が変わる**／キャッシュは温存 | × | **2.0.0** |
| **4** | Nano 用語集自動抽出 + 承認 UI、検出失敗時のセッション内学習 fallback | なし（候補追加のみ） | ◯ | 2.1.0 |
| **5** | Nano シリーズ検出 fallback | 検出精度向上 | ◯ | 2.2.0 |
| **6** | （任意）Nano 訳文整合化、キャラ別口調・few-shot 例文の拡張枠 | 翻訳結果が変わる | ◯ | 2.3.0 |

各 Phase は単独でリリース可能。Phase 1〜2 は完全に副作用なしの追加。

---

## 8. マイグレーション戦略

v1.6 → v2 移行時：

| 既存データ | 扱い |
|---|---|
| `cache:${imgHash}:...` | **そのまま保持・キー形式変更なし**（R7）。用語集追加でキャッシュは無効化されない |
| `adj:${imgHash}` | そのまま保持。シリーズ単位への移行は当面不要 |
| `whitelist` | そのまま。シリーズとは独立した責務（サイト ON/OFF ゲート）。シリーズ検出は whitelist 通過後にのみ走る |
| `settings` | そのまま。シリーズ override は別レイヤー |
| `apiStats` | そのまま。シリーズ別集計を出すかは Phase 2 完了後に判断（YAGNI） |

**破壊的変更なし**。Phase 3 でも既存キャッシュは温存される。

---

## 9. リスクと緩和策

| # | リスク | 緩和案 |
|---|---|---|
| 1 | シリーズ自動推定の誤マージ（別作品が偶然同名） | 設定 UI で一覧・手動分離（Phase 2）、`urlPatterns` に origin を残して可視化 |
| 2 | 用語集の誤登録累積 | 自動登録は候補キュー止まり、`approved: true` のみ層 B 置換に適用 |
| 3 | プロンプト肥大化によるコスト・レイテンシ増 | 上位 N 件 cap、口調指示は短文に限定 |
| 4 | `storage.local` 5MB 枠超過 | 4MB 到達時警告、`lastVisitedAt` LRU で古いシリーズを自動アーカイブ（Phase 2） |
| 5 | 同人作品・タイトル不明ページ | URL fallback、設定 UI から命名可能 |
| 6 | 用語集の**逆翻訳衝突**（"Hulk" → ハルク 適用後、"Hulk Hogan" が別文脈で出る） | 層 B 置換は `original` フィールドに該当単語があった場合のみ実行 |
| 7 | キャラ別口調・few-shot 例文を Phase 3 でやらない判断の妥当性 | Phase 6 で対応。MVP は全体トーン1個に絞る |
| 8 | Nano モデルダウンロード未完了／Safety Filter による拒否 | 状態を UI 可視化、ダウンロード促進ボタン、Safety 拒否時は Regex/URL fallback |
| 9 | Service Worker 再起動で Nano セッションが切れる | セッションは都度生成・破棄、永続化しない。状態は `series:*` 側だけに保持 |
| 10 | `adjustments`（ユーザー手動修正）と用語集の優先順位 | adjustments が常に最優先。glossary 置換は adjustments で上書きされた overlay には適用しない |
| 11 | 言語ペア複数併用（英→日と英→中で同シリーズ） | `glossary` を `[targetLang]` でネスト（§4 参照） |
| 12 | whitelist 未登録サイトでのシリーズ検出走行 | **whitelist 通過後にのみシリーズ検出を実行**（Phase 1 でこの境界を明示） |
| 13 | ユーザー読書サイトの実タイトル分布が不明 | Phase 1 で実データを `urlPatterns` から収集、Phase 2 着手前に Regex 命中率 80% 以上を確認 |

---

## 10. 既知の限界・注意事項

- シリーズ検出はタイトルとURLに強く依存する。データが乱れているサイトでは精度が落ちる
- 用語集は「Hulk → ハルク」レベルの単純対応のみを保持。文脈依存の訳し分け（同じ単語が場面で違う訳）は対象外
- 口調統一は Vision API への指示として注入するだけで、後処理での強制はしない（Phase 6 で対応検討）
- 層 A のプロンプトインジェクトはキャッシュ miss 時のみ効く。既存キャッシュには遡及しない
- 層 B の出力後置換は単純な文字列置換のため、活用形・送り仮名違い等は対応不可

---

## 11. 次のステップ

Phase 1（シリーズ検出パイプライン）の詳細設計に進む。
別ファイル `2026-05-27-doug-v2-phase1-detection-design.md` として書き起こす予定。
