# Doug v2 Phase 6 — few-shot 例文注入 実装プラン

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** シリーズごとに承認済みの良訳例を貯め、翻訳プロンプトに【翻訳例】として上位5件注入して訳文スタイルを安定させる。

**Architecture:** `series.examples` 枠を追加し、`recentPairs` から候補提示→ユーザー承認で貯める。層A `buildSeriesPromptSection` に examples 引数を足して注入。候補絞り込みは既存 `sampleRecentPairs`（Nano不使用）。

**Tech Stack:** Vanilla JS（Chrome Extension MV3）、Vitest（ユニットテスト）。**Nano 非依存**。

**設計文書:** `docs/plans/2026-07-24-doug-v2-phase6-few-shot-design.md`

## Global Constraints

- **バージョン:** 完了時に `manifest.json` と `package.json` を **1.14.0** に更新
- **utils 純粋性:** `chrome.*` を `utils/` に持ち込まない
- **content.js は IIFE:** `buildSeriesPromptSection` のコピーを手動同期（CLAUDE.md）。**同期4箇所** = `utils/prompt-builder.js` / `content.js`(IIFEコピー) / `translate.js:45`呼び出し / `content.js:237`呼び出し
- **保存:** `series-store.js` は `withSeriesLock(seriesId, async () => { get → 変更 → set })` パターン（既存 `addGlossaryEntry` 準拠）
- **上限:** examples 保持 **10 件**（`EXAMPLES_MAX`）、プロンプト注入 **5 件**（`EXAMPLES_CAP`）、各フィールド **150 字**
- **サニタイズ:** 例文はプロンプトに入るため保存時に多層防御（制御/方向/タグ文字除去・区切り記号無害化・150字）
- **テスト:** `npm run test:unit`

---

## File Structure

| ファイル | 種別 | 責務 |
|---|---|---|
| `utils/example-utils.js` | 新規 | `sanitizeExample`（純粋関数） |
| `tests/unit/example-utils.test.js` | 新規 | 上記テスト |
| `utils/prompt-builder.js` | 修正 | `buildSeriesPromptSection` に examples 対応 |
| `tests/unit/prompt-builder.test.js` | 追加 | examples 注入テスト（既存ファイルに追加） |
| `series-store.js` | 修正 | `addExample`/`removeExample`、`getSeriesWithDefaults` に examples 補完 |
| `tests/unit/series-store.test.js` | 追加 | 上記テスト（既存ファイルに追加） |
| `background.js` | 修正 | `ADD_EXAMPLE`/`REMOVE_EXAMPLE` ハンドラ |
| `content.js` | 修正 | `buildSeriesPromptSection` コピー同期＋呼び出しに examples |
| `translate.js` | 修正 | 呼び出しに `examples` |
| `series.js` / `series.html` | 修正 | `renderExamplesSection`（承認UI） |
| `manifest.json` / `package.json` | 修正 | 1.14.0 |

---

## Task 1: `sanitizeExample`（純粋関数・TDD）

**Files:**
- Create: `utils/example-utils.js`
- Test: `tests/unit/example-utils.test.js`

**Interfaces:**
- Produces: `sanitizeExample({ original, translated }): { original, translated } | null`

- [ ] **Step 1: 失敗するテストを書く**

