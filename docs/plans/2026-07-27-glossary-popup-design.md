# 固有名詞解説ポップアップ（辞書機能）実装設計

作成日: 2026-07-27
種別: **実装設計**
対象バージョン: 1.17.0（機能追加）
前提: Phase 1〜6-B 実装済み（v1.16.1）

先行文書: `2026-07-27-fandom-popup-evaluation.md`（評価。以下「評価メモ」）
本メモは評価メモ §51 / §52 を受けた実装設計であり、**実測にもとづき §51.4 の一部要件を訂正する**（§9）。

---

## 0. 決定事項

| 項目 | 決定 |
|---|---|
| データソース | **en Wikipedia 単独**。Fandom は実装しない |
| 拡張性 | ソース契約（1 メソッド）だけ切る。レジストリ・優先度チェーン・ソース別 UI は作らない |
| 取得方式 | `generator=search` + `prop=extracts&explaintext` の **1 コール**（解決と取得を同時に行う） |
| 生成エンジン | **Nano 優先・翻訳 API フォールバック**。options で変更可 |
| 生成物の形 | JSON `{identity, powers}` の 2 フィールド。自由文にしない |
| 生成タイミング | Nano: **シリーズ検出直後に先読み** / API: hover 時の遅延生成 |
| キャッシュ | `series.glossDefs`（series レコードの兄弟フィールド） |
| UI | オーバーレイ本文中の用語を `<span>` 化 → hover でポップアップ |
| 権限 | `chrome.permissions.request()` で有効化時に取得。必須 `host_permissions` は変更しない |
| 失敗時 | **常にポップアップを出さない**。誤情報を出すより出さない |

---

## 1. 実測（2026-07-27・本設計のために実施）

評価メモ §40 の 8/10 は**ページ名を人手で指定した**数字だった。本設計では glossary が持つ原語だけを入力に自動解決させ、改めて測った。

### 1.1 名前解決＋取得＋抽出（6/6 成功）

クエリ: `action=query&generator=search&gsrsearch="<原語>" <シリーズ名> comics&gsrlimit=1&prop=extracts&explaintext=1&redirects=1`

| 入力語 | 解決先ページ | 能力節 | 導入節 | 転送量 |
|---|---|---|---|---|
| Nightcrawler | Nightcrawler (character) | 1,903 字 | 2,405 字 | 32,569 B |
| Sentry | Sentry (Robert Reynolds) | 860 | 1,222 | 20,070 B |
| Vision | Vision (Marvel Comics) | 4,927 | 2,374 | 59,200 B |
| Moon Knight | Moon Knight | 7,204 | 2,543 | 45,736 B |
| Squirrel Girl | Squirrel Girl | 3,959 | 960 | 39,049 B |
| Deathstroke | Deathstroke | 1,284 | 1,311 | 37,030 B |

**評価メモ §51.2-1 が Fandom の障害として挙げた「コードネームからページに到達できない」問題は、Wikipedia では起きない。** シリーズ名をクエリに混ぜることで曖昧さ回避（`Vision` → `Vision (Marvel Comics)`）まで解決している。

### 1.2 検証ゲート（6/6 正答）

ゲート条件: **能力節が抽出できる AND 導入節に `/comic/i` が含まれる**。

| 入力語 | 解決先 | 能力節 | 導入 comic | 判定 |
|---|---|---|---|---|
| Nightcrawler | Nightcrawler (character) | あり | あり | ✅ 出す |
| Zzzax | Zzzax | あり | あり | ✅ 出す |
| Bamf | Bamf | あり | あり | ✅ 出す |
| Xavier Institute | List of Xavier Institute students | なし | あり | ❌ 出さない |
| Sokovia | Features of the Marvel Cinematic Universe | なし | あり | ❌ 出さない |
| Blorptastic（造語） | ヒットなし | ─ | ─ | ❌ 出さない |

キャラ以外の語（場所・施設）は一覧記事に当たるが能力節を持たないため落ちる。造語は検索がミスする。**誤ったページの内容を黙って採用する経路が無い。**

### 1.3 取得方式の比較（実測）

