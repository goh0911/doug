# Welcome Page 実装プラン

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** インストール時に利用規約・プライバシーポリシーを表示する `welcome.html` を追加する。

**Architecture:** `chrome.runtime.onInstalled`（reason: `'install'`）で `welcome.html` を新規タブで開く。ページは既存の `popup.css` を流用し、ToS・PP をタブ切り替えで表示する。同意の強制はしない。

**Tech Stack:** HTML / Vanilla JS（IIFE）/ Chrome Extension MV3

---

### Task 1: background.js に初回インストール時のタブ表示を追加

**Files:**
- Modify: `background.js:21`（`onInstalled` リスナー内）

**Step 1: 変更箇所を確認**

`background.js` の `onInstalled` リスナーの冒頭（`loadWhitelist()` 直後）。
現状:
```js
chrome.runtime.onInstalled.addListener(async (details) => {
  await loadWhitelist();
  createContextMenu();
  if (details.reason === 'install' || details.reason === 'update') {
```

**Step 2: `'install'` のみの分岐を追加**

`createContextMenu();` の直後に以下を挿入:
```js
  if (details.reason === 'install') {
    chrome.tabs.create({ url: chrome.runtime.getURL('welcome.html') });
  }
```

変更後:
```js
chrome.runtime.onInstalled.addListener(async (details) => {
  await loadWhitelist();
  createContextMenu();
  if (details.reason === 'install') {
    chrome.tabs.create({ url: chrome.runtime.getURL('welcome.html') });
  }
  if (details.reason === 'install' || details.reason === 'update') {
```

**Step 3: 動作確認方法**

`chrome://extensions/` で拡張機能を削除 → zip から再インストール → `welcome.html` のタブが自動で開くことを確認。
（開発中は `chrome.tabs.create` の行を直接コンソールで実行して HTML を確認するのが速い）

**Step 4: Commit**
```bash
git add background.js
git commit -m "feat: open welcome page on first install"
```

---

### Task 2: welcome.html を作成

**Files:**
- Create: `welcome.html`
- Create: `welcome.js`

**Step 1: welcome.html を作成**

