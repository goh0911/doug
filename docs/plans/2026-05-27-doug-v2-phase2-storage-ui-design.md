# Doug v2 Phase 2: ストレージ層 + 設定 UI 詳細設計

作成日: 2026-05-27
改訂: 2026-05-27（architecture-evaluator 2 回レビュー反映、サブフェーズ 4→3、書込トリガー変更、UI 独立ページ化、サニタイザ強化（C0/C1/方向制御文字明示）、urlPatterns サイト別アダプタ方式、実測ゲート数値化、Phase 4 書込原則注記）
親設計: `2026-05-27-doug-v2-series-detection-design.md`
前段: `2026-05-27-doug-v2-phase1-detection-design.md`
次段: マージ・分離・エイリアス UI は Phase 4 へ分離

## 概要

Phase 1 で検出したシリーズを `chrome.storage.local` に永続化し、シリーズ管理ページから一覧表示・編集できるようにする。
**翻訳パイプラインへの影響はゼロ**（用語集の実適用は Phase 3）。Phase 3 の土台となる「データを蓄える箱と編集 UI」をここで完成させる。

完了基準：ユーザーが翻訳ボタンを押した時点で初めてシリーズが記録され、`series.html` で一覧・編集ができる状態。

---

## 0. 実装着手前のゲート（実測結果）

Phase 2A 着手前に `tools/measure-storage.html` で実測を実施した。

### 実測結果（2026-05-27）

| 項目 | 値 |
|---|---|
| 測定対象 | 100 シリーズ × 各 50 用語（原文 30 字 + 訳 15 字平均） |
| 総使用量 (dummy) | 832.3 KB |
| 1 シリーズあたり平均 | **8.32 KB** |
| `chrome.storage.local.QUOTA_BYTES` | **10 MB**（10,485,760 bytes）※当初設計の「5 MB」は誤り |
| dummy / クォータ | 8.13 %（5〜10% 帯） |
| 推定収容数（クォータ 80% まで） | **984 シリーズ** |
| 合格判定 | **合格基準B**（5〜10%） |

### 確定した閾値

- `WARN_THRESHOLD = 6.5 MB`（クォータの 65%、≈ 800 シリーズ相当）
- `ARCHIVE_THRESHOLD = 7.32 MB`（クォータの 70%、≈ 900 シリーズ相当）
- `MAX_QUOTA = 10 MB`（実測クォータ、`QUOTA_BYTES` 直接参照）

### 補足

8.32 KB/series は **50 用語フル積載時の最大ケース**。実運用では用語数が少ないシリーズが多数派になると見込まれ、平均はこれより小さくなる見通し（数 KB 〜 5 KB 程度）。984 シリーズは保守的な下限見積もり。

---

## 1. スコープ

Phase 2 は 3 サブフェーズに分割（旧設計の 2D は Phase 4 へ分離）。各サブフェーズで個別コミット・動作確認を行う。

| サブ | 内容 | 完了基準 | 想定差分 |
|---|---|---|---|
| **2A** | ストレージ層 (`series-store.js`) + 翻訳時記録 + LRU 容量管理 | 翻訳ボタン押下時にシリーズが記録される | +350 行 |
| **2B** | シリーズ管理ページ (`series.html`) 一覧（読み取り専用） | options から遷移可能、一覧が表示される | +250 行 |
| **2C** | 用語集・口調の手動編集 + 削除 + 入力サニタイズ | 各シリーズで CRUD ができる、危険入力は拒否される | +300 行 |

**Phase 2 から外したもの**（Phase 4 へ）：マージ、分離、エイリアス書き込み路、シリーズ間操作 UI。
理由：実運用で誤マージが観測されてから初めて必要になる機能であり、Phase 2 着手時点では記録すらまだ無いため YAGNI。

---

## 1.5 代替案の検討と棄却

