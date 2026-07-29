# Fandom 連携・固有名詞解説ポップアップ 機能評価

作成日: 2026-07-27
種別: **評価のみ（実装なし）**
対象案: MARVEL / DC 作品を検知 → FANDOM にアクセス → 固有名詞に Wikipedia ライクな解説ポップアップを表示
前提: Phase 1〜6-B 実装済み（v1.16.1）

---

## 0. 結論

> 🔴 **本節は最終結論ではない。確定した参照方針は §51 を参照すること。**
> Wikipedia をメイン、Marvel/DC Fandom をサブとする構成で決定済み（2026-07-27）。
> 以下の「Fandom 見送り」という判定は §46 / §51 により上書きされている。

> ⚠️ **【2026-07-27 追記・重要な訂正】本節の理由 1 は §46 の実測により撤回された。**
> `prop=revisions` で wikitext を取得すれば、Marvel Fandom は `Powers` / `Abilities` を
> **構造化された infobox フィールド**として提供しており、データ品質は Wikipedia より高い。
> 「解説文を返す手段が無い」という結論は、`prop=extracts` だけを試して `prop=revisions` を
> 試さなかったことによる誤りである。**下記の理由 3（曖昧性）のみが有効な障害として残る**（§46.3）。

**現行案（Fandom から解説文を取得してポップアップ表示）は推奨しない。** 理由は嗜好ではなく実測の壁：

- ~~Fandom には **短い解説文を返す API が存在しない**~~ → **§46 で撤回。** `prop=extracts` / `prop=description` は確かに未対応だが、`prop=revisions&rvslots=main` で wikitext が取得でき、そこに構造化された `Powers` / `Abilities` フィールドが存在する。
- 生 HTML を扱う必要はない（wikitext はテンプレート記法の除去で済む）。ただし Fandom は第三者が編集できるため、R-SEC-1a / R-SEC-1b（独立プロンプト・`escapeDelimiters`）は変わらず必要。
- 唯一安定して動く `opensearch` も、**無関係な語に対して平然とヒットを返す**（§1.3 実測）。**この曖昧性の問題は §46.3 の実測でも再確認され、Fandom 採用の決定的な障害として残る。**

---

## 1. 実測結果（2026-07-27 時点）

| エンドポイント | 結果 | 判定 |
|---|---|---|
| `api.php?action=query&prop=extracts&exintro` | `Unrecognized value for parameter "prop": extracts` | ❌ TextExtracts 拡張が未インストール |
| `api.php?action=query&prop=description` | `Unrecognized value for parameter "prop"` | ❌ 未対応 |
| `api.php?action=query&list=search` | 200 だが `"snippet":""`（常に空） | ❌ 要約文取得不可 |
| `api/v1/Articles/Details?abstract=200` | Cloudflare `Just a moment...` HTML | ❌ ボット判定で拒否 |
| `api/v1/SearchSuggestions/List` | 同上 | ❌ 拒否 |
| `api.php?action=opensearch` | 200・正規タイトルと URL を返す | ✅ **唯一安定して使える** |
| `api.php?action=parse&prop=text&section=0` | 200・巨大な生 HTML（infobox・曖昧さ回避テンプレート込み） | △ 動くが untrusted HTML |
| `api.php?action=query&prop=langlinks` | 空（言語間リンク未設定） | ❌ 英↔日ページの自動対応付け不可 |
| CORS ヘッダ | `Access-Control-Allow-Origin` なし | ─ background.js から fetch すれば無関係 |

※ 検証コマンドは `/opt/homebrew/opt/curl/bin/curl` で実行（素の `curl` は LuLu ブロック）。

### 曖昧性解消が構造的に困難

Marvel Fandom は多元宇宙ごとにページが分かれる。実測：

- `opensearch("Bruce Banner")` → `Bruce Banner`, `Bruce Banner (Earth-6109)`, `Bruce Banner (Earth-1610)`
- `list=search("Peter Parker")` → 上位が `Peter Parker (Earth-6160)`, `Peter Parker (Earth-730911)`

**読者が今読んでいる号がどの Earth かを拡張は知らない。** 正典（Earth-616）とも限らない。誤ったアースの設定を「解説」として出すのは、ポップアップを出さないより悪い。

### 1.3 `opensearch` に識別力がない（案 A を否定した実測）

「Fandom に実在する語かどうか」を用語の妥当性判定に使えるか検証した。結果は**使えない**：

| クエリ | 実際の出自 | Marvel Fandom の応答 |
|---|---|---|
| `Sanji` | ONE PIECE | `Sanji Yamamoto (Earth-616)` |
| `Zoro` | ONE PIECE | `Zoro`（**完全一致でヒット**） |
| `Naruto` | NARUTO | `Mr. Naruto (Earth-70019)` |
| `Levi Ackerman` | 進撃の巨人 | `Galan (Earth-610102)/Gallery`（全く無関係） |
| `the` | ─ | `Thing` ほか |
| `Qwertzuiop` | 無意味な文字列 | `[]`（空） |

`opensearch` は前方一致で外れると全文検索にフォールバックするため、**ランダム文字列以外はほぼ何かにヒットする**。「Fandom に載っている」というフラグはノイズであり、シグナルではない。完全一致に限定しても `Zoro` が誤検知するため救えない。

### 日本語版の状態

`marvel.fandom.com/ja` は存在する（200）が、`opensearch("スパイダー")` の上位は「スパイダーハム(アース25)」「スパイダーバース」等で網羅性が低く、英語版との langlinks も未設定。**公式訳語の供給源としても自動対応付けができない。**

---

## 2. セキュリティ評価（最重要）

`docs/security/2026-07-25-nano-injection-findings.md` の F-1 / F-2 はいずれも「未検証テキストがプロンプトに届く」問題だった。本案が持ち込むのは、それより**厳しい条件の入力**である：

| | F-1（Nano 候補） | F-2（ページ由来シリーズ名） | 本案（Fandom） |
|---|---|---|---|
| 出所 | 自モデル出力 | ホワイトリスト済みページ | **第三者が自由編集できる wiki** |
| 承認ゲート | ✅ 手動承認あり | ❌ なし | ❌ なし（hover 表示） |
| 形式 | 30 字の短文 | タイトル文字列 | **任意長の HTML** |

したがって、実装するなら以下は要件であって注意書きではない：

- **R-SEC-1**: Fandom 由来テキストは**表示専用**。`glossary` / `examples` / `recentPairs` / `buildSeriesPromptSection` のいずれの経路にも、既存の人手承認ゲートを通さずに入れない。
- **R-SEC-2**: 描画は `textContent` のみ。`innerHTML` は使わない（既存の clean な描画点：content.js:1798 / 1816 / 2126 / 2147）。
- **R-SEC-3**: `action=parse` の HTML を使う場合、拡張内での DOM パース＋タグ剥がしが必須。これは新規の攻撃面であり、監査済みの安全性を再検証し直す必要がある。

**R-SEC-3 を満たすコストが、この機能の価値に見合わない** —— これが §0 の結論の中身。

---

## 3. Marvel / DC 判定の評価

`detectSeriesFromTitle` の信頼度は最終手段で 0.5（`trailing-num`）、URL fallback で 0.4。その上に「Marvel か DC か」の推論を重ねるのは、弱い推論の二段重ね。

| 方式 | 評価 |
|---|---|
| タイトル allowlist をハードコード | 永続的な保守負債。作品追加のたびに更新 |
| 両 wiki を検索してヒットした方を採用 | 1 シリーズにつき 2 リクエスト。"Batman" / "Vision" / "Robin" は wiki 間および無関係 fandom と衝突 → 誤検知 |
| **既存のシリーズ編集 UI でユーザーがタグ付け** | 誤検知ゼロ・出荷済み UI を再利用・Phase 6/6-B の YAGNI 方針と整合 → **推奨** |

---

## 4. 実装コスト

- **同期ペアが 4 組目に増える**。チェックリストは既に 3 組（`utils/ollama.js` / `prompt-builder.js`+`glossary-substitute.js` / `nano-extract.js`+series.js）を抱えており、新規 pure 関数ごとに drift 経路が増える。
- **オーバーレイの text→span リファクタが最大リスク**。用語をクリック可能にするには上記 4 箇所の `textContent` をテキストノード＋`<span>` に分割する必要があり、まさにそこが「`innerHTML` に手が伸びて監査済みの XSS 対策を巻き戻す」地点。
- **ストレージ予算**。`GLOSSARY_SERIES_MAX_BYTES` は 2 KB/シリーズ。wiki 由来データは glossary 予算とは別枠のキャッシュ（独自上限＋TTL）が必要。`chrome.storage.local` のクォータは共有。
- **権限は追加不要**（好材料）。`optional_host_permissions: ["*://*/*"]` があり、popup.js:65,78,89 / background.js:492 に `chrome.permissions.request` の実行時フローが既にある。**manifest 変更も Web Store の新規警告も発生しない。**
- **LLM 呼び出しゼロ**（好材料）。他の全 Phase と違い API コストが増えない。
- **ライセンス**：Fandom は CC-BY-SA。本文を表示するなら出典元記事へのリンクと帰属表示が必要。