| 方式 | 転送量 | 往復 | 実装 |
|---|---|---|---|
| **A. 1 コール**（採用） | 平均 35 KB/語 | 1 回 | プレーンテキスト。節抽出のみ |
| B. 3 コール（`prop=sections` → 該当節 `wikitext`） | 約 12 KB/語 | 3 回 | テンプレート記法の除去が必要 |

A を採用する。20 語で約 700 KB になるが**シリーズ単位で一度きり**（以降はキャッシュ）で、抽出後は本文を即破棄する。B は転送量が 1/3 になる代わりに往復が 3 倍になり、かつ wikitext のテンプレート除去という Fandom 用の処理を Wikipedia にも背負い込む。

### 1.4 User-Agent

`Api-User-Agent: Doug-Comic-Translator/<version> (<contact>)` を付けて HTTP 200 を確認した。詳細は §9 の R-W1 訂正を参照。

---

## 2. アーキテクチャ

**取得・検証・生成・キャッシュはすべて `background.js` に置く。** これらのロジックは `content.js` の IIFE に一切入れない。content.js は生成済みの `{identity, powers, url}` を受け取って描画するだけになる。

例外は描画用の純関数 `splitByTerms` のみで、これは content.js 側にコピーを置く（Classic Script が ES Module を import できないための既存パターン。`utils/glossary-substitute.js` と同じ扱いで、CLAUDE.md のチェックリストに同期規則を追加する）。

```
┌─ content.js ────────────────────────────────────────┐
│  ページ読み込み                                       │
│    → 既存のシリーズ検出（title/h1/ogTitle）           │
│    → ★ PREFETCH_GLOSS_DEFS を送る                    │
│                                                      │
│  翻訳完了                                             │
│    → GET_GLOSS_DEFS で結果を受け取る                  │
│    → 訳文を用語境界で分割し <span> 化                 │
│    → hover でポップアップ（textContent 描画）          │
└──────────────────────────────────────────────────────┘
                        ↕ chrome.runtime.sendMessage
┌─ background.js ─────────────────────────────────────┐
│  ① series.glossDefs を照会（キャッシュヒット即返し）    │
│  ② 未生成語のみ 3 並列で source.fetchEntry()          │
│  ③ 検証ゲート（§1.2）                                │
│  ④ Nano で {identity, powers} 生成（不可なら翻訳 API） │
│  ⑤ series.glossDefs へ保存                           │
└──────────────────────────────────────────────────────┘
                        ↕
        utils/wiki-source.js / gloss-summary.js（純関数）
```

---

## 3. ソース抽象化

「あとで他ソースを足せる」ために必要なのは**継ぎ目 1 本**であり、システムではない。

```js
// ソース契約
{
  id: 'en-wikipedia',
  origin: 'https://en.wikipedia.org/*',   // permissions.request 用
  async fetchEntry(term, seriesName) {
    // → { title, url, intro, powers } | null
    // 検証ゲート不通過は null を返す
  }
}
```

実装は `utils/wiki-source.js` の 1 本のみ。background.js は `const SOURCES = [wikipediaSource]` を順に試し、最初に非 null を返したものを採用する。

**作らないもの**：ソース優先度の設定 UI、ソースごとの有効/無効トグル、動的登録レジストリ、ソース間のマージ。これらは Fandom を実装するときに初めて必要になる問題であり、Fandom は実装しない（評価メモ §51.2 の名前解決・ToS・ネタバレが未解決のため）。

---

## 4. データフローと生成タイミング

### 4.1 先読み（Nano 使用時のみ）

**トリガー**: シリーズ検出成功時（ページ読み込み直後）。翻訳完了を待たない。

ページ読み込み時点では本文が画像なので「ページ内にどの用語があるか」は判定できない。代わりに**シリーズの glossary 登録語全体**を対象にする。glossary は 1 シリーズ 2 KB 上限（`series-store.js:17`）で 1 エントリ約 70 バイトのため、対象は**実質 30 語弱**に自然に有界化される。

発火条件（すべて満たすとき）:

