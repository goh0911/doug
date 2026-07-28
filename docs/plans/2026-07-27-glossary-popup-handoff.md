# 固有名詞解説ポップアップ 引き継ぎメモ

作成日: 2026-07-28
ブランチ: `feature/glossary-popup`（25 commits）
バージョン: 1.17.0
状態: **実装完了・自動テスト通過・ブラウザでの動作未確認**

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
5. **シリーズ管理画面で用語を「承認」する**

**5 が特に見落としやすい点です。** 対象は `approved: true` の語だけで、Nano が自動抽出した候補は `approved: false` で入ります（`utils/nano-extract.js:151`）。新規プロファイルでは、承認するまでこの機能は無言で何もしません。

---

## 3. 未検証のまま残っている項目

自動テストは 436 件通過していますが、**ブラウザでの動作は一度も確認していません。** サブエージェントには Chrome を操作できず、E2E スイートはユーザーの実プロファイルを使い有料 API を消費するため実行していません。

### 3.1 手動確認が必要なこと

- [ ] 訳文中の登録語に点線の下線が出る
- [ ] hover して 150ms 後にポップアップが出る／Esc で閉じる
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

計画側の誤りも実装中に 8 件見つかり訂正済み（オーバーレイのコンテナ ID、`display:flex` によるレイアウト破綻、`callTextOnlyProvider` の 5 箇所のプロバイダ仕様差異など）。

---

## 5. 保留した項目（別途対応）

いずれも動作をブロックしないと判断したもの。

**コード品質**
- `getSeries` を 1 回の解決で最大 3 回読んでいる
- `glossUserAgent` の連絡先が placeholder（`https://github.com/`）— **公開前に実リポジトリ URL へ置換すべき**
- 両メッセージハンドラが `WIKIPEDIA_ORIGIN` をハードコード（2 つ目のソース追加時に破綻する）
- `glossEngine` / `getSettings` を語ごとに読んでいる
- `putGlossDefs` に容量ガードが無い（他の series 書き込みは持っている）
- `resolveGlossDefs` の統合テストが無い

**UI**
- 出典リンクがマウス／キーボードで到達しにくい（帰属表示自体は常に出るので CC BY-SA 義務は充足）
- スクロール中にポップアップが span から離れる
- 2 回目の翻訳時に一瞬 gloss 無しで描画される

**拡張性**
- `source` フィールドが background→content の seam で落ちており、`content.js` が Wikipedia のホスト名とラベルをハードコードしている。**設計 §3 の「ソースを 1 つ足すだけ」は現状そのままでは成り立たない**

---

## 6. 本ブランチ外の既存問題

**既存の E2E テストは通り得ない状態にあります。** `translation.spec.js` / `auto-translate.spec.js` / `whitelist.spec.js` が待っているセレクタが content.js に存在しません。

| テストのセレクタ | 実体 |
|---|---|
| `#doug-toolbar` | `#mut-toolbar`（content.js:393） |
| `#doug-overlay-container` | `#mut-overlay-container`（content.js:2304） |
| `.doug-overlay` | `.mut-overlay`（content.js:2057, 2374） |

加えて `toHaveCount({ minimum: 1 })` は Playwright の不正な API（数値を取る仕様）。

`.github/workflows/` は `publish.yml` のみで **E2E を CI で回していない**ため露見していませんでした。`CLAUDE.md` の「新機能追加時のチェックリスト」も同じ誤ったセレクタを記載しています（`CLAUDE.md` は `.gitignore:7` で除外されているためコミット対象外）。

本ブランチでは新規 `gloss-popup.spec.js` だけを実在するセレクタに直し、既存 spec には触れていません。