---

## 5. 前提として置いた設計判断

ポップアップの対象は **訳文側の固有名詞（＋用語集登録語）** とする。既存の用語リストをそのまま照合キーに使えるため。
（代替：原文＝英語側の固有名詞に付ける案もある。こちらは「英語で読む人の理解補助」であって翻訳一貫性には寄与しない別機能。）

---

## 6. 検討した縮小案と、その評価

### 案 A: 用語候補に「Fandom 実在」フラグを付ける → **実測により否定**

当初、`opensearch` で得られる正規タイトルだけを使い（解説文は取らない＝ HTML パース不要）、Phase 4 の候補に妥当性フラグを付ける案を検討した。承認ゲートが既にあるため §2 の危険を構造的に回避でき、有望に見えた。

しかし §1.3 の実測でこの前提は崩れた。`opensearch` は `Sanji` にも `Naruto` にも `Levi Ackerman` にもヒットを返す。**存在フラグは判定に使えない。**

残るのは「綴りの正規化」——`Bruce Banner` を正規ページ名に寄せる——という、より狭い用途だけ。ただしこれも無関係語に正規タイトルを返すため、承認 UI に**参考リンクを添える**程度の補助に留まる。実装コスト（新 pure 関数＋同期ペア 4 組目・fetch 経路・キャッシュ）に対して得られるものが小さく、**優先度は低い**。

### 案 B: シリーズ単位で Fandom ページへリンクする

固有名詞ごとではなく、**§3 でユーザーが手動タグ付けしたシリーズ**そのものの Fandom ページへリンクする案。

- 曖昧性の問題を回避できる（キャラ単位の Earth 推定が不要）
- テキストを取り込まないので untrusted HTML を扱わない
- ただし提供価値は「ブラウザで検索する手間の削減」に留まる

※ 当初検討した「固有名詞ごとにリンクを出す」案は不可。`Peter Parker (Earth-6160)` へのリンクは、読者が 616 の号を読んでいる場合、誤った設定を提示するのと同じ失敗（§1.2）を起こす。HTML パースのリスクを外しただけで、曖昧性の問題は一切解決していない。

### 同じ目的により近い投資先

「固有名詞の理解を助ける」という狙いに対しては、外部 wiki より **既存の用語集（glossary）に説明文フィールドを持たせ、Phase 4 の承認時にユーザー自身または Nano が一行メモを付ける**ほうが直接的。データは自前・承認ゲート済み・曖昧性なし・外部依存ゼロで、ポップアップ表示部分（§4 の text→span リファクタ）だけが共通コストになる。

---

## 7. 判定

| 項目 | 判定 |
|---|---|
| 現行案（Fandom 解説文ポップアップ） | ❌ 非推奨。要約 API 不在・多元宇宙の曖昧性・untrusted HTML の三点 |
| 案 A（実在フラグ） | ❌ 実測により否定。`opensearch` に識別力なし |
| 案 A'（承認 UI に参考リンク） | △ 成立するが価値が小さい。優先度低 |
| 案 B（シリーズ単位リンク） | ○ 安全に成立。ただし価値は限定的 |
| Marvel/DC 判定 | 自動検知は誤検知コストが高い。やるならユーザーの手動タグ付け |
| **総合** | **Fandom 連携は現時点で見送り。** 解説ポップアップ自体が欲しいなら、データ源を自前の glossary に置く案を先に検討する |

---

# 追補（同日）— Fandom 以外のデータソース評価

「自前 glossary は時間がかかりすぎる」との判断を受け、外部ソースを実測比較した。

## 8. 結論（追補）

**日本語 Wikipedia が Fandom より明確に優れる。** Fandom を否定した 3 つの理由のうち 2 つが消える：

| Fandom の壁 | ja Wikipedia |
|---|---|
| 要約 API が存在しない | ✅ `api/rest_v1/page/summary` が **プレーンテキスト** `extract` を返す |
| untrusted HTML のパースが必要 | ✅ 不要。§2 の R-SEC-3 が消滅する |
| 多元宇宙の曖昧性 | △ 軽減（Earth 別ページが無い）。ただし別種の誤ヒットが残る（§10） |

加えて **CORS `access-control-allow-origin: *`・API キー不要・CC-BY-SA**。

**ただしカバレッジが 50%（実測）** であり、これが採否の分水嶺になる。

## 9. 実測（2026-07-27・UA 付き）

| 項目 | 結果 |
|---|---|
| `api/rest_v1/page/summary` | ✅ `extract`（プレーンテキスト）＋ `type` 判定用フィールド |
| `list=search`（文脈語付き） | ✅ 「ヴィジョン マーベル」→『ヴィジョン (マーベル・コミック)』が1位（170 hits） |
| `prop=extracts&exintro&explaintext&exlimit=20` | ✅ **動作**。1 リクエストで最大 20 タイトル分のプレーンテキスト |
| CORS | ✅ `access-control-allow-origin: *` |
| **User-Agent なし** | ❌ **HTTP 429**。12 件の連続アクセスで即ブロック |

**User-Agent は必須要件**（Wikimedia のレート制限ポリシー）。実測では UA を付けた瞬間に 429 が解消した。連絡先を含む UA を送る必要がある。

## 10. カバレッジ実測 —— 50%、かつ失敗様式が悪い

中堅キャラ 12 名を「検索 → summary」のチェーンに通した結果：

| 結果 | 件数 | 例 |
|---|---|---|
| ✅ 正しい記事 | 6 | ナイトクローラー / ワスプ / デスストローク / ヴィジョン / ロビン / ムーンナイト※ |
| ❌ **無関係な記事にヒット** | 6 | ザターナ→「DCコミックス・ボムシェルズ」、セントリー→「ウルトロン」、ブースター・ゴールド→「ドゥームズデイ」、ローグ／ビースト→X-MEN 映画、スクイレル・ガール→「スパイディとすごいなかまたち」 |

※ ムーンナイトは**テレビドラマの記事**にヒット（コミックキャラの記事ではない）。厳密には 5/12 = 42%。

**失敗が全て `type: "standard"` で返る**点が重要。type チェックだけでは弾けない。実測では「取得した本文に元の語が含まれるか」を検証することで 6 件すべてを検出できた。**この検証が無いと、ウルトロンの解説を「セントリー」として表示する** —— Fandom を否定した「誤った情報は無情報より悪い」がそのまま再現する。

## 11. 他候補（実測せず却下）

| ソース | 却下理由 |
|---|---|
| Comic Vine API | API キー必須・200 req/h・**英語のみ**。日本語出力の本拡張には不適 |
| Marvel 公式 Developer API | 公開鍵＋秘密鍵＋MD5 署名が必要・**Marvel のみで DC 非対応**・英語 |
| Wikidata | 英語名→日本語ラベルの対応付けには有用（`Nightwing`→`ディック・グレイソン`）。ただし説明文は多くが英語のまま。曖昧語で外す実測あり（`Vision`→「視覚」、`Naruto`→「鳴門市」、`Robin`→「男女両用の名前」）。**用語集の訳語正規化の補助**としてのみ価値がある |

## 12. 有力案 —— 二層構成

カバレッジ 50% を埋めるため、**既にユーザーが API キーを持っている LLM** を第二層に置く：

```
固有名詞 → ① ja Wikipedia（検索→一括 extracts）
              ├─ type=standard かつ 本文に語が含まれる → 採用（出典リンク付き）
              └─ それ以外 → ② LLM に一行解説を生成させる（「AI 生成」と明示）
```

- 第一層は権威があり出典を示せる。第二層が Wikipedia に無い中堅キャラを埋める
- 幻覚の懸念はあるが、本製品は既に**翻訳そのもの**を LLM の出力に委ねている。一行の人物注釈はそれより影響が小さい
- LLM 呼び出しは Wikipedia が外した時のみ＝コスト増は限定的

## 13. 実装要件（採用する場合）

