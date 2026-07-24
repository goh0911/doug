# Doug v2 Phase 6 — few-shot 例文注入 設計

作成日: 2026-07-24
対象バージョン: **1.14.0**
前提: Phase 1〜5 実装済み（シリーズ検出 / ストレージ・UI / プロンプト注入 / Nano用語集抽出 / Nano検出fallback）

---

## 1. 目的とスコープ

### 目的
シリーズごとに「良い訳例（原文→訳文の文ペア）」を few-shot として翻訳プロンプトに注入し、
訳文の口調・言い回しの一貫性と品質を安定させる。

### スコープ
- `series` に `examples` 枠を追加し、`recentPairs` から**候補提示→ユーザー承認**で例文を貯める。
- 翻訳プロンプト生成（層A `buildSeriesPromptSection`）に **【翻訳例】ブロック**を追加し、承認済み例文の上位 5 件を注入する。
- 候補の絞り込みは既存の `sampleRecentPairs`（ヒューリスティック）を流用し、**Nano は使わない**。

### 非スコープ（YAGNI）
- Nano による例文の選別・生成（ヒューリスティック候補＋手動承認で十分）。
- キャラ別口調・訳文整合化（Phase 6 の別候補。本 Phase では扱わない）。
- 既存キャッシュの再翻訳（プロンプト変更後の新規翻訳から効く。既存キャッシュは温存）。

---

## 2. 要件

| ID | 要件 |
|---|---|
| R1 | シリーズごとに良訳例を貯め、翻訳プロンプトに注入して訳文スタイルを安定させる |
| R2 | 例文は「良い訳」であることを担保する（ユーザー承認フロー） |
| R3 | 例文もプロンプトに入るため、インジェクション・肥大を防ぐ（サニタイズ・件数/長さ上限） |
| R4 | 既存翻訳キャッシュを壊さない（新規翻訳から反映） |
| R5 | Nano 非依存で動作する（実機ゲート不要・ユニットテストで完結） |

---

## 3. アーキテクチャ（3つの流れ）

```
① 候補提示・承認（series 詳細ページ）
   series.recentPairs ──sampleRecentPairs()──▶ 候補リスト表示
     ├ 「例文に採用」 ──ADD_EXAMPLE──▶ series.examples に追加（サニタイズ・上限チェック）
     └ 登録済み examples に「削除」 ──REMOVE_EXAMPLE──▶ 該当を削除

② データモデル（series-store）
   series.examples: [{ original, translated, addedAt }]
     - 保持上限 10 件（超過は追加拒否）
     - 各フィールド 150 字切り詰め
     - series 全体の quota 管理に含める

③ 翻訳プロンプト注入（層A 拡張）
   buildSeriesPromptSection({ seriesName, glossaryLangMap, toneStyle, examples })
     【用語集】→【訳文の口調】→【翻訳例】(上位 5 件) の順
```

### 設計原則
- **Nano 非依存**：候補は `sampleRecentPairs`（既存ヒューリスティック）、注入は文字列組み立てのみ。純粋関数でユニットテスト完結。
- **層A の一貫性**：既存の `buildSeriesPromptSection`（用語集・口調）に **examples 引数を1つ足す**だけ。
- **同期ルール順守**：`utils/prompt-builder.js` を変更したら content.js のコピー（IIFE 内 `buildSeriesPromptSection`）も同期（CLAUDE.md）。

---

## 4. データモデルと容量管理

### series への追加フィールド
```js
series.examples: [
  { original: string, translated: string, addedAt: number }
]
```
- `getSeriesWithDefaults` に補完を追加：`if (!Array.isArray(series.examples)) series.examples = [];`
  （既存の `recentPairs` / `rejectedOriginals` 補完と同型。マイグレーション不要）

### 上限
- **保持 10 件**（`EXAMPLES_MAX = 10`）。超過時は**追加を拒否**して UI 通知（手動キュレーションなので勝手に削除しない）。
- 各フィールド **150 文字**に切り詰め。
- 専用バイト上限は設けず、件数×長さで抑制（10件×150字で実質数KB）。既存の series quota（WARN 6.5MB / ARCHIVE 7.32MB）に含める。

### サニタイズ（`utils/example-utils.js`・純粋関数）
`sanitizeExample({ original, translated })`:
- 各フィールド 150 文字に切り詰め
- 制御文字（U+0000–001F, U+007F）・Unicode方向制御（U+202A–202E, U+2066–2069, U+200B–200F）・タグ文字（U+E0000–E007F）除去、改行/タブ→空白
- 区切り記号 `<<<<` `>>>>` `[SYSTEM]` `[DATA]` を `_` に無害化（Phase 4/5 と同型）
- どちらかが空になったら `null`（無効）
- 戻り値 `{ original, translated } | null`

### 新規 series-store 関数 + background ハンドラ
| 関数 | メッセージ | 動作・戻り値 |
|---|---|---|
| `addExample(seriesId, { original, translated })` | `ADD_EXAMPLE` | `sanitizeExample`→重複チェック（original+translated一致）→10件上限チェック→追加。`{ status:'ok'\|'full'\|'duplicate'\|'invalid', examples }` |
| `removeExample(seriesId, index)` | `REMOVE_EXAMPLE` | 指定 index を削除。`{ examples }` |

`getSeries` は既存どおり `examples` も含めて返す（追加実装不要）。

---

## 5. プロンプト注入（`buildSeriesPromptSection` 拡張）

引数に `examples` を追加し、【翻訳例】ブロックを用語集・口調の**後**に配置する。

