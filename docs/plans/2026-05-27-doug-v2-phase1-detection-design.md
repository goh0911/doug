# Doug v2 Phase 1: シリーズ検出パイプライン 詳細設計

作成日: 2026-05-27
親設計: `2026-05-27-doug-v2-series-detection-design.md`

## 概要

Phase 1 では「シリーズを検出する」ロジックだけを実装し、検出結果をデバッグ表示する。
**翻訳挙動・ストレージ構造に一切変更を加えない**。Phase 2 以降の土台と、実データでの検出精度検証を目的とする。

完了基準：複数のコミックサイトでシリーズが正しく検出されることを目視確認できる状態。

---

## 1. スコープ

### Phase 1 でやること
- シリーズ検出関数の実装（Regex のみ、Nano は Phase 5）
- 検出結果をツールバーに表示するデバッグ UI
- 検出結果のログ収集ヘルパ（後の精度検証用）
- 単体テスト（検出パターン網羅）

### Phase 1 でやらないこと（Phase 2 以降）
- `series:` ストレージへの永続化（Phase 2）
- 翻訳プロンプトへのインジェクト（Phase 3）
- 設定 UI（Phase 2）
- Nano フォールバック（Phase 5）
- 検出精度の自動チューニング

---

## 2. 新規ファイル

### `utils/series-detect.js` — pure 関数

`chrome.*` API に依存しない pure 関数。Vitest で単体テスト可能。

```js
// 公開 API
export function detectSeriesFromTitle(title)
  // → { series, issueNumber, matchedPattern } | null

export function detectSeriesFromUrl(url)
  // → { series, slug } | null

export function normalizeSeriesName(name)
  // → string（小文字化・記号除去・全半角統一）

export function computeSeriesId(origin, seriesName)
  // → string（16 文字の hex ハッシュ）

export function detectSeries({ title, url, h1, ogTitle })
  // → { seriesId, series, issueNumber, source, confidence } | null
```

### `utils/series-detect.test.js` — Vitest 単体テスト

`SERIES_PATTERNS` の各パターンに対するヒット・非ヒットケースを網羅。

---

## 3. 検出アルゴリズム詳細

### detectSeries の処理順序

```
function detectSeries({ title, url, h1, ogTitle }) {
  // 1. 入力候補を優先度順に配列化
  const candidates = [title, ogTitle, h1].filter(Boolean);

  // 2. 各候補に対し Regex を試行（順番に）
  for (const text of candidates) {
    const m = detectSeriesFromTitle(text);
    if (m) return {
      seriesId: computeSeriesId(originOf(url), m.series),
      series: m.series,
      issueNumber: m.issueNumber,
      source: 'regex',
      confidence: 0.9,
    };
  }

  // 3. URL fallback
  const u = detectSeriesFromUrl(url);
  if (u) return {
    seriesId: computeSeriesId(originOf(url), u.series),
    series: u.series,
    issueNumber: null,
    source: 'url',
    confidence: 0.4,
  };

  return null;
}
```

### Regex パターン（最終版）

定義順 = 試行順。最初にマッチしたものを採用。

```js
const SERIES_PATTERNS = [
  // 1. "Immortal Hulk #20" / "Spider-Man #1.5"
  {
    name: 'hash-num',
    re: /^(.+?)\s*#\s*(\d+(?:\.\d+)?)\b/i,
    confidence: 0.95,
  },
  // 2. "One Piece Chapter 1100" / "Manga Ch.5" / "Series Vol. 3" / "Episode 12"
  {
    name: 'keyword-num',
    re: /^(.+?)\s+(?:Chapter|Ch\.?|Vol\.?|Volume|Episode|Ep\.?|Issue)\s*(\d+(?:\.\d+)?)\b/i,
    confidence: 0.9,
  },
  // 3. "ベルセルク 第41巻" / "ワンピース 第1100話" / "進撃の巨人 第100章"
  {
    name: 'ja-num',
    re: /^(.+?)\s*第\s*(\d+(?:\.\d+)?)\s*[巻話章]/,
    confidence: 0.9,
  },
  // 4. "Title 100: Subtitle" / "Title 100" — last resort
  {
    name: 'trailing-num',
    re: /^(.+?)\s+(\d+(?:\.\d+)?)(?:\s*[:：]\s*.+)?$/,
    confidence: 0.5,
  },
];
```