| ID | 要件 |
|---|---|
| R-W1 | 連絡先を含む **User-Agent を必ず送る**（無いと 429・実測済み） |
| R-W2 | `prop=extracts&exlimit=20` で**一括取得**する（1 ページ 20 語で 20 リクエストは非現実的） |
| R-W3 | `type: "standard"` **かつ** 本文に対象語が含まれることを確認。どちらか欠けたら表示しない |
| R-W4 | `extract` を使う。**`extract_html` は使わない**（HTML 問題の再導入） |
| R-W5 | `list=search` の結果は**タイトル取得にのみ**使う。snippet は `<span class="searchmatch">` を含むため描画しない |
| R-W6 | 描画は `textContent` のみ（§2 の R-SEC-2 を継承） |
| R-W7 | Wikipedia も誰でも編集できる。取得文は**表示専用**とし、承認ゲート無しに `glossary`/`examples`/プロンプトへ流さない（§2 の R-SEC-1 を継承） |
| R-W8 | 独自キャッシュ（TTL 付き・glossary の 2 KB 枠とは別建て）でリクエストを抑える |
| R-W9 | CC-BY-SA のため、出典記事へのリンクと帰属表示を添える |

## 14. 判定（追補）

| 項目 | 判定 |
|---|---|
| データソースを Fandom → **ja Wikipedia** に差し替え | ✅ 明確に優れる。要約 API・プレーンテキスト・CORS・キー不要 |
| Wikipedia 単独での解説ポップアップ | △ カバレッジ 42〜50%。**半分は表示されない**。R-W3 の検証は必須 |
| Wikipedia＋LLM の二層（§12） | ✅ **現実的に最も有望**。カバレッジ問題を追加ソースなしで解決 |
| Comic Vine / Marvel 公式 API | ❌ キー・レート制限・英語のみ |
| Wikidata | △ 解説用途は不可。訳語正規化の補助としてのみ |
| Marvel/DC 判定 | 変更なし。検索の文脈語としてシリーズ名が要るため、§3 の手動タグ付けが前提 |

---

# 追補2（同日）— 出版社別 API ルーティングの評価

「Marvel 公式 API / DC 公式 API を場合分けで使う」案を実測検証した。

## 15. 結論（追補2）

**分岐先の両方が存在しない。**

- **DC 公式 API は存在したことがない**（`developer.dccomics.com` / `api.dccomics.com` はドメイン解決せず＝ `000`）
- **Marvel 公式 API は稼働していない**（`developer.marvel.com` は全パスが `www.marvel.com` へ 301、`gateway.marvel.com/v1/public/*` は `500`）

ただし**多層化という発想自体は正しい**。誤っているのは分岐軸で、「出版社別」ではなく「**取得成否によるフォールスルー**」にすべき（§18）。

## 16. 実測（2026-07-27）

| URL | 結果 |
|---|---|
| `https://developer.marvel.com/` | **301 → https://www.marvel.com/** |
| `https://developer.marvel.com/documentation/authorization` | **301 → https://www.marvel.com/**（認証仕様書が消滅） |
| `https://developer.marvel.com/docs` | **301 → https://www.marvel.com/** |
| `https://gateway.marvel.com/v1/public/characters?name=Hulk` | **HTTP 500** `{"message": "Internal server error"}` |
| `https://gateway.marvel.com/v1/public/comics` | **HTTP 500** |
| `https://developer.dccomics.com/` | `000`（名前解決せず） |
| `https://api.dccomics.com/` | `000`（名前解決せず） |
| `https://www.dccomics.com/api/` | `301`（API ではない） |

Marvel は 401（認証エラー）ではなく **500** を返す。開発者ポータルの消滅と合わせ、サービス終了と判断できる（2026年7月中旬に "Marvel API Is Dead" の第三者記事あり）。

### 仮に生きていたとしても採用できない理由

`manifest.json` の説明文は **「自分のAPIキーを使うので外部サーバーなし」**。これがストア掲載上の約束であり、Marvel API のキー管理はこれと両立しない：

| 方式 | 問題 |
|---|---|
| 開発者のキーを拡張に埋め込む | 拡張のコードは誰でも読める。全ユーザーで日次上限を共有し、容易に盗用される |
| プロキシサーバーを立ててキーを保持 | **「外部サーバーなし」に真っ向から反する** |
| ユーザー各自に Marvel キーを登録させる | 翻訳用キーに続く 2 本目の登録負担。得られるのは英語の説明文（しかも公式ドキュメントが空値を認めている） |

## 17. 認証不要の第三の選択肢 — akabab/superhero-api

Marvel/DC 双方を含む、認証不要の静的 JSON API。実測：

| 項目 | 値 |
|---|---|
| 件数 | 563（Marvel 269 / DC 155 / Dark Horse 15 ほか） |
| 認証 | 不要 |
| 形式 | 静的 JSON（GitHub Pages）。`all.json` = **917 KB** |
| ライセンス | **MIT**（再配布可） |
| 最終更新 | 2024-02-26（アーカイブはされていない） |
| Wikipedia が外した語の補完 | **Sentry / Zatanna / Moon Knight をカバー**（6件中3件） |
| 欠落 | Booster Gold / Squirrel Girl（鮮度の問題の可能性） |

**ただし解説文（散文）のフィールドが無い。** 実際のデータ構造は `powerstats` / `appearance` / `biography` / `work` / `connections` / `images` で、得られるのは属性の集合：

```
セントリー — 本名: Robert Reynolds ／ 初登場: Sentry #1 (2000)
              所属: New Avengers ほか ／ 出版社: Marvel Comics
```

つまり **「Wikipedia ライクな解説」ではなく「属性カード」**。別種の UX であり、当初の要望をそのまま満たすものではない。

2 つの制約：

- **英語キー**。§5 の前提（訳文＝日本語側の固有名詞にポップアップ）と噛み合わせるには英語の原語が必要。glossary は原語→訳語を保持しているので**用語集登録済みの語には使えるが、任意の検出語には使えない**。
- MIT なので **917 KB を拡張に同梱してオフライン動作**させられる（Ollama 対応という製品性格とも合う）。ただしパッケージサイズ増と、データが 2024-02 で止まる点は許容判断が要る。

## 18. 正しい分岐軸 — 出版社ではなく取得成否

出版社別ルーティングは「Marvel か DC か」の判定を前提にするが、§3 の結論はそれが**手動タグ付けを要する未実装機能**だということ。未着手の作業への依存が増える。

取得成否によるフォールスルーなら出版社を知る必要がない：

```
固有名詞
  ├─ ① ja Wikipedia：type=standard かつ本文に語が含まれる → 採用（出典リンク付き）
  ├─ ② akabab：glossary に原語がある語のみ → 属性カード表示
  └─ ③ LLM（既存キー）：一行解説を生成 →「AI 生成」と明示
```

各段は失敗時のフォールスルーであり、出版社による分岐ではない。§12 の二層案に ② を挟んだ形。

## 19. 判定（追補2）

| 項目 | 判定 |
|---|---|
| DC 公式 API を使う | ❌ **存在しない**（ドメイン未解決） |
| Marvel 公式 API を使う | ❌ **稼働していない**（ポータル 301・API 500）。仮に生きていても「外部サーバーなし」と両立しない |
| 出版社別ルーティング | ❌ 分岐先が無く、かつ未実装の Marvel/DC 判定に依存する |
| **多層化の発想** | ✅ **正しい。** ただし分岐軸は取得成否（§18） |
| akabab を第2段に追加 | ○ 認証不要・MIT・Wikipedia の穴を一部埋める。ただし解説文ではなく属性カード、かつ glossary 登録語に限る |

---

# 追補3（同日）— 「何をして、どんな能力があるキャラか」を出せるか

「属性カードでは何者か分からない」との指摘を受け、各ソースが**能力・役割**の情報を持つか実測した。

## 20. 指摘は実測で裏付けられた

### 20.1 導入節（`exintro`）は書誌情報しか書いていない

§9 で採用予定だった `api/rest_v1/page/summary` の `extract`（＝導入節）の実際の中身：

| 語 | 導入節の内容 |
|---|---|
| ナイトクローラー | 「レン・ウェインとデイブ・クックラムによって創られ、『Giant-Size X-Men』#1（1975年5月）に初登場」＋**クックラムがレギオン用にデザインした経緯** |
| ヴィジョン | 「『The Avengers』#57（1968年10月）で初登場したアベンジャーズのメンバー」 |
| デスストローク | 「マーブ・ウルフマンとジョージ・ペレスによって創造され、1980年の "New Teen Titans #2" で初登場」 |

**テレポート能力にも、ヴィブラニウム製の体にも、一言も触れていない。** 日本語 Wikipedia の導入節は「作中人物の説明」ではなく「出版物としてのメタ情報」を書く構成になっている。読者が知りたい「何ができるキャラか」は導入節に無い。

### 20.2 akabab の powerstats も答えになっていない

```
Nightcrawler: {"intelligence":50,"strength":10,"speed":47,"durability":14,"power":76,"combat":80}
              work.occupation: "Adventurer, Teacher"
Sentry:       work.occupation: "-"
```

