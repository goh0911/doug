# 解説ポップアップの当たり率が低い件 — 調査記録

対象: Immortal Hulk (2018) / `series:5754b0720763b89c` / 翻訳 111 回
測定日: 2026-08-04
きっかけ: 固有名詞が並ぶページで「ハルク」しか解説が出ない

## 結論

**検証ゲートは概ね正しく機能している。当たり率を押し下げている主因は用語抽出の質。**

用語集 60 語・glossDefs 54 件（成功 16 / 失敗 38）。失敗 38 件の内訳:

| 分類 | 件数 | 例 | 評価 |
|---|---|---|---|
| 制作スタッフ・誌面名 | 9 | ALAN FINE, C.B. CEBULSKI, CORY PETIT, PAUL MOUNTS, RYAN BODENHEIM, SARAH BRUNSTAD, EWING BODENHEIM MOUNTS, Mighty Marvel Missive, MARVEL | 却下は正しい。**そもそも登録すべきでない** |
| 一般名詞・台詞断片 | 12 | GAMMA GUY, GAMMA TERRORIST, NO HUMAN CASUALTIES, WAKANDANS, ALPHANS, MINNESOTA, DEATH VALLEY, UNITED STATES MILITARY/AIR FORCE, RICHARD, THE IMM, B-GOW | 却下は正しい。**登録すべきでない** |
| 同一実体の重複 | 6 | SHIELD↔S.H.I.E.L.D.、WALT↔WALTER↔LANGKOWSKI↔DR. LANGKOWSKI、GENERAL FORTEAN↔FORTEAN、Marvel↔MARVEL、Richard↔RICHARD、United States military↔UNITED STATES MILITARY | **重複除去が効いていない** |
| 記事が存在しない | 7 | FORTEAN, GAMMA BASE, DOC GREEN, DR. McGOWAN, ALPHA FLIGHT SPACE STATION 等 | 修正不能 |
| 出版社ゲートで正しく却下 | 1 | REGGIE（Archie Comics の Reggie Mantle） | 意図どおり |
| **ゲートを直せば増える語** | **4** | BANNER, RED HULK, TONY STARK, SHIELD | — |

**ゲートを緩めても増えるのは 4 語のみ。** 一方、不満の対象となった語
（ABOMINATION / GAMMA FLIGHT / SHADOW BASE / DOOM）は**用語集に 1 つも入っていない**。

## 棄却した仮説

### glossDefs の 16 KB 上限

用語集 60 語に対し glossDefs は 54 件保存されている。上限に当たっていない。棄却。

### 一時的失敗の 24 時間焼き付き

失敗 41 件を削除して再取得したところ、**成功に転じたのは 0 件**。失敗は決定論的であり、
一時的失敗の焼き付きではない。棄却。

ただし `background.js:561-565` で Nano / API の一時的失敗が `{failed:true}` として
24 時間キャッシュされるのは**コード上の実在の欠陥**（`8bb758d` が Wikipedia 取得側だけを
直し、生成側を積み残した）。今回の症状の原因ではないが、別途直す価値はある。

```js
let parsed = plan.tryNano ? await generateWithNano(prompt, term) : null;
if (!parsed) {
  if (!plan.allowApiFallback) return nanoOnly ? null : { failed: true, at: now };
  parsed = await generateGlossWithApi(prompt, term);
}
if (!parsed) return { failed: true, at: now };   // ← タイムアウト・429 も恒久失敗扱い
```

## 実測: 検索が何を引くか

`series.html` のコンソールから拡張機能自身の権限で `buildSearchUrl` を再現した
（外部 CLI から叩くと共有 IP がレート制限され、拡張機能側のキャッシュまで汚染するため）。

| 語 | シリーズ名あり | シリーズ名なし |
|---|---|---|
| SHIELD | The Incredible Hulk (comic book) ❌ | Captain America ❌ |
| BANNER | Brian Banner ✅通過（但し不採用） | Hulk ❌ |
| ROSS | The Incredible Hulk (comic book) ❌ | **Thunderbolt Ross ✅** |
| RED HULK | List of Hulk titles ❌ | Thunderbolt Ross ❌ |
| TONY STARK | She-Hulk ❌ | Iron Man ❌ |
| FORTEAN | Abomination (character) ❌ | Steve Moore (comics) ❌ |
| GAMMA BASE | Betty Ross ❌ | The Incredible Hulk (1982 TV series) ❌ |
| DOC GREEN | Rick Jones (character) ❌ | Hulk ❌ |
| WALT | **Sasquatch (comics)**（記事は正解・愛称で照合失敗） | Marvel Comics ❌ |
| DEATH VALLEY | List of Marvel Comics characters: M ❌ | The Uncensored Mouse ❌ |