| 案 | 内容 | 採用/棄却 | 理由 |
|---|---|---|---|
| **検出毎に書き込み** | detect 成功で即 storage.local.set | **棄却** | SW を頻発で起こす、ホワイトリスト全ページで暗黙記録が増え続けプライバシー的に不透明、書き込み spam |
| **翻訳実行時に書き込み**（採用） | 翻訳ボタン押下時のみ記録 | **採用** | ユーザーの「翻訳する意思」が記録同意に相当、書き込み頻度が現実的 |
| **CLI 風コマンドパレットで操作** | シリーズ操作を一括コマンドで | 棄却 | エンドユーザー向け拡張機能では不適、UI 工数削減効果は小 |
| **popup に組み込み** | popup を拡張 | 棄却 | popup は領域が狭すぎる |
| **options タブ化** | 既存 options ページ内タブ | 棄却 | options が肥大化する、将来拡張時に再分離コスト |
| **独立ページ `series.html`**（採用） | options から遷移する別ページ | **採用** | options の見通しを保つ、将来拡張余地、URL 直接アクセス可能 |

---

## 2. データモデル

### `series:${seriesId}` の Phase 2 完了時の形

```js
{
  meta: {
    name: "Immortal Hulk",              // 表示名（2C で編集可、SeriesId は変えない）
    detectedAt: 1748376000000,
    lastVisitedAt: 1748376000000,       // 翻訳実行時に更新
    issueCount: 12,                     // 翻訳実行回数（同一シリーズの異なるページで増える）
    detectionSource: "regex" | "nano" | "url" | "manual",
  },
  urlPatterns: [
    // 翻訳実行時の URL から末端 issue セグメントを除去した prefix を記録
    // 例: /comics/issue/128949/wonder_man_2026_3 → /comics/issue/
    { origin: "https://www.marvel.com", pathPrefix: "/comics/issue/", lastSeenAt: ... }
  ],
  overrides: {
    provider: null, model: null, targetLang: null,  // Phase 3 で使う、Phase 2 では未編集
  },
  glossary: {
    "ja": {                              // 言語ペアごとに分離
      "Hulk":         { translated: "ハルク",         count: 0, lastSeenAt: ..., source: "manual", approved: true },
    },
  },
  tone: { style: "auto" },
  stats: { translationCount: 0, lastTranslatedAt: null },
}
```

### `seriesAliases` キー（**Phase 2 ではモデル定義のみ・書き込み路なし**）

```js
{
  // Phase 4 でマージ・分離 UI が書き込む
  // Phase 2A 〜 2C では参照しない（読み込みもしない）
  // [oldSeriesId]: newSeriesId
}
```

Phase 2 ではエイリアス解決を実装しない。Phase 4 で書込路・読込路・depth 制限（その時点で 1 か 5 かを再決定）をまとめて導入する。

---

## 3. Phase 2A: ストレージ層

### 3.1 新規ファイル: `series-store.js`

プロジェクトルートに配置（既存 `cache.js` `settings.js` と同層）。`chrome.*` API を直接使う。

```js
// 公開 API
export async function getSeries(seriesId)
  // → series object | null

export async function listSeries()
  // → Array<{ seriesId, meta, urlPatterns, glossary, tone, ... }>
  //   lastVisitedAt 降順

export async function recordSeriesTranslation({ seriesId, name, detectionSource, origin, pathPrefix })
  // → 翻訳ボタン押下時に呼ぶ。存在しなければ作成、あれば
  //   lastVisitedAt / issueCount を更新、urlPatterns に origin+pathPrefix が新しければ追加
  // 容量超過時は console.warn して null を返す（既存翻訳パイプラインを止めない）

export async function deleteSeries(seriesId)
  // → 削除

export async function updateSeriesField(seriesId, fieldPath, value)
  // → ホワイトリスト化したパスのみ受け付ける
  //   許可: 'meta.name', 'tone.style', 'overrides.provider', 'overrides.model', 'overrides.targetLang'

export async function addGlossaryEntry(seriesId, targetLang, original, translated)
  // → サニタイズ後に glossary[targetLang][original] を追加。既存があれば上書き

export async function removeGlossaryEntry(seriesId, targetLang, original)
  // → 削除

export async function getStorageUsageInfo()
  // → { usedBytes, totalBytes, seriesCount, isNearWarn, isNearArchive }
```