`tests/unit/example-utils.test.js`:
```js
import { describe, it, expect } from 'vitest';
import { sanitizeExample } from '../../utils/example-utils.js';

describe('sanitizeExample', () => {
  it('通常の文ペアはそのまま（trim）', () => {
    expect(sanitizeExample({ original: '  WHO ARE YOU?!  ', translated: ' お前は誰だ！？ ' }))
      .toEqual({ original: 'WHO ARE YOU?!', translated: 'お前は誰だ！？' });
  });

  it('非文字列は null', () => {
    expect(sanitizeExample({ original: 1, translated: 'x' })).toBeNull();
    expect(sanitizeExample({ original: 'x', translated: null })).toBeNull();
    expect(sanitizeExample()).toBeNull();
  });

  it('どちらかが空になったら null', () => {
    expect(sanitizeExample({ original: '   ', translated: 'x' })).toBeNull();
    expect(sanitizeExample({ original: 'x', translated: '' })).toBeNull();
  });

  it('150文字に切り詰める', () => {
    const long = 'a'.repeat(200);
    const r = sanitizeExample({ original: long, translated: long });
    expect(r.original.length).toBe(150);
    expect(r.translated.length).toBe(150);
  });

  it('制御文字・方向制御・タグ文字を除去し改行/タブを空白化', () => {
    expect(sanitizeExample({ original: 'a\n\tb\x00', translated: 'c‮d' }))
      .toEqual({ original: 'a b', translated: 'cd' });
  });

  it('区切り記号を無害化', () => {
    expect(sanitizeExample({ original: 'a<<<<b>>>>c', translated: 'd[SYSTEM]e[DATA]f' }))
      .toEqual({ original: 'a_b_c', translated: 'd_e_f' });
  });
});
```

- [ ] **Step 2: 失敗を確認**

Run: `npm run test:unit -- example-utils`
Expected: FAIL（`sanitizeExample is not a function`）

- [ ] **Step 3: 実装**

`utils/example-utils.js`:
```js
// utils/example-utils.js — few-shot 例文サニタイズ pure 関数（chrome.* 非依存）
// Phase 6: 例文はプロンプトに注入されるため保存時に多層防御を施す

function cleanControlChars(s) {
  s = s.replace(/[\r\n\t]+/g, ' ');
  s = s.replace(/[\x00-\x1F\x7F]/g, '');
  s = s.replace(/[‪-‮]/g, '');
  s = s.replace(/[⁦-⁩]/g, '');
  s = s.replace(/[​-‏]/g, '');
  s = s.replace(/[\u{E0000}-\u{E007F}]/gu, '');
  return s;
}

function escapeDelimiters(s) {
  s = s.split('<<<<').join('_');
  s = s.split('>>>>').join('_');
  s = s.split('[SYSTEM]').join('_');
  s = s.split('[DATA]').join('_');
  return s;
}

/**
 * few-shot 例文をサニタイズする（保存前）
 * @param {{ original: string, translated: string }} pair
 * @returns {{ original: string, translated: string } | null}
 */
export function sanitizeExample({ original, translated } = {}) {
  if (typeof original !== 'string' || typeof translated !== 'string') return null;
  const clean = (s) => escapeDelimiters(cleanControlChars(s.slice(0, 150))).trim();
  const o = clean(original);
  const t = clean(translated);
  if (o === '' || t === '') return null;
  return { original: o, translated: t };
}
```

- [ ] **Step 4: パス確認**

Run: `npm run test:unit -- example-utils`
Expected: PASS（6件）

- [ ] **Step 5: コミット**

```bash
git add utils/example-utils.js tests/unit/example-utils.test.js
git commit -m "feat: add sanitizeExample for Phase 6 few-shot"
```

---

## Task 2: `buildSeriesPromptSection` の examples 対応（TDD）

**Files:**
- Modify: `utils/prompt-builder.js`
- Test: `tests/unit/prompt-builder.test.js`（既存に追加）

**Interfaces:**
- Modified: `buildSeriesPromptSection({ seriesName, glossaryLangMap, toneStyle, examples })`

- [ ] **Step 1: 失敗するテストを追加**