### 観察

**1. 検索順序は変更しないこと。**

一見シリーズ名つきがノイズ源に見えるが、`WALT` ではシリーズ名つきが
*Sasquatch (comics)*＝**正解の記事**を引いている（落ちたのは検索ではなく
"WALT" と "Walter" の語境界照合）。`LANGKOWSKI` の既存の成功も同じ経路と考えられる。

`fetchWikipediaEntry` のコメントが記録する `"Vision" comics → Scarlet Witch`
（ゲートを通る**別人**を引く）の危険は依然として有効で、`acceptsNonExactTitle` が
安全に成立しているのは**シリーズ名つきを先に試すからこそ**である。順序を入れ替えてはならない。

**2. `acceptsNonExactTitle` は設計どおり機能している。**

BANNER でシリーズ名つきが Brian Banner をゲート通過させたが、完全一致でないため
不採用となり、誤った解説は出ていない。`5438deb` の修正は有効。

**3. ROSS は次回翻訳で成功する見込み。**

シリーズ名なしで Thunderbolt Ross を引き、`acceptsNonExactTitle('')` が true なので
fallback として採用される。実機で「未生成」なのは `GLOSS_MAX_TERMS_PER_RUN = 30` の
上限で今回の再試行に入らなかっただけ。

**4. ゲートの真の recall 不足は BANNER / RED HULK / TONY STARK の 3 件。**

いずれも別名・実名で立項されており、導入節に名前はあるが第 1 文の主語には無い
（"Iron Man is a superhero…" に Tony Stark は現れない）。`07c6df8` で照合範囲を
主語に絞った影響。段落全体に戻すと `UNITED STATES MILITARY → Father Time` 型の
誤答が復活するため、安易には戻せない。

## 修正の優先順位

### 1. 抽出の質（最優先・ただし未確定の分岐あり）

クレジットページ由来の人名・誌面名を登録しない。大文字小文字を無視した重複除去。
`mergeCandidates`（`utils/nano-extract.js:181`）は `original` の完全一致と
前方一致（80%）でしか重複を見ないため、大文字小文字違いが素通りする。

**未検証の分岐**: 「抽出枠がゴミで埋まっているから本命が入らない」は**まだ測定していない**。
競合する機構として `PAIRS_PER_TRANSLATION = 10`（`series-store.js:26`）がある。
1 ページの吹き出しは 10 個より多く、`sampleRecentPairs` が残りを恒久的に捨てる。
ABOMINATION のペアがそもそも `recentPairs` に入っていないなら、ゴミを除いても
枠は制約ではなかったことになり、修正箇所が変わる。

判別方法（`series.html` のコンソール）:

```js
chrome.storage.local.get('series:5754b0720763b89c').then(o => {
  const p = o['series:5754b0720763b89c'].recentPairs || [];
  console.log(p.length + ' pairs');
  console.log(p.map(x => x.original).join(' | '));
});
```

- 対象語が現れるのに抽出されていない → **抽出の質**（プロンプト・重複除去）
- 対象語が現れない → **サンプリング欠落**（`PAIRS_PER_TRANSLATION` 側）

### 2. 一時的失敗の焼き付き

`background.js:561-565`。今回の症状の原因ではないが実在の欠陥。修正は小さい。

### 3. ゲートの recall（保留推奨）

増えるのは 4 語。精度とのトレードオフが直撃するため、フィクスチャを増やしてから着手する。

## 実施した修正（2026-08-04）

Codex によるセカンドオピニオンで、私が見落としていた経路が 1 つ判明した。

### `93b9a7b` 抽出プロンプトの除外リストに上限（10 語）

上表の実測にもとづく。プロンプト長は実データで 2373 → 1584 字。

### `07aaf7f` 新規候補ゼロのときにペアを捨てない

**Codex 指摘の核心。** Nano が既存語だけ・空配列を返しても `success = true` になり
（`background.js:279-306`）、渡した 10 ペアが消費されて永久に失われていた。
実測で、対象 5 ペアに対し Nano が既存語 `LANGKOWSKI` 1 件しか返さない事象を確認済み。
**この経路で ABOMINATION / GAMMA FLIGHT が二度と登録されない。**

新規ゼロなら末尾へ回して再挑戦させる（空振り 3 回で諦める）。

