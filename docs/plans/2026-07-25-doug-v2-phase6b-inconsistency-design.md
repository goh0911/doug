# Doug v2 Phase 6-B — 訳ゆれ検出（用語ブレ警告）設計

作成日: 2026-07-25
対象バージョン: **1.15.0**
前提: Phase 1〜6（6-A few-shot 含む）実装済み

---

## 1. 目的とスコープ

### 目的
用語集に未登録の固有名詞で、同じ原語が回によって異なる訳になっている（訳ゆれ）ものを検出し、
候補UIで「⚠️訳ゆれ」として可視化・優先提示して、用語集への登録（＝層Bでの統一）を促す。

### スコープ
- **Phase 4（Nano 用語集抽出）に相乗り**：1回の抽出（`runExtraction`）で「用語候補」と「訳ゆれ」を同時に取得。
- Nano プロンプトを拡張し、訳ゆれのある語に `variants`（訳のバリエーション）と `inconsistent:true` を付与させる。
- 候補UI（`renderCandidateSection`）で訳ゆれ候補を⚠️表示＋優先ソート。

### 非スコープ（YAGNI）
- 独立した専用ブレ検出機能・専用UI（Phase 4 の候補フローに統合するため不要）。
- 登録済み用語のブレ検出（層B `glossary-substitute.js` が既に自動統一しているため対象外）。
- Nano 呼び出しの追加（Phase 4 の1回で完結）。

---

## 2. 要件

| ID | 要件 |
|---|---|
| R1 | 未登録固有名詞の訳ゆれ（同一原語に複数訳）を検出し可視化する |
| R2 | Nano 呼び出しを増やさない（Phase 4 の抽出に相乗り） |
| R3 | 誤検出（Nano の variants 誤申告）が用語集・翻訳を汚染しない |
| R4 | 既存挙動（用語候補抽出）を壊さない（候補に情報が増えるだけ） |

---

## 3. アーキテクチャ

```
runExtraction（Phase 4・既存）
  └ buildExtractionPrompt に「訳ゆれ検出」指示を追加
  → Nano 出力: [{original, translated, variants?, inconsistent?}]
  → parseCandidatesJson / sanitizeCandidate（variants/inconsistent 検証・正規化）
  → mergeCandidates: 候補エントリ（source:'nano-extract', approved:false）に
     variants/inconsistent を一時保存
  → renderCandidateSection:
      - inconsistent:true を上位に優先ソート
      - ⚠️アイコン＋「訳ゆれ」ラベル＋ variants 併記
  → 承認（ADD_GLOSSARY_ENTRY, source:'manual'）で通常エントリに上書き
     → variants は自然に落ちる → 層Bで以後統一
```

### 設計原則
- **Phase 4 相乗り**：recentPairs を1回渡すだけで候補＋訳ゆれを取得（R2）。
- **候補エントリに一時保存**：候補は glossaryLangMap に永続化され UI がそこから読むため、
  `variants`/`inconsistent` を候補エントリに保存する必要がある。承認で通常エントリに上書きされ残らない。
- **同期**：`utils/nano-extract.js` の `buildExtractionPrompt`/`sanitizeCandidate`/`parseCandidatesJson` を変更 →
  series.js のインライン `_buildExtractionPrompt` / `_parseCandidatesJson` を同期（CLAUDE.md）。
  `mergeCandidates` は nano-extract.js のみ（series-store.js が ES module import）で **series.js コピー不要**。

---

## 4. Nano プロンプトと出力形式

### 出力形式（`variants`/`inconsistent` は任意）
```json
[
  {"original":"Hulk","translated":"ハルク"},
  {"original":"Banner","translated":"バナー","variants":["バナー","バンナー"],"inconsistent":true}
]
```
- 訳ゆれのない語は従来どおり `{original, translated}` のみ。

