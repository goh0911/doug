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

#### 「翻訳は再配布にあたるか」の検討

該当条項の全文:

> **Don't redistribute in another form**
> Do not edit, manipulate or reproduce on any other medium. Do not use our brand name
> to promote your work. If you want to use our name, email us.

**当たらないと読む根拠:**

1. 見出しが `redistribute` に限定されており、続く文もブランド名の話。**他所での再頒布**を
   規律する節として一貫している
2. **帰属条項と矛盾する。** 同規約に「**On any page you use our data**, please link back to us」
   とあり、**自製品での表示を前提**にしている。表示自体が禁止ならこの条項が意味を成さない
3. 「Concentrate on **using the data in a unique way**」「Build something awesome」は
   **加工を当然の前提**にしている。禁じられているのは競合データリソースの構築

**それでも残るリスク:**

- 翻訳は著作権法上の**二次的著作物**であり、「edit, manipulate」に該当しないとは言い切れない
- **Comic Vine には開いたライセンスの表示が無い。** フッターは `© 2026 FANDOM, INC.
  ALL RIGHTS RESERVED.` で、CC-BY-SA の記載を確認できなかった（API ドキュメント・
  記事ページとも）。Fandom 本体（CC-BY-SA 明示）との重要な違い。
  **開いたライセンスが無い以上、翻訳が二次的著作物として許諾されるという著作権法上の
  根拠は使えず、許諾の源泉は API Terms of Use ただ一つになる**

**結論: 条文だけでは判断できない。照会が必要。** 先方は
「contact us when you have a prototype and let's figure out a way to work together」と
明示的に問い合わせを歓迎しており、Doug は非商用・非競合・帰属表示済みという
先方が歓迎する条件を満たしている。

Comic Vine も Fandom, Inc. の所有（`© 2026 FANDOM, INC.`）だが、独自の API 規約を持つ点が本体と異なる。

#### 実測（2026-08-04・ユーザーの API キーで実行）

**収録範囲は Wikipedia の穴をほぼ埋める。ただし検索精度は低く、出版社ゲートが必須。**

用語集の実際の語（コードネーム・略称のまま）で `resources=character,location,team,concept`・
`limit=1` を投げた結果、**12 語中 5 語が誤答**だった:

| 語 | 第 1 候補 | 判定 |
|---|---|---|
| ABOMINATION | 「Voltron Force と戦う Krell 星の巨大生物」 | ❌ Lion Forge Comics |
| DOOM | 「豪邸破壊を盾に富豪を強請る」 | ❌ DC Comics |
| WALT | 「Mom's eldest son.」 | ❌ Bongo（Simpsons） |
| BANNER | 「Bar Sinister の登場人物」 | ❌ Valiant/Acclaim |
| TONY STARK | Tony Stark (Amalgam) | ❌ 別世界線 |

`ABOMINATION` は象徴的で、**Wikipedia が完全一致で正解を返す語**を Comic Vine は Voltron の敵にした。
評価メモ §1.2「誤った情報は無情報より悪い」に真正面から抵触する。

#### 出版社ゲートで救える

`field_list=publisher` で **`publisher` が構造化フィールドとして返る**（Wikipedia のように
導入節から推測する必要がない）。`limit=5` で取り直し、出版社と名前で絞ると全件救えた:

| 語 | 却下される誤答 | 採用される候補 |
|---|---|---|
| ABOMINATION | 1位 Lion Forge | **2位 Abomination \| Marvel**（Emil Blonsky） ✅ |
| DOOM | 1位 DC、4位 Company-Licensed | **3位 Doctor Doom \| Marvel** ✅ |
| TONY STARK | 1位 Amalgam | **2位 Iron Man \| Marvel**（deck 冒頭が "Tony Stark was…"） ✅ |
| SHADOW BASE | — | **1位 Shadow Base \| Marvel (team)** ✅ |
| RED HULK | — | **1位 Thunderbolt Ross \| Marvel** ✅ |
| WALT | Bongo / Guǎngdōng / Le Lombard / Conundrum | Marvel の Walt は **deck が空 → 何も出さない**（正しい） |
| BANNER | Valiant / DC | Marvel に完全一致なし。Brian Banner は**完全一致必須で落とす**（正しい） |