### URL fallback アルゴリズム

```js
function detectSeriesFromUrl(url) {
  const u = new URL(url);
  const segments = u.pathname.split('/').filter(Boolean);
  if (segments.length === 0) return null;

  // 末尾セグメントが数字のみなら一つ前を採用
  // 例: /comics/immortal-hulk/20/ → "immortal-hulk"
  let series = segments[segments.length - 1];
  if (/^\d+(\.\d+)?$/.test(series) && segments.length >= 2) {
    series = segments[segments.length - 2];
  }
  // 数字埋め込みも除去: "immortal-hulk-20" → "immortal-hulk"
  series = series.replace(/[-_]\d+(\.\d+)?$/, '');
  series = series.replace(/[-_]/g, ' ').trim();

  if (!series || series.length < 2) return null;
  return { series, slug: series };
}
```

### 正規化関数

```js
function normalizeSeriesName(name) {
  return name
    .toLowerCase()
    .normalize('NFKC')           // 全角英数→半角、半角カナ→全角等
    .replace(/[\s　]+/g, ' ')      // 連続空白を1個に
    .replace(/[!-/:-@\[-`{-~]/g, '')  // ASCII 記号除去
    .replace(/[「」『』【】〈〉《》・…]/g, '')  // 日本語記号除去
    .trim();
}
```

### SeriesId 生成

```js
async function computeSeriesId(seriesName) {
  const normalized = normalizeSeriesName(seriesName);
  const buf = new TextEncoder().encode(normalized);
  const hashBuf = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(hashBuf))
    .slice(0, 8)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}
```

**origin は意図的に含めない**（親設計 §3 参照、R1 のため）。
サイト跨ぎで同シリーズを同一視する代償として、別作品が偶然同名のケースは設定 UI で手動分離する（Phase 2）。

8 バイト = 16 文字 hex。衝突確率は実用上無視可能（1000シリーズで衝突確率 ≈ 2.7×10⁻¹⁴）。

---

## 4. content.js 側の統合

### 呼び出し箇所

`captureComic` の直前、画像を検出した直後に呼ぶ：

```js
const comicInfo = findLargestVisibleImage();
if (!comicInfo) { /* 既存処理 */ }