### `buildExtractionPrompt` への追記
```
「訳ゆれ検出」 同じ原語が DATA 内で複数の異なる訳で訳されている場合、
  variants に訳のバリエーションを列挙し inconsistent を true にする。
  translated には最も適切と思われる訳を入れる。訳ゆれが無ければ variants/inconsistent は省略。

「出力」 ```json で囲んだ JSON 配列のみ。説明・前置き不可。
[{"original":"...","translated":"...","variants":["...","..."],"inconsistent":true}]
```

### パーサー（`sanitizeCandidate`）の拡張
- 既存検証（`original` 英数記号1〜30字 / `translated` 制御文字除去1〜30字）は不変。
- `variants`：配列のときのみ採用。各要素を `translated` と同じサニタイズ、無効要素は除外。
- **正規化**：有効な `variants` が **2件未満なら訳ゆれ扱いしない** → `variants`/`inconsistent` を落として通常候補にする（Nano の誤申告を弾く / R3）。
- `inconsistent`：`variants.length >= 2` のときのみ `true`。

### `mergeCandidates` の拡張
```js
next[c.original] = {
  translated: c.translated,
  approved: false,
  count: 0,
  addedAt: Date.now(),
  source: 'nano-extract',
  ...(c.inconsistent && Array.isArray(c.variants) ? { variants: c.variants, inconsistent: true } : {}),
};
```

---

## 5. 候補UI（`renderCandidateSection`）

`series.js:539` の候補描画ループを拡張：

1. **優先ソート**：`inconsistent:true` を上位に
   ```js
   pendingKeys.sort((a, b) =>
     (glossaryLangMap[b].inconsistent ? 1 : 0) - (glossaryLangMap[a].inconsistent ? 1 : 0));
   ```
2. **⚠️表示**：`inconsistent` な候補は、アイコンを `✨`→`⚠️`、ラベルを「自動候補」→「訳ゆれ」にし、variants を併記
   ```
   ⚠️ 訳ゆれ  Banner → バナー
             訳ゆれ: バナー / バンナー
   ```
3. **承認/却下は既存のまま**：承認で `translated` 確定（層Bで統一）、却下で削除。

---

## 6. テスト戦略

| テスト | 内容 |
|---|---|
| `tests/unit/nano-extract.test.js`（追加） | `sanitizeCandidate`：variants の配列検証・各要素サニタイズ・**2件未満で variants/inconsistent を落とす**・inconsistent 正規化 / `parseCandidatesJson`：variants を含む候補のパース / `mergeCandidates`：訳ゆれ候補に variants/inconsistent が付く・通常候補には付かない |
| 手動確認 | series.js UI（⚠️表示・優先ソート）、Nano 実機での訳ゆれ検出、承認後に variants が残らないこと |

---

## 7. リスクと対策

| # | リスク | 対策 |
|---|---|---|
| R1 | Nano の訳ゆれ検出が不正確（variants 誤列挙） | 「2件未満は訳ゆれ扱いしない」正規化で誤検出を弾く。承認制なので誤りは翻訳に影響しない |
| R2 | プロンプト複雑化でトークン増・抽出精度低下 | Phase 4 プロンプトに1ブロック追加のみ。実機で抽出品質を確認 |
| R3 | nano-extract.js ↔ series.js インラインの同期漏れ | CLAUDE.md チェックリストに従い `_buildExtractionPrompt` / `_parseCandidatesJson` を同期（`mergeCandidates` は nano-extract.js のみでコピー不要） |
| R4 | 承認後に variants が残る | `ADD_GLOSSARY_ENTRY`（source:'manual'）で上書きされ残らない（テスト＋手動で確認） |

---

## 8. バージョン

- **1.15.0**（機能追加・既存挙動は候補に情報が増えるのみ）。
- `manifest.json` / `package.json` を更新。

---

## 9. 決定ログ

| ID | 決定 | 理由 |
|---|---|---|
| D-1 | ブレ検出対象は**未登録固有名詞**のみ | 登録済み用語は層Bが自動統一するため対象外 |
| D-2 | **Phase 4 抽出に相乗り**（独立機能にしない） | ゴール（用語集化→層B統一）が Phase 4 と重なる。Nano 1回で完結し軽量（R2） |
| D-3 | **variants が2件未満なら訳ゆれ扱いしない** | Nano の誤申告を弾く（R3） |
| D-4 | variants/inconsistent は**候補エントリに一時保存、承認で落とす** | 候補は glossaryLangMap に永続化され UI がそこから読むため。承認後は不要 |
| D-5 | バージョンは **1.15.0**（実系列準拠のマイナー） | 機能追加・既存挙動は候補に情報追加のみ |