`tests/unit/prompt-builder.test.js` に追記（既存の import / describe に合わせる）:
```js
describe('buildSeriesPromptSection - examples (Phase 6)', () => {
  it('examples を【翻訳例】として注入する（上位5件・順序は用語集→口調→例文）', () => {
    const s = buildSeriesPromptSection({
      seriesName: 'Immortal Hulk',
      glossaryLangMap: { Hulk: { translated: 'ハルク', approved: true, count: 3 } },
      toneStyle: '硬め',
      examples: [
        { original: 'WHO ARE YOU?!', translated: 'お前は誰だ！？' },
        { original: 'I AM THE HULK.', translated: '私がハルクだ。' },
      ],
    });
    expect(s).toContain('【用語集】');
    expect(s).toContain('【訳文の口調】');
    expect(s).toContain('【翻訳例】');
    expect(s).toContain('1. WHO ARE YOU?! → お前は誰だ！？');
    // 順序: 用語集 < 口調 < 翻訳例
    expect(s.indexOf('【用語集】')).toBeLessThan(s.indexOf('【訳文の口調】'));
    expect(s.indexOf('【訳文の口調】')).toBeLessThan(s.indexOf('【翻訳例】'));
  });

  it('examples は上位5件に制限される', () => {
    const examples = Array.from({ length: 8 }, (_, i) => ({ original: `O${i}`, translated: `T${i}` }));
    const s = buildSeriesPromptSection({ examples });
    expect(s).toContain('5. O4 → T4');
    expect(s).not.toContain('6. O5');
  });

  it('examples のみでもセクションを生成する', () => {
    const s = buildSeriesPromptSection({ examples: [{ original: 'A', translated: 'B' }] });
    expect(s).toContain('【翻訳例】');
    expect(s).toContain('1. A → B');
  });

  it('用語集・口調・examples が全て空なら空文字', () => {
    expect(buildSeriesPromptSection({ examples: [] })).toBe('');
    expect(buildSeriesPromptSection({})).toBe('');
  });

  it('不正な example 要素は除外する', () => {
    const s = buildSeriesPromptSection({ examples: [{ original: 'A', translated: 'B' }, { original: 'C' }, null] });
    expect(s).toContain('1. A → B');
    expect(s).not.toContain('C →');
  });
});
```

- [ ] **Step 2: 失敗を確認**

Run: `npm run test:unit -- prompt-builder`
Expected: FAIL（examples が注入されない）

- [ ] **Step 3: 実装**

`utils/prompt-builder.js` を修正。`GLOSSARY_CAP` の下に定数追加:
```js
// 例文をプロンプトに載せる上限（Phase 6）
const EXAMPLES_CAP = 5;
```

`buildSeriesPromptSection` を以下に置き換える（examples 引数追加・空判定更新・【翻訳例】ブロック追加）:
```js
export function buildSeriesPromptSection({ seriesName, glossaryLangMap, toneStyle, examples } = {}) {
  // 用語集: approved のみ・count 降順・上位 GLOSSARY_CAP 件
  const entries =
    glossaryLangMap && typeof glossaryLangMap === 'object'
      ? Object.keys(glossaryLangMap)
          .map((orig) => ({ orig, ...glossaryLangMap[orig] }))
          .filter((e) => e.approved === true && typeof e.translated === 'string')
          .sort((a, b) => (b.count ?? 0) - (a.count ?? 0))
          .slice(0, GLOSSARY_CAP)
      : [];

  const toneInstruction = buildToneInstruction(toneStyle);

  // 例文: 有効な要素のみ・上位 EXAMPLES_CAP 件
  const exampleList = Array.isArray(examples)
    ? examples.filter((e) => e && typeof e.original === 'string' && typeof e.translated === 'string')
        .slice(0, EXAMPLES_CAP)
    : [];

  if (entries.length === 0 && !toneInstruction && exampleList.length === 0) return '';

  const lines = [];
  if (seriesName) lines.push(`このコミックは「${seriesName}」シリーズです。`);
  if (entries.length > 0) {
    lines.push('【用語集】以下の固有名詞は必ずこの訳語を使用してください:');
    entries.forEach((e, i) => lines.push(`${i + 1}. ${e.orig} → ${e.translated}`));
  }
  if (toneInstruction) lines.push(`【訳文の口調】${toneInstruction}`);
  if (exampleList.length > 0) {
    lines.push('【翻訳例】以下の対訳と同じ口調・言い回しで訳してください:');
    exampleList.forEach((e, i) => lines.push(`${i + 1}. ${e.original} → ${e.translated}`));
  }
  return lines.join('\n');
}
```