**出版社だけでは足りない。** `DOOM` の 2 位は `T'Channa | Marvel` で、出版社は一致するが
Doom と無関係。Wikipedia 側の `termAppearsIn` に相当する名前照合が必要:

1. **出版社一致** — `expectedPublisher(host)` をそのまま流用できる
2. **名前照合** — `name` が語として term を含む、または `deck` の主語が term
3. **`deck` が非空かつ十分な長さ**

#### Wikipedia のゲートが落とす語を拾える

- `TONY STARK`: Wikipedia は *Iron Man* の第 1 文の主語が "Iron Man" のため却下。
  **Comic Vine の deck は「Tony Stark was the arrogant son of…」で主語が Tony Stark なので通る**
- `RED HULK`: 同様に Wikipedia では却下、Comic Vine は 1 位で `Thunderbolt Ross` を返す

`2026-08-04-gloss-recall-investigation.md` で「ゲートを緩めても増えるのは 4 語」とした
その 4 語のうち 2 語がここで解決する。

#### `deck` の品質

一行要約であり、Wikipedia の節抽出（R-W2''）も Fandom の wikitext パースも不要。
`resource_type` で character / location / team / concept が判別でき、
Wikipedia では推測するしかなかった型情報が構造化されている。
HTML エンティティ（`&amp;`）が含まれるため復号が要る。

#### robots.txt の Content-Signal

```
User-agent: *
Content-Signal: search=yes, ai-train=no, use=reference
Allow: /
```

| シグナル | 値 | Doug への影響 |
|---|---|---|
| `search` | yes | 短い抜粋の提示は許可 |
| `ai-train` | **no** | 学習・微調整は禁止 → **Doug は学習しない。抵触しない** |
| `ai-input` | **記載なし** | RAG 等。規定(c)により「許諾も制限もしない」 |

**運営者は AI 用途を意識したうえで、禁じたのは学習だけ。** `ai-input` は定義が存在するのに
あえて `no` を置いていない。照会メールで使える材料。

個別 AI クローラ（GPTBot / ClaudeBot / CCBot / Google-Extended 等）は `Disallow` だが、
これらは**学習用クローラ**であり、ユーザー操作を起点に語単位で取得する Doug とは性質が異なる。

#### CORS

`access-control-allow-origin` は返らない（CORS 無効）。ただし **MV3 の Service Worker は
`host_permissions` があれば CORS を迂回する**ため `background.js` からは呼べる。
Gemini / Claude / OpenAI と同じ経路であり新しい問題ではない。
Wikipedia と同様に明示的な権限リクエストにするのが筋。

### 5.1c 許諾申請の比較

2 通同時に出すのが効率的。どちらか通れば実装に進める。

| | Marvel Fandom（案 1） | Comic Vine（案 2） |
|---|---|---|
| 自動アクセス | ❌ 書面許諾が必要 | ✅ 公開 API で解決済み |
| コンテンツのライセンス | ✅ CC-BY-SA。**翻訳は帰属＋継承で明示的に許諾** | ⚠️ 開いたライセンス無し（All Rights Reserved） |
| 収録範囲 | ✅ 実測で 6/6 解決 | ❓ 未確認 |
| 聞くべきこと | 自動アクセスの許諾 | 翻訳が「edit, manipulate」に当たるか |

**許諾さえ得られれば Fandom 本体のほうが法的には明快**（CC-BY-SA のため翻訳の扱いが確定している）。
Comic Vine は入口が広いが、翻訳の可否が規約解釈に依存する。

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
