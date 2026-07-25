# セキュリティ修正 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** セキュリティレビューで発見された5件の問題（Ollama SSRF・PRELOAD_QUEUE URL検証・CSS インジェクション・model名パストラバーサル・whitelist型検証）を優先度順に修正する。

**Architecture:** 既存コードへの最小差分追加。各修正は独立しており副作用なし。ユニットテスト対象は `utils/` 関数のみ（今回の修正は `utils/` 外のガード追加が中心のため既存テストの通過確認で十分）。

**Tech Stack:** Chrome Extension MV3, Vitest（ユニットテスト）, Playwright（E2Eテスト）

---

### Task 1: Ollama SSRF — translate.js にエンドポイント検証を追加

**Files:**
- Modify: `translate.js:333-335`（`translateImageWithOllama` 関数の冒頭）

**Step 1: 現状を確認する**

```bash
grep -n "translateImageWithOllama\|^async function translateImageWithOllama" translate.js | head -5
```

Expected: `333:async function translateImageWithOllama(endpoint, model, imageData, prompt, imageDims) {`

**Step 2: エンドポイント検証を追加する**

`translate.js` の `translateImageWithOllama` 関数の先頭（`const base64Data =` の前）に追加：

```js
  // http/https スキームのみ許可（SSRF 対策 — content.js:95 と対称）
  if (!/^https?:\/\//i.test(endpoint)) {
    throw new Error('Ollama エンドポイントは http:// または https:// で始まる必要があります。');
  }
```

**Step 3: 既存テストが通ることを確認**

```bash
npm run test:unit
```

Expected: すべて PASS（今回の変更は純粋なガード追加のため既存テストに影響なし）

**Step 4: コミット**

```bash
git add translate.js
git commit -m "fix: add endpoint validation to translateImageWithOllama (SSRF guard)"
```

---

### Task 2: PRELOAD_QUEUE URL 検証 — preload.js に isAllowedImageUrl を適用

**Files:**
- Modify: `preload.js:3`（import 追加）
- Modify: `preload.js:69`（フィルタ変更）

**Step 1: 現状を確認する**

```bash
grep -n "^import\|normalUrls\|blob:" preload.js
```

Expected:
```
3:import { getSettings } from './settings.js';
...
69:  const normalUrls = imageUrls.filter(u => !u.startsWith('blob:'));
```

**Step 2: import を追加する**

`preload.js` の `import { getSettings } from './settings.js';` の次の行に追加：

```js
import { isAllowedImageUrl } from './utils/url-utils.js';
```

**Step 3: フィルタを置き換える**

```js
// 変更前
const normalUrls = imageUrls.filter(u => !u.startsWith('blob:'));

// 変更後（isAllowedImageUrl は https: のみ通過、blob: は自動的に除外される）
const normalUrls = imageUrls.filter(u => isAllowedImageUrl(u));
```

**Step 4: 既存テストが通ることを確認**

```bash
npm run test:unit
```

Expected: すべて PASS

**Step 5: コミット**

```bash
git add preload.js
git commit -m "fix: filter preload queue URLs with isAllowedImageUrl (HTTPS only)"
```

---

### Task 3: CSS インジェクション — sanitizeCssValue の linear-gradient 正規表現を厳格化

**Files:**
- Modify: `content.js:712-713`（`sanitizeCssValue` 内の `linear-gradient` 判定）

**Step 1: 現状を確認する**

```bash
grep -n "linear-gradient" content.js
```

Expected: `713:    if (/^linear-gradient\(.+\)$/.test(v) && !/url\s*\(/i.test(v) && !/expression\s*\(/i.test(v)) return v;`

**Step 2: 厳格な正規表現に置き換える**

`content.js:713` の該当行を以下に置き換える：

```js
    // linear-gradient()（方向・HEX・rgb()/rgba()・named color・% のみ許可するホワイトリスト方式）
    if (/^linear-gradient\(\s*(?:to\s+(?:top|bottom|left|right|(?:top|bottom)\s+(?:left|right))|\d+(?:\.\d+)?deg)\s*(?:,\s*(?:#[0-9a-fA-F]{3,6}|rgba?\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}(?:\s*,\s*[\d.]+)?\s*\)|transparent|white|black)(?:\s+\d+%)?\s*)+\)$/i.test(v)) return v;
```

**Step 3: 既存テストが通ることを確認**

```bash
npm run test:unit
```

Expected: すべて PASS

**Step 4: コミット**

```bash
git add content.js
git commit -m "fix: tighten linear-gradient regex in sanitizeCssValue (whitelist approach)"
```

---

### Task 4: model 名パストラバーサル — Gemini の URL 構築に encodeURIComponent を適用

**Files:**
- Modify: `translate.js:190`（Gemini の URL 構築）

**Step 1: 現状を確認する**

```bash
grep -n "generativelanguage.googleapis.com\|modelName" translate.js | head -5
```

Expected:
```
189:  const modelName = model || 'gemini-2.5-flash-lite';
190:  const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent`;
```

**Step 2: encodeURIComponent を適用する**

`translate.js:190` の URL 構築を変更：

```js
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(modelName)}:generateContent`;
```

注意: `:generateContent` の `:` は URL のパス区切りではなくメソッドサフィックスなので `encodeURIComponent` の外に置く。

**Step 3: 既存テストが通ることを確認**

```bash
npm run test:unit
```

Expected: すべて PASS

**Step 4: コミット**

```bash
git add translate.js
git commit -m "fix: encodeURIComponent for Gemini model name to prevent path traversal"
```

---

### Task 5: whitelist 型検証 — loadWhitelist と onChanged で文字列フィルタリングを追加

**Files:**
- Modify: `whitelist.js:11`（`loadWhitelist` 内）
- Modify: `whitelist.js:17`（`onChanged` ハンドラー内）

**Step 1: 現状を確認する**

```bash
grep -n "new Set\|whitelistedOrigins" whitelist.js
```

Expected:
```
11:  whitelistedOrigins = new Set(whitelist);
17:    whitelistedOrigins = new Set(changes.whitelist.newValue || []);
```

**Step 2: loadWhitelist に型フィルタを追加する**

`whitelist.js:11` を変更：

```js
  // chrome.storage.sync から取得した値が文字列であることを保証（他デバイスでの改ざん対策）
  whitelistedOrigins = new Set(whitelist.filter(o => typeof o === 'string'));
```

**Step 3: onChanged ハンドラーに型フィルタを追加する**

`whitelist.js:17` を変更：

```js
    whitelistedOrigins = new Set((changes.whitelist.newValue || []).filter(o => typeof o === 'string'));
```

**Step 4: 既存テストが通ることを確認**

```bash
npm run test:unit
```

Expected: すべて PASS

**Step 5: バージョンを 1.5.4 に更新する**

`manifest.json` と `package.json` の `version` フィールドを `1.5.4` に変更。

**Step 6: コミット**

```bash
git add whitelist.js manifest.json package.json
git commit -m "fix: filter whitelist entries by type string; bump to v1.5.4"
```

---

## 最終確認

```bash
npm run test:unit
```

全 PASS を確認後、`chrome://extensions/` で拡張機能を再読み込みして動作確認する。