- [ ] **Step 4: パス確認**

Run: `npm run test:unit -- prompt-builder`
Expected: PASS（既存 + 新規5件）

- [ ] **Step 5: コミット**

```bash
git add utils/prompt-builder.js tests/unit/prompt-builder.test.js
git commit -m "feat: inject few-shot examples in buildSeriesPromptSection (Phase 6)"
```

---

## Task 3: series-store に `addExample`/`removeExample`（TDD）

**Files:**
- Modify: `series-store.js`
- Test: `tests/unit/series-store.test.js`（既存に追加）

**Interfaces:**
- Consumes: `sanitizeExample`（`utils/example-utils.js`）
- Produces: `addExample(seriesId, { original, translated }): Promise<{ status, examples }>` / `removeExample(seriesId, index): Promise<{ examples }>`

- [ ] **Step 1: 失敗するテストを追加**

`tests/unit/series-store.test.js` の末尾に追記（既存の beforeEach / chrome.storage モックを使う。事前に `series:test1` を作っておく形は既存テストのセットアップに合わせる）:
```js
describe('addExample / removeExample (Phase 6)', () => {
  it('ok: 正常追加で examples に入る', async () => {
    await recordSeriesTranslation({ seriesId: 'ex1', name: 'S', url: 'https://x/', pairs: [] });
    const r = await addExample('ex1', { original: 'A', translated: 'B' });
    expect(r.status).toBe('ok');
    expect(r.examples).toHaveLength(1);
    expect(r.examples[0]).toMatchObject({ original: 'A', translated: 'B' });
  });

  it('invalid: サニタイズで空になる入力は拒否', async () => {
    await recordSeriesTranslation({ seriesId: 'ex2', name: 'S', url: 'https://x/', pairs: [] });
    const r = await addExample('ex2', { original: '   ', translated: 'B' });
    expect(r.status).toBe('invalid');
  });

  it('duplicate: 同一 original+translated は重複拒否', async () => {
    await recordSeriesTranslation({ seriesId: 'ex3', name: 'S', url: 'https://x/', pairs: [] });
    await addExample('ex3', { original: 'A', translated: 'B' });
    const r = await addExample('ex3', { original: 'A', translated: 'B' });
    expect(r.status).toBe('duplicate');
    expect(r.examples).toHaveLength(1);
  });

  it('full: 10件を超える追加は拒否', async () => {
    await recordSeriesTranslation({ seriesId: 'ex4', name: 'S', url: 'https://x/', pairs: [] });
    for (let i = 0; i < 10; i++) await addExample('ex4', { original: `O${i}`, translated: `T${i}` });
    const r = await addExample('ex4', { original: 'O10', translated: 'T10' });
    expect(r.status).toBe('full');
    expect(r.examples).toHaveLength(10);
  });

  it('removeExample: index 指定で削除', async () => {
    await recordSeriesTranslation({ seriesId: 'ex5', name: 'S', url: 'https://x/', pairs: [] });
    await addExample('ex5', { original: 'A', translated: 'B' });
    await addExample('ex5', { original: 'C', translated: 'D' });
    const r = await removeExample('ex5', 0);
    expect(r.examples).toHaveLength(1);
    expect(r.examples[0].original).toBe('C');
  });
});
```

（`addExample` / `removeExample` / `recordSeriesTranslation` は既存 import 行に追加すること。）

- [ ] **Step 2: 失敗を確認**

Run: `npm run test:unit -- series-store`
Expected: FAIL（`addExample is not a function`）

- [ ] **Step 3: 実装**

`series-store.js` の import に追加:
```js
import { sanitizeExample } from './utils/example-utils.js';
```

定数（`RECENT_PAIRS_MAX` の近く）に追加:
```js
const EXAMPLES_MAX = 10;                   // few-shot 例文の保持上限（Phase 6）
```

`getSeriesWithDefaults` に補完を追加（`recentPairs` 補完の隣）:
```js
  if (!Array.isArray(series.examples)) series.examples = [];
```

