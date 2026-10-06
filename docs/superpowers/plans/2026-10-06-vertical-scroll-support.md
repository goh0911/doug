# 縦スクロール型リーダー対応 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 縦に画像が並ぶリーダーで、見えている画像すべてを翻訳し、`prefetch` ON のとき下方 N 枚を先読みする。めくり型の挙動は変えない。

**Architecture:** 対象選別を pure 関数 `utils/scroll-select.js` に切り出す。content.js は単一の `overlayContainer` を残したまま、画像ごとの「ビュー」（要素・コンテナ・ロック）を `Map` で持ち、既存の描画関数をビューに対して呼ぶ。先読みは既存の `PRELOAD_QUEUE` と blob 経路を再利用する。

**Tech Stack:** Chrome MV3 / Vanilla JS（content.js は Classic IIFE）/ Vitest / Playwright

**Spec:** `docs/superpowers/specs/2026-10-06-vertical-scroll-support-design.md`

## Global Constraints

- `content.js` は IIFE の Classic Script のまま。ES Module にしない。
- `utils/` に `chrome.*` を持ち込まない。
- `content.js` に `utils/scroll-select.js` のコピーを置く場合は `tests/unit/copy-sync.test.js` の `COPIES` に 1 行足す。
- WebP を撮影形式に使わない（Ollama がデコードできない）。撮影は既存の `captureComic` を使う。
- 既存の URL キャッシュ・Port 経路（`TRANSLATE_IMAGE`）・`PRELOAD_QUEUE`（直列・最大 50 件・間隔 4.2 秒）は変えない。
- 画像の最小サイズは 200×200、可視面積は viewport の 10% 以上（既存 `findLargestVisibleImage` と同じ）。
- 先読み N の既定は 2、1 回の操作で翻訳する可視画像の上限は 6。
- 選択規則を診断ツールに再実装しない（診断は `scroll-select.js` を import する）。
- バージョンはマイナー（機能追加）。`manifest.json` と `package.json` の両方を更新する。

## Review Focus

1. 横スライダー型（Kindle 風、次ページが右外）で `mode` が `'single'` のままであること。
2. 可視 1 枚の下に画像の一部だけ覗いている場合（面積が 10% 未満）、可視ではなく `ahead` に入ること。
3. 画像が 0 枚、または全部が 200px 未満のとき、例外を出さず `single` と空配列を返すこと。
4. 入力の並びが DOM 順でなくても、結果が上から順に並ぶこと。
5. 可視が上限を超えたとき、超過分が `deferred` に入り、`ahead` に重複しないこと。

---

### Task 1: 対象選別の pure 関数

**Files:**
- Create: `utils/scroll-select.js`
- Test: `tests/unit/scroll-select.test.js`

**Interfaces:**
- Consumes: なし
- Produces: `selectScrollTargets(rects, viewport, opts?) → { mode, visible, deferred, ahead }`
  - `rects`: `{ id: string, left, top, right, bottom }[]`（viewport 座標、px）
  - `viewport`: `{ width, height }`
  - `opts`: `{ ahead?: number, maxVisible?: number }`
  - 戻り値の `visible` / `deferred` / `ahead` は `id` の配列（上から順）。`mode` は `'single' | 'scroll'`

- [ ] **Step 1: 失敗するテストを書く**