あわせて抽出後の `extractionDue` 判定を 20 → 10 に下げた。20 件で起動しても
評価するのは古い側 10 件だけで、残りが滞留していた（Codex §4）。

### 見送った項目

- **抽出の API フォールバック**（Codex §3）: `runExtractionBg` は Nano 不可なら即 return。
  Nano が使えない環境では用語候補が一件も登録されない。ただし今回の環境では
  Nano は応答しており、本件の主因ではない。設計変更になるため別立てとする。
- **`sampleRecentPairs` の 10 件上限**（Codex §4-2）: 1 ページの吹き出しが 10 を超えると
  その時点で捨てられる。当たり率を下げる構造だが、対象語は `recentPairs` に
  到達していたため本件の直接原因ではない。
- **解説生成の一時的失敗の焼き付き**: 上記「棄却した仮説」参照。実在の欠陥だが別件。
- **ゲートの recall**（BANNER / RED HULK / TONY STARK / SHIELD の 4 語）: 精度との
  トレードオフが直撃するため、フィクスチャを増やしてから着手する。

### 修正後の実機測定（2026-08-04）

抽出（Nano・同一 5 ペア）:

| | 修正前 | 修正後 |
|---|---|---|
| プロンプト | 2373 字 | 1746 字 |
| 抽出結果 | `LANGKOWSKI` のみ | `LANGKOWSKI` `DOC DOOM` `GAMMA FLIGHT` `HULK` `SHADOW BASE` `SITE B` |

新規登録される 4 語について、実際に Wikipedia を引いてゲートを通したところ:

| 語 | シリーズ名あり | シリーズ名なし | 解説が出るか |
|---|---|---|---|
| GAMMA FLIGHT | Sasquatch (comics) ❌ | **Gamma Flight ✅ 完全一致** | **出る** |
| SHADOW BASE | The Immortal Hulk ❌ | Leader (character) ❌ | 出ない（記事なし） |
| DOC DOOM | ヒット 0 件 | Doctor Doom ❌ | 出ない（愛称のため照合失敗） |
| SITE B | The Immortal Hulk ❌ | Jurassic Park (franchise) ❌ | 出ない（ノイズ・却下が正しい） |
| **ABOMINATION** | **Abomination (character) ✅** | **Abomination (character) ✅** | **抽出さえされれば出る** |

**正味の増加は GAMMA FLIGHT の 1 語。** ABOMINATION はゲート側の準備が整っており、
抽出できれば 2 語目になる。

### 判明した本質的な上限

不満の対象だった語の多くは、**en Wikipedia に記事が存在しない**:

- SHADOW BASE / SITE B（Immortal Hulk 固有の施設）
- FORTEAN / GENERAL FORTEAN（本作の登場人物）
- GAMMA BASE / ALPHA FLIGHT SPACE STATION
- DOC GREEN（別名）

これらは Marvel Fandom には記事があるが Wikipedia には無い。
`docs/plans/2026-07-27-fandom-popup-evaluation.md` §51 で
「Wikipedia をメイン、Marvel/DC Fandom をサブ」とする構成が決定済みだが、
実装は Wikipedia 単独のまま（`background.js` の `GLOSS_SOURCES = [wikipediaSource]`）。

**当たり率の天井は Wikipedia のコミック細部に対する収録率で決まっており、
抽出とゲートをいくら改善してもこの天井は超えられない。**

### 検証状況

- 単体テスト **621 件 green**（修正前 610 件 → 新規 11 件追加）
- Brian Banner / Reggie Mantle の却下テストは通過を個別に確認済み
- **実機での効果は未検証。** 拡張機能を再読み込みして再測定が必要

## 変更時の不変条件

`tests/fixtures/wiki-articles.json` を用いたテストで、**Brian Banner と Reggie Mantle が
引き続き却下される**こと。これを壊す変更は入れない。

## リリース判断

今回判明した問題はいずれも 2.1.0 の変更が原因ではなく、以前からの状態。
2.1.0 のリリースを止める理由は無い。**ただし当たり率の問題は未解決のまま残る。**

---

## 追記（2026-08-05）: 失敗キャッシュの焼き付き

Comic Vine を実装（`591becb`）したのに下線が増えなかった。原因は **Comic Vine が
一度も呼ばれていなかった**こと。

`resolveGlossDefs` は「キャッシュに使える値が無い語」だけを取得対象にするが
（`background.js`）、`isUsable` は `failed` エントリを 24 時間「使える」と判定していた。
そのため Comic Vine 導入**前**に失敗した語は、24 時間経つまで新ソースを試す経路に
到達しない。