- 拡張が有効
- ホワイトリスト登録済みドメイン
- 辞書機能が ON
- シリーズ検出が成功している
- 生成エンジンが Nano（＝課金が発生しない）

**API フォールバック時は先読みしない。** hover 時の遅延生成に留める。使われない語のぶんまでユーザーの API キーを消費させないため。

副次的な効果として、`background.js:140` に記録されている Nano 初回推論のウォームアップ（実測 ≈18 秒）がページ読み込み直後に消化される。

### 4.2 hover 時

先読みが間に合わなかった語、および API フォールバック時は、hover 時にスピナーを表示してその場で生成する。**先読みと遅延生成は排他ではなく、前者が後者を先回りするだけ**の関係とする。

### 4.3 待ち時間

| | 1 話目 | 2 話目以降 |
|---|---|---|
| Nano（既定） | 先読み済みで基本ゼロ。間に合わなければ hover でスピナー | ゼロ（キャッシュ） |
| API フォールバック | 初回 hover で生成（スピナー） | ゼロ（キャッシュ） |

---

## 5. 生成エンジン

### 5.1 選択順

1. options の設定を読む（既定 `auto`）
2. `auto` の場合、`isNanoAvailableBg()`（`background.js:121`）が真なら Nano
3. Nano が不可、または Nano の出力が JSON 検証に落ちた場合は翻訳用 API にフォールバック
4. どちらも不可なら**生成しない**（ポップアップを出さない）

options の選択肢: `auto`（既定）/ `nano`（Nano のみ。不可なら機能を出さない）/ `api`（翻訳 API のみ）。

### 5.2 出力形式

自由文ではなく JSON 2 フィールドとする。この repo の Nano 呼び出しは `parseSeriesDetectionResponse` / `parseCandidatesJson` を含めすべて JSON 構造化＋フィールド単位検証で組まれており、その規律を踏襲する。

```json
{"identity": "…（対象言語で 40 字以内）", "powers": "…（同 80 字以内）"}
```

- `identity`: 何者か（所属・立場・正体）
- `powers`: 主要な能力 1〜2 点。列挙しない

検証（`utils/gloss-summary.js`）:

| 項目 | 規則 |
|---|---|
| 型 | 両フィールドとも string。オブジェクト・配列は不可 |
| 長さ | `identity` 1〜40 字、`powers` 1〜80 字。超過は句点で切る（文中で切らない） |
| 制御文字 | `cleanControlChars` を通す |
| 片方欠落 | もう片方が検証を通れば、欠落側を空にして表示する |
| 両方不正 | 生成失敗として扱い、ポップアップを出さない |

再生成はしない（評価メモ R-W16。コストとレイテンシに見合わない）。

### 5.3 入力

- 導入節: 先頭 600 字に切り詰め
- 能力節: 先頭 1,500 字に切り詰め（Moon Knight の 7,204 字は Nano の文脈長に載らない）
- 両方に共有サニタイザ（§9 の R-SEC-1b 訂正）を適用してからプロンプトへ入れる

プロンプトは既存の `buildSeriesDetectionPrompt`（`utils/series-nano.js:61`）と同じ `[SYSTEM]` / `[DATA]` / `<<<<BEGIN>>>>` 構造にする。第三者が編集できるソースを入力にするため、DATA ブロック内の指示を無視する旨を明示する。

---

## 6. キャッシュ

### 6.1 置き場所

`series.glossDefs` — series レコードの**兄弟フィールド**として持つ。

```js
series.glossDefs = {
  ja: {
    "Nightcrawler": {
      identity: "X-メンの一員",
      powers:   "別次元を経由して最大2キロ先まで瞬間移動する。",
      url:      "https://en.wikipedia.org/wiki/Nightcrawler_(character)",
      source:   "en-wikipedia",
      at:       1769500000000
    }
  }
}
```

**新しい `gloss:*` namespace を作らない。** `series-store.js:46` の `computeUsageInfo` は `series:*` で始まるキーしか集計せず、WARN（6.5 MB）/ ARCHIVE（7.32 MB）閾値もそこを基準にしている。別 namespace にすると既存の LRU・アーカイブ管理から外れて容量が野放しになる。

