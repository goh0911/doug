# Fandom サブソース化の実現可能性調査

作成日: 2026-08-04
種別: **調査のみ（実装なし）**
前提: v2.1.0 リリース済み。解説の出典は en Wikipedia 単独
関連: [`2026-07-27-fandom-popup-evaluation.md`](2026-07-27-fandom-popup-evaluation.md) §46 / §51、
      [`2026-08-04-gloss-recall-investigation.md`](2026-08-04-gloss-recall-investigation.md)

## 0. 結論

**§51.2-1 の「名前解決が未解決」は解ける。§46.4 の転送量の懸念は本件では成立しない。
残る障害は ToS の 1 点のみで、これは技術判断ではない。**

| §51.2 のブロッカー | 本調査の結果 |
|---|---|
| 1. 名前解決（コードネーム → 正典ページ） | ✅ **解決。** `action=opensearch` で 4/4 到達 |
| 2. 最新連載状態（ネタバレ・時代違い） | ⚠️ **未解決。** ただし施設・組織では影響が小さい可能性 |
| 3. ToS（自動アクセスに書面許諾） | ❌ **未解決。** 原文を取得できず（Cloudflare 403） |

## 1. 前提が変わった —— 埋めるべき穴の性質

§51.1 は Fandom の用途を「**メイン（Wikipedia）が能力節を取れない語**」（Booster Gold / Robin 等）と
想定していた。しかし 2026-08-04 の実測で、実際に不足しているのは別種の語だと判明した。

| 語 | en Wikipedia | Marvel Fandom |
|---|---|---|
| SHADOW BASE | ✗ 記事なし | ○ |
| GAMMA BASE | ✗ 記事なし | ○ |
| FORTEAN | ✗ 記事なし | ○ |
| DOC GREEN | ✗ 記事なし | ○ |
| ALPHA FLIGHT SPACE STATION | ✗ 記事なし | ○ |

**キャラクターの能力節ではなく、作品固有の施設・組織・脇役そのものが Wikipedia に無い。**
これは Fandom の最も得意な領域であり、想定していた用途より適合度が高い。

## 2. 名前解決 —— §46.3 の判定を覆す

§46.3 は**曖昧さ回避ページのリンクを辿る**方法で 4 件中 1 件しか到達できず、これを
「決定的な障害」と判定した。同じ 4 件を `action=opensearch` で再測定した結果:

| 語 | §46.3（リンク経由） | 本調査（opensearch） |
|---|---|---|
| Nightcrawler | ❌ 到達せず | ✅ 2 位 `Kurt Wagner (Earth-616)` |
| Spider-Man | ❌ 到達せず | ✅ 3 位 `Peter Parker (Earth-616)` |
| Moon Knight | ❌ キャラですらない | ✅ 3 位 `Marc Spector (Earth-616)` |
| Squirrel Girl | ✅ 2 位 | ✅ 3 位 `Doreen Green (Earth-616)` |

**4/4 で正典に到達する。** しかも規則性がある。1 件目はコードネーム／曖昧さ回避ページで、
その後に `<本名> (Earth-616)` が並ぶ。

今回不足していた語も全件解決した:

| 語 | opensearch 第 1 候補 |
|---|---|
| Shadow Base | `Shadow Base Site A` |
| Gamma Flight | `Gamma Flight`（完全一致） |
| Fortean | `Reginald Fortean (Earth-616)` |
| Gamma Base | `Gamma Base`（完全一致） |
| Doc Green | `Doc Green`（完全一致） |
| Abomination | `Abomination` / `Emil Blonsky (Earth-616)` |

**選択規則の案**: 完全一致タイトルを最優先、無ければ `(Earth-616)` を含む最初の候補。
※ 本調査は 10 語での測定であり、この規則の妥当性は**未検証**。

## 3. 転送量 —— §46.4 の再評価

§46.4 は 150〜350 KB を「△」と判定したが、これは Spider-Man / Bruce Banner という
**主要キャラ**での測定だった。主要キャラは Wikipedia が既にカバーしており、
Fandom を引く必要がない。実際に Fandom を引きたい語のサイズは桁が違う:

| ページ | wikitext |
|---|---|
| Shadow Base Site A | 2,395 字 |
| Gamma Base | 3,353 字 |
| Reginald Fortean (Earth-616) | 14,736 字 |

