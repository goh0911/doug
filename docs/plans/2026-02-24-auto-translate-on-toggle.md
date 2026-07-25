# 自動翻訳トグルON時の即時翻訳 実装計画

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 自動翻訳トグルをONにした瞬間、現在のページが未翻訳なら即座に翻訳を開始する。

**Architecture:** `toggleAutoTranslate` 関数の末尾に条件チェックを3行追加するだけ。既存の `scheduleAutoTranslate()` を再利用することで、600ms の画像ロード待機を維持しつつ最小変更で実現する。

**Tech Stack:** Chrome拡張 Manifest V3, content script (vanilla JS)

---

### Task 1: `toggleAutoTranslate` に即時翻訳トリガーを追加

**Files:**
- Modify: `content.js:1034-1040`（`toggleAutoTranslate` 関数末尾）

**Step 1: 変更前の状態を確認**

`content.js` の `toggleAutoTranslate` 関数（1034行目付近）を確認する。

現在の実装：
```javascript
function toggleAutoTranslate() {
  autoTranslate = !autoTranslate;
  const btn = document.getElementById('mut-btn-auto');
  if (!btn) return;
  btn.classList.toggle('mut-btn-active', autoTranslate);
  btn.title = autoTranslate ? '自動翻訳: ON（クリックでOFF）' : '自動翻訳: OFF（クリックでON）';
}
```

**Step 2: 変更を適用**

`toggleAutoTranslate` 関数の末尾（閉じ括弧 `}` の直前）に以下を追加：

```javascript
function toggleAutoTranslate() {
  autoTranslate = !autoTranslate;
  const btn = document.getElementById('mut-btn-auto');
  if (!btn) return;
  btn.classList.toggle('mut-btn-active', autoTranslate);
  btn.title = autoTranslate ? '自動翻訳: ON（クリックでOFF）' : '自動翻訳: OFF（クリックでON）';
  if (autoTranslate && !overlayContainer && !isTranslating) {
    scheduleAutoTranslate();
  }
}
```

追加するのはこの3行のみ：
```javascript
  if (autoTranslate && !overlayContainer && !isTranslating) {
    scheduleAutoTranslate();
  }
```

**Step 3: 動作確認**

Chrome で対応サイト（例: comicbookplus.com）を開き、拡張機能を有効化した状態で：

1. ページを開く（翻訳されていない状態）
2. 自動翻訳ボタン（⏱アイコン）をクリックしてONにする
3. **期待動作**: 約600ms後に翻訳が自動開始される
4. 既に翻訳済みの状態でONにした場合、翻訳が再実行されないことを確認
5. ONにしてすぐOFFにしても、翻訳が走らないことを確認（`autoTranslate` が false になるので `scheduleAutoTranslate` は呼ばれないが、すでにタイマーが仕掛かっている場合は走る可能性あり）

**Step 4: コミット**

```bash
git add content.js
git commit -m "feat: 自動翻訳トグルON時に未翻訳なら即時翻訳を開始"
```