### 3.2 書き込みトリガー

| イベント | 動作 | 書込先 |
|---|---|---|
| **検出成功（毎ページ）** | in-memory `seriesInfo` を更新、ツールバー表示のみ | なし |
| **翻訳ボタン押下（初回）** | `recordSeriesTranslation` を呼び書き込み | `series:${id}` |
| **翻訳ボタン押下（2回目以降・同セッション）** | `recordSeriesTranslation` を呼ぶが、`lastVisitedAt` の前回値から 60 秒以内なら no-op | 条件付き |

「60 秒以内 no-op」で連打 spam を回避。Phase 2A 内で実装。

### 3.3 urlPatterns の正規化（サイト別アダプタ方式）

**汎用正規表現は破綻するため採用しない。** 既存の `utils/url-utils.js` の `normalizeImageUrl` がサイト別の知見を持つのと同様、**サイト別アダプタ**で URL → `pathPrefix` を導出する。

```js
// utils/url-pattern.js（新規、pure）
// site adapters: 既存の url-utils.js と並ぶレイヤー
const SITE_ADAPTERS = [
  {
    // Marvel.com: /comics/issue/{id}/{slug}
    test: (u) => u.hostname === 'www.marvel.com' && u.pathname.startsWith('/comics/issue/'),
    derive: (u) => '/comics/issue/',
  },
  // MangaDex / Webtoons 等は実データ採取後に追加
];

export function derivePathPrefix(url) {
  try {
    const u = new URL(url);
    for (const adapter of SITE_ADAPTERS) {
      if (adapter.test(u)) return adapter.derive(u);
    }
    // 汎用フォールバック: ルートのみ
    return '/';
  } catch { return '/'; }
}
```

破綻するエッジケースの扱い：

- クエリパラメータベース（`?id=123`）→ サイトアダプタを追加するまで `/` で記録（粗い、Phase 4 で精緻化）
- ハッシュフラグメント（`#chapter-5`）→ `URL.pathname` には含まれず無視
- 数字を含むシリーズ名（`one-piece-1080-spoilers`）→ サイトアダプタで明示しない限り `/` フォールバックで安全側

実装ポリシー：**新しいサイトを Doug でサポートするたびに adapter を追加**する。汎用ロジックでの自動推測はしない（誤検出リスクの方が高い）。

### 3.4 並行書込対策

```js
// series-store.js モジュールスコープ
const writeQueue = new Map();  // seriesId → Promise

async function withSeriesLock(seriesId, fn) {
  const prev = writeQueue.get(seriesId) || Promise.resolve();
  const next = prev.then(fn).catch(() => {/* swallow */});
  writeQueue.set(seriesId, next);
  return next;
}
```

**writeQueue は non-critical 用途のみ**（このストアでは write が常に critical なので、結局はキュー経由でも `await` した完了を保証する）。
Service Worker が writeQueue 動作中に終了するリスクは：

- ユーザー操作の直接同期書き込み（用語集追加・削除・rename・delete）は `await chrome.runtime.sendMessage(...)` で content/options 側から待機している間 SW が生きている保証あり
- `recordSeriesTranslation` の自動書込が SW 終了で消える可能性は **next 翻訳実行時に上書きされるため許容**

### 3.5 LRU 容量管理

§0 の実測結果に基づき確定：

- **WARN_THRESHOLD = 6.5 MB**（クォータ 65%、約 800 シリーズ相当）超過 → `console.warn` + 設定ページ警告バナー（2B 実装）
- **ARCHIVE_THRESHOLD = 7.32 MB**（クォータ 70%、約 900 シリーズ相当）超過 → `lastVisitedAt` 最古から自動削除
- **MAX_QUOTA = `chrome.storage.local.QUOTA_BYTES`**（実測 10 MB） 到達時 → `recordSeriesTranslation` は静かに null を返し、ユーザーには既存翻訳機能で notification を出す（「シリーズが記録できませんでした。古いシリーズを削除してください」）

