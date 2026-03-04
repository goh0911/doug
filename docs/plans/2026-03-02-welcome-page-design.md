# 設計書: インストール時 利用規約・PP 表示ページ

日付: 2026-03-02

## 概要

Chrome 拡張機能の初回インストール時に、利用規約（ToS）とプライバシーポリシー（PP）を表示する `welcome.html` ページを追加する。

## 採用アプローチ

**アプローチA: インストール時に専用タブを開く**

- `chrome.runtime.onInstalled`（reason: `'install'`）で `welcome.html` を新規タブで開く
- 同意の強制はしない（表示のみ）
- 既存コードへの影響を最小化

## ファイル構成

| ファイル | 種別 | 内容 |
|----------|------|------|
| `welcome.html` | 新規 | ToS・PP をタブ切り替えで表示する拡張機能ページ |
| `welcome.js` | 新規 | タブ切り替え・「確認しました」ボタン処理 |
| `background.js` | 変更 | `onInstalled` の `'install'` 分岐に `chrome.tabs.create` を追加 |
| `manifest.json` | 変更なし | 拡張機能ページは `web_accessible_resources` 不要 |

## UI 設計

```
┌─────────────────────────────┐
│  Doug - Comic Book Translator│
│                              │
│ [利用規約] [プライバシーポリシー]  ← タブ
│ ─────────────────────────── │
│                              │
│  （文書本文・スクロール可能）      │
│                              │
│ ─────────────────────────── │
│        [ 確認しました ]        │  ← クリックでタブを閉じる
└─────────────────────────────┘
```

## スタイル

- `popup.css` を流用（背景 `#1e1e2e`・アクセント `#ffd700`）
- 本文エリアは `max-width: 800px` で読みやすく
- タブ切り替えは CSS クラスの付け替えのみ（JS最小）

## background.js 変更内容

```js
// onInstalled 内の既存 'install' | 'update' 分岐の外側に追加
if (details.reason === 'install') {
  chrome.tabs.create({ url: chrome.runtime.getURL('welcome.html') });
}
```

## 制約・注意事項

- `content.js` の IIFE 構造・`background.js` の ES Module 構成は変更しない
- `welcome.js` は Classic Script（IIFE）で記述（ES Module 不要）
- 利用規約・PP の本文は `docs/terms-of-service.md` と `docs/privacy-policy.md` を HTML に変換してインライン記述