実測での確定:

| | |
|---|---|
| FORTEAN / WALT の失敗時刻 | 8/4 19:30 |
| Comic Vine の commit | 8/4 21:38 |

失敗エントリを手で削除して再翻訳したところ下線が増え、ソース内訳は
`comicvine: ['DR. MCGOWAN', 'DR. McGOWAN', 'FORTEAN', 'GENERAL FORTEAN', 'REGGIE',
'TONY STARK', 'WALTER']` / `en-wikipedia: 19 件` となった。**Comic Vine は
Wikipedia が記事を持たない FORTEAN / GENERAL FORTEAN を実際に埋めている。**

### 修正

失敗エントリに「どの世代の・どのソース構成で失敗したか」を指紋として記録し、
現在の指紋と違えば無効にする。

- `utils/gloss-cache.js` の `isUsable(entry, now, sourcesKey)` に第 3 引数を追加。
  失敗エントリは `entry.sources === sourcesKey` のときだけ 24 時間有効。
  指紋を持たない旧エントリは無効（いつの構成か分からないため）
- `background.js` の `glossSourcesKey()` が `${GLOSS_PIPELINE_EPOCH}:${使えるソース id}` を返す。
  「使える」＝ origin 権限があり、必要な設定（Comic Vine の API キー）も済んでいる
- `GLOSS_PIPELINE_EPOCH` は手で上げる定数。**ソース構成が変わらない改修
  （`passesGate` の緩和・プロンプト変更など）を実機に届かせる唯一の手段。**
  ゲートや素材の取り方を変えたら必ず上げる

この欠陥は今回だけの事故ではない。8/4 の抽出修正とゲート修正も、同じ理由で
実機に反映されるまで最大 24 時間見えなかった。

### 残る課題（②抽出漏れ）

`ABOMINATION` / `DOC DOOM` / `DOOM` は依然として用語集に入らない。
材料は揃っている（`recentPairs` に該当ペアが存在することを確認済み）ため、
サンプリングや消費の問題ではなく **Nano の出力品質**の問題。

なお `GAMMA FLIGHT` は解決済み（en-wikipedia でヒット）。

---

## 追記（2026-08-05）: 抽出の破綻と、その真因

`ABOMINATION` が抽出されない件を追ったところ、**抽出そのものが壊れていた**ことが
判明した。オプションページで実パイプラインと同じプロンプトを Nano に投げて計測。

### 症状

Nano が「台詞を丸ごと `original` に写す」モードに落ちる。プロンプトが
「悪い例（文をそのまま返している。禁止）」として明示的に禁じている出力そのもの。

```json
{"original":"FIRST YOU KILL TWO GAMMA FLIGHT MEMBERS RETRIEVING THE ABOMINATION SHELL--ON YOUR SO-CALLED STEALTH ", ...}
```

`parseCandidatesJson` が 30 字超を落とすため 10 件中 9 件は消えるが、生き残った
1 件が `"THE MAN IS BARELY COLD--"` として**用語集に登録されていた**。用語集の
`NO HUMAN CASUALTIES` / `THE IMM` / `B-GOW` / `GAMMA GUY` はすべてこの経路で入った。
**長さフィルタは破綻を防いでおらず、破綻を見えなくしていただけだった。**

### 真因: 訳ゆれ検出の出力スキーマ

同一入力・`temperature: 0` / `topK: 1` の A/B（10 ペア。完全に再現する）:

| 条件 | 時間 | JSON | 丸写し | 採用 |
|---|---|---|---|---|
| A 現行 | 32.9s | 10 件 | **9 件** | 1（誤検出） |
| B 訳ゆれ節なし | **1.2s** | 1 件 | **0 件** | 1 |
| C 現行 + responseConstraint | 3.5s | 3 件 | 1 件 | 3 |

全候補が `"inconsistent":true` かつ variants が translated と同一という不自然な形で、
モデルが出力テンプレートの最も複雑な形を埋めることに引きずられ、抽出タスク自体を
見失っていた。`EXTRACTION_PAIRS_PER_RUN = 10` では防げていない。

**`responseConstraint`（JSON Schema で original を 30 字に制限）は採用しない。**
丸写しを「30 字で切り詰めた偽物」に変換するだけで、C では
`"ANY OBJECTIONS TO ME TAKING LE"` が生成され `sanitizeCandidate` を素通りした。
既存の長さフィルタが偶然 9/10 を落としていたのに対し、制約版はそれを通す分だけ悪化する。