数値と職業だけで、**「テレポートする」という質的な能力が無い**。§17 の属性カード案は、指摘のとおり要求を満たさない。

## 21. 解決策 —— 能力節はプレーンテキストのまま取れる

`prop=extracts&explaintext` から **`exintro` を外す**と全文がプレーンテキストで返り、節見出し（`== 能力 ==`）ごと取得できる。**HTML パースは不要のまま**（§2 の R-SEC-3 は復活しない）。

実際に抽出できた内容：

| 語 | 節 | 抽出結果 |
|---|---|---|
| ナイトクローラー | 能力とパワー | 「最も優れた能力は自分自身に加えていくらかの体積をある場所から別の場所へテレポートさせるもの…最大で2キロメートル」 |
| ヴィジョン | 能力 | 「ヴィブラニウム製ボディ…空中浮揚・高速飛行能力／エネルギービーム」 |
| ハルク | 能力 | 「マーベルヒーローでも屈指の筋力（限界がほとんどないとされたり次元や物理法則を突破することも）」 |
| ドクター・ドゥーム | 能力 | 「最も危険な武器はマーヴェル・ユニバースでも屈指の知能…ロボット工学・遺伝…」 |
| デスストローク | 能力 | 「近接格闘術・マーシャルアーツ・射撃能力・剣術などを使った圧倒的な戦闘能力／優れた戦術家」 |

**これは求められていた情報そのもの。**

## 22. ただし生出しは外れる（節見出しの揺れ）

8 件で能力系見出しを全列挙した結果：

| 語 | 見出し | 問題 |
|---|---|---|
| ヴィジョン / ハルク / ドゥーム / デスストローク / ワスプ | `能力` | ─（ただしヴィジョンの中身は MCU 版の説明） |
| ナイトクローラー | `特徴` と **`能力とパワー`** | 先頭マッチだと「特徴」＝**外見描写**（青黒い毛皮、2本の指…）を拾う |
| スパイダーマン | `能力（サム・ライミ版）` `能力（マーク・ウェブ版）` `能力（MCU版）` | **素の「能力」節が存在しない。全て映画版** |
| ロビン | なし | 複数キャラ統合記事のため節が無い |

**節選択ルール**（実測から導出）：

1. 「能力」を含む見出しを「特徴」より優先 → ナイトクローラーが救われる
2. 括弧付き（〜版）・映画/ドラマ/ゲーム名を含む見出しは後回し
3. 素の能力節が無い場合（スパイダーマン）は、映画版である旨を明示する

**結果：クリーンに取れる 6/8、映画版のみ 1/8、取得不可 1/8。**

## 23. 推奨構成 —— Wikipedia 能力節を LLM に要約させる（RAG）

生出しは §22 の汚染があり、LLM 単独生成は幻覚が出る。**両者を組み合わせるのが最も筋がよい**：

```
固有名詞（glossary 登録語に限定）
  │
  ├ ① ja Wikipedia 全文を explaintext で取得（バッチ）
  ├ ② クライアント側で能力節を正規表現抽出 → 1〜2 KB に切り詰め
  ├ ③ 抽出テキストのみを LLM に渡して一行に要約させる
  └ ④ 生成された一行（〜100字）をキャッシュし、出典リンクを添えて表示
```

- **幻覚が抑えられる**（ソースがある＝生成ではなく要約タスク）
- 節冒頭の外見描写や映画版混入を LLM 側で処理できる
- 日本語で簡潔に揃う
- 出典を示せる（CC-BY-SA の帰属要件も満たす）

## 24. セキュリティ要件の修正（R-SEC-1 の改訂）

§2 の R-SEC-1 は「取得文を**プロンプトへ**流さない」と書いたが、§23 はこれに抵触する。改訂する：

> **R-SEC-1（改訂）**: Wikipedia 由来テキストを**翻訳プロンプトに流すことは禁止**。解説生成用の**独立したプロンプト**に渡すことは可とするが、以下を必須とする。

| ID | 要件 |
|---|---|
| R-SEC-1a | 解説生成は**翻訳とは別の LLM 呼び出し**とする。`buildSeriesPromptSection` には一切合流させない。注入が起きても汚染範囲はポップアップ 1 件に限定される |
| R-SEC-1b | プロンプト投入前に既存の `escapeDelimiters`（`utils/nano-extract.js`）を適用する。新しいサニタイザは作らない |
| R-SEC-1c | 生成結果は表示専用。承認ゲート無しに `glossary` / `examples` へ入れない（従来どおり） |

## 25. 実装要件（§13 からの差分）

| ID | 要件 |
|---|---|
| R-W2'（改訂） | `exintro` は**使わない**。全文 `explaintext` を取得し、**節抽出はクライアント側**で行う。LLM には抽出後の 1〜2 KB のみ渡す（記事全文は渡さない。スパイダーマンは 63 KB ある） |
| R-W8'（改訂） | キャッシュ対象は**生成された一行解説**（〜100字）であり記事本文ではない。glossary の 2 KB 枠とは別建て |
| R-W10 | 解説生成は**バッチ**で行う（N 語を 1 回の呼び出しで） |
| R-W11 | hover 時に fetch＋LLM を走らせると数秒かかる。**翻訳完了時に glossary 登録語ぶんを先行生成**しておく（既存の prefetch 機構と同じ発想） |
| R-W12 | 対象を **glossary 登録語に限定**する。呼び出し回数が有界になり、akabab の英語キー問題（§17）とも整合する |

## 26. 判定（追補3）

| 項目 | 判定 |
|---|---|
| 導入節（`exintro`）で「何者か」を出す | ❌ 書誌情報のみ。能力は書かれていない |
| akabab の属性カード | ❌ 数値と職業のみ。質的な能力が無い |
| **Wikipedia の能力節を抽出** | ✅ **取得可能・プレーンテキストのまま**。クリーン 6/8 |
| 能力節をそのまま表示 | △ 外見描写・映画版の混入あり（§22） |
| **能力節を LLM に要約させる** | ✅ **推奨。** 幻覚を抑えつつ汚染も処理でき、出典も示せる |

---

# 追補4（同日）— 公式サイト（marvel.com / dc.com）のスクレイピング評価

## 27. 結論（追補4）

**「正確」は実測で裏付けられた。「速い」は逆だった。**

- ✅ 公式サイトは**構造が統一**されており、Wikipedia の節名揺れ（§22）が起きない
- ✅ **注入リスクが Wikipedia より低い**（出版社管理下＝第三者が編集できない）
- ❌ **転送量が 20〜50 倍**。バッチ取得もできない
- ❌ 英語のみ → LLM 依存は消えない
- ⚠️ **ToS が未確認**。これは判断を仰ぎたい

## 28. 実測 —— 公式サイトは「能力」を明示的に持つ

| URL | HTTP | 可視テキスト | 内容 |
|---|---|---|---|
| `dc.com/characters/batman` | 200 | **17,805 字**（SSR） | `OFFICIAL CHARACTER PROFILE` ＋ **`POWERS AND ABILITIES` 節が明示的に存在** |
| `marvel.com/characters/hulk-bruce-banner` | 200 | 1,452 字 | 概要1文のみ。本文は別ページ |
| `marvel.com/characters/hulk-bruce-banner/in-comics` | 200 | **15,244 字** | タイトル「In Comics Powers, Villains, Weaknesses」＋ `Biography` 節 |

DC の実際の出力：

> **POWERS AND ABILITIES** — Batman does not have any metahuman abilities. Instead, he relies on his sharp mind and disciplined body, as well as his extensive combat and detective training. A master of virtually every form of ma...

**これは Wikipedia の導入節に無かった情報そのもの。** しかも公式サイトは節構造が統一されているため、§22 で問題になった「特徴／能力とパワー／能力（サム・ライミ版）」のような見出し揺れが起きない。セレクタ1つで済み、ヒューリスティックが要らない。**指摘のとおり、精度では公式が勝る。**

### セキュリティ評価の訂正

§2 の表で「第三者が自由編集できる wiki」を最大のリスクとしたが、**公式サイトにはこれが当てはまらない**。marvel.com / dc.com は出版社の管理下にあり、第三者が本文を書き換えられない。本評価を通じて支配的だった注入リスクは、**Wikipedia より公式サイトの方が低い**。R-SEC-3（HTML パース）は復活するが、相手は敵対的でないソースになる。

## 29. ただし「速い」は成り立たない

| | ja Wikipedia | 公式サイト |
|---|---|---|
| 1 語あたり転送量 | **8〜16 KB**（プレーンテキスト） | **168 KB**（Marvel）/ **389 KB**（DC）の HTML |
| バッチ取得 | ✅ `exlimit=20` で **20 語を 1 リクエスト** | ❌ **1 語 1 ページ。バッチ不可** |
| Marvel の能力情報 | ─ | `/characters` と `/in-comics` で **2 リクエスト必要** |

