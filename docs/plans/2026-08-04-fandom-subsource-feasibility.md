# Fandom サブソース化の実現可能性調査

作成日: 2026-08-04
種別: **調査のみ（実装なし）**
前提: v2.1.0 リリース済み。解説の出典は en Wikipedia 単独
関連: [`2026-07-27-fandom-popup-evaluation.md`](2026-07-27-fandom-popup-evaluation.md) §46 / §51、
      [`2026-08-04-gloss-recall-investigation.md`](2026-08-04-gloss-recall-investigation.md)

## 0. 結論

**技術的な障害はすべて解消した。しかし ToS が明確に禁じているため、
書面許諾を得ない限り実装してはならない。**

| §51.2 のブロッカー | 本調査の結果 |
|---|---|
| 1. 名前解決（コードネーム → 正典ページ） | ✅ **解決。** `action=opensearch` で 4/4 到達 |
| 2. 最新連載状態（ネタバレ・時代違い） | ⚠️ 未測定。施設・組織では影響が小さい可能性 |
| 3. ToS（自動アクセスに書面許諾） | ❌ **原文で確認。明確に禁止されている（§5.1）** |

皮肉な結果になった。§46.3 が「決定的な障害」としていた技術的問題は解けたが、
§49 が「原文未確認」として保留していた規約の問題のほうが本物だった。

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

### 5.1 ToS —— 確認済み。**実装不可**

当初は `https://www.fandom.com/terms-of-use` が Cloudflare 403 で取得できなかったが、
**ユーザーが原文を提示したことで確認できた**（Date of Last Revision: December 19, 2025）。
§49 の推測は正しかった。「User conduct」節に以下がある:

> Use any robot, spider, site search and/or retrieval application, or other device to
> **scrape, extract, retrieve or index any portion of the content**;

> not use any robot, spider, scraper or **other automated means to access the Services
> for any purpose without our express written permission**;

> **Without our express, prior written consent**, use or copy the content for the
> development of any software program, including, but not limited to, training a
> machine learning or artificial intelligence (AI) system

**拡張機能から `api.php` を叩く行為は「automated means to access the Services」に該当する。
MediaWiki API に対する例外は無い。** `robots.txt` の Allow は ToS に劣後する（§49 の判断どおり）。

第 1 条項には除外規定があるが、これは適用されない:

> Except as expressly permitted by the Company (for example with respect to the use of
> text content ... as permitted as set forth at our licensing page)

licensing page＝CC-BY-SA が定めるのは**入手した後のテキストの扱い**であって**入手の方法**ではない。
自動アクセスの禁止は独立した条項であり、コンテンツのライセンスでは解除されない。

**結論: 書面許諾なしに実装してはならない。** 連絡先は `support@fandom.com`。

なお本調査で送信した 14 リクエスト（§8）もこの条項に抵触する。原文が取得できない状態での
評価目的の少量アクセスだったが、規約が判明した以降は自動アクセスを行わない。

### 5.1b 代替候補 —— Comic Vine（要検討・別調査）

評価メモ §41 は Comic Vine を「キー必須のため拡張に組み込めない」として却下したが、
**この論拠は現在の Doug には当てはまらない。** Doug はすでに「ユーザーが自分の API キーを
入れる」設計であり（manifest の説明文にも明記）、負担は既に受け入れられている。

さらに重要な点として、**公開 API を提供していること自体が express permission にあたる。**
Fandom 本体を塞いでいた「許諾されていない自動アクセス」の問題は発生しない。

API 規約（`https://comicvine.gamespot.com/api/`）の実測:

| 条項 | Doug への影響 |
|---|---|
| 公開 API・キー登録制 | ✅ 自動アクセスの許諾問題が解消 |
| Non-commercial use only | ✅ Doug は無料 |
| 200 req/resource/hour・キャッシュ推奨 | ✅ 解説は 30 語/回・キャッシュ済み |
| Don't build a competing product | ✅ 翻訳ツールであり wiki ではない |
| Give credit（リンクバック必須） | ✅ 既に出典リンクを表示している |
| **Don't redistribute in another form**<br>"Do not **edit, manipulate** or reproduce on any other medium" | ⚠️ **LLM による翻訳・要約が該当しうる。曖昧** |

最後の 1 点が未解決。見出しはデータセットの再配布を想定した書き方に見えるが、本文は広く読める。
Comic Vine 側は「contact us when you have a prototype」と問い合わせを歓迎しているため、
**照会すれば解消できる可能性がある。**

Comic Vine も Fandom, Inc. の所有（`© 2026 FANDOM, INC.`）だが、独自の API 規約を持つ点が本体と異なる。

**未検証**: Comic Vine が実際に `Shadow Base` / `Gamma Base` / `Fortean` を収録しているか。
API キーが必要なため本調査では確認していない。

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

**Marvel Fandom の直接参照は実装しない。** ToS が明確に禁じており、技術で解ける問題ではない。

選べる道は 3 つある。いずれも技術判断ではないため、着手はユーザーの決定を要する。

### 案 1: Fandom に許諾を申請する

`support@fandom.com` に用途を説明して書面許諾を求める。無料で、通れば §1〜4 の
測定がそのまま活きる（技術的な準備は完了している）。返答が得られない・拒否される
可能性はある。

### 案 2: Comic Vine を評価する（推奨）

§5.1b のとおり、公開 API を持つため自動アクセスの許諾問題が発生しない。
残る曖昧さは "Do not edit, manipulate..." の 1 点で、これも問い合わせで解消しうる。

先に確認すべきは**規約ではなくデータ**。`Shadow Base` / `Gamma Base` / `Fortean` を
実際に収録しているかが分からなければ、規約を詰める意味がない。API キーの登録が要る。

### 案 3: Wikipedia の天井を受け入れる

作品固有の施設・脇役には解説を出さない。現状維持。
`utils/wiki-source.js` の検証ゲートは正しく機能しており、**誤った解説は出ていない**
（2026-08-04 の調査で確認）。「無情報は誤情報より良い」という評価メモ §1.2 の原則には適う。

### 実装時の設計（許諾が得られた場合のみ）

§48 の 4 段構成をベースに、本調査の測定で以下を差し替える:

- ① の「en Wikipedia で本名を取得」は**不要**。`opensearch` が直接正典を返す
- ② の対象フィールドは `Powers` / `Abilities` に加えて `History` を含める
- ⑤ として **Fandom 用の検証ゲート**を追加する（§5.2）

## 8. 本調査で行った通信

評価目的で `marvel.fandom.com/api.php` に対し `opensearch` 10 件・`revisions` 4 件の
計 14 リクエストを送信した（1 秒間隔・連絡先入りの User-Agent）。
`www.fandom.com` の ToS 取得は 403 で失敗。