**サブソースとしての用途では転送量は問題にならない。**

## 4. 抽出契約

ページ全体が 1 つの巨大テンプレートで、本文は名前付きフィールドの中にある。

- **キャラクター**: `Powers` / `Abilities`（§46.1 で確認済み）
- **施設・組織**: `History`

`Shadow Base Site A` の `History` フィールド（原文）:

> Site A was the former headquarters of United States Hulk Operations (a.k.a. Shadow Base),
> a secret anti-Hulk military branch. Scientists at Site A conducted research and
> experimentations on gamma mutates such as Del Frye and the Hulk himself.

そのまま解説の材料になる品質。必要な前処理は `[[…|…]]` のリンク除去、`{{r|…}}` の出典脚注除去、
`'''` の強調除去のみ。Wikipedia 側の節抽出（R-W2''）より単純。

その他の利用可能フィールド: `Status`（Destroyed 等）、`First`（初出）、`Creators`。

## 5. 残る障害

### 5.1 ToS（未解決・技術で解けない）

`https://www.fandom.com/terms-of-use` は **HTTP 403**（Cloudflare）で原文を取得できなかった。
`marvel.fandom.com/robots.txt` も `api.php` に関する記述を確認できなかった。
§49 の「ToS が自動アクセス全般に書面許諾を要求（原文未確認）」は**依然として未確認のまま**。

**これは実装の可否を決める前提であり、判断はユーザーに委ねる。**
選択肢は §50 のとおり ① 許諾を申請する ② 使わない ③ Wikipedia で代替する。

### 5.2 曖昧さ —— 新たに見つかった懸念

`SHADOW BASE` の第 1 候補は `Shadow Base Site A` だが、原文の台詞は
「SHADOW BASE SITE B.」だった。Site A の解説を出すと**別の施設の説明になる**。
より適切な対象は 5 位の `United States Hulk Operations (Earth-616)`。

Wikipedia 側の `passesGate` に相当する**検証ゲートが Fandom にも必要**であり、
Wikipedia 用のものはそのままでは使えない（`/comic/i` の判定や出版社ゲートが噛み合わない）。

### 5.3 最新連載状態（§51.2-2・未解決）

キャラの `Powers` が現在の連載設定を返す問題（§46.5）は未検証のまま。
ただし施設の `History` には `Status = Destroyed` のように時系列が明示されており、
キャラの `Powers` ほど深刻にならない可能性がある。**未測定。**

## 6. 判定

| 項目 | 判定 |
|---|---|
| 名前解決 | ✅ 解決（opensearch・4/4） |
| 転送量 | ✅ 問題なし（サブ用途では 2〜15 KB） |
| 抽出のしやすさ | ✅ Wikipedia より単純 |
| 用途適合 | ✅ **想定より高い。** 不足していた語がまさに Fandom の得意領域 |
| 検証ゲート | ⚠️ Fandom 用に新規作成が必要 |
| 最新設定 | ⚠️ 未測定 |
| **ToS** | ❌ **未確認。ここが唯一の決定的な障害** |

## 7. 推奨

**技術的には着手可能な状態になった。** §51.3 が「サブは名前解決を検証してからでないと
着手できない」としていた依存関係は解消している。

ただし **ToS が未確認のまま実装に進むべきではない。** 順序としては:

1. Fandom の利用規約の原文を確認する（ブラウザで手動アクセス）
2. 自動アクセスが許諾を要するなら、申請するか断念するかを決める
3. 許諾が得られた場合にのみ実装に着手する

実装時の設計は §48 の 4 段構成をベースに、本調査の測定で以下を差し替える:

- ① の「en Wikipedia で本名を取得」は**不要**。`opensearch` が直接正典を返す
- ② の対象フィールドは `Powers` / `Abilities` に加えて `History` を含める
- ⑤ として **Fandom 用の検証ゲート**を追加する（§5.2）

## 8. 本調査で行った通信

評価目的で `marvel.fandom.com/api.php` に対し `opensearch` 10 件・`revisions` 4 件の
計 14 リクエストを送信した（1 秒間隔・連絡先入りの User-Agent）。
`www.fandom.com` の ToS 取得は 403 で失敗。