`removeGlossaryEntry` の後に追加:
```js
/**
 * few-shot 例文を追加する（Phase 6）
 * @param {string} seriesId
 * @param {{ original: string, translated: string }} pair
 * @returns {Promise<{ status: 'ok'|'full'|'duplicate'|'invalid', examples: Array }>}
 */
export async function addExample(seriesId, { original, translated } = {}) {
  const sanitized = sanitizeExample({ original, translated });
  if (!sanitized) return { status: 'invalid', examples: [] };

  return withSeriesLock(seriesId, async () => {
    const key = `series:${seriesId}`;
    const result = await chrome.storage.local.get(key);
    const series = result[key];
    if (!series) return { status: 'invalid', examples: [] };

    const examples = Array.isArray(series.examples) ? series.examples : [];
    if (examples.some((e) => e.original === sanitized.original && e.translated === sanitized.translated)) {
      return { status: 'duplicate', examples };
    }
    if (examples.length >= EXAMPLES_MAX) {
      return { status: 'full', examples };
    }
    const nextExamples = [...examples, { ...sanitized, addedAt: Date.now() }];
    await chrome.storage.local.set({ [key]: { ...series, examples: nextExamples } });
    return { status: 'ok', examples: nextExamples };
  });
}

/**
 * few-shot 例文を index 指定で削除する（Phase 6）
 * @param {string} seriesId
 * @param {number} index
 * @returns {Promise<{ examples: Array }>}
 */
export async function removeExample(seriesId, index) {
  return withSeriesLock(seriesId, async () => {
    const key = `series:${seriesId}`;
    const result = await chrome.storage.local.get(key);
    const series = result[key];
    if (!series) return { examples: [] };

    const examples = Array.isArray(series.examples) ? [...series.examples] : [];
    if (index >= 0 && index < examples.length) examples.splice(index, 1);
    await chrome.storage.local.set({ [key]: { ...series, examples } });
    return { examples };
  });
}
```

- [ ] **Step 4: パス確認**

Run: `npm run test:unit -- series-store`
Expected: PASS（既存 + 新規5件）

- [ ] **Step 5: 全テスト確認**

Run: `npm run test:unit`
Expected: PASS（全件）

- [ ] **Step 6: コミット**

```bash
git add series-store.js tests/unit/series-store.test.js
git commit -m "feat: add addExample/removeExample to series-store (Phase 6)"
```

---

## Task 4: background に `ADD_EXAMPLE`/`REMOVE_EXAMPLE` ハンドラ

**Files:**
- Modify: `background.js`

- [ ] **Step 1: import に追加**

`background.js` の series-store import（`import { getSeries, ... } from './series-store.js';`）に `addExample, removeExample` を追加する。

- [ ] **Step 2: ハンドラ追加**

既存の `ADD_GLOSSARY_ENTRY` / `REMOVE_GLOSSARY_ENTRY` ハンドラ（`addGlossaryEntry` を呼ぶ箇所）の直後に追加:
```js
if (message.type === 'ADD_EXAMPLE') {
  try {
    const { seriesId, original, translated } = message.payload;
    const result = await addExample(seriesId, { original, translated });
    sendResponse(result);
  } catch (err) {
    sendResponse({ status: 'invalid', examples: [] });
  }
  return;
}

if (message.type === 'REMOVE_EXAMPLE') {
  try {
    const { seriesId, index } = message.payload;
    const result = await removeExample(seriesId, index);
    sendResponse(result);
  } catch (err) {
    sendResponse({ examples: [] });
  }
  return;
}
```

- [ ] **Step 3: 構文・テスト確認**

Run: `node --check --input-type=module < background.js && npm run test:unit`
Expected: 構文OK・全テストPASS

- [ ] **Step 4: コミット**

```bash
git add background.js
git commit -m "feat: route ADD_EXAMPLE/REMOVE_EXAMPLE in background (Phase 6)"
```

---