実装上は `chrome.storage.local.QUOTA_BYTES` を直接参照し、ハードコードしない。

### 3.6 background.js のメッセージハンドラ追加

```js
// 既存ハンドラの隣に追加
if (msg.type === 'RECORD_SERIES_TRANSLATION') {
  recordSeriesTranslation(msg.payload).then(sendResponse);
  return true;
}
if (msg.type === 'GET_SERIES') { ... return true; }
if (msg.type === 'LIST_SERIES') { ... return true; }
if (msg.type === 'UPDATE_SERIES_FIELD') { ... return true; }
if (msg.type === 'ADD_GLOSSARY_ENTRY') { ... return true; }
if (msg.type === 'REMOVE_GLOSSARY_ENTRY') { ... return true; }
if (msg.type === 'DELETE_SERIES') { ... return true; }
if (msg.type === 'GET_STORAGE_USAGE') { ... return true; }
```

### 3.7 content.js の呼び出し変更

Phase 1 では detect 成功時に何もストレージ書き込みしていない。Phase 2A では `translateCurrentPage` の翻訳成功直後に追加：

```js
async function translateCurrentPage(forceRefresh = false) {
  // ... 既存処理 ...
  if (seriesInfo && seriesInfo.series) {
    chrome.runtime.sendMessage({
      type: 'RECORD_SERIES_TRANSLATION',
      payload: {
        seriesId: seriesInfo.seriesId,
        name: seriesInfo.series,
        detectionSource: seriesInfo.source,
        origin: location.origin,
        pathPrefix: normalizePathPrefix(location.pathname),
      },
    });
  }
}
```

検出時の `detectAndUpdateSeriesIndicator` は**書き込まない**（Phase 1 のまま）。

### 3.8 単体テスト

`tests/unit/series-store.test.js`：

| テスト分類 | ケース数 |
|---|---|
| getSeries 基本（存在/不在） | 2 |
| recordSeriesTranslation 新規 | 2 |
| recordSeriesTranslation 既存更新 | 3 |
| recordSeriesTranslation 60秒以内 no-op | 2 |
| urlPatterns 重複排除 | 2 |
| normalizePathPrefix（utils 側に切り出し） | 5 |
| listSeries 並び順 | 1 |
| updateSeriesField ホワイトリスト | 3 |
| updateSeriesField 不正パス拒否 | 2 |
| addGlossaryEntry サニタイズ | 4 |
| addGlossaryEntry 上限拒否 | 2 |
| removeGlossaryEntry | 1 |
| deleteSeries | 1 |
| 並行書込の直列化 | 2 |
| LRU 容量管理 | 2 |

合計 34 件。`normalizePathPrefix` は pure 関数として `utils/series-detect.js` に追加（または別ファイル）。

### 2A 完了判定

- [ ] `npm run test:unit` 全 PASS
- [ ] Marvel.com で翻訳ボタンを押すと自動でストレージに記録される（DevTools で確認）
- [ ] 同シリーズの異なる話を翻訳すると `issueCount` が増える
- [ ] 60 秒以内の再翻訳では書き込まれない
- [ ] urlPatterns が同 origin+pathPrefix で重複しない

---

## 4. Phase 2B: シリーズ管理ページ（独立ページ、読み取り専用）

### 4.1 新規ファイル

- `series.html`（独立ページ）
- `series.js`
- `series.css`

`manifest.json` の `web_accessible_resources` は不要（拡張機能内ページなので拡張機能 URL 経由でアクセス）。

### 4.2 options からの導線

options.html に「シリーズ管理を開く」ボタンを 1 つ追加：

```html
<button id="openSeriesManagerBtn">📚 シリーズ管理を開く</button>
```

```js
document.getElementById('openSeriesManagerBtn').addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('series.html') });
});
```

### 4.3 series.html のレイアウト