**固有名詞が 20 個あるページで、Wikipedia は 1 リクエスト。公式サイトは 20〜40 ページ・数 MB。** 転送量で 20〜50 倍の差がある。

「正確性では公式、取得コストでは Wikipedia が桁違いに有利」——トレードオフは実在するが、速度に関しては想定と逆になる。

## 30. 英語のみ → LLM 依存は消えない

両サイトとも英語。§5 の前提（訳文＝日本語側の固有名詞にポップアップ）と噛み合わせるには翻訳が要る。つまり §23 のパイプライン形状は変わらず、**LLM の役割が「要約」から「翻訳＋要約」に変わるだけ**。「公式だから正確」はソースの質の話であり、LLM 呼び出しを不要にはしない。

## 31. 未検証項目 —— ToS（判断を仰ぎたい点）

| 項目 | 状態 |
|---|---|
| `marvel.com/robots.txt` | 実質空（明示的な制限なし） |
| `dc.com/robots.txt` | `Disallow: /search*` ＋ **`User-agent: GPTBot` → `Disallow: /`** |
| 両サイトの利用規約 | **未読** |

dc.com は AI クローラーを明示的に拒否している。Doug はクローラーではなくユーザー操作起点の拡張なので GPTBot には該当しないが、**Chrome Web Store で配布する拡張が Disney / WBD の資産をスクレイピングする**という構図であることは事実。これは技術判断ではなく自社製品の法務・ポリシー判断なので、こちらで結論を出さずに委ねる。

## 32. スラッグ解決は解決済み

| サイト | 手段 | 状態 |
|---|---|---|
| DC | `https://www.dc.com/merged.sitemap.dc.xml` | ✅ 200（robots.txt が公開） |
| Marvel | `https://www.marvel.com/sitemap.xml` | ✅ 200 |

キャラクター URL の一覧を取得してキャッシュできる。「固有名詞 → slug」の解決は障害にならない。

なお **DC は Next.js（`__NEXT_DATA__` あり）** で構造化データが HTML に埋め込まれており、パースはさらに容易。

## 33. 構造的な脆さ

スクレイピングは API 契約と違い、**マークアップ変更で無言で壊れる**。Wikipedia API は後方互換の契約があるが、公式サイトのリニューアルは予告なく起きる。しかも配布済みの拡張は即座に修正を届けられない。運用負担として記録しておく。

## 34. 推奨構成 —— 既定は Wikipedia、公式は補完

3 つのソースが異なる失敗様式を持つので、役割を分ける：

```
glossary 登録語
 ├ ① ja Wikipedia（explaintext → 能力節抽出 → LLM 要約）   ← 既定
 │    安価・日本語・API 契約が安定・バッチ可
 └ ② 公式サイト（①が能力節を取れない / 映画版しか無い語）   ← 精度の補完・要 ToS 確認
      正確・構造統一・注入リスク低／重い・英語・法務未確認
```

§22 で Wikipedia が失敗した語——**ロビン（節が無い）、スパイダーマン（映画版のみ）**——は、まさに ② がコストに見合う対象。Wikipedia が誤る約 25% にのみ高コスト・法務未確認の経路を使うのは妥当だが、全語に使うのは正当化しにくい。

## 35. 判定（追補4）

| 項目 | 判定 |
|---|---|
| 公式サイトの精度・構造の統一 | ✅ **Wikipedia より優れる**（`POWERS AND ABILITIES` が明示的に存在） |
| 注入リスク | ✅ **Wikipedia より低い**（出版社管理下）。§2 の懸念は公式サイトには当てはまらない |
| 「速い」 | ❌ **逆**。転送量 20〜50 倍・バッチ不可 |
| LLM 依存の解消 | ❌ 英語のみのため解消しない（要約→翻訳＋要約に変わるだけ） |
| slug 解決 | ✅ sitemap で解決済み |
| ToS | ⚠️ **未確認。判断を仰ぎたい** |
| **推奨** | **既定は Wikipedia、Wikipedia が外す語のみ公式サイトで補完**（§34） |

---

# 追補5（同日）— 利用規約の確認結果

§31 で未検証としていた ToS を、両社の原文で確認した。

## 36. 結論 —— 両社とも明示的に禁止。§34 の公式サイト案を撤回する

### Warner Bros.（dc.com）
出典: https://policies.warnerbros.com/terms/en-us/html/terms_en-us_1.5.1.html

**Section 10 — Code of Conduct:**

> "copy, reproduce, distribute, transfer, sell, license, publish, enter into a database, display, perform publicly, modify, create derivative works of, upload, edit, post, link to, frame, transmit, rent, lease, lend or sublicense, **scrape, crawl**, or in any way exploit any part of the Service"

> "copy, data mine, scrape or in any way extract any part of the Service or data **for the purpose of training any artificial intelligence algorithm**"

> "use the Service for any **commercial purposes**"

**Section 3 — The Warner Service:**

> "Any authorization to copy material granted by Warner in any part of the Service for any reason is restricted to viewing a single copy for **non-commercial, personal, entertainment use only**"

`scrape, crawl` は目的を問わず全面禁止であり、AI 学習目的の条項とは**別に**規定されている。

### Disney（marvel.com）
出典: https://disneytermsofuse.com/japanese/ ・ https://disneytermsofuse.com/english/

**セクション 2.B — Disneyサービスの利用に関する制限:**

> 「**ロボット、スパイダー、スクレーパー又はその他自動化された手段により、Disneyサービスへのアクセス、モニター、コピー又は抽出**（疑義を避けるために明記しますと、これには**AIツールの作成若しくは開発、データマイニング若しくはウェブスクレイピング**又はその他データ、データセット若しくはデータベースのコレクション…）」

**セクション 2.A — お客様のライセンス:**

> 「人工知能又は機械学習ツール、モデル、システム、アルゴリズム、製品又はその他技術（「**AIツール**」）の**使用**、作成、開発、変更、促進、ファインチューニング、トレーニング、テスト、ベンチマーク又は検証に関連する…」

**セクション 3.H — 商業・マーケティング・ブランディング目的での利用禁止**

## 37. Doug に当てはめた場合

| 条項 | Doug の該当性 |
|---|---|
| 自動化手段によるアクセス・抽出の禁止 | **該当する。** 拡張が自動で fetch し本文を抽出する行為そのもの |
| AI ツールでの利用の禁止 | **該当する。** 抽出文を LLM に渡す設計（§23）が Disney 条項の「AIツールの**使用**」に当たる。学習させないから可、とは読めない |
| 商業利用の禁止 | **該当しうる。** Chrome Web Store で配布する製品であり、無料でも "commercial or business-related use" と解される余地が大きい |
| 個人・非商業の単一コピー閲覧のみ許諾（WB） | 拡張による自動取得はこの範囲を超える |

**§34 で「Wikipedia が外す語のみ公式サイトで補完」と推奨したが、これを撤回する。** 規約の文言は解釈の余地が小さく、Doug の設計は複数の条項に正面から該当する。

## 38. 修正後の推奨構成

```
glossary 登録語
  ├ ① ja Wikipedia（explaintext → 能力節抽出 → LLM 要約）  ← 唯一の外部ソース
  └ ② ①が能力節を取れない語（ロビン / スパイダーマン等 約25%）
        → 解説を出さない、または LLM 単独生成に「AI 生成」と明示して委ねる
```

§22 で Wikipedia が失敗した約 25% は、公式サイトでは埋められない。**埋めないか、LLM 単独生成（幻覚リスクあり・出典なし）で補うかの二択**になる。

CC-BY-SA の Wikipedia と、akabab（MIT）は再配布・改変が許諾されており、この制約を受けない。

## 39. 判定（追補5）

| 項目 | 判定 |
|---|---|
| dc.com のスクレイピング | ❌ **ToS で明示的に禁止**（`scrape, crawl` を目的を問わず禁止） |
| marvel.com のスクレイピング | ❌ **ToS で明示的に禁止**（自動化手段によるアクセス・抽出、AI ツールでの使用） |
| 公式サイトを補完ソースとする §34 案 | ❌ **撤回** |
| ja Wikipedia（CC-BY-SA） | ✅ 制約なし。唯一の実用的な外部ソース |
| akabab（MIT） | ✅ 制約なし。ただし質的な能力情報は無い（§20.2） |

---

# 追補6（同日）— 他データベースの探索

## 40. 結論 —— 見落としがあった。**英語版 Wikipedia** が最良

外部 DB を広く当たった結果、最も有効なソースは新規の DB ではなく、**これまで検討していなかった英語版 Wikipedia** だった。日本語版の弱点をほぼ全て解消する。