評価メモ R-W8' の「glossary の 2 KB 枠とは別建て」は、**同一レコード内の別フィールド**として満たす。

### 6.2 上限

`GLOSSDEFS_SERIES_MAX_BYTES = 16 * 1024`（1 シリーズ 16 KB）。

内訳（UTF-8 バイト。`series-store.js` は `TextEncoder` で計測するため日本語 1 字 = 3 バイト）:

| 項目 | 上限 | バイト |
|---|---|---|
| `identity` | 40 字 | 120 |
| `powers` | 80 字 | 240 |
| `url` | ─ | 約 70 |
| `source` / `at` / キー / JSON 構造 | ─ | 約 90 |
| **1 エントリ計** | | **約 520** |

520 バイト × 30 語 ≒ 15.6 KB。超過時は `at` の古い順に落とす。

### 6.3 保存しないもの

記事本文・抽出したテキスト・検索結果の生 JSON は保存しない。生成後に即破棄する（評価メモ R-W18）。

---

## 7. UI

### 7.1 span 化

訳文中の用語を hover 可能にするため、描画を「1 個のテキストノード」から「テキストノード＋`<span>` の並び」に変える。

現状（`content.js:1800` ほか）:
```js
textEl.textContent = item.translated;
```

変更後:
```js
const parts = splitByTerms(item.translated, termList);  // 純関数
textEl.replaceChildren(...parts.map(p =>
  p.term ? Object.assign(document.createElement('span'),
                         { className: 'doug-gloss-term', textContent: p.text })
         : document.createTextNode(p.text)
));
```

**`innerHTML` は使わない。** `createElement` + `textContent` + `createTextNode` のみで組むため、評価メモ R-SEC-2 の規律は保たれる。

`substituteGlossaryTerms`（`utils/glossary-substitute.js:27`）は**変更しない**。span 化は描画時に別の純関数 `splitByTerms` で行うため、既存の置換ロジックと content.js コピーの同期規則には触れない。

`splitByTerms` の対象は `glossaryLangMap[orig].translated` の文字列集合（置換後の訳文に現れるのはこちら）。既存の置換と同じく**長い順にソートして 1 パス**で走査し、部分一致の誤爆（Hulkbuster に Hulk がマッチする）を避ける。

### 7.2 ポップアップ

- トリガー: `mouseenter`（150 ms のディレイを置き、通り過ぎでは出さない）／`focus`（キーボード操作）
- 構造: `identity` を 1 行目、`powers` を 2 行目、出典リンクを末尾
- 描画: すべて `textContent`。リンクの `href` は生成済み URL を `new URL()` で検証し、`https://` かつ既知ソースの origin であることを確認してから設定する
- 帰属表示: 「出典: Wikipedia (CC BY-SA)」を常に添える
- 寸法: `content.css` の既存オーバーレイの作法に合わせる。新しいサイズ体系を導入しない（評価メモ R-W17）
- a11y: `<span>` に `tabindex="0"` と `aria-describedby`、ポップアップに `role="tooltip"`。Esc で閉じる

### 7.3 生成できなかった語

下線を引かず、`<span>` でも包まない。**通常の訳文としてそのまま表示する。**

---

## 8. 権限

`manifest.json:20` に `optional_host_permissions: ["*://*/*"]` が既にある。これを使う。

```js
await chrome.permissions.request({ origins: ['https://en.wikipedia.org/*'] });
```

- 呼ぶタイミング: options で辞書機能を ON にした瞬間（ユーザー操作の直後でなければ `permissions.request()` は失敗する）
- 拒否された場合は機能を OFF のままにし、理由を options に表示する
- **必須 `host_permissions` は変更しない。** 公開済み拡張の必須権限を増やすと、全ユーザーが再同意するまで拡張が無効化される
- 他ソースを足すときも、各 source が自分の `origin` を要求する形になる（§3 の契約に `origin` を含めた理由）

---

## 9. 継承要件と訂正

評価メモ §51.4 / §52.2 から継承する。**実測により 4 件を訂正する。**

### 9.1 訂正するもの