```js
// tests/unit/scroll-select.test.js
import { describe, it, expect } from 'vitest';
import { selectScrollTargets } from '../../utils/scroll-select.js';

const VP = { width: 1280, height: 800 };
const box = (id, top, h = 800, left = 280, w = 720) =>
  ({ id, left, top, right: left + w, bottom: top + h });

describe('selectScrollTargets', () => {
  it('可視 1 枚・下に続きなし → single（めくり型の陽性対照）', () => {
    const r = selectScrollTargets([box('a', 0)], VP);
    expect(r).toEqual({ mode: 'single', visible: ['a'], deferred: [], ahead: [] });
  });

  it('可視 1 枚と下方に 3 枚 → scroll、先読みは既定 2 枚', () => {
    const rects = [box('a', 0), box('b', 800), box('c', 1600), box('d', 2400)];
    const r = selectScrollTargets(rects, VP);
    expect(r.mode).toBe('scroll');
    expect(r.visible).toEqual(['a']);
    expect(r.ahead).toEqual(['b', 'c']);
  });

  it('可視 2 枚（境界をまたぐ）→ scroll', () => {
    const r = selectScrollTargets([box('a', -400), box('b', 400)], VP);
    expect(r.mode).toBe('scroll');
    expect(r.visible).toEqual(['a', 'b']);
  });

  it('下端に 10% 未満だけ覗く画像は可視でなく ahead に入る', () => {
    const r = selectScrollTargets([box('a', 0), box('b', 780)], VP);
    expect(r.visible).toEqual(['a']);
    expect(r.ahead).toEqual(['b']);
  });

  it('上に外れた画像は含まない', () => {
    const r = selectScrollTargets([box('up', -1000), box('a', 0)], VP);
    expect(r.visible).toEqual(['a']);
    expect(r.ahead).toEqual([]);
  });

  it('横スライダー型：右外・左外のページは ahead にならず single のまま', () => {
    const rects = [box('prev', 0, 800, -720), box('cur', 0), box('next', 0, 800, 1280)];
    const r = selectScrollTargets(rects, VP);
    expect(r).toEqual({ mode: 'single', visible: ['cur'], deferred: [], ahead: [] });
  });

  it('200px 未満の画像は無視する', () => {
    const r = selectScrollTargets([box('icon', 0, 100, 0, 100), box('a', 0)], VP);
    expect(r.visible).toEqual(['a']);
  });

  it('入力が空・全部小さいとき例外なく single と空配列', () => {
    const empty = { mode: 'single', visible: [], deferred: [], ahead: [] };
    expect(selectScrollTargets([], VP)).toEqual(empty);
    expect(selectScrollTargets([box('s', 0, 50, 0, 50)], VP)).toEqual(empty);
  });

  it('入力順が DOM 順でなくても上から順に返す', () => {
    const rects = [box('c', 1600), box('a', 0), box('b', 800)];
    const r = selectScrollTargets(rects, VP);
    expect(r.visible).toEqual(['a']);
    expect(r.ahead).toEqual(['b', 'c']);
  });

  it('可視が上限を超えたら deferred に回り、ahead と重複しない', () => {
    const rects = [box('a', 0, 250), box('b', 250, 250), box('c', 500, 250), box('d', 750, 250), box('e', 1000, 250)];
    const r = selectScrollTargets(rects, VP, { maxVisible: 2 });
    expect(r.visible).toEqual(['a', 'b']);
    expect(r.deferred).toEqual(['c']);
    expect(r.ahead).toEqual(['d', 'e']);
  });

  it('ahead の枚数は opts で変えられる', () => {
    const rects = [box('a', 0), box('b', 800), box('c', 1600)];
    expect(selectScrollTargets(rects, VP, { ahead: 1 }).ahead).toEqual(['b']);
    expect(selectScrollTargets(rects, VP, { ahead: 0 }).ahead).toEqual([]);
  });
});
```

- [ ] **Step 2: 失敗を確認する**

Run: `npx vitest run tests/unit/scroll-select.test.js`
Expected: FAIL（`utils/scroll-select.js` が存在しない）

- [ ] **Step 3: 最小実装を書く**

```js
// utils/scroll-select.js — 縦スクロール型リーダーの翻訳対象の選別（chrome.* 非依存）
//
// 画像の矩形（viewport 座標）から、いま翻訳する「可視」と、先読みする「下方」を選ぶ。
// 可視の判定は content.js の findLargestVisibleImage と同じ基準
// （200×200 以上、可視面積が viewport の 10% 以上）。

export const MIN_SIDE = 200;
export const MIN_VIEWPORT_RATIO = 0.1;
export const DEFAULT_AHEAD = 2;
export const DEFAULT_MAX_VISIBLE = 6;

function visibleArea(r, vw, vh) {
  const w = Math.min(r.right, vw) - Math.max(r.left, 0);
  const h = Math.min(r.bottom, vh) - Math.max(r.top, 0);
  return w > 0 && h > 0 ? w * h : 0;
}

/**
 * @param {{id:string,left:number,top:number,right:number,bottom:number}[]} rects
 * @param {{width:number,height:number}} viewport
 * @param {{ahead?:number,maxVisible?:number}} [opts]
 * @returns {{mode:'single'|'scroll',visible:string[],deferred:string[],ahead:string[]}}
 */
export function selectScrollTargets(rects, viewport, opts = {}) {
  const aheadN = opts.ahead ?? DEFAULT_AHEAD;
  const maxVisible = opts.maxVisible ?? DEFAULT_MAX_VISIBLE;
  const { width: vw, height: vh } = viewport;

  const sized = rects
    .filter((r) => r.right - r.left >= MIN_SIDE && r.bottom - r.top >= MIN_SIDE)
    .sort((a, b) => a.top - b.top);

  const minArea = vw * vh * MIN_VIEWPORT_RATIO;
  const allVisible = sized.filter((r) => visibleArea(r, vw, vh) >= minArea);
  const visibleIds = new Set(allVisible.map((r) => r.id));

  // 下方：可視でなく、下端が viewport の下にあり、横位置が viewport に重なるもの。
  // 横スライダー型の右外・左外ページは横が重ならないのでここで落ちる
  const ahead = sized
    .filter((r) => !visibleIds.has(r.id) && r.bottom > vh && r.left < vw && r.right > 0)
    .slice(0, Math.max(0, aheadN))
    .map((r) => r.id);

  const mode = allVisible.length >= 2 || (allVisible.length >= 1 && ahead.length >= 1) ? 'scroll' : 'single';
  return {
    mode,
    visible: allVisible.slice(0, maxVisible).map((r) => r.id),
    deferred: allVisible.slice(maxVisible).map((r) => r.id),
    ahead,
  };
}
```