```html
<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <title>Doug - ようこそ</title>
  <link rel="stylesheet" href="popup.css">
  <style>
    /* popup.css の width: 300px を上書き */
    body {
      width: auto;
      max-width: 800px;
      margin: 0 auto;
      padding: 40px 24px;
    }
    h1 { font-size: 22px; margin-bottom: 24px; }

    /* タブ */
    .tabs {
      display: flex;
      gap: 4px;
      margin-bottom: 16px;
      border-bottom: 2px solid #333;
      padding-bottom: 0;
    }
    .tab-btn {
      padding: 8px 20px;
      background: none;
      border: none;
      border-radius: 6px 6px 0 0;
      color: #999;
      font-size: 14px;
      font-weight: 600;
      cursor: pointer;
      transition: color 0.15s, background 0.15s;
    }
    .tab-btn:hover { color: #e0e0e0; }
    .tab-btn.active {
      color: #ffd700;
      background: rgba(255, 215, 0, 0.08);
      border-bottom: 2px solid #ffd700;
      margin-bottom: -2px;
    }

    /* コンテンツ */
    .tab-content { display: none; }
    .tab-content.active { display: block; }
    .doc-body {
      line-height: 1.8;
      font-size: 14px;
      color: #ccc;
    }
    .doc-body h2 {
      font-size: 15px;
      color: #e0e0e0;
      margin: 24px 0 8px;
      padding-bottom: 4px;
      border-bottom: 1px solid #333;
    }
    .doc-body p { margin: 8px 0; }
    .doc-body ul { margin: 8px 0 8px 20px; }
    .doc-body li { margin: 4px 0; }
    .doc-body a { color: #ffd700; }
    .doc-body table {
      width: 100%;
      border-collapse: collapse;
      font-size: 13px;
      margin: 12px 0;
    }
    .doc-body th, .doc-body td {
      padding: 6px 10px;
      border: 1px solid #333;
      text-align: left;
    }
    .doc-body th { background: #222; color: #e0e0e0; }
    .doc-body code {
      background: #2a2a2a;
      padding: 1px 5px;
      border-radius: 3px;
      font-size: 12px;
      color: #ffd700;
    }

    /* フッター */
    .footer {
      margin-top: 40px;
      text-align: center;
    }
    .btn-close {
      padding: 12px 48px;
      background: #ffd700;
      color: #1a1a2e;
      border: none;
      border-radius: 8px;
      font-size: 15px;
      font-weight: 700;
      cursor: pointer;
      transition: background 0.15s;
    }
    .btn-close:hover { background: #c9a800; }
    .footer-note {
      margin-top: 12px;
      font-size: 12px;
      color: #666;
    }
  </style>
</head>
<body>
  <h1>Doug - Comic Book Translator へようこそ</h1>

  <div class="tabs">
    <button class="tab-btn active" data-tab="tos">利用規約</button>
    <button class="tab-btn" data-tab="pp">プライバシーポリシー</button>
  </div>

  <div id="tos" class="tab-content active">
    <div class="doc-body">
      <h2>1. 概要</h2>
      <p>Doug - Comic Book Translator（以下「本拡張機能」）は、AI Vision API を使用してコミックの吹き出しをリアルタイム翻訳する Chrome 拡張機能です。本規約は、本拡張機能の利用に関する条件を定めます。</p>

      <h2>2. 利用条件</h2>
      <p>本拡張機能の利用をもって、本規約の内容に同意したものとみなします。同意いただけない場合は、本拡張機能のご利用をお控えください。</p>

      <h2>3. 第三者サービスの利用規約</h2>
      <p>本拡張機能は以下の外部サービスと連携します。各サービスの利用規約・ポリシーへの遵守は、<strong>ユーザー自身の責任</strong>です。</p>
      <table>
        <tr><th>サービス</th><th>提供元</th><th>利用規約・ポリシー</th></tr>
        <tr><td>Gemini API</td><td>Google LLC</td><td><a href="https://ai.google.dev/terms" target="_blank">ai.google.dev/terms</a></td></tr>
        <tr><td>Claude API</td><td>Anthropic PBC</td><td><a href="https://www.anthropic.com/legal/usage-policy" target="_blank">anthropic.com/legal/usage-policy</a></td></tr>
        <tr><td>OpenAI API</td><td>OpenAI, LLC</td><td><a href="https://openai.com/policies/usage-policies" target="_blank">openai.com/policies/usage-policies</a></td></tr>
        <tr><td>Ollama</td><td>ローカル実行のみ</td><td>外部通信なし</td></tr>
      </table>
      <p>また、翻訳するウェブサイト（コミックサービス等）の利用規約への遵守も、ユーザー自身の責任です。</p>

      <h2>4. AI によるデータの学習利用</h2>
      <p>各 AI プロバイダーが送信された画像データを学習に利用するか否かは、各社のポリシーに依存します。詳細は上表のリンク先をご確認ください。一般的に API 経由のデータは学習に使用されない場合が多いですが、開発者はその保証をするものではありません。</p>

      <h2>5. API キーの管理</h2>
      <ul>
        <li>API キーは端末内（<code>chrome.storage.local</code>）にのみ保存され、開発者のサーバーには送信されません</li>
        <li>API キーの流出を防ぐため、第三者と共有しないよう十分ご注意ください</li>
        <li>API の利用料金は各サービスのプランに従い、ユーザーが負担します</li>
      </ul>

      <h2>6. 翻訳の精度</h2>
      <p>翻訳結果は AI による自動生成であり、正確性・品質を保証しません。翻訳結果の利用はユーザーの判断と責任において行ってください。</p>

      <h2>7. 動作の保証</h2>
      <p>以下の事由による動作不能・不具合について、開発者は責任を負いません。</p>
      <ul>
        <li>ブラウザ（Chrome）のバージョンアップによる仕様変更</li>
        <li>対応ウェブサイトの構造変更</li>
        <li>各 AI プロバイダーの API 仕様変更</li>
      </ul>

      <h2>8. 著作権</h2>
      <p>本拡張機能が生成する翻訳テキストに関する著作権上の取り扱いは、ユーザーおよび原著作権者との関係において判断されます。翻訳コンテンツの著作権侵害について、開発者は責任を負いません。</p>

      <h2>9. 免責事項</h2>
      <p>本拡張機能は現状有姿（"as is"）で提供されます。開発者の<strong>故意または重大な過失</strong>によるものを除き、本拡張機能の利用により生じたいかなる損害についても責任を負いません。</p>

      <h2>10. 規約の変更</h2>
      <p>本規約は予告なく変更される場合があります。重要な変更が生じた場合は、拡張機能のアップデートノートまたは配布ページにてお知らせします。変更後も本拡張機能を継続利用した場合、変更内容に同意したものとみなします。</p>

      <h2>11. 準拠法</h2>
      <p>本規約は日本法に準拠し、日本法に従って解釈されます。</p>

      <h2>12. お問い合わせ</h2>
      <p>本規約に関するお問い合わせは、配布ページの連絡先までご連絡ください。</p>
    </div>
  </div>

  <div id="pp" class="tab-content">
    <div class="doc-body">
      <h2>1. 概要</h2>
      <p>Doug - Comic Book Translator（以下「本拡張機能」）は、ユーザーのプライバシーを尊重します。本ポリシーは、本拡張機能がどのようなデータをどのように扱うかを説明します。</p>

      <h2>2. 保存するデータ</h2>
      <p>本拡張機能がローカルに保存するデータは以下のみです。開発者のサーバーへのデータ送信は一切ありません。</p>
      <table>
        <tr><th>データ</th><th>保存場所</th><th>目的</th></tr>
        <tr><td>AI サービスの API キー</td><td><code>chrome.storage.local</code>（端末内のみ）</td><td>API 認証</td></tr>
        <tr><td>翻訳先言語・モデル等の設定</td><td><code>chrome.storage.local</code>（端末内のみ）</td><td>設定の保持</td></tr>
        <tr><td>翻訳キャッシュ</td><td><code>chrome.storage.local</code>（端末内のみ）</td><td>API 呼び出しの削減</td></tr>
        <tr><td>ホワイトリスト（有効サイト一覧）</td><td><code>chrome.storage.sync</code>（Chrome 同期）</td><td>複数端末での設定共有</td></tr>
      </table>
      <p><strong>chrome.storage.sync について:</strong> ホワイトリストは <strong>Google のサーバーを経由してお使いの Chrome アカウントに同期</strong>されます。Google によるデータの取り扱いについては <a href="https://policies.google.com/privacy" target="_blank">Google のプライバシーポリシー</a>をご参照ください。</p>

      <h2>3. 外部サービスへの送信</h2>
      <p>翻訳実行時、コミックページの<strong>画像データ</strong>が以下のいずれかに送信されます。送信先はユーザーが設定ページで選択した AI プロバイダーに限られます。</p>
      <table>
        <tr><th>プロバイダー</th><th>送信先</th><th>再学習ポリシー</th></tr>
        <tr><td>Google Gemini</td><td><code>generativelanguage.googleapis.com</code></td><td><a href="https://ai.google.dev/terms" target="_blank">Gemini API 追加利用規約</a></td></tr>
        <tr><td>Anthropic Claude</td><td><code>api.anthropic.com</code></td><td><a href="https://www.anthropic.com/legal/privacy" target="_blank">Anthropic プライバシーポリシー</a></td></tr>
        <tr><td>OpenAI</td><td><code>api.openai.com</code></td><td><a href="https://openai.com/policies/privacy-policy" target="_blank">OpenAI プライバシーポリシー</a></td></tr>
        <tr><td>Ollama</td><td><code>localhost</code>（端末内のみ）</td><td>外部送信なし</td></tr>
      </table>

      <h2>4. 収集しないデータ</h2>
      <ul>
        <li>氏名・メールアドレス等の個人情報</li>
        <li>閲覧履歴・翻訳履歴（開発者への送信なし）</li>
        <li>利用統計・クラッシュレポート・アクセス解析</li>
      </ul>

      <h2>5. データの削除方法</h2>
      <ol>
        <li><strong>設定ページ</strong>からキャッシュをクリア（翻訳キャッシュのみ）</li>
        <li><strong>Chrome の拡張機能管理画面</strong>で本拡張機能をアンインストール（すべてのデータが消去されます）</li>
      </ol>

      <h2>6. 対象年齢</h2>
      <p>本拡張機能自体に年齢制限はありませんが、利用する AI サービスおよびコミックサービスの年齢制限に従ってください。</p>

      <h2>7. ポリシーの変更</h2>
      <p>本ポリシーは予告なく変更される場合があります。重要な変更が生じた場合は、拡張機能のアップデートノートまたは配布ページにてお知らせします。</p>

      <h2>8. 準拠法</h2>
      <p>本ポリシーは日本法に準拠し、日本法に従って解釈されます。</p>

      <h2>9. お問い合わせ</h2>
      <p>本ポリシーに関するお問い合わせは、配布ページの連絡先までご連絡ください。</p>
    </div>
  </div>

  <div class="footer">
    <button class="btn-close" id="closeBtn">確認しました</button>
    <p class="footer-note">本拡張機能を利用することで、上記の規約・ポリシーに同意したものとみなされます。</p>
  </div>

  <script src="welcome.js"></script>
</body>
</html>
```