### 修正（f816073）

1. 抽出プロンプトから訳ゆれ検出を削除
2. 訳ゆれ判定を `mergeCandidates` の純粋な文字列比較に移動。
   副次的に検出範囲が 1 バッチ 10 ペア内 → 巻をまたいだ全履歴に広がる
3. 除外リストを `addedAt` 降順に。`slice(-N)` は「新しい側」を採るつもりだったが、
   `chrome.storage` はオブジェクトを `base::Value::Dict`（キーがソートされる flat_map）で
   保持するため、読み戻した用語集の `Object.keys()` は辞書順になっていた
4. 5 語以上の原語を却下（実在する最長級の固有名詞が `ALPHA FLIGHT SPACE STATION` の 4 語）

修正後の実測: 応答 1917 字 / 32.9 秒 → **205 字 / 丸写し 0 件**、
`DOC DOOM` `GAMMA FLIGHT` `LANGKOWSKI` `WALT` を正しく抽出。

### `ABOMINATION` は Nano の認識限界

該当ペア 1 件だけを渡しても抽出されない。同じ文から `GAMMA FLIGHT` は拾える。

```
入力: "FIRST YOU KILL TWO GAMMA FLIGHT MEMBERS RETRIEVING THE ABOMINATION SHELL--..."
出力: [{"original":"GAMMA FLIGHT", ...}]
```

除外リストなし・良い例の追加でも改善しない（3 条件とも新規 0 件）。
`abomination` は英語の一般名詞であり、`THE ABOMINATION SHELL` を普通名詞句と読むのは
妥当な判断でもある。`DOOM` / `LEADER` / `VISION` と同じ「一般名詞と同形のキャラクター名」
クラスで、無理に取りに行くと `sanitizeCandidate` が既に対策した `MENTOR`（訳: 恩師 →
タノスの父の解説が出た）型の誤検出が復活する。**追わない。手動追加で補う。**

### 残課題: 愛称・略称の正規化

`DOC DOOM` は抽出され、両ソースに問い合わせもされたうえで失敗する。記事は
`Doctor Doom` にあるが `DOC DOOM` という表記は本文に無いため `termAppearsIn` が通らず、
Comic Vine の `isSameEntity` も `DOC` と `Doctor` を別物として扱う。
`DOC` → `DOCTOR` のような敬称略称の正規化で対処できるクラス。着手する場合は
`tests/fixtures/wiki-articles.json` で **Brian Banner / Reggie Mantle が却下され続ける**
不変条件を守ること。

---

## 追記（2026-08-05）: 愛称・略記の正規化と、その結果

`DOC DOOM` は抽出も検索も両ソースへの問い合わせも通ったうえで失敗していた。
記事は `Doctor Doom` で立項されており、本文に `Doc Doom` という表記が無いため
`termAppearsIn` が通らず、Comic Vine の `isSameEntity` も `DOC` と `Doctor` を
別物として扱っていた。

### 修正（32a8ee2 / d424ab5）

- Wikipedia 側: `normalizeForMatch` に敬称・階級の略記展開を追加
  （`doc`→`doctor` / `sgt`→`sergeant` 等）。語と記事の両方に同じ変換が掛かるため
  どちらが略記でも一致する。**後ろに語が続くときだけ開く**——単独の `DOC` を
  `doctor` にすると敬称でない同綴りを巻き込む
- Comic Vine 側: `HONORIFICS` に `doc` / `cpt` / `adm` を追加し、敬称を語側からも外す。
  ただし**候補名にも敬称が付いているときに限る**。語側だけ外すと `DOC DOOM` が
  `doom` になり DC Comics の別キャラ `Doom` に当たる（出版社が分かる経路では
  出版社ゲートが止めるが、未知サイトは `publisher: null` で素通りする）
- `GLOSS_PIPELINE_EPOCH` を 2 に上げ、既存の失敗キャッシュを失効させた

### 実機の結果

`DOC DOOM` → `Doctor Doom`（en-wikipedia）で解説が生成された。

### 新たに見つかった別課題: 解説本文の固有名詞の誤訳

生成された `powers` に「宿敵**リー・チャイルド**の知能に匹敵する」とある。
Doctor Doom の宿敵は Reed Richards であり、Nano が英文中の Reed Richards を
作家 Lee Child と訳している。ゲートや取得ではなく解説生成
（`buildGlossPrompt` → `generateWithNano`）側の翻訳品質の問題。
解説本文に登場する固有名詞は同種の誤訳を起こしうる。**未着手。**