- [ ] **Step 4: 通過を確認する**

Run: `npx vitest run tests/unit/scroll-select.test.js`
Expected: PASS（11 件）。落ちたら実装を直す。テストを実装に合わせて弱めない。

- [ ] **Step 5: 全体の単体テストを回してコミット**

Run: `npm run test:unit`
Expected: 既存テストを含め全件 PASS

```bash
git add utils/scroll-select.js tests/unit/scroll-select.test.js
git commit -m "feat(scroll): 縦スクロール型の翻訳対象を選ぶ pure 関数を追加"
```

---

### Task 2: content.js のビュー管理（複数オーバーレイ）

**前提:** content.js に未コミットの差分（3 行）がある。着手前にユーザーがコミットするか、別途退避する。

**Files:**
- Modify: `content.js`（`isTranslating` / `overlayContainer` 周辺 40〜41 行、`renderOverlays` 2305、`observePosition` 2588、`clearOverlays` 2646）
- Test: 結合は Task 5。ここは手元の目視 + 既存 E2E 回帰

**Interfaces:**
- Consumes: Task 1 の `selectScrollTargets`
- Produces（content.js 内部）:
  - `const views = new Map()` — キー: 画像要素、値: `{ el, container, translating }`
  - `withView(view, fn)` — 一時的に `overlayContainer = view.container` を差し替えて `fn()` を実行し、必ず元に戻す
  - `clearOverlays()` は全ビューを破棄する

- [ ] **Step 1: 現状の回帰基準を取る** — 単一画像（Comic Book Plus）で `npm run test:e2e -- translation.spec.js -g "Comic Book Plus"` が通ることを確認する（Chrome を閉じて実行）。
- [ ] **Step 2: ビュー管理を足す** — 既存の `renderOverlays(targetEl, …)` は同期処理なので、描画の直前に `withView` で `overlayContainer` を差し替える方式にし、関数本体は変えない。

```js
  // 縦スクロール：画像要素ごとのビュー。既存の描画関数は単一の overlayContainer を
  // 前提にしているため、描画中だけ差し替えて呼ぶ（同期処理のみ。await をまたがない）
  const views = new Map();

  function withView(view, fn) {
    const saved = overlayContainer;
    overlayContainer = view.container || null;
    try {
      return fn();
    } finally {
      view.container = overlayContainer;
      overlayContainer = saved;
    }
  }
```

- [ ] **Step 3: `clearOverlays` を全ビュー対応にする** — 既存の単一コンテナの破棄に加え、`for (const v of views.values()) withView(v, () => { …既存の破棄処理… })` の後に `views.clear()`。
- [ ] **Step 4: 回帰確認** — Step 1 と同じ E2E が通ること。通らなければ Step 2〜3 を直す。
- [ ] **Step 5: コミット** — `git add content.js && git commit -m "refactor(overlay): 画像ごとのビュー管理を足す（単一画像の挙動は不変）"`

> 再翻訳（`2206`〜`2273` 行）は `await` の後で `overlayContainer` を参照する。縦スクロールのビューに対しては `await` をまたいで `withView` を使わず、結果を受け取ってから同期部分だけを `withView` で包む。

---

### Task 3: 縦スクロール経路（可視画像の翻訳）

**Files:**
- Modify: `content.js`（翻訳ボタンのハンドラ、`translateCurrentPage` 898、`scheduleAutoTranslate` 2686）
- Create: なし

**Interfaces:**
- Consumes: `selectScrollTargets`（content.js にコピー）、`views` / `withView`（Task 2）、既存 `translateImage` / `captureComic` / `renderOverlays`
- Produces: `translateScrollTargets(forceRefresh)` — `mode === 'scroll'` のときだけ呼ばれる