## Task 5: プロンプト注入をフローに接続（content.js コピー同期＋呼び出し）

**Files:**
- Modify: `content.js`（IIFE 内 `buildSeriesPromptSection` コピー＋呼び出し）
- Modify: `translate.js`（呼び出し）

- [ ] **Step 1: content.js の `buildSeriesPromptSection` コピーを同期**

`content.js`（138行付近）の `buildSeriesPromptSection` を、Task 2 で `utils/prompt-builder.js` に実装したロジックと**同一**にする（`EXAMPLES_CAP = 5` 定数、examples 引数、空判定更新、【翻訳例】ブロック）。IIFE 内なので export は付けない。

- [ ] **Step 2: translate.js の呼び出しに examples を追加**

`translate.js:45` 付近:
```js
        seriesSection = buildSeriesPromptSection({
          seriesName: series.name,
          glossaryLangMap,
          toneStyle: series.tone && series.tone.style,
          examples: series.examples,
        });
```
（既存の引数に `examples: series.examples,` を1行追加。`series.name` 等の既存キーはそのまま。）

- [ ] **Step 3: content.js の呼び出しに examples を追加**

`content.js:237` 付近の `buildSeriesPromptSection({ ... })` 呼び出しにも `examples: series.examples,` を追加する（translate.js と対称）。

- [ ] **Step 4: 構文・テスト確認**

Run: `npm run test:unit`
Expected: PASS（全件。content.js/translate.js はユニット対象外だが回帰確認）

- [ ] **Step 5: 動作確認（実機）**

1. `chrome://extensions/` で Doug 再読み込み
2. 例文を登録済みのシリーズ（Task 6 完了後）で翻訳し、翻訳結果に例文の口調が反映されるか確認
3. 例文なしのシリーズでは従来どおり翻訳されること（回帰なし）

- [ ] **Step 6: コミット**

```bash
git add content.js translate.js
git commit -m "feat: pass examples to prompt section in translate flow (Phase 6)"
```

---

## Task 6: 承認UI（series 詳細ページ）

**Files:**
- Modify: `series.js`（`renderExamplesSection` 追加、`renderDetail` から呼ぶ）
- Modify: `series.html`（セクション枠）

**Interfaces:**
- 送信: `ADD_EXAMPLE`（payload `{ seriesId, original, translated }`）/ `REMOVE_EXAMPLE`（payload `{ seriesId, index }`）

- [ ] **Step 1: `series.html` にセクション枠を追加**

シリーズ詳細のコンテナ内（用語集候補セクションの近く）に、`renderExamplesSection` が `replaceChildren` で描画する空コンテナを追加:
```html
<div id="examples-section"></div>
```
（既存の候補セクション枠と同じ命名規則に合わせる。実際の親要素は series.html の詳細描画構造を確認して配置する。）

- [ ] **Step 2: `series.js` に `renderExamplesSection` を追加**