| ID | 訂正 |
|---|---|
| **R-W1** | ~~連絡先を含む `User-Agent` を必ず送る~~ → **`Api-User-Agent` ヘッダを送る**。`User-Agent` は Fetch 仕様の禁止ヘッダ名であり、Service Worker の `fetch()` からは設定しても黙って落ちる。Wikimedia がブラウザクライアント向けに用意している `Api-User-Agent` を使う（§1.4 で 200 を確認） |
| **R-W10** | ~~解説生成はバッチで行う~~ → **語ごとに独立・並列度 3**。1 記事が平均 35 KB あるため `exlimit=20` の一括取得は 700 KB の単一レスポンスになり逆効果。Nano 側も 20 語分の入力は文脈長に載らない |
| **R-W8'** | キャッシュは新 namespace ではなく **`series.glossDefs`**（§6.1） |
| **R-SEC-1b** | `escapeDelimiters` は `utils/nano-extract.js:35` でモジュール private であり、そのままでは再利用できない。**`utils/sanitize.js` に移して export し、nano-extract.js からも import する**（挙動は変えない） |
| **R-W11** | ~~翻訳完了時に glossary 登録語ぶんを先行生成~~ → **シリーズ検出直後に前倒し**（§4.1）。かつ Nano 使用時に限定する |

### 9.2 そのまま継承するもの

| ID | 内容 |
|---|---|
| R-SEC-1a | 解説生成は翻訳とは別の LLM 呼び出し。`buildSeriesPromptSection` に合流させない |
| R-SEC-1c | 生成結果は表示専用。承認ゲート無しに `glossary` / `examples` へ入れない |
| R-SEC-2 | 描画は `textContent` のみ（§7.1 の span 化でも維持） |
| R-W2'' | 能力節の終端は「同じ深さ以下の見出し」（§1.1 で再確認済み） |
| R-W12 | 対象は glossary 登録語に限定 |
| R-W13 | 抽出結果が空・極端に短い場合はポップアップを出さない |
| R-W14 | 出力文字数の上限をプロンプトで明示（§5.2 でフィールド単位に具体化） |
| R-W15 | 能力は主要な 1〜2 点に絞る。列挙させない |
| R-W16 | 上限超過は句点で切る。再生成はしない |
| R-W17 | 寸法は既存オーバーレイ UI の作法に合わせる |
| R-W18 | 記事本文・抽出テキストは保存しない |
| ライセンス | CC BY-SA。出典リンクと帰属表示を添える |

---

## 10. エラー処理

**すべての失敗は「ポップアップを出さない」に収束させる。**

| 失敗 | 挙動 |
|---|---|
| 検索ヒットなし | 出さない |
| 検証ゲート不通過（§1.2） | 出さない |
| 能力節が抽出できない | 出さない |
| JSON 検証で両フィールドとも不正 | 出さない |
| Nano・API とも利用不可 | 出さない |
| ネットワークエラー / タイムアウト | 出さない |
| 権限が拒否されている | 機能自体を OFF にする |

「出さない」＝ span で包まず下線も引かない。ユーザーからは辞書機能が存在しないのと同じ見た目になる。誤情報を出すより出さないほうが安全、という評価メモの原則を実装規律にする。

### 10.1 負の結果のキャッシュ

失敗した語も `series.glossDefs` に記録する。毎回のページ読み込みで同じ失敗を繰り返さないため。

```js
series.glossDefs.ja["Xavier Institute"] = { failed: true, at: 1769500000000 }
```

- 有効期間 24 時間。経過後は再試行する（記事が加筆される可能性があるため恒久的に諦めない）
- 1 エントリ約 60 バイトで、§6.2 の 16 KB 枠に同居する
- LRU で落とすときは失敗エントリを成功エントリより優先して落とす

タイムアウト: fetch 10 秒、Nano 生成 30 秒（`background.js:141` の既存値に合わせる）。

---

## 11. ファイル一覧

### 新規