```
┌─ Doug シリーズ管理 ─────────────────────────────┐
│                                                 │
│ 容量: 1.2 MB / 5 MB ▓▓▓░░░░░░░░░░░░░░          │
│                                                 │
│ ┌─ 検出済みシリーズ ──────────────────────┐  │
│ │ 📚 Wonder Man (2026)            [編集] │  │
│ │    話数: 3 / 検出: regex                │  │
│ │    最終: 2026-05-27 / サイト: 1         │  │
│ │ ─────────────────────────────────── │  │
│ │ 📚 Doomquest (2026)             [編集] │  │
│ │    ...                                   │  │
│ └─────────────────────────────────────────┘  │
└─────────────────────────────────────────────────┘
```

「編集」ボタンは Phase 2C で機能実装。2B では disabled で表示のみ。

### 4.4 series.js の実装

```js
// ページロード時
window.addEventListener('DOMContentLoaded', async () => {
  const usage = await chrome.runtime.sendMessage({ type: 'GET_STORAGE_USAGE' });
  renderUsageMeter(usage);
  const list = await chrome.runtime.sendMessage({ type: 'LIST_SERIES' });
  renderList(list);
});
```

### 4.5 容量警告バナー

`isNearWarn === true` で赤いバナー表示。
`isNearArchive === true` で「古いシリーズが自動アーカイブされました」と通知。

### 2B 完了判定

- [ ] options から `series.html` に遷移できる
- [ ] シリーズ一覧が lastVisitedAt 降順で表示される
- [ ] 容量メーターが正しい使用量を表示する
- [ ] シリーズ 0 件時のメッセージが出る

---

## 5. Phase 2C: 用語集・口調の手動編集 + 入力サニタイズ

### 5.1 詳細ページ（series detail）

2B のリストの「編集」ボタンクリックで遷移：

```
series.html?id=${seriesId}
```

```
┌─ Wonder Man (2026) ────────────────────────────┐
│ [← 一覧へ戻る]                                  │
│                                                 │
│ 表示名: [Wonder Man (2026)         ] [保存]    │
│                                                 │
│ 口調 (tone.style): [auto ▼]                     │
│   auto / 敬体 / 常体 / 硬め / 柔らかめ / カスタム │
│   （カスタム選択時はテキストエリア表示、200 文字上限） │
│                                                 │
│ ┌─ 用語集（日本語）──────────────────────┐  │
│ │ Hulk          → ハルク           [削除] │  │
│ │ Bruce Banner  → ブルース・バナー [削除] │  │
│ │                                          │  │
│ │ 原文: [_______]                          │  │
│ │ 訳語: [_______]    [+ 追加]              │  │
│ └─────────────────────────────────────────┘  │
│                                                 │
│ [このシリーズを削除]                            │
└─────────────────────────────────────────────────┘
```

### 5.2 入力サニタイズ（**Phase 3 のプロンプトインジェクション対策の核**）

`addGlossaryEntry` と `updateSeriesField('tone.style')` で以下のサニタイズを実施。
**Phase 2 で確定させ、Phase 3 で同ロジックを参照する。**

#### 除去対象（明示）

| カテゴリ | 範囲 | 理由 |
|---|---|---|
| C0 制御文字 | `U+0000` 〜 `U+001F` | 不可視文字によるパース乱し |
| C1 制御文字 | `U+007F` 〜 `U+009F` | 同上 |
| ゼロ幅文字 | `U+200B`〜`U+200D`, `U+FEFF` | 視覚的に空でない錯覚 |
| 方向制御文字 | `U+202A`〜`U+202E`, `U+2066`〜`U+2069` | 文字方向操作による視覚的偽装 |

#### 拒否対象（マッチしたら null を返す）

