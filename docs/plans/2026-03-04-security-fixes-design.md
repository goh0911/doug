# セキュリティ修正 設計ドキュメント

Date: 2026-03-04
Priority: High → Medium × 4

---

## 背景

セキュリティレビューで発見された5件の問題を優先度順に修正する。
Critical なし。最高は High 2件（Ollama SSRF / PRELOAD_QUEUE）。

---

## 修正一覧

### 1. Ollama SSRF（High）

**ファイル**: `translate.js:339`

**問題**: `translateImageWithOllama` 関数がエンドポイントを検証せずに `fetch()` に渡す。
`content.js:95` には同等チェックがあるが非対称。

**修正**: `translateImageWithOllama` 関数の冒頭（`base64Data` 取得の前）に1行追加。

```js
if (!/^https?:\/\//i.test(endpoint)) {
  throw new Error('Ollama エンドポイントは http:// または https:// で始まる必要があります。');
}
```

---

### 2. PRELOAD_QUEUE URL 検証（Medium）

**ファイル**: `preload.js:69`

**問題**: `handlePreloadQueue` の URL フィルタが `blob:` 除外のみ。
`http://` URL が通過し `fetchImageAsDataUrl` に渡される。

**修正**: `isAllowedImageUrl` を import して `blob:` 除外を HTTPS 検証に置き換える。

```js
// 追加
import { isAllowedImageUrl } from './utils/url-utils.js';

// 変更前
const normalUrls = imageUrls.filter(u => !u.startsWith('blob:'));
// 変更後
const normalUrls = imageUrls.filter(u => isAllowedImageUrl(u));
```

---

### 3. CSS インジェクション — sanitizeCssValue 厳格化（Medium）

**ファイル**: `content.js:713`

**問題**: `linear-gradient(.+)` のブラックリスト方式（`url()` / `expression()` 除外）は
迂回される可能性がある。

**修正**: ホワイトリスト正規表現に置き換える。許可する構文：
- 方向: `to top/bottom/left/right` または `Ndeg`
- 色: HEX（3〜6桁）、`rgb()`、`rgba()`、`transparent/white/black`
- オプション: 各色の後に `N%`

```js
const SAFE_GRADIENT_RE = /^linear-gradient\(\s*(?:to\s+(?:top|bottom|left|right|(?:top|bottom)\s+(?:left|right))|\d+(?:\.\d+)?deg)\s*(?:,\s*(?:#[0-9a-fA-F]{3,6}|rgba?\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}(?:\s*,\s*[\d.]+)?\s*\)|transparent|white|black)(?:\s+\d+%)?\s*)+\)$/i;

if (SAFE_GRADIENT_RE.test(v)) return v;
```

---

### 4. model 名パストラバーサル（Medium）

**ファイル**: `translate.js:190`（Gemini）、`translate.js:288`（OpenAI）

**問題**: model 名が `chrome.storage.local` から取得したユーザー入力のまま URL に埋め込まれる。
`..` や `/` による意図しないエンドポイント操作が可能。

**修正**: `encodeURIComponent()` を適用してパス区切り文字を無害化する。
Claude は URL が固定（`/v1/messages`）のため対象外。

```js
// Gemini (translate.js:190)
const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(modelName)}:generateContent`;

// OpenAI は model が URL でなく body の JSON フィールドのため対象外
```

※ OpenAI は `model` が `JSON.stringify()` の body に含まれるだけで URL に直接埋め込まれないため対象外。

---

### 5. whitelist 型検証（Medium）

**ファイル**: `whitelist.js:11, 17`

**問題**: `chrome.storage.sync` から復元した配列の要素が文字列かどうかを検証していない。
`chrome.storage.sync` はデバイス間同期のため、他デバイスでの改ざんが伝播する可能性。

**修正**: `new Set()` に渡す前に文字列フィルタリングを追加。

```js
// loadWhitelist
whitelistedOrigins = new Set(whitelist.filter(o => typeof o === 'string'));

// onChanged ハンドラー
whitelistedOrigins = new Set((changes.whitelist.newValue || []).filter(o => typeof o === 'string'));
```

---

## テスト方針

- 単体テストは `utils/` 関数が対象のため、今回の修正（ガード追加）は単体テスト不要
- E2E テストで `chrome://extensions/` 再読み込み後に翻訳が正常動作することを確認
- Ollama が起動していない状態でエンドポイント不正入力（`ftp://...`）をストレージに書き込んで
  エラーメッセージが適切に表示されることを確認

---

## バージョン

修正後は `1.5.4`（パッチバージョンアップ）。