### 実測（10 語・`en.wikipedia.org` / `prop=extracts&explaintext&redirects=1`）

| 語 | 節 | 結果 |
|---|---|---|
| Nightcrawler | `Powers and abilities` | 「teleports by displacing himself into an alternate dimension」 |
| Vision (Marvel Comics) | `Powers and abilities` | 「android body is originally a functioning replica of a human body」← **コミック版** |
| Deathstroke | `Powers and abilities` | 「experimental super-soldier serum that increased his physica…」 |
| **Squirrel Girl** | `Powers and abilities` | ✅ 日本語版に記事が無かった語 |
| **Sentry** | `Powers and abilities` | ✅ 同上 |
| **Zatanna** | `Powers, abilities, and resources` | ✅ 同上 |
| **Moon Knight** | `Powers and abilities` | ✅ 同上 |
| **Spider-Man** | `Powers, skills, and equipment` | ✅ **コミック版**（日本語版は映画版3種のみだった） |
| Booster Gold | ─ | ❌ 節構成が異なる |
| Robin (character) | ─ | ❌ 複数キャラ統合記事（日本語版と同じ理由） |

**成功 8/10。** 日本語版の 6/8 と比べ、質・量ともに上回る。

### 日本語版に対する優位点

| 課題（§22） | 英語版での状態 |
|---|---|
| 節名の揺れ（特徴／能力とパワー／能力（サム・ライミ版）） | `Powers and abilities` / `Powers, abilities, and resources` / `Powers, skills, and equipment` の 3 形だが、いずれも **`Powers` を含み単一の正規表現で拾える** |
| 映画版が混入する（スパイダーマン・ヴィジョン） | **コミック版が本文**。映画は別記事に分離されている |
| マイナーキャラの記事が無い（Squirrel Girl / Sentry / Zatanna / Moon Knight） | **全て存在する** |

### 代償

英語なので LLM による翻訳が必要。ただし §30 で確認したとおり **LLM 依存はどのみち消えない**（公式サイト案も英語だった）。パイプライン（§23）の形は変わらず、LLM の役割が「要約」から「翻訳＋要約」になるだけ。

## 41. 他に当たった DB（いずれも不採用）

| DB | 実測 / 状態 | 判定 |
|---|---|---|
| Comic Vine API | `HTTP 401 {"error":"Invalid API Key"}` | ❌ キー必須。§16 と同じ配布問題。加えて 200 req/h・英語 |
| Metron（metron.cloud） | `HTTP 401` | ❌ キー（アカウント）必須 |
| Superhero API（superheroapi.com） | トップは 200 だが API はトークン必須 | ❌ akabab の元データ。powerstats のみで質的能力なし（§20.2） |
| Grand Comics Database（GCD） | CC ライセンス・200 万号超 | △ **書誌カタログであってキャラ解説ではない**。用途が違う（シリーズ判定には使える可能性） |
| Kaggle の Marvel データセット | 静的ダンプ | ❌ ライセンス・出典・更新が不明 |
| DBpedia | Wikipedia の構造化版 | ❌ abstract は導入節と同一＝能力の記述が無い（§20.1 と同じ壁） |

**キー必須の DB は拡張に組み込めない**という制約が効く。開発者キーを埋め込めば盗用され、プロキシは「外部サーバーなし」に反し、ユーザーに登録させれば負担が増える（§16）。この点で**認証不要**という Wikipedia の性質は大きい。

## 42. 修正後の推奨構成

> ⚠️ **本節は §51 により更新された。** 「節が無い語は解説を出さない」は、Fandom をサブ参照に
> 加える決定（2026-07-27）により「Fandom の infobox フィールドで補う」に変わった。
> 最終的な構成は **§51 を参照**のこと。

```
glossary 登録語
  ├ ① en Wikipedia の能力節を抽出 → LLM が翻訳＋要約   ← 既定
  └ ② 節が無い（Booster Gold / Robin 等）→ 【§51 で更新】Fandom をサブ参照
```

**当初は「ja を先に当てて翻訳コストを省く」構成にしたが、撤回する。** §22 のデータでは、**最も参照される語ほど日本語版が汚染されている**：

- スパイダーマン：日本語版は `能力（サム・ライミ版）`『マーク・ウェブ版』『MCU版』のみ＝**コミック版の能力節が存在しない**
- ヴィジョン：日本語版は素の `能力` 見出しなのに**中身が MCU 版の説明**。見出しでは判別できない

ja 優先にすると、ヴィジョンで映画設定を無言で出すことになる —— Fandom を否定した「誤った情報は無情報より悪い」の再現。英語版にはこの罠がなく（`Vision (Marvel Comics)` → "android body is originally a functioning replica of a human body"）、LLM 呼び出しはどちらにせよパイプラインに存在するため、翻訳は追加の呼び出しではなくトークン増にとどまる。

**よって en を既定とし、ja は任意の最適化（または不採用）に降格する。**

- どちらも CC-BY-SA・認証不要・`exlimit=20` でバッチ可
- ToS の制約なし（§36 の問題を受けない）
- 残る欠落は複数キャラ統合記事（Robin）と節構成が特殊な記事（Booster Gold）のみ

## 43. 判定（追補6）

| 項目 | 判定 |
|---|---|
| **en Wikipedia** | ✅ **最良。** 8/10・節名統一・コミック版本文・認証不要・CC-BY-SA |
| ja Wikipedia | ✅ 併用価値あり（日本語記事がある語は翻訳コストを省ける） |
| Comic Vine / Metron / Superhero API | ❌ 認証必須。拡張に組み込めない |
| GCD | △ 書誌カタログ。キャラ解説には使えない |
| DBpedia / Kaggle | ❌ 能力情報が無い / 出自不明 |

---

# 追補7（同日）— 抽出ルールの欠陥（実装仕様の訂正）

## 44. §22 / §40 で使った正規表現には欠陥がある

当初の終端条件 `(?=^==|\Z)` は**深さを問わず次の見出しで終端する**。節の直後に小見出しがある記事では、本文が 1 文字も取れない。

実際、§40 で「✓」と数えた Sentry と Moon Knight は**抽出結果が空だった**（節は存在するのに直後が `=== … ===` だったため）。このまま実装すると、該当記事で**無言で空のポップアップが出る**。

### 修正した抽出ルール

**同じ深さ以下の見出しで終端する**必要がある：

```python
HEAD = re.compile(r'^(=+) *([^=\n]*(?:Powers|Abilities|Skills|Equipment)[^=\n]*?) *=+ *$', re.M)
m    = HEAD.search(extract)
lvl  = len(m.group(1))                                   # 見出しの深さ
nxt  = re.compile(r'^={2,%d} *[^=]' % lvl, re.M).search(extract, m.end())
body = extract[m.end() : nxt.start() if nxt else len(extract)]
```

### 修正後の実測

| 語 | 見出しレベル | 修正前 | 修正後 |
|---|---|---|---|
| Sentry (Robert Reynolds) | 2 | **0 字** | **860 字**「The Sentry's powers derive from a variant of the Super-Soldier Serum…」 |
| Moon Knight | 3 | **0 字** | **7,204 字**「Olympic-level athlete and a skilled acrobat who excels at combat strategy…」 |
| Nightcrawler | 3 | 1,903 字 | 1,903 字（変化なし） |

**§40 の 8/10 という成功数は正しい。ただしそれは修正後のルールを前提とする。**

## 45. 要件の追加・訂正

| ID | 要件 |
|---|---|
| **R-W2''**（R-W2' を訂正） | 能力節の終端は「**同じ深さ以下の見出し**」とする。深さを無視した終端は、小見出しを持つ記事（Sentry / Moon Knight 等）で本文を 0 字にする |
| R-W13 | 抽出結果が空または極端に短い場合は**ポップアップを出さない**（無言の空表示を防ぐ）。Moon Knight のように 7 KB を超える節もあるため、上限側の切り詰めも併せて行う |

---

# 追補8（同日）— Fandom 再評価：前回の判断は誤りだった

「Category:Characters は本当に使えないのか、英語→日本語翻訳前提でも」という問い直しを受けて再検証した。

## 46. 結論 —— 品質では最良。しかし到達できない

**前回 Fandom を否定した理由 1 は誤りだった。** `prop=extracts` が無いことを確認した時点で止め、**`prop=revisions` を試していなかった**。Wikipedia で行った「全文取得 → 節抽出」と同じことを Fandom で試していなかったことになる。

### 46.1 wikitext は取得でき、しかも Wikipedia より構造化されている

`action=query&prop=revisions&rvprop=content&rvslots=main` で wikitext が返る。Marvel Fandom のキャラページは **infobox の名前付きフィールド**として能力を持つ：