- マークダウンコード境界: ` ``` ` / `~~~`
- LLM 制御トークン形: `<|...|>` / `[INST]` / `<|im_start|>` / `<|im_end|>`
- テンプレート構文: `{{...}}`
- プロンプトデリミタ衝突: `<glossary>`, `</glossary>`, `<system>`, `<user>`, `<assistant>`, `<context>`, `<instructions>`（大文字小文字無視）

#### 実装スケッチ（utils/sanitize.js）

```js
// 除去（unicode escape で明示、リテラル混入を避ける）
const STRIP_REGEX = new RegExp(
  "[\u0000-\u001F\u007F-\u009F\u200B-\u200D\uFEFF\u202A-\u202E\u2066-\u2069]",
  "g"
);
const REJECT_REGEX = /```|~~~|<\|[^>]*\|>|\[INST\]|\{\{[^}]*\}\}|<\/?(?:glossary|system|user|assistant|context|instructions)\b/i;

export function sanitizeGlossaryText(text, { maxLength = 100 } = {}) {
  if (typeof text !== 'string') return null;
  if (REJECT_REGEX.test(text)) return null;
  const t = text.replace(STRIP_REGEX, '').trim();
  if (t.length === 0 || t.length > maxLength) return null;
  return t;
}

export function sanitizeToneStyle(text) {
  return sanitizeGlossaryText(text, { maxLength: 200 });
}
```

#### ホワイトリスト方式の併用検討

「アルファベット・ひらがな・カタカナ・漢字・ハイフン・スペースのみ許可」のような厳密ホワイトリストも検討したが、以下の理由で**棄却**し、上記ブラックリストで運用する：

- 多言語（中国語繁体・タイ語・キリル文字等）の作品名を扱う可能性がある
- 公式タイトルに `&`, `:`, `'`, `,`, `.` などの記号が含まれることが多い（"Wonder Man (2026)" の括弧、"Spider-Man" のハイフン等）

将来、プロンプトインジェクション事案が観測されたらホワイトリスト方式への切替を再検討。


### 5.3 用語集全体サイズの上限

1 シリーズの glossary 全体を 2 KB（プロンプトに注入したときのおおよそのトークン上限）に制限。
追加時に総バイト数を計算し、超える追加は拒否してエラー表示。
（cap は Phase 3 の N=30 件とは別軸の安全装置）

### 5.4 編集メッセージフロー

| 操作 | メッセージ | サニタイズ |
|---|---|---|
| 表示名変更 | `UPDATE_SERIES_FIELD { fieldPath: 'meta.name', value }` | sanitize（100 字上限） |
| 口調変更（プリセット） | `UPDATE_SERIES_FIELD { fieldPath: 'tone.style', value: 'auto'\|'敬体'\|... }` | ホワイトリスト |
| 口調変更（カスタム） | 同上、value=任意文字列 | sanitizeToneStyle |
| 用語集追加 | `ADD_GLOSSARY_ENTRY { targetLang, original, translated }` | 両者 sanitize、上限 100字、合計 2KB |
| 用語集削除 | `REMOVE_GLOSSARY_ENTRY { targetLang, original }` | なし |
| シリーズ削除 | `DELETE_SERIES { seriesId }`（確認ダイアログ） | なし |

### 5.5 言語ペア

`glossary[targetLang]` のうち、現在の `settings.targetLang` のみを表示・編集対象とする。
複数言語ペア切替 UI は将来課題（Phase 6 以降）。

### 2C 完了判定

- [ ] 表示名・口調・用語集の CRUD ができる
- [ ] サニタイズで危険入力が拒否される（バッククォート 3 連、`<glossary>` 等）
- [ ] 100 字超・2KB 超の入力が拒否される
- [ ] シリーズ削除ができる
- [ ] 変更が `chrome.storage.local` に反映される

---

## 6. Phase 1 との接続

Phase 1 で実装済みの `detectAndUpdateSeriesIndicator` には**手を入れない**。
Phase 2A で追加するのは `translateCurrentPage` の翻訳成功直後の `RECORD_SERIES_TRANSLATION` 呼び出し1か所のみ。

これにより Phase 1 のデバッグ表示挙動は完全に維持され、Phase 2 が壊れても Phase 1 機能は生き残る。

---

## 7. テスト全体方針

| サブ | 単体テスト | 手動テスト |
|---|---|---|
| 2A | series-store CRUD・LRU・正規化・並行書込・サニタイズ（34件） | Marvel で翻訳→ストレージに記録 |
| 2B | 軽微（後述） | series.html 一覧表示・遷移 |
| 2C | サニタイズ単体テスト（10件） | 編集 UI 動作、危険入力拒否 |