```js
// EXAMPLES_CAP = 5（プロンプト注入上限）
const exampleList = Array.isArray(examples)
  ? examples.filter(e => e && e.original && e.translated).slice(0, EXAMPLES_CAP)
  : [];

// 空判定を更新
if (entries.length === 0 && !toneInstruction && exampleList.length === 0) return '';

// ...用語集・口調の lines.push の後...
if (exampleList.length > 0) {
  lines.push('【翻訳例】以下の対訳と同じ口調・言い回しで訳してください:');
  exampleList.forEach((e, i) => lines.push(`${i + 1}. ${e.original} → ${e.translated}`));
}
```

生成例：
```
このコミックは「Immortal Hulk」シリーズです。
【用語集】以下の固有名詞は必ずこの訳語を使用してください:
1. Hulk → ハルク
【訳文の口調】硬く落ち着いた文体で翻訳してください。
【翻訳例】以下の対訳と同じ口調・言い回しで訳してください:
1. WHO ARE YOU?! → お前は誰だ！？
2. I AM THE HULK. → 私がハルクだ。
```

### 同期が必要な4箇所（CLAUDE.md ルール）
| ファイル | 変更 |
|---|---|
| `utils/prompt-builder.js` | `buildSeriesPromptSection` に examples 対応 |
| `content.js`（IIFE 内 `buildSeriesPromptSection`、138-165 付近） | 同一ロジックを同期 |
| `translate.js:45` | 呼び出しに `examples: series.examples` を追加 |
| `content.js:237` | 同上 |

- 注入は **上位5件（`examples` の先頭5件＝追加順）**。保存時にサニタイズ済みのため注入時の加工は不要。

---

## 6. 承認 UI（series 詳細ページ）

Phase 4 の候補承認UI（`renderCandidateSection` / `renderGlossaryRows`）と同じパターンで `renderExamplesSection` を追加する。

```
【翻訳例】セクション
├ 登録済み examples 一覧（各行 original → translated ＋「削除」ボタン → REMOVE_EXAMPLE）
├ 候補エリア: sampleRecentPairs(series.recentPairs) を表示
│   └ 各候補に「例文に採用」ボタン → ADD_EXAMPLE
└ 10 件上限に達したら採用ボタンを無効化＋「上限（10件）」通知
```
- 対象：`series.js`（`renderExamplesSection` 追加、`renderDetail` から呼ぶ）、`series.html`（セクション枠）

---

## 7. テスト戦略（Nano 非依存・全てユニットで完結）

| テスト | 内容 |
|---|---|
| `tests/unit/example-utils.test.js`（新規） | `sanitizeExample`：制御/方向/タグ文字除去・区切り記号無害化・150字切り詰め・空拒否 |
| `tests/unit/prompt-builder.test.js`（新規 or 追加） | `buildSeriesPromptSection` の examples 注入：上位5件・順序（用語集→口調→例文）・空判定・examples のみのケース・既存（用語集/口調）の回帰 |
| `tests/unit/series-store.test.js`（追加） | `addExample`（上限10・重複・invalid・ok）/ `removeExample` |
| 手動確認 | content.js コピーの同期（`buildSeriesPromptSection`）／series ページの UI 動作 |

---

## 8. リスクと対策

| # | リスク | 対策 |
|---|---|---|
| R1 | プロンプト肥大（用語集30＋例文5でトークン増） | 例文 5 件・各 150 字で抑制。効果を見て調整可 |
| R2 | インジェクション（例文がプロンプトに入る） | 保存時 `sanitizeExample`（Phase 4/5 と同型の多層防御） |
| R3 | 自己参照で品質が上がらない（AI訳を例に再投入） | ユーザー承認フローで良訳のみ昇格（供給源の設計で対処） |
| R4 | content.js コピーの同期漏れ | CLAUDE.md チェックリスト＋手動確認（`buildSeriesPromptSection` 4箇所） |
| R5 | 翻訳結果が変わる（プロンプト変更） | Phase 3 と同じ性質。既存キャッシュは温存、新規翻訳から反映（R4 要件どおり） |

---

## 9. バージョン

- **1.14.0**（機能追加・翻訳結果が変わる＝Phase 3 と同じ性質、実系列準拠のマイナーバンプ）。
  ※ ロードマップ表の当初想定は 2.3.0 だが、実バージョン系列（Phase 3=1.10.0 / Phase 4=1.12.0 / Phase 5=1.13.0）に合わせる。
- `manifest.json` と `package.json` の両方を更新。

---

## 10. 決定ログ

| ID | 決定 | 理由 |
|---|---|---|
| D-1 | 供給源は**承認フロー**（候補提示→ユーザー承認） | few-shot は「良訳」であることが効果の前提（R2）。Phase 4 用語集と一貫した UX |
| D-2 | 候補絞り込みは**ヒューリスティック**（`sampleRecentPairs` 流用）、Nano不使用 | 例文は文ペアなので抽出加工不要。Nano依存を避け軽量・オフライン可・テスト完結（R5） |
| D-3 | **保持10件・各150字・超過は追加拒否** | 手動キュレーションなので勝手に削除しない。トークン肥大を抑制（R1/R3） |
| D-4 | 注入は用語集→口調→**【翻訳例】上位5件** の順 | few-shot を直近文脈に置き効かせる。件数は肥大とのバランス |
| D-5 | サニタイズは `utils/example-utils.js` に純粋関数化 | プロンプト注入前の多層防御。ユニットテスト可能（Phase 4/5 と同方針） |
| D-6 | バージョンは **1.14.0**（実系列準拠のマイナー） | 機能追加・既存キャッシュ温存。ロードマップ表の 2.3.0 ではなく実系列に合わせる |
