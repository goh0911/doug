# 固有名詞解説ポップアップ 引き継ぎメモ

作成日: 2026-07-28（最終更新: 2026-07-29）
ブランチ: `feature/glossary-popup`（50 commits・master へマージ済み）
バージョン: 2.0.0
状態: **実装完了・自動テスト通過・実機で下線／ポップアップ／再翻訳を確認済み**

関連文書: [設計](2026-07-27-glossary-popup-design.md) / [実装計画](2026-07-27-glossary-popup-impl.md) / [評価](2026-07-27-fandom-popup-evaluation.md)

---

## 1. 何が動くようになったか

翻訳された吹き出しの中の glossary 登録語に点線の下線が付き、hover すると「何者か」と「何ができるか」を日本語で説明するポップアップが出る。

```
ページ読み込み → シリーズ検出 → 先読み（Nano 使用時のみ）
翻訳実行 → GET_GLOSS_DEFS → 訳文を span 化 → hover でポップアップ
```

出典は en Wikipedia のみ。Fandom は実装していない（設計 §14）。

---

## 2. 使い始めるまでに必要な操作

**この機能は既定で OFF です。** 以下を踏まないと何も起きません。

1. `chrome://extensions/` で拡張を再読み込み
2. 設定ページを開き「固有名詞の解説ポップアップ」を ON にする
3. 権限ダイアログで `en.wikipedia.org` へのアクセスを**許可**する
4. コミックページで翻訳を実行する

**用語の「承認」は不要になりました**（2026-07-29・commit `5f99c25`）。解説ポップアップは Nano が自動抽出した `approved: false` の候補も対象にします。誤った語なら background 側の検証ゲートで落ちて何も表示されないため、訳文を書き換える層B置換とは危険度が違うという判断です。**層B置換（`utils/glossary-substitute.js`）の `approved` ゲートは維持しています。**

用語集そのものは、翻訳が 20 ペア溜まった時点で background が自動抽出します（`runExtractionBg`）。以前は シリーズ管理画面のボタンを押さないと一度も走りませんでした。1 回の抽出で消費するのは古い側 20 ペアまでで、積み残しがあるうちは `extractionDue` が立ったまま＝管理画面のバナーが出たままになります（次の翻訳記録で続きが走る）。

---

## 3. 未検証のまま残っている項目

自動テストは 456 件通過。実機（Marvel リーダー）で下線・ポップアップ・再翻訳まで確認済みです。E2E スイートは実プロファイルと有料 API を使うため実行していません。

実機で見つかり修正した問題は §4 に追記しています。

### 3.1 手動確認が必要なこと

- [x] 訳文中の登録語に点線の下線が出る
- [x] hover して 150ms 後にポップアップが出る
- [ ] Esc で閉じる
- [ ] Tab キーで span にフォーカスできる（`aria-describedby` 実装済み）
- [ ] 解説が生成できなかった語に下線が**付かない**
- [ ] 設定 OFF → Wikipedia へのリクエストが飛ばない（DevTools の Network で確認）
- [ ] 権限を拒否 → チェックボックスが OFF に戻る
- [ ] Nano 不可環境で API フォールバックに落ちる
- [ ] `<dialog>` を使うリーダーでポップアップが隠れない（`getUIParent()` 対応済み・要実機確認）

### 3.2 設計書 §13 が挙げた最大のリスク（未計測）

**Nano の英→日 翻訳＋要約の品質。** 既存の Nano 用途（短い入力から JSON を抜く）より質的に重いタスクで、1.5 KB の英文を日本語 80〜120 字に圧縮させる。**駄目なら設定の生成エンジンを「翻訳用APIのみ」に倒してください**——その逃げ道は設計に組み込んであります。

あわせて未計測：先読みが読書開始に間に合う割合、検証ゲートの却下率。

---

## 4. レビューで捕まえた欠陥（記録）

各タスクのレビューと最終の whole-branch レビューで見つかり、修正済みのもの。実装の性質を示すので残します。

| 深刻度 | 内容 |
|---|---|
| Critical | 先読みが**ページ訪問時**（翻訳時ではない）に発火し、エンジンゲートが無いため設計 §4.1 が明文で禁止する「API フォールバック時の先読み」が起きていた。ユーザー操作なしに有料キーで課金される状態 |
| Important | `putGlossDefs` の戻り値を捨てており、series レコードが無いとキャッシュが永久に効かず毎回全語を再取得していた |
| Important | API 生成パスに timeout が無く、`Retry-After: 60` で 1 語あたり最悪 180 秒ハングしていた |
| Important | 1 語の throw でバッチ全体が破棄され、既にキャッシュ済みの語まで消えていた |
| Important | バッチを末尾で 1 回だけ保存していたため、Service Worker 停止で完了分が全損していた |
| Important | ポップアップが `document.body` + 絶対座標で、`position:fixed` のオーバーレイとスクロールでずれ、`<dialog>` 配下では隠れていた |
| Important | `clearOverlays` がポップアップを消さず、SPA 遷移で前ページのキャラ解説が残っていた |

