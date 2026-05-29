# Doug v2 Phase 3: 用語集・口調インジェクト（層A）+ 出力後置換（層B）詳細設計

作成日: 2026-05-29
親設計: `2026-05-27-doug-v2-series-detection-design.md`（§5 を実装に落とす）
前段: Phase 2（2A ストレージ / 2B 一覧 / 2C 編集 UI）完了済み（v1.10.0）
バージョン: **2.0.0**（新規翻訳の結果が変わる＝メジャー）

## 概要

Phase 2 で「貯めて編集できる箱」（`series:${id}.glossary` / `.tone`）が完成した。Phase 3 で初めてそれを **翻訳結果に反映**する。

- **層A（プロンプトインジェクト）**: API 呼び出し時（cache miss 時のみ）、用語集と口調をプロンプトに織り込む。
- **層B（出力後置換）**: 翻訳結果の `translated` 文字列に対し、用語集の訳語へ置換。**cache hit にも適用**（用語集追加が既存翻訳にも効く・R7）。

**キャッシュキーは変更しない**（親設計 §5.1）。`cache:${imgHash}:${lang}:${provider}:${model}` のまま。用語1語の追加で全キャッシュが飛ぶ事故を防ぐ。

---

## 1. スコープ

| | 内容 |
|---|---|
| IN | 層A（用語集＋口調注入）、層B（出力後置換）、seriesId のリクエスト配線、`stats.glossaryHits` 集計、**Gemini/Claude/OpenAI 系と Ollama 系の両方**対応 |
| OUT（Phase 4 以降） | Nano による用語集自動抽出、キャラ別口調、few-shot 例文、訳文整合化 |

---

## 2. 翻訳パイプラインの現状（調査結果）

| 系統 | 実行主体 | プロンプト構築 | パース | キャッシュ |
|---|---|---|---|---|
| **Gemini/Claude/OpenAI** | background.js → translate.js | `buildTranslationPrompt(targetLang)`（translate.js L101-133） | `parseVisionResponse`（utils/parse-utils.js L26-97） | **あり**（cache.js、background が get/save） |
| **Ollama** | content.js 完結 | `translateWithOllamaDirect`（content.js L121-182、プロンプト L132-163） | `ollamaParseResponse`（content.js L73-119、正本 utils/ollama.js） | **なし**（content.js に cache 呼び出し無し） |

- `parseVisionResponse` / `ollamaParseResponse` の各要素: `{ bbox, original, translated, type }`。層Bの対象は `translated`、ガードは `original`。
- キャッシュ内容: `{ translations, timestamp, version }`。`getCachedTranslation` は `translations` 配列（`original` 含む）を返す → **cache hit でも層Bのガードに使える**。
- content→background の翻訳要求: port `translate` に `{ type:'TRANSLATE_IMAGE', imageData, imageUrl, forceRefresh }`（content.js L202, L728）。
- `seriesInfo`（`{ seriesId, series, source, ... }`）は content.js で検出済み（L18 宣言、L370 セット）。翻訳成功時に `RECORD_SERIES_TRANSLATION` を送出（L630-）。

---

## 3. 新規 pure モジュール

`chrome.*` を使わず、`tests/unit` でテストする（CLAUDE.md の制約準拠）。

### 3.1 `utils/prompt-builder.js`（層A）

```js
// プリセット口調 → 指示文（'auto' は指示なし＝''）
const TONE_INSTRUCTIONS = {
  auto:    '',
  敬体:    '全体的に「です・ます」調で翻訳してください。',
  常体:    '全体的に「だ・である」調で翻訳してください。',
  硬め:    '硬く落ち着いた文体で翻訳してください。',
  柔らかめ: '柔らかく口語的な文体で翻訳してください。',
};

const GLOSSARY_CAP = 30; // 親設計 §5.4

/**
 * シリーズ文脈（用語集＋口調）をプロンプト断片として返す。
 * 何も無ければ '' を返す（呼び元は素のプロンプトのまま）。
 * @param {{ seriesName?:string, glossaryLangMap?:object, toneStyle?:string }} args
 * @returns {string}
 */
export function buildSeriesPromptSection({ seriesName, glossaryLangMap, toneStyle }) { ... }
```