| ファイル | 責務 | 純関数 |
|---|---|---|
| `utils/wiki-source.js` | 検索 URL 構築、導入節/能力節の抽出（R-W2''）、検証ゲート | ✅ |
| `utils/gloss-summary.js` | 生成プロンプト構築、JSON パースとフィールド検証、句点切り詰め | ✅ |
| `utils/gloss-highlight.js` | `splitByTerms(text, terms)` → `[{text, term}]` | ✅ + content.js コピー |
| `tests/unit/wiki-source.test.js` | 〃 | |
| `tests/unit/gloss-summary.test.js` | 〃 | |
| `tests/unit/gloss-highlight.test.js` | 〃 | |

### 変更

| ファイル | 変更内容 |
|---|---|
| `background.js` | `PREFETCH_GLOSS_DEFS` / `GET_GLOSS_DEFS` ハンドラ、fetch + 生成 + キャッシュのオーケストレーション、並列度 3 の制御 |
| `series-store.js` | `glossDefs` の読み書き、8 KB 上限と LRU 落とし |
| `content.js` | シリーズ検出後の先読み送信、`splitByTerms` コピー、span 描画、hover ポップアップ |
| `content.css` | `.doug-gloss-term`（下線）、`.doug-gloss-popup` |
| `options.html` / `options.js` | 辞書機能トグル、生成エンジン選択（auto/nano/api）、権限リクエスト |
| `utils/sanitize.js` | `escapeDelimiters` / `cleanControlChars` を移設して export |
| `utils/nano-extract.js` | 上記を import に置き換え（挙動は変えない） |
| `manifest.json` / `package.json` | 1.17.0 |
| `CLAUDE.md` | `utils/gloss-highlight.js` の同期規則をチェックリストに追加 |

---

## 12. テスト

### 単体（Vitest）

- `wiki-source`: URL 構築（原語・シリーズ名のエスケープ）、節抽出（Moon Knight の入れ子小見出しで本文が 0 字にならないこと）、検証ゲートの 6 ケース（§1.2）
- `gloss-summary`: JSON 抽出（fenced / bare / 前置きあり）、型・長さ検証、句点切り詰めが文中で切らないこと、片方欠落時の挙動
- `gloss-highlight`: 部分一致の誤爆（Hulkbuster / Hulk）、重複語、用語が 0 件、訳文が空

### E2E（Playwright）

- `.doug-overlay` のテキスト表明が span 化後も通ること（CLAUDE.md のチェックリスト対象セレクタ）
- hover でポップアップが出ること、Esc で閉じること
- 生成できなかった語に下線が付かないこと

### 手動

- `chrome://extensions/` で再読み込み後、シリーズ検出のあるページで先読みが走ること
- Nano 不可環境（フラグ無効）で API フォールバックに落ちること
- 権限を拒否したときに機能が OFF のままになること

---

## 13. 未確定事項

| 項目 | 状態 |
|---|---|
| Nano の英→日 翻訳＋要約の品質 | **未検証。本設計で最大のリスク。** 既存の Nano 用途（短い入力からの JSON 抽出・シリーズ検出）に対し、今回は英文 1.5 KB を読んで対象言語に翻訳しつつ要約する質的に重いタスクになる。実装後に実測が要る。品質が出なければ options 既定を `api` に変える（§5.1 のエンジン選択がそのまま逃げ道になる） |
| 先読みが読書開始に間に合う割合 | 未計測。Nano ウォームアップ ≈18 秒 + 30 語ぶんの生成時間に依存 |
| glossary 登録語の実分布 | 30 語弱と見積もったが実データ未確認。キャラ以外の語（場所・擬音）の比率が高ければ検証ゲートの却下率が上がる |

いずれも実装をブロックしない。実装後に測って調整する。

---

## 14. 実装しないもの（意図的な非スコープ）

- **Fandom 連携**（評価メモ §51.2 の名前解決・ToS・ネタバレが未解決）
- **ja Wikipedia 併用**（評価メモ §42。主要キャラほど記事が映画版に汚染されている）
- ソース優先度の設定 UI、ソース間マージ、動的ソース登録
- 生成結果の glossary への書き戻し（R-SEC-1c）
- 解説の再生成 / ユーザーによる編集