### 2B の単体テスト

`series.html` 内 DOM 操作は jsdom 環境で軽くテストできるが、Phase 2 では割愛し、手動確認に依存する。
E2E テストの追加は Phase 2 完了時点で判断。

---

## 8. リスク

| # | リスク | 緩和案 |
|---|---|---|
| 1 | 並行書込 race | writeQueue で直列化、テストで検証 |
| 2 | 容量超過で書き込み失敗 | 4MB warn / 4.5MB archive / 5MB は静かに失敗、ユーザー通知 |
| 3 | マイグレーション（v1 ユーザー） | `series:*` が存在しないだけ、特別な migration コード不要 |
| 4 | プロンプトインジェクション | §5.2 のサニタイズ、Phase 3 で同ロジック参照、ホワイトリスト方式の口調プリセット |
| 5 | 用語集肥大化 | 100字/エントリ・2KB/シリーズ全体の二重キャップ |
| 6 | UI の i18n | 既存設定が日本語のみ。`series.html` も日本語固定、i18n は将来 |
| 7 | Service Worker 終了で writeQueue 消失 | ユーザー操作は同期 await で保証、自動記録は次回上書き許容 |
| 8 | 実測前の閾値乖離 | §0 のゲートで実測してから 2A 着手 |
| 9 | options ページの肥大化回避不徹底 | 独立ページに切り出し、options からはボタン 1 つで遷移 |

---

## 9. Phase 3 への引き継ぎ事項

Phase 2 完了時点で揃っているもの：

- [x] `series:${id}.glossary[lang]` にサニタイズ済み用語データ
- [x] `series:${id}.tone.style` にサニタイズ済み口調
- [x] 検出フローでストレージから glossary/tone をロード可能
- [x] サニタイズロジック（utils/sanitize.js）が Phase 3 でも再利用可能

Phase 3 で追加するもの：

- `prompt-builder.js`（プロンプトに glossary/tone を織り込む、§5.2 のデリミタを使用）
- 翻訳前のロード・パラメータ追加
- 出力後の用語置換（層 B、cache hit にも適用）

---

## 10. 既知の限界

- **同期は実装しない**：`chrome.storage.sync` 経由のクロスデバイス同期は将来課題
- **検索機能なし**：シリーズが 100 件超えるとリストが長くなるが、フィルタ・検索は Phase 2 では実装しない
- **エクスポート/インポートなし**：用語集の JSON エクスポートは将来課題
- **複数言語ペア UI**：Phase 2C は現在の targetLang のみ
- **マージ・分離は Phase 4 へ分離**：実運用で誤マージが観測されてから着手

---

## 11. Phase 4 スタブ（参考）

将来 Phase 4 で対応する範囲（Phase 2 では実装しない）：

- `seriesAliases` の書込路（マージ・分離操作）
- 検出時のエイリアス解決（depth=1 か 5 か再決定）
- シリーズマージ UI（glossary・urlPatterns・stats の統合）
- シリーズ分離 UI（特定 origin だけ別 SeriesId に切り出し）
- 「このサイトでは別シリーズ扱い」のオーバーライド
- **Nano による用語集自動候補抽出**（Phase 4 の中核機能、§3.2 の「翻訳実行のみ書込」原則を継承する）

### Phase 4 の書込トリガー原則

Phase 4 で新規に書き込む路（用語集候補・エイリアス更新等）は、**すべて翻訳実行の延長として発火**する。
「検出毎に書き込み」へ逆戻りしてはいけない（§1.5 の代替案棄却理由を引き続き尊重）。

具体例：
- Nano による glossary 候補抽出 → 翻訳完了後の post-processing として実行、ユーザー承認後に書込
- マージ・分離 UI からの書込 → ユーザー操作起点（自動発火しない）

Phase 4 着手のトリガー：Phase 2 リリース後、誤マージ事例が 3 件以上観測されたら設計開始。