- 用語集: `approved === true` のみ、`count` 降順、上位 `GLOSSARY_CAP` 件、`原文 → 訳語` で列挙。
- 口調: プリセットは `TONE_INSTRUCTIONS` で変換。`auto` または該当なし→口調指示を出さない。**プリセット外の文字列（カスタム口調）はそのまま指示文として埋め込む**（2C で sanitize 済み・≤200字）。
- 出力フォーマット（親設計 §5.2 準拠）:
  ```
  このコミックは「{seriesName}」シリーズです。
  【用語集】以下の固有名詞は必ずこの訳語を使用してください:
  1. Hulk → ハルク
  ...
  【訳文の口調】{toneInstruction}
  ```
- 用語集が空かつ口調が auto/なし → `''`（注入しない）。

### 3.2 `utils/glossary-substitute.js`（層B）

```js
/**
 * 1 吹き出しの訳文に用語集置換を適用。
 * ガード: 用語集の original が当該吹き出しの original テキストに含まれる場合のみ置換を試みる（親設計 §5.3）。
 * @returns {{ text:string, hits:number }}
 */
export function substituteGlossaryTerms(translated, original, glossaryLangMap) { ... }

/**
 * translations 配列全体に適用。
 * @returns {{ translations:Array, totalHits:number }}
 */
export function applyGlossaryPostProcess(translations, glossaryLangMap) { ... }
```

- `approved === true` のエントリのみ対象。
- **1パス置換（冪等性確保・レビュー P0-1）**: 層Bは cache hit で繰り返し走るため、素朴な逐次 `replace` だと二重置換・連鎖置換（訳語が別の original を含むと連鎖）で訳文が累積破壊される。これを防ぐため：
  1. 対象 original を **長い順（文字数降順）にソート**（`Hulk` より `Hulkbuster` を先に＝部分一致誤爆を緩和）。
  2. 全 original を `|` で alternation した**単一正規表現を1回だけ** `replace(re, m => map[m])` で適用。マッチ済み領域は再走査されないため、置換結果に再マッチせず冪等。
  3. `original` は正規表現メタ文字を**エスケープ**。case-sensitive。
- **ガード（逆翻訳衝突防止・親設計 §5.3）**: その吹き出しの `original`（原文）に含まれる用語のみを alternation に組み込む。原文に無い用語は置換対象にしない。
- `hits` は1パスでのマッチ数。`glossaryLangMap` が空/undefined のときは入力をそのまま返し `hits=0`。
- **CJK の単語境界判定（`\b` は CJK で機能しない）は Phase 4 送り**。Phase 3 は「長い順ソート＋1パス」で実害の大半を防ぐ方針。

---

## 4. 層A の配線

### 4.1 seriesId をリクエストに乗せる
- content.js `translateImage`（L187）→ port メッセージ（L202, L728）に `seriesId: seriesInfo && seriesInfo.seriesId ? seriesInfo.seriesId : null` を追加。
- background port handler（L100-107）→ `handleImageTranslation(imageData, imageUrl, imageDims, { forceRefresh, seriesId })` に渡す。

### 4.2 Gemini/Claude/OpenAI 系（background / translate.js）
- `buildTranslationPrompt(targetLang, seriesSection = '')` に引数追加。`seriesSection` が非空なら既存プロンプト末尾（または冒頭の文脈部）に追記。
- `handleImageTranslation`: **cache miss 時のみ** `getSeries(seriesId)` → `buildSeriesPromptSection({...})` → `buildTranslationPrompt(targetLang, section)`。
- cache hit 時は層Aをスキップ（プロンプトを作らない）。

### 4.3 Ollama 系（content.js）
- `translateWithOllamaDirect`: `seriesInfo.seriesId` があれば `GET_SERIES` で series を取得し、プロンプト（L132-163）に用語集・口調を追記。
- **論点**: content.js は classic script で `utils/prompt-builder.js` を import できない（§7 で扱う）。

---

## 5. 層B の配線

### 5.1 Gemini/Claude/OpenAI 系（background）
- `handleImageTranslation`: fresh（parse 後）と cache hit（`getCachedTranslation` 後）の **両方**で、`getSeries(seriesId).glossary[targetLang]` を使い `applyGlossaryPostProcess` を適用してから返す。
- cache hit のためだけに `getSeries` を呼ぶコストは軽微（storage.local 1 read）。seriesId が null のときは層Bスキップ。