| ページ | フィールド | 内容 |
|---|---|---|
| Kurt Wagner (Earth-616) | `Powers` | 「Nightcrawler is a mutant with the following abilities: **{{Power\|Teleportation}}**: Ability to teleport himself, the clothes he is wearing, and within limits a certain amount of additional mass」 |
| 〃 | `Abilities` | 「**Master Acrobat:** Nightcrawler is an Olympic-class acrobat thanks to his flexible spine…」 |
| Peter Parker (Earth-616) | `Powers` | 「**Spider-Physiology:** Spider-Man possesses the proportionate powers of a spider…」 |
| 〃 | `Abilities` | 「**Indomitable Will:** …」 |

**Wikipedia より扱いやすい点**：

- `Powers` と `Abilities` が**別々の名前付きフィールド**。§22 の見出し名の揺れ（特徴／能力とパワー／Powers, skills, and equipment）が発生しない
- §44 で見つけた「見出しレベルによる終端」のバグ類型が**存在しない**（フィールド抽出なので）
- §22 の映画版混入も起きない（Earth-616 = コミック本編を明示的に指定するため）
- `{{Power|Teleportation}}` で**能力名が明示的にマークアップ**されている
- CC-BY-SA・認証不要・`api.php` は Cloudflare の影響を受けない（ブロックされていたのは `api/v1` のみ）

### 46.2 Category:Characters も取得できる

`action=query&list=categorymembers&cmtitle=Category:Characters` は正常に動作し、`continue` によるページングで全件走査できる。ただし内容は `'Lectron (Earth-12772)` `'Selka (Earth-928)` のようなあらゆるアースのマイナーキャラを含み、総数は数万件。

### 46.3 決定的な障害 —— コードネームから正典ページに到達できない

**Marvel Fandom はキャラページを「本名」で作る。** 「Nightcrawler」の記事は存在せず、正典は `Kurt Wagner (Earth-616)` にある。glossary が持つのはコードネーム（Nightcrawler）なので、そのままでは能力フィールドを持つページに届かない。

曖昧さ回避ページのリンクから Earth-616 の正典を拾えるか実測した結果：

| 検索語 | ページ内の Earth-616 リンク | 正典に到達したか |
|---|---|---|
| Nightcrawler | `Crawler (Earth-616)`, `Dark-Crawler (Earth-616)` | ❌ `Kurt Wagner (Earth-616)` が出ない |
| Spider-Man | `Alan Schmidt (Earth-616)`, `Anti-Spider Squad (Earth-616)`, `Armored Spider-Man…` | ❌ `Peter Parker` が出ない |
| Squirrel Girl | `Allene Green (Earth-616)`, **`Doreen Green (Earth-616)`** | ✅ 2 番目に正解 |
| Moon Knight | `Earth-616`（宇宙そのもの）, `Earth-6160`, `Earth-61610` | ❌ キャラですらない |

**4 件中 1 件しか解決できない。** リンクはアルファベット順で返るため、正典を選び出す手がかりが無い。

代替として `list=search` に `Earth-616` を足す方法があるが、§1.3 で実測したとおり Fandom の検索は `Sanji` に `Sanji Yamamoto (Earth-616)` を返すような精度であり、**誤った人物の能力を表示するリスク**が高い。「誤った情報は無情報より悪い」（§1.2）に抵触する。

### 46.4 転送量

`section=0` は効かない（ページ全体が 1 つの巨大テンプレートのため 100% が返る）。

| ページ | wikitext サイズ |
|---|---|
| Kurt Wagner (Earth-616) | 149,435 字 |
| Peter Parker (Earth-616) | 265,811 字 |
| Bruce Banner (Earth-616) | 346,511 字 |

Wikipedia（32〜63 KB）の **5〜10 倍**。ただし `titles=A|B|C` のバッチは効き、R-W8'/R-W11 により**生成後の一行解説（〜100 字）をキャッシュする**設計なので、重い取得は用語ごとに一度きり。公式サイト案（§29）と違い ToS の制約も無いため、サイズだけで失格にはならない。

### 46.5 Fandom 固有のリスク —— 最新設定を反映する

```
Bruce Banner (Earth-616) の Powers フィールド:
「Banner was recently separated from the Hulk and has been rendered powerless
  as a consequence of this.」
```

これは不具合ではなく Fandom の編集方針（**現在進行中の連載設定を追う**）である。百科事典的な通史を書く Wikipedia と対照的で、読者が 1970 年代の号を読んでいる場合、**時代が違ううえにネタバレになる**。Nightcrawler / Spider-Man は正常だったので普遍的ではないが、**どちらのケースかを拡張側で判別できない**。

この 1 点だけは Wikipedia の百科事典的な記述が明確に勝る。

## 47. 判定（追補8）

| 項目 | 判定 |
|---|---|
| 「Fandom には解説を返す手段が無い」（§0 理由1） | ❌ **撤回。** `prop=revisions` で構造化フィールドが取れる |
| データ品質・構造 | ✅ **Wikipedia より優れる**（Powers/Abilities が別フィールド、能力名がマークアップ済み） |
| 網羅性 | ✅ 数万件。Wikipedia が持たないマイナーキャラも収録 |
| ライセンス・認証 | ✅ CC-BY-SA・認証不要・ToS の制約なし |
| 転送量 | △ 150〜350 KB/件。キャッシュ前提なら許容範囲 |
| **コードネーム → 正典ページの解決** | ❌ **4 件中 1 件。これが決定的な障害** |
| 最新設定の反映（ネタバレ・時代違い） | ⚠️ 判別不能 |
| **総合** | **品質は最良だが到達手段が無い。** 名前解決が解ければ第一候補になり得る |

## 48. 名前解決が解けた場合の構成

もしコードネーム→本名の対応が別途得られるなら（例：英語版 Wikipedia の記事から本名を取得し、それを Fandom のページ名に使う）、Fandom は第一ソースになり得る：

```
glossary 登録語（コードネーム）
  ├ ① en Wikipedia で記事を引き、本名を取得        ← 名前解決
  ├ ② Fandom「<本名> (Earth-616)」の Powers/Abilities を取得
  ├ ③ 取れなければ en Wikipedia の Powers 節にフォールバック
  └ ④ LLM が翻訳＋要約 →「AI 生成」と出典を明示
```

ただしこれは **1 語につき 2 ソース・3 リクエスト**になり、複雑性は大きく増す。**まず §42（en Wikipedia 単独）で実装し、品質が不足した場合の拡張として保留する**のが妥当。

---

# 追補9（同日）— Fandom にスクレイピングは必要か

## 49. 技術的には不要。しかし規約上は同じ扱いになる

### 49.1 HTML スクレイピングは不要

§46 の検証は**すべて MediaWiki API 経由**であり、HTML を取得してパースする処理は一切していない。

| 経路 | 内容 |
|---|---|
| `api.php?action=query&prop=revisions&rvslots=main` | wikitext（構造化された infobox）を JSON で取得 |
| `api.php?action=query&list=categorymembers` | Category:Characters のメンバー一覧 |
| `api.php?action=query&prop=links` | ページ内リンク一覧 |

公式サイト（marvel.com / dc.com）で必要だった **HTML の DOM パースは発生しない**。返るのは JSON であり、その中の wikitext からテンプレート記法（`[[a|b]]` / `{{Power|X}}` / `{{Citation}}`）を除去する処理が要るだけ。これは正規表現で完結し、HTML パースより単純で、DOM sink も生まない。

### 49.2 robots.txt は API を明示的に許可している

`marvel.fandom.com/robots.txt` の実測：

```
User-agent: GPTBot
Disallow: /
User-agent: CCBot
Disallow: /

User-agent: *
Allow: /api.php?
Allow: /api.php?action=
Allow: /api.php?*&action=
```

**AI クローラー（GPTBot / CCBot / SemrushBot 等）は全面拒否だが、`api.php` は `User-agent: *` に対して明示的に Allow されている。** 公式サイトとは扱いが違う。

### 49.3 ただし利用規約は自動アクセスに書面許諾を求めている

Fandom の Terms of Use（`www.fandom.com/terms-of-use`）には以下の条項がある：

> "use any robot, spider, scraper or other automated means to access the Services for any purpose **without express written permission**"

> "use any robot, spider, site search and/or retrieval application, or other device to **scrape, extract, retrieve or index any portion of the content**"

> （AI/ML）"use or copy the content for the development of any software program, including, but not limited to, **training a machine learning or artificial intelligence (AI) system**"

> ⚠️ **出典の限界**: ToS 本文の直接取得は Cloudflare により拒否された（`www.fandom.com/terms-of-use` → HTTP 403 / WebFetch → 402）。上記は検索経由で得た引用であり、**原文での逐語確認ができていない**。採否を決める前に、ブラウザで本文を確認することを推奨する。