### 実機確認で見つかった欠陥（2026-07-29）

| 深刻度 | 内容 |
|---|---|
| Critical | 検証ゲートが記事の同一性を見ておらず、検索 1 位をそのまま採用していた。S.H.I.E.L.D. に Absorbing Man、Gamma Base に Betty Ross の解説を表示（`termAppearsIn` を追加して修正） |
| Important | 用語抽出が成功時に `recentPairs` を全消去し、上限で渡さなかった新しい側のペアが消えていた |
| Important | ポップアップがサイト側の `[role="tooltip"]` CSS に負けて `visibility:hidden` で伏せられていた |
| Important | 吹き出し再翻訳ボタンが押せなかった（`top/right:-8px` ではみ出しているのに `.mut-overlay:hover` を条件にしていた） |
| Important | 再翻訳ボタンが 2 個表示（`addPanelRetranslateButtons` が前回ぶんを消さずに追加していた） |
| Minor | 解説が「まとめすぎ」で identity が用語名のオウム返しになっていた |

UI は実機の指摘を受けて次のとおり変更しました。

- 用語の**承認は不要**（自動抽出の未承認候補も解説対象）
- 用語抽出は翻訳 20 ペアごとに**自動実行**（1 回 20 ペアまで消費）
- 再翻訳は**吹き出し単位に一本化**し、パネル単位のボタンは削除
- ツールバーに**再翻訳モード**を追加。通常モードでは再翻訳ボタンを一切出さず、
  再翻訳モードでは解説を出さない

計画側の誤りも実装中に 8 件見つかり訂正済み（オーバーレイのコンテナ ID、`display:flex` によるレイアウト破綻、`callTextOnlyProvider` の 5 箇所のプロバイダ仕様差異など）。

---

## 5. 保留した項目（別途対応）

いずれも動作をブロックしないと判断したもの。

**コード品質**
- `getSeries` を 1 回の解決で最大 3 回読んでいる
- 両メッセージハンドラが `WIKIPEDIA_ORIGIN` をハードコード（2 つ目のソース追加時に破綻する）
- `glossEngine` / `getSettings` を語ごとに読んでいる
- `putGlossDefs` に容量ガードが無い（他の series 書き込みは持っている）
- `resolveGlossDefs` の統合テストが無い

**UI**
- 出典リンクがマウス／キーボードで到達しにくい（帰属表示自体は常に出るので CC BY-SA 義務は充足）
- スクロール中にポップアップが span から離れる
- 2 回目の翻訳時に一瞬 gloss 無しで描画される

**拡張性**
- ~~`source` フィールドが background→content の seam で落ちている~~ → 2026-07-29 対応。`GET_GLOSS_DEFS` の応答に `source` を含め、`content.js` は `GLOSS_SOURCES` 対応表からホスト名とラベルを引く。ソース追加時は background の `GLOSS_SOURCES` 配列と content.js の対応表に 1 行ずつ足す

---

## 6. 既存 E2E テストの修正（2026-07-29 対応済み）

`translation.spec.js` / `auto-translate.spec.js` / `whitelist.spec.js` は、存在しないセレクタを待っており通り得ない状態でした。

| 修正前 | 修正後 |
|---|---|
| `#doug-toolbar` | `#mut-toolbar` |
| `#doug-overlay-container` | `#mut-overlay-container` |
| `.doug-overlay` | `.mut-overlay` |

セレクタ以外にも 3 点あり、あわせて直しています。

- `toHaveCount({ minimum: 1 })` は Playwright の不正な API（数値しか取らない）→ `.first()` の存在確認に置換
- 自動翻訳トグルを `getByRole('checkbox')` で取っていたが、実体は `<button id="mut-btn-auto">`。ON/OFF も `.mut-btn-active` クラスで表される → id と class で判定
- 翻訳ボタンを `getByRole('button', { name: /翻訳/ })` で取っていたが、`title` に「翻訳」を含むボタンが複数あり strict mode に触れる → `#mut-btn-translate` で取得

`.github/workflows/` は `publish.yml` のみで **E2E を CI で回していない**ため露見していませんでした。

**修正後の実行は未実施です。** このスイートは実ブラウザで実際に翻訳を走らせるため、ユーザーの Chrome プロファイルと有料 API を消費します。静的検証（`npx playwright test --list` で 7 テスト 4 ファイルを収集）までは確認済みです。