### 5.2 Ollama 系（content.js）
- `ollamaParseResponse` 後に置換を適用（content 内コピー関数、§7）。Ollama はキャッシュ無しなので毎回 fresh + 層B。

### 5.3 `stats.glossaryHits` 集計（レビュー P0-2：単一合流に確定）
- **単一合流点 = content.js が送る `RECORD_SERIES_TRANSLATION`**。翻訳成功時に content が送出する既存メッセージ（fresh / cache hit の**両方で発火することを確認済み** content.js L630）の payload に `glossaryHits` を載せ、`recordSeriesTranslation` で `stats.glossaryHits = (stats.glossaryHits ?? 0) + (glossaryHits ?? 0)`。
- 各系統での hits の渡し方:
  - **Gemini系**: 層Bは background で走るため、`handleImageTranslation` の戻り（port レスポンス `{ translations, fromCache, ... }`）に `glossaryHits` を**追加して返す**。content はそれを RECORD payload に転送。
  - **Ollama系**: 層Bは content で走るため、content が直接 `totalHits` を RECORD payload に載せる。
- **カウントの意味論**: 「翻訳イベントごとの累積置換回数」。cache hit でも層B（＝RECORD）が走るので、同じ画像を開くたびに加算される。これは精密なユニーク数ではなく **「用語集が効いているかの粗いデバッグ指標」** と定義する（親設計 §5.3「誤置換検出のため」の用途に十分）。fresh 限定カウントや画像単位の重複排除は将来検討（Phase 4）。
- 書込は **翻訳実行の延長**のみ（親設計の「翻訳実行時のみ書込」原則を維持）。

---

## 6. キャッシュ戦略（親設計 §5.1 を踏襲）

- キャッシュキー **不変**。`CACHE_AFFECTING_KEYS` も変更しない（seriesId/glossary/tone を含めない）。
- 層A: cache miss のみ。層B: cache hit/miss 両方。
- **既知の妥協**: 口調（tone）は文章全体の文体に効くため層Bでは後から変えられない。cache hit のページは「過去の文体のまま、表記揺れだけ層Bで補正」。新しい口調を全面反映したい場合は **再翻訳（forceRefresh）** で対応（既存の「再翻訳」ボタンが該当）。
- 破壊的変更なし。Phase 3 でも既存キャッシュは温存。

---

## 7. content.js の重複コード問題（要・設計判断）

層A/B の pure 関数を **Gemini系（background, ESM）と Ollama系（content, classic script）の両方**で使う必要があるが、content.js は `utils/` を import できない。

| 案 | 内容 | 評価 |
|---|---|---|
| **案1: content にコピー + utils に正本** | `utils/ollama.js` と同じ既存パターン。`utils/prompt-builder.js` / `utils/glossary-substitute.js` をテスト正本にし、content.js 内に同期コピーを置く。CLAUDE.md に「同期義務」記載済みの方式 | 既存方針と一致。同期忘れリスクは CLAUDE.md チェックリストで担保 |
| 案2: Ollama も background 経由に統一 | content の翻訳経路を background に寄せる | 大改修・リスク大。Phase 3 のスコープ外。**却下** |
| 案3: background に新メッセージ | `BUILD_SERIES_PROMPT_SECTION` / `APPLY_GLOSSARY` を background に追加し content は呼ぶだけ。pure ロジックは utils 1 箇所 | 重複ゼロ。ただし Ollama 翻訳ごとに往復メッセージ増（プロンプト構築1回＋置換1回） |

**確定: 案1**（architecture-evaluator 推奨）。理由：
- 既存 `utils/ollama.js` が既に案1方式 → プロジェクト内で共有パターンを統一（規約「既存構成尊重」）。
- 層A/Bは完全な pure 関数（chrome.* 不要）。案3の往復メッセージは Ollama 翻訳ごとに **SW コールドスタート遅延**を被るうえ、pure 関数を往復させる本質的理由がない。

**同期義務（必須）**:
- `utils/prompt-builder.js` / `utils/glossary-substitute.js` の冒頭コメントに「content.js にコピーあり・変更時は両方更新」を明記（ollama.js と同じ運用文言）。
- CLAUDE.md「新機能追加時のチェックリスト」に同期項目を1行追加。

---

## 8. テスト方針