**robots.txt が `api.php` を Allow していても、ToS は「automated means」に書面許諾を要求している。** 技術的な許可（robots.txt）と契約上の許可（ToS）は別物であり、法的には後者が上位に立つ。

### 49.4 CC-BY-SA との関係

Fandom の記事本文は CC-BY-SA だが、これは**コンテンツの再利用ライセンス**であって**サービスへのアクセス方法の許諾ではない**。「CC-BY-SA だから自動取得してよい」とは言えない。この区別は Wikipedia でも同じだが、Wikipedia は別途 API 利用を明示的に認めている点が決定的に異なる（§49.5）。

### 49.5 Wikipedia との比較 —— ここが分かれ目

| | Wikipedia / Wikimedia | Fandom | marvel.com / dc.com |
|---|---|---|---|
| HTML スクレイピングの要否 | 不要（API） | 不要（API） | **必要** |
| robots.txt | API 許可 | **API を明示的に Allow** | dc.com は GPTBot 拒否 |
| ToS の自動アクセス条項 | **API 利用を公式に提供・推奨**（UA ポリシー遵守が条件） | **書面許諾を要求** | **明示的に禁止**（§36） |
| コンテンツライセンス | CC-BY-SA | CC-BY-SA | 全権利留保 |
| 本件での可否 | ✅ **問題なし** | ⚠️ **許諾が必要** | ❌ **不可** |

Wikimedia は API を公開インターフェースとして提供し、User-Agent ポリシーとレート制限に従う限り自動アクセスを想定している（§9 で 429 と UA 必須を実測済み）。**この点で Wikipedia だけが明確にクリーン。**

## 50. 判定（追補9）

| 問い | 答え |
|---|---|
| Fandom に HTML スクレイピングは必要か | ❌ **不要。** MediaWiki API で JSON が取れる |
| では規約上の問題は無いか | ⚠️ **ある。** ToS が自動アクセス全般に書面許諾を要求（原文未確認） |
| robots.txt はどうか | ✅ `api.php` を明示的に Allow。ただし ToS が上位 |
| 実務上の選択肢 | ① Fandom に許諾を申請する ② 使わない ③ Wikipedia で代替する |
| 推奨 | **§42（en Wikipedia 単独）を維持。** Fandom は許諾を得られた場合の将来拡張として保留 |

---

# 51. 確定した参照方針（本メモの結論・2026-07-27）

> **本節が本メモの最終結論であり、§0（Fandom 見送り）および §42（en Wikipedia 単独）の判定を上書きする。**

## 51.1 構成

```
glossary 登録語
  ├ ① メイン: en Wikipedia
  │    prop=extracts&explaintext（exintro なし）で全文を取得
  │    → Powers / Abilities 系の見出しを同レベル以下で終端して抽出（R-W2''）
  │    → LLM が翻訳＋要約 → 出典リンク付きで表示
  │    実測 8/10（§40）
  │
  └ ② サブ: Marvel Fandom / DC Fandom
       prop=revisions&rvslots=main で wikitext を取得
       → infobox の Powers / Abilities フィールドを抽出（§46.1）
       → ①が能力節を取れない語（Booster Gold / Robin 等）に適用
```

メインを Wikipedia とする根拠は、節見出しが `Powers` を含む形で一貫し（3 形あるが単一の正規表現で拾える）、コミック版の記述が本文であり、百科事典的な通史が書かれていること。サブを Fandom とする根拠は、`Powers` / `Abilities` が名前付きフィールドとして構造化されており、Wikipedia が収録しないマイナーキャラも網羅していること。

## 51.2 サブ（Fandom）の適用条件

以下は実測で判明済みの制約であり、実装前に解消が必要：

1. **名前解決が未解決。** Fandom はキャラページを本名で作るため（`Nightcrawler` → `Kurt Wagner (Earth-616)`）、glossary のコードネームでは到達できない。曖昧さ回避ページのリンク経由は **4 件中 1 件**しか解決できず使えない（§46.3）。§48 の経路（en Wikipedia から本名を取得 → `<本名> (Earth-616)` を引く）が候補だが**未検証**。
2. **最新連載状態が返ることがある。** `Bruce Banner (Earth-616)` の `Powers` は「ハルクと分離され無力化された」という現在の設定を返す（§46.5）。読者が旧作を読んでいる場合、時代違い・ネタバレになるが、**どちらのケースかを拡張側で判別できない**。
3. **ToS**: Fandom の利用規約は自動アクセスに書面許諾を要求している（原文未確認・§49.3）。サブ参照として使う前提で記録する。

## 51.3 実装順序

**メイン（Wikipedia）を先に実装する。サブ（Fandom）は §51.2-1 の名前解決を検証してからでないと着手できない。** これは慎重を期した保留ではなく依存関係であり、メインの実装は今すぐ着手できる。

## 51.4 継承する要件

| ID | 内容 |
|---|---|
| R-SEC-1a | 解説生成は翻訳とは別の LLM 呼び出し。`buildSeriesPromptSection` に合流させない |
| R-SEC-1b | プロンプト投入前に既存の `escapeDelimiters`（`utils/nano-extract.js`）を適用 |
| R-SEC-1c | 生成結果は表示専用。承認ゲート無しに `glossary` / `examples` へ入れない |
| R-SEC-2 | 描画は `textContent` のみ（content.js:1798 / 1816 / 2126 / 2147 の規律を継承） |
| R-W1 | 連絡先を含む User-Agent を必ず送る（無いと 429・§9 実測） |
| R-W2'' | 能力節の終端は「同じ深さ以下の見出し」（§44。深さ無視だと本文 0 字になる） |
| R-W8' | キャッシュ対象は生成された一行解説（〜100 字）。記事本文ではない。glossary の 2 KB 枠とは別建て |
| R-W10 | 解説生成はバッチで行う |
| R-W11 | 翻訳完了時に glossary 登録語ぶんを先行生成（hover 時の待ちを回避） |
| R-W12 | 対象は glossary 登録語に限定（呼び出し回数を有界にする） |
| R-W13 | 抽出結果が空・極端に短い場合はポップアップを出さない。長すぎる場合は切り詰める |
| ライセンス | Wikipedia・Fandom とも CC-BY-SA。出典リンクと帰属表示を添える |

---

# 52. 出力長の要件（ポップアップに収める）

## 52.1 入力側の切り詰めと、出力側の要約は別物

既存の R-W2'' / R-W13 は**入力側**（記事から抽出したテキストを LLM に渡すまで）の規定であり、**出力側**（LLM が生成する解説の長さ）は未規定だった。これを補う。

取得データの実測長：

| ソース | 対象 | 長さ |
|---|---|---|
| en Wikipedia | Moon Knight の `Powers and abilities` | **7,204 字** |
| 〃 | Nightcrawler の `Powers and abilities` | 1,903 字 |
| 〃 | Sentry の `Powers and abilities` | 860 字 |
| Fandom | Kurt Wagner (Earth-616) の `Powers` フィールド | 数百〜数千字 |

ポップアップに収まるのは **100 字前後**。**最大 70 倍の圧縮**が必要であり、単純な切り詰めでは文が途中で切れて読めない。**LLM による要約が必須**（これは §23 で決めた RAG 構成の主目的でもある）。

## 52.2 要件

| ID | 内容 |
|---|---|
| **R-W14** | 解説生成プロンプトで**出力文字数の上限を明示**する（日本語 80〜120 字程度）。「短く」ではなく具体的な字数で指定する |
| **R-W15** | 能力が複数ある語（Nightcrawler = テレポート＋空間知覚＋壁面歩行…）は、**主要な 1〜2 点に絞る**ようプロンプトで指示する。列挙させない |
| **R-W16** | 生成結果が上限を超えた場合は**文末（句点）で切る**。文の途中で切らない。再生成はしない（コストとレイテンシに見合わない） |
| **R-W17** | ポップアップの寸法は**既存のオーバーレイ UI（`content.css`）の作法に合わせる**。新しいサイズ体系を導入しない |
| **R-W18** | 生成結果は R-W8' のとおり**要約後の 100 字前後をキャッシュ**する。記事本文や抽出テキストは保存しない（ストレージ節約とプライバシーの両面） |

## 52.3 プロンプト設計の指針

- 入力：抽出した能力節（1〜2 KB に切り詰め済み。§25 の R-W2'）
- 出力：日本語 80〜120 字、主要な能力 1〜2 点、体言止めや箇条書きにしない（ポップアップ内で読みやすい平文）
- 英語ソース（en Wikipedia / Fandom）の場合は翻訳と要約を 1 回の呼び出しで同時に行う（§30）
- バッチ処理（R-W10）でも 1 語ごとに独立した出力になるよう、語ごとの区切りを明示する