`renderCandidateSection`（370行付近）のパターンに倣い追加。`sampleRecentPairs` は `utils/nano-extract.js` からの import があるか確認し、無ければ series.js の既存 import 方針に合わせる（series.js は候補抽出で既に nano-extract の関数を使っているため同じ経路で取得可能）:
```js
// Phase 6: few-shot 例文セクションを描画する
function renderExamplesSection(container, series, seriesId) {
  container.replaceChildren();

  const sectionLabel = document.createElement('label');
  sectionLabel.textContent = '翻訳例（few-shot）';
  container.appendChild(sectionLabel);

  const examples = Array.isArray(series.examples) ? series.examples : [];

  // 登録済み一覧
  examples.forEach((ex, index) => {
    const row = document.createElement('div');
    row.className = 'series-meta example-row';

    const text = document.createElement('span');
    text.textContent = `${ex.original} → ${ex.translated}`;
    row.appendChild(text);

    const delBtn = document.createElement('button');
    delBtn.className = 'btn-secondary series-edit-btn';
    delBtn.textContent = '削除';
    delBtn.addEventListener('click', async function () {
      const result = await chrome.runtime.sendMessage({
        type: 'REMOVE_EXAMPLE',
        payload: { seriesId, index },
      });
      series.examples = (result && result.examples) || [];
      renderExamplesSection(container, series, seriesId);
    });
    row.appendChild(delBtn);
    container.appendChild(row);
  });

  // 上限表示
  if (examples.length >= 10) {
    const full = document.createElement('div');
    full.className = 'series-meta';
    full.textContent = '例文は上限（10件）です。追加するには既存を削除してください。';
    container.appendChild(full);
    return;
  }

  // 候補（recentPairs から sampleRecentPairs で上位提示）
  const pairs = Array.isArray(series.recentPairs) ? series.recentPairs : [];
  const candidates = sampleRecentPairs(pairs, 5);
  if (candidates.length === 0) return;

  const candLabel = document.createElement('div');
  candLabel.className = 'series-meta';
  candLabel.textContent = '候補（最近の翻訳から）:';
  container.appendChild(candLabel);

  candidates.forEach((c) => {
    const row = document.createElement('div');
    row.className = 'series-meta example-candidate-row';

    const text = document.createElement('span');
    text.textContent = `${c.original} → ${c.translated}`;
    row.appendChild(text);

    const addBtn = document.createElement('button');
    addBtn.className = 'btn-secondary series-edit-btn';
    addBtn.textContent = '例文に採用';
    addBtn.addEventListener('click', async function () {
      const result = await chrome.runtime.sendMessage({
        type: 'ADD_EXAMPLE',
        payload: { seriesId, original: c.original, translated: c.translated },
      });
      series.examples = (result && result.examples) || series.examples;
      renderExamplesSection(container, series, seriesId);
    });
    row.appendChild(addBtn);
    container.appendChild(row);
  });
}
```

- [ ] **Step 3: `renderDetail` から呼ぶ**

`series.js` の `renderDetail`（537行付近）で、候補セクションを描画している箇所の近くに追加:
```js
  const examplesContainer = document.getElementById('examples-section');
  if (examplesContainer) renderExamplesSection(examplesContainer, series, seriesId);
```
（`series` / `seriesId` は `renderDetail` スコープの既存変数に合わせる。）

- [ ] **Step 4: 動作確認（実機）**

1. `chrome://extensions/` で Doug 再読み込み
2. シリーズ詳細ページを開き「翻訳例」セクションが表示されること
3. 候補の「例文に採用」→ 一覧に追加、10件で候補が消え上限表示
4. 「削除」→ 一覧から消える
5. 重複追加が拒否されること（同じ候補を2回採用しても1件）

- [ ] **Step 5: コミット**

```bash
git add series.js series.html
git commit -m "feat: add few-shot examples approval UI to series page (Phase 6)"
```

---

## Task 7: バージョン更新

**Files:**
- Modify: `manifest.json` / `package.json`

- [ ] **Step 1: バージョンを 1.14.0 に更新**

`manifest.json` と `package.json` の `"version"` を `"1.14.0"` にする。

- [ ] **Step 2: 全テスト最終確認**

Run: `npm run test:unit`
Expected: PASS（全件）

- [ ] **Step 3: コミット**

```bash
git add manifest.json package.json
git commit -m "chore: bump version to 1.14.0 (Phase 6 few-shot examples)"
```

---

## 完了時チェックリスト

- [ ] `utils/example-utils.js`（`sanitizeExample`）ユニットテスト済み
- [ ] `buildSeriesPromptSection` の examples 注入テスト済み、**content.js コピーと同期**
- [ ] `translate.js` / `content.js` 両方の呼び出しに `examples` を追加（同期4箇所完了）
- [ ] `addExample`/`removeExample` テスト済み（上限10・重複・invalid・削除）
- [ ] series ページで例文の採用・削除・上限が動作
- [ ] 例文ありシリーズで翻訳に反映、例文なしで回帰なし
- [ ] `npm run test:unit` 全件パス
- [ ] `manifest.json` / `package.json` が 1.14.0