// === v2 Phase 1 追加 ===
const seriesInfo = await detectSeries({
  title: document.title,
  url: location.href,
  h1: document.querySelector('h1')?.textContent?.trim(),
  ogTitle: document.querySelector('meta[property="og:title"]')?.content,
});
if (seriesInfo) {
  console.log('[doug] Series detected:', seriesInfo);
  updateSeriesIndicator(seriesInfo);  // デバッグ UI 更新
}
// === ここまで ===
```

`seriesInfo` は **content.js のローカル変数** に保持するだけ。ストレージにも書き込まず、翻訳パイプラインにも渡さない（Phase 1 では）。

### モジュール読み込み — 3 案比較

`utils/series-detect.js` は ES Module 形式。content.js は IIFE のため import できない。

| 案 | テスト可能性 | 保守性 | I/O コスト（1ページあたり） | 結論 |
|---|---|---|---|---|
| **A. content.js に直書きコピー** | △（Ollama 式の test-only コピー必要） | × 二重管理リスク | 0 ms（同期処理） | 棄却 |
| **B. `executeScript` の files で注入** | ◯ | △ グローバル汚染 | 0 ms（同期処理） | 棄却 |
| **C. background.js 経由（メッセージ）** | ◎ | ◎ | ≈ 1〜5 ms（メッセージ往復） | **採用** |

**案 C 採用理由**：
- Phase 1 で検出は翻訳ボタン押下時（または auto-translate 起動時）に**1回だけ**呼ばれる。1〜5 ms のメッセージ往復は翻訳全体（数百 ms 〜数秒）から見て無視可能
- pure ロジックを `utils/` に集約することで Vitest テストが直接書ける（プロジェクト方針との整合）
- 将来 Nano fallback を追加するとき（Phase 5）も background.js 側で完結する

```js
// content.js（Phase 1）
const seriesInfo = await chrome.runtime.sendMessage({
  type: 'DETECT_SERIES',
  payload: { title, url, h1, ogTitle },
});
```

### whitelist との境界（重要）

**シリーズ検出は whitelist 通過後にのみ実行する**。
非対応サイト（whitelist 未登録）では detectSeries を呼ばない。理由：
- 検出ノイズの蓄積を防ぐ（urlPatterns に意図しない origin が混入する）
- ユーザーが翻訳意図を示したサイトのみ作品状態を持つという責務の明確化

実装上は、既存の `isSiteAllowed` チェックの**直後**に detectSeries を呼ぶ。

```js
// background.js（Phase 1 追加）
import { detectSeries } from './utils/series-detect.js';
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'DETECT_SERIES') {
    detectSeries(msg.payload).then(sendResponse);
    return true;
  }
  // ... 既存ハンドラー
});
```

---

## 5. デバッグ UI

ツールバー右端に小さなテキスト表示を追加：

```
[🌐 翻訳] [⚙] [⚡ 自動] [👁] [🗑] [🐛] | 📚 Immortal Hulk #20
                                            ↑ 検出されたシリーズ
```

- 検出失敗時：`📚 検出不可`（薄いグレー）
- ホバーで詳細ツールチップ：`source: regex (hash-num), confidence: 0.95`
- クリック動作なし（Phase 1 は読み取り専用）

CSS は最小限。既存の `#doug-toolbar` 内に span を追加するだけ。

---

## 6. テスト

### 単体テスト（Vitest）

`tests/unit/series-detect.test.js`：

| テスト分類 | ケース数目安 |
|---|---|
| Regex `hash-num` ヒット | 5（標準 / 小数 / 余分な空白 / 末尾文字 / 大文字小文字） |
| Regex `keyword-num` ヒット | 6（Chapter / Ch. / Vol / Volume / Episode / Issue） |
| Regex `ja-num` ヒット | 3（巻 / 話 / 章） |
| Regex `trailing-num` ヒット | 3（標準 / コロン付き / 余分なスペース） |
| 全パターン非マッチ | 4（URL 形式 / 空文字 / 数字のみ / 記号のみ） |
| URL fallback ヒット | 4（標準 / 数字末尾 / ハイフン区切り / 数字埋め込み） |
| URL fallback 失敗 | 2（ルートのみ / クエリのみ） |
| normalizeSeriesName | 5（全角→半角 / 記号除去 / 連続空白 / NFKC / 日本語） |
| computeSeriesId | 3（同じ入力で同じ出力 / origin に依存しない / 大小文字無視） |
| detectSeries 統合 | 6（title優先 / ogTitle fallback / h1 fallback / URL fallback / 全失敗 / 優先順位） |

合計約 40 ケース。既存の `tests/unit/` 配下に追加。

### 手動検証（精度確認）

実データで検証するサイトリスト（候補）：

| サイト系統 | 確認観点 |
|---|---|
| 英語コミックサイト（標準的なタイトル） | `hash-num` パターンの精度 |
| マンガ翻訳サイト | `keyword-num` パターンの精度 |
| 日本語マンガサイト | `ja-num` パターンの精度 |
| URL のみで識別するサイト | URL fallback の挙動 |
| タイトルが乱雑なサイト | 検出失敗時の挙動・誤検出防止 |