**Step 2: welcome.js を作成**

```js
(function () {
  // タブ切り替え
  document.querySelectorAll('.tab-btn').forEach(function (btn) {
    btn.addEventListener('click', function () {
      document.querySelectorAll('.tab-btn').forEach(function (b) {
        b.classList.remove('active');
      });
      document.querySelectorAll('.tab-content').forEach(function (c) {
        c.classList.remove('active');
      });
      btn.classList.add('active');
      document.getElementById(btn.dataset.tab).classList.add('active');
    });
  });

  // 確認しましたボタン
  document.getElementById('closeBtn').addEventListener('click', function () {
    window.close();
  });
})();
```

**Step 3: 動作確認**

1. `chrome://extensions/` で拡張機能を「再読み込み」
2. Service Worker のコンソールで以下を実行してタブを開いてテスト:
   ```js
   chrome.tabs.create({ url: chrome.runtime.getURL('welcome.html') })
   ```
3. 確認ポイント:
   - タブが開き、利用規約が表示される
   - 「プライバシーポリシー」タブに切り替えられる
   - 「確認しました」でタブが閉じる
   - リンクが新しいタブで開く

**Step 4: Commit**
```bash
git add welcome.html welcome.js background.js
git commit -m "feat: show ToS/PP on first install via welcome page"
```
