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

## 変更時の不変条件

`tests/fixtures/wiki-articles.json` を用いたテストで、**Brian Banner と Reggie Mantle が
引き続き却下される**こと。これを壊す変更は入れない。

## リリース判断

今回判明した問題はいずれも 2.1.0 の変更が原因ではなく、以前からの状態。
2.1.0 のリリースを止める理由は無い。**ただし当たり率の問題は未解決のまま残る。**
