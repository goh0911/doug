// utils/publishers.js — 出版社の判定（chrome.* 非依存）
//
// Wikipedia（導入節の "published by …" から推測）と Comic Vine（publisher フィールドを
// そのまま照合）の 2 経路から使うため、表を 1 箇所に置く。
// 元は utils/wiki-source.js にあり、同ファイルから再エクスポートして API を保っている。

/**
 * 既知の出版社。ホスト名と、導入節の "published by …" に現れる表記の対応。
 * 旧社名・傘下レーベルも同じ出版社として扱う（Timely / Atlas は Marvel の前身、
 * Vertigo / Wildstorm は DC のインプリント）
 */
export const PUBLISHERS = [
  { key: 'marvel', hosts: ['marvel.com'], pattern: /marvel|timely|atlas\s+comics/i },
  { key: 'dc', hosts: ['dc.com', 'dcuniverseinfinite.com', 'readdc.com'], pattern: /\bDC\b|vertigo|wildstorm/i },
  { key: 'archie', hosts: ['archiecomics.com'], pattern: /archie\s+comics/i },
  { key: 'image', hosts: ['imagecomics.com'], pattern: /image\s+comics/i },
  { key: 'darkhorse', hosts: ['darkhorse.com'], pattern: /dark\s+horse/i },
  { key: 'idw', hosts: ['idwpublishing.com'], pattern: /\bIDW\b/i },
  { key: 'boom', hosts: ['boom-studios.com'], pattern: /boom!?\s+studios/i },
  { key: 'dynamite', hosts: ['dynamite.com'], pattern: /dynamite\s+entertainment/i },
  { key: 'valiant', hosts: ['valiantentertainment.com'], pattern: /valiant\s+(?:comics|entertainment)/i },
  // 日本の出版社はまとめて 1 つの鍵にする。Viz は集英社作品を英語版として出しており、
  // 記事の表記も揺れるため、社ごとに分けると同じ作品で誤って矛盾扱いになる
  { key: 'manga', hosts: ['viz.com', 'shonenjump.com', 'shueisha.co.jp', 'kodansha.us', 'kodanshacomics.com'],
    pattern: /shueisha|kodansha|shogakukan|\bviz\s+media/i },
  // 廃業した出版社。閲覧サイトは存在しないので検出専用
  { key: 'charlton', hosts: [], pattern: /charlton\s+comics/i },
];

/**
 * 閲覧中のホストから期待される出版社キーを返す。未知なら null（条件を課さない）。
 * @param {string} host location.hostname 相当
 * @returns {string|null}
 */
export function expectedPublisher(host) {
  const h = String(host ?? '').toLowerCase().trim();
  if (h === '') return null;
  for (const p of PUBLISHERS) {
    // 完全一致かサブドメイン一致のみ。marvel.com.example.net を通さない
    if (p.hosts.some((d) => h === d || h.endsWith(`.${d}`))) return p.key;
  }
  return null;
}

/**
 * 出版社名の文字列（Comic Vine の publisher.name 等）から出版社キーを引く。
 * 該当しなければ null。
 *
 * Wikipedia 側は導入節から推測するしかないが、Comic Vine は publisher を
 * 構造化フィールドで返すため、こちらは表記をそのまま照合できる。
 * 実測（2026-08-04）で返る表記の例:
 *   "Marvel" / "DC Comics" / "Lion Forge Comics" / "Valiant/Acclaim" / "Bongo"
 *
 * @param {string} name
 * @returns {string|null}
 */
export function matchPublisherKey(name) {
  const s = String(name ?? '').trim();
  if (s === '') return null;
  for (const p of PUBLISHERS) {
    if (p.pattern.test(s)) return p.key;
  }
  return null;
}

/**
 * 導入節が名乗る出版社が、期待する出版社と食い違うか。
 *
 * 実測（2026-07-31）: "REGGIE" comics → Reggie Mantle（Archie Comics）が
 * ゲートを通り、Immortal Hulk の「レジー」の解説として表示されていた。
 * 別宇宙の同名キャラを落とすのがこの条件の目的。
 *
 * 記載が無い場合は却下しない。必須にすると S.H.I.E.L.D.（組織）や
 * Gamma Base（場所）のように出版社を書かない記事が軒並み消える。
 *
 * @param {string} intro
 * @param {string|null} publisher expectedPublisher の戻り値
 * @returns {boolean}
 */
export function publisherConflicts(intro, publisher, title = '') {
  if (!publisher) return false;
  const expected = PUBLISHERS.find((p) => p.key === publisher);
  if (!expected) return false;

  // タイトルの曖昧さ回避括弧が出版社を名乗る場合（Captain Marvel (DC Comics)）は
  // そこを最優先で見る。導入節が出版社に触れない記事でも別宇宙を弾ける
  const paren = String(title ?? '').match(/\(([^)]*)\)/);
  if (paren) {
    const other = PUBLISHERS.find((p) => p.key !== publisher && p.pattern.test(paren[1]));
    if (other && !expected.pattern.test(paren[1])) return true;
  }

  // 「最初の published by だけを見る」と、共同出版のキャラクターを誤って落とす。
  // 期待出版社が導入節のどこかに現れるなら矛盾なしとする
  const text = String(intro ?? '');
  if (expected.pattern.test(text)) return false;

  // 「originally published by X」は来歴であって現在の帰属ではない。ここで却下すると
  // 移管キャラクターの解説が出なくなる（実記事: Peter Cannon, Thunderbolt の導入節は
  // "originally published by Charlton Comics" のみで、後の DC には触れていない）。
  // 一方 Reggie Mantle は "published by Archie Comics" と現在形なので却下対象のまま
  const current = text.replace(/\b(?:originally|formerly|initially|first)\s+published by[^.;]*/gi, ' ');

  // 期待出版社がどこにも現れず、別の既知出版社を現在の帰属として名乗っているときだけ却下する。
  // 出版社に一切触れない記事（組織・場所など）は従来どおり通す
  return PUBLISHERS.some((p) => p.key !== publisher && p.pattern.test(current));
}