検証手順：各サイトで 5〜10 ページを開き、ツールバーのシリーズ表示を目視確認。
誤検出・検出失敗のサンプルを集め、Phase 5（Nano fallback）で改善する素材とする。

### 付録: 実タイトル採取（着手前に埋める）

**実装着手前のゲート条件**として、ユーザーが普段読んでいるコミックサイトから実際のページタイトル文字列を採取し、ここに貼る。
机上で 4 パターンの妥当性を判定するのは危険なため、最低でも 1 サイトあたり 5 件、3 サイト以上のサンプルを集める。

```
# サイトA（例: ComiXology）
[ ] "Immortal Hulk #20"           → hash-num ヒット想定
[ ] "Saga Vol. 9 - Endless War"   → keyword-num ヒット想定
[ ] ...

# サイトB（例: MangaDex）
[ ] "One Piece - Chapter 1100"    → keyword-num ヒット想定
[ ] ...

# サイトC（実際の読書サイト）
[ ] ...
```

このリストが埋まるまで Phase 1 実装に着手しない。

### E2E テスト

Phase 1 では追加しない（DOM 副作用がないため）。
Phase 2 でストレージ書き込みが入ったときに追加。

---

## 7. タスク分割（実装着手時用）

| # | タスク | 想定差分 |
|---|---|---|
| 1 | `utils/series-detect.js` 新規作成（pure 関数） | +200 行 |
| 2 | `tests/unit/series-detect.test.js` 新規作成 | +250 行 |
| 3 | `background.js` にメッセージハンドラー追加 | +15 行 |
| 4 | `content.js` で検出呼び出しと変数保持 | +20 行 |
| 5 | ツールバーにデバッグ表示追加（HTML / CSS / JS） | +30 行 |
| 6 | README / CLAUDE.md に Phase 1 の存在を1行追記 | +2 行 |
| 7 | `manifest.json` / `package.json` のバージョン 1.7.0 へ | +2 行 |

全 7 タスク、想定 1〜2 セッションで完了。

---

## 8. 完了判定

以下すべてが満たされたら Phase 1 完了：

- [ ] `npm run test:unit` で series-detect 関連 40 ケース全 PASS
- [ ] `chrome://extensions/` で再読込してエラーゼロ
- [ ] 既存の翻訳機能に挙動変化なし（リグレッションなし）
- [ ] 検証サイト 5 種以上でシリーズが正しく表示される
- [ ] バージョン 1.7.0 でコミット済み

---

## 9. リスク（Phase 1 固有）

| リスク | 対応 |
|---|---|
| Regex の正規表現が予期せぬ入力で破綻 | 単体テストで網羅、フォールバックチェーンで catch |
| `URL` コンストラクタが特殊スキームで例外 | try/catch でラップ |
| メッセージング往復のレイテンシ | 翻訳ボタン押下時の処理に乗せる（独立した遅延ではない） |
| デバッグ UI がツールバー幅を圧迫 | 長いシリーズ名は `text-overflow: ellipsis` |
| 検出精度の事前見積もり不可 | Phase 1 完了後に実データで評価、不足なら Phase 5 を前倒し |

---

## 10. Phase 2 への引き継ぎ事項

- 検出結果の `source` 別ヒット率（Phase 1 デバッグログから集計）
- 失敗ケースのサンプル（Phase 5 Nano プロンプト設計の素材）
- ユーザーの読書サイトでの実際のシリーズ一覧（Phase 2 設定 UI の優先度判断）

### Phase 2 着手ゲート（定量条件）

「2週間運用」のような曖昧な期間ではなく、以下のいずれかを満たしたら Phase 2 着手可：

- [ ] 検証サイト 3 種以上で **Regex 命中率 80% 以上**（URL fallback への到達率 20% 以下）
- [ ] 誤検出（別シリーズ扱いになるべき2つが同 SeriesId）が 0 件
- [ ] 検証ページ累計 30 ページ以上

達成できない場合は Phase 5（Nano fallback）を前倒し検討する。