### 単体（新規）
- `prompt-builder.test.js`: cap30 / count 降順 / approved フィルタ / tone プリセット変換 / カスタム口調そのまま / 空入力で '' / seriesName 反映
- `glossary-substitute.test.js`: ガード（original 不在なら非置換）/ case-sensitive / 正規表現メタ文字を含む original のエスケープ / 複数語 / hits カウント / 空 glossary でそのまま

### 回帰
- 既存 161 件 + 新規。`utils/ollama.js` 同様に content コピーを採る場合（案1）はコピー側もテスト対象に含めるか検討。

### 手動
- 用語集ありシリーズで新規翻訳 → 訳語反映（層A）
- 既にキャッシュ済みページで用語集追加 → 再読込で層B反映
- 口調変更 → 新規翻訳で文体反映、cache hit では不変（再翻訳で反映）
- Ollama でも層A/B 動作

---

## 9. リスク

| # | リスク | 緩和 |
|---|---|---|
| 1 | 部分一致による誤置換（"Hulk"→"Hulking" 等） | 親設計どおり当面は単純置換。将来 word-boundary を検討。ガード（original 在席）で軽減 |
| 2 | プロンプト肥大化（コスト/レイテンシ） | 用語集上位 30 件 cap、口調 ≤200 字 |
| 3 | 2 系統の挙動差 | 共通 pure 関数で吸収（§7 の方式に依存） |
| 4 | content コピーの同期漏れ（案1 採用時） | CLAUDE.md チェックリストに項目追加 |
| 5 | seriesId 未検出ページ | 層A/B ともスキップ（既存挙動と同一） |
| 6 | 口調が cache hit に効かない | 既知の妥協として文書化、再翻訳で対応（§6） |

---

## 10. 完了基準

- [ ] 用語集ありシリーズで新規翻訳すると訳語が反映される（層A）
- [ ] キャッシュ済みページで用語集追加後、再読込で訳語が反映される（層B）
- [ ] 口調設定が新規翻訳に反映される
- [ ] Ollama でも層A/B が動作する
- [ ] `npm run test:unit` 全 PASS（新規テスト含む。層Bの冪等性＝同じ訳文に2回適用しても結果不変、を必ずテスト）
- [ ] 既存キャッシュが Phase 3 適用後も無効化されない
- [ ] seriesId 未検出ページで従来どおり翻訳できる（層A/B スキップ・例外なし）
- [ ] `approved:false` の用語は層B置換されない（エスケープハッチ）

---

## 11. レビュー反映後の確定事項（architecture-evaluator 2026-05-29）

| # | 論点 | 確定 |
|---|---|---|
| 1 | §7 コード共有 | **案1**（content コピー＋utils 正本＋同期義務）。§7 参照 |
| 2 | hits 集計 | **content の RECORD に単一合流**。Gemini系は background が glossaryHits を戻す。§5.3 参照 |
| 3 | 層A 位置 | Phase 3 は現書式（用語集→口調の1ブロック）で着手。冒頭/末尾の最適化は**実装後に実測チューニング**（過剰設計回避）。Notes に残す |
| 4 | tone と cache key | **key に入れない**（forceRefresh 運用）。glossary 追加で全キャッシュが飛ぶ事故（R7）と同じコストを tone で再現するため。§6 参照 |

### 11.1 seriesId 未検出時の完全フォールバック（P1）
- `seriesId` が null/未検出のページでは層A・層Bを**両方スキップし、従来どおりの翻訳にフォールバック**する。
- 層A/Bのいずれも**例外を投げない**（getSeries 失敗・glossary 不在・targetLang 不一致でも翻訳本体を止めない）。null/空チェックを網羅。

### 11.2 層Bのエスケープハッチ（P1）
- 誤置換が起きた用語は `approved:false` で**即座に層B対象から外れる**（2C の編集UIで approved を操作）。検証項目に含める。

### 11.3 カスタム口調は信頼境界外入力（P2）
- カスタム tone は 2C で sanitize 済み（≤200字・制御文字/デリミタ拒否）だが、プロンプトに直接埋め込む以上**信頼境界外の入力**として認識する。1人運用では実害低だが、配布時はプロンプトインジェクション観点で再点検する旨を注記。

### 11.4 tone 妥協のユーザー可視化（P2）
- 「口調変更は新規翻訳から反映、既読（キャッシュ）ページは再翻訳で反映」を、2C の口調編集UI付近にヒント表示する（実装は本フェーズ末 or Phase 4）。