- [ ] **Step 1: 候補収集を足す** — 既存の 4 グループ（blob img / svg image / img / canvas）を同じ優先順で集め、各要素に安定した `id`（`WeakMap` で採番）を付けて矩形配列にする。選択の再実装はせず、`selectScrollTargets` に渡すだけにする。
- [ ] **Step 2: ボタンのルーティング** — 押下時に `selectScrollTargets` を呼び、`mode === 'single'` なら従来の `translateCurrentPage` へ、`'scroll'` なら `translateScrollTargets` へ。`single` の経路には一切手を入れない。
- [ ] **Step 3: `translateScrollTargets`** — `visible` を上から順に、画像ごとに「`view.translating` を立てる → `captureComic` → `translateImage`（キャッシュ込み）→ `withView(view, () => renderOverlays(...))` → `view.translating` を戻す」。失敗は画像単位で握りつぶさず、そのビューだけにエラーを出す。`deferred` は保留する。
- [ ] **Step 4: スクロール追従** — スクロール停止（既存 `scheduleAutoTranslate` と同じデバウンス）後に再判定する。`autoTranslate` が ON のときだけ、新たに可視になった画像（`views` に無いもの）を処理する。OFF のときは何もしない。
- [ ] **Step 5: 後始末** — 画像が DOM から消えたビューは破棄する。ページ変更検知（`startUniversalPageWatcher`）では `clearOverlays` が全ビューを破棄する（Task 2）。
- [ ] **Step 6: 検証とコミット** — めくり型 E2E の回帰、`npm run test:unit`、手元の縦長ダミーページ（画像を縦に並べた HTML）での目視。`git commit -m "feat(scroll): 見えている画像をすべて翻訳する縦スクロール経路"`

---

### Task 4: 下方 N 枚の先読み

**Files:**
- Modify: `content.js`（`triggerPrefetch` 1100、`scheduleSafeModeNextPage` 1076）

**Interfaces:**
- Consumes: `selectScrollTargets().ahead`（id の配列）と id→要素の対応
- Produces: `triggerScrollPrefetch(aheadEls)`

- [ ] **Step 1: 通常 URL** — `aheadEls` の `src` のうち `isAllowedImageUrl` を満たすものを、`PRELOAD_QUEUE` メッセージで background に渡す（`prefetch` OFF なら background 側が無視する既存動作のまま）。
- [ ] **Step 2: blob** — `captureRasterElement(el)` で canvas 変換し、既存セーフモード先読みと同じ Port 経路（`TRANSLATE_IMAGE`）で送る。`prefetch` 設定の確認と 2 秒ディレイは既存と揃える。
- [ ] **Step 3: 呼び出し** — `translateScrollTargets` の末尾とスクロール追従の再判定で呼ぶ。
- [ ] **Step 4: 検証** — `chrome.*` をモックして、渡る URL が `ahead` と一致することを確認する（tests/unit に配線テストを足す）。`git commit -m "feat(scroll): 下方 N 枚の先読み"`

---

### Task 5: 同期・テスト・リリース準備

**Files:**
- Modify: `tests/unit/copy-sync.test.js`（`COPIES` に 1 行）、`tests/e2e/translation.spec.js`、`CLAUDE.md`（ファイル構成と新機能チェックリスト）、`manifest.json` / `package.json`

- [ ] **Step 1:** `COPIES` に `utils/scroll-select.js` → `content.js` を足し、`npm run test:unit` で突き合わせが通ることを確認する。
- [ ] **Step 2:** E2E に「複数オーバーレイ」の確認を足す（`MARVEL_WEBTOON_URL` 設定時のみ。待機セレクタは実測後に決める）。
- [ ] **Step 3:** `CLAUDE.md` のファイル構成に `scroll-select.js` を足し、チェックリストにコピー同期を足す。
- [ ] **Step 4:** バージョンを 2.3.0 に更新し、`npm run test:unit` と回帰 E2E の結果を記録してコミットする。リリースは別途ユーザーの指示を待つ。

---

## Self-Review

- **Spec coverage:** 可視すべて翻訳（Task 3）、下方 N 枚先読み（Task 4）、めくり型不変（Task 1 の陽性対照 + Task 3 Step 2 + Task 2 回帰）、上限 6 枚（Task 1 `maxVisible`、Task 3 `deferred`）、自動翻訳トグル追従（Task 3 Step 4）、コピー同期（Task 5）。未決事項（分割・モード判定規則・遅延読み込み・シリーズ名・利用規約）は spec どおり 11/16 以降。
- **Placeholder scan:** Task 1 は完全なコード。Task 2〜4 は content.js の既存コードを触るため、行番号と手順を示し、核心のコード（`withView`）だけ書いた。実装時に既存コードを読みながら書く前提で、**Task 2〜4 は Task 1 ほど具体的でない**。
- **Type consistency:** `selectScrollTargets` の戻り値（`mode` / `visible` / `deferred` / `ahead`）、`views` / `withView` の名前は全 Task で同一。
