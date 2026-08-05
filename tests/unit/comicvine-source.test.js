// tests/unit/comicvine-source.test.js — utils/comicvine-source.js の単体テスト
//
// フィクスチャは 2026-08-04 に実際の Comic Vine API から取得した応答をそのまま使う
// （docs/plans/2026-08-04-fandom-subsource-feasibility.md §5.1b）。
// 素の検索は 12 語中 5 語が誤答するため、ゲートで落とせることを実データで担保する。

import { describe, it, expect } from 'vitest';
import {
  COMICVINE_ORIGIN,
  SOURCE_ID,
  buildSearchUrl,
  parseSearchResponse,
  decodeEntities,
  passesGate,
  pickBestResult,
  toMaterial,
} from '../../utils/comicvine-source.js';

// ── 実測フィクスチャ（limit=5・field_list=name,deck,resource_type,publisher）──
const R = (name, publisher, deck, type = 'character') => ({
  name, deck, resource_type: type,
  publisher: publisher === null ? null : { name: publisher },
  site_detail_url: `https://comicvine.gamespot.com/${name.toLowerCase().split(' ').join('-')}/4005-0/`,
});

const FIXTURES = {
  ABOMINATION: [
    R('Abomination', 'Lion Forge Comics', 'Massive creature from the planet Krell that battles the Voltron Force.'),
    R('Abomination', 'Marvel', 'Craving for the power of a Hulk, Emil Blonsky purposely exposed himself to gamma radiation and became a monster.'),
    R('Rick Jones', 'Marvel', 'A scrappy, rebellious orphan, Rick Jones stumbled into the gamma bomb test site.'),
    R('Frankenstein', 'DC Comics', 'The hero known as Frankenstein is the actual legendary monster of Mary Shelley fame.'),
    R('Tyrannus', 'Marvel', 'This telepathic immortal roman emperor is as ruthless as they come.'),
  ],
  DOOM: [
    R('Doom', 'DC Comics', 'He extorted wealthy men by threatening to destroy their mansions unless their property was signed over.'),
    R("T'Channa", 'Marvel', "T'Channa is T'Challa's sister in Mangaverse."),
    R('Doctor Doom', 'Marvel', 'The very mention of his name makes lesser men tremble! Victor von Doom rules Latveria.'),
    R('Doom Marine', 'Company-Licensed', 'The lone soldier that descended into the depths of Hell.'),
    R('Amanda Von Doom', 'Marvel', 'A government agent in charge of the Mad Squad.'),
  ],
  WALT: [
    R('Walt', 'Bongo', "Mom's eldest son."),
    R('Walt', 'Guǎngdōng New Century', "The Loud's pet bird named after cartoonist Walt Kelly."),
    R('Walt', 'Le Lombard', null),
    R('Walt', 'Marvel', null),
    R('Walt', 'Conundrum Press', null),
  ],
  BANNER: [
    R('Banner', 'Valiant/Acclaim', 'Banner is a character in Bar Sinister. His genetic combinant: Badger.'),
    R('Banner', 'DC Comics', 'A flag wearing terrorist who fought Batman. A one shot villain.'),
    R('Nerd Hulk', 'Marvel', "Nerd Hulk is the odd result of Bruce Banner's intellect combined with Skrull DNA."),
    R('Brian Banner', 'Marvel', 'Brian Banner is the mentally unstable and abusive alcoholic father of Bruce Banner.'),
    R('Bobbi-Jo Banner', 'Marvel', 'Bobbi Jo is one of the offspring of Bruce Banner and mother unknown.'),
  ],
  'TONY STARK': [
    R('Tony Stark (Amalgam)', 'Marvel Comics and DC Comics', 'Amalgam version of Tony Stark'),
    R('Iron Man', 'Marvel', 'Tony Stark was the arrogant son of wealthy, weapon manufacturer Howard Stark.'),
    R('Night Thrasher', 'Marvel', 'Dwayne Taylor was the leader of the superhero-group known as the New Warriors.'),
  ],
  'SHADOW BASE': [
    R('Shadow Base', 'Marvel', 'Also known as United States Hulk Operations was a clandestine U.S. Military organization tasked with hunting down the Hulk.', 'team'),
    R('Base', 'Marvel', 'Base is a member of the team called Genetix. Base has the power to control the elements.'),
    R('Shadow', 'Rebellion', null),
  ],
  'RED HULK': [
    R('Thunderbolt Ross', 'Marvel', 'Thaddeus "Thunderbolt" Ross is former U.S. military general. He later became the Red Hulk.'),
    R('Robert L. Maverick', 'Marvel', 'The man that Thunderbolt Ross thought "Was a little much" became the new Red Hulk.'),
  ],
  FORTEAN: [
    R('General Fortean', 'Marvel', 'One of the biggest threats to the Red Hulk. He is determined to avenge the death of his mentor General Thunderbolt Ross.'),
  ],
};

// ============================================================
// buildSearchUrl
// ============================================================
describe('buildSearchUrl', () => {
  it('検索語・キー・形式をクエリに含む', () => {
    const u = buildSearchUrl('SHADOW BASE', 'KEY123');
    expect(u).toContain('comicvine.gamespot.com/api/search/');
    expect(decodeURIComponent(u)).toContain('query=SHADOW BASE');
    expect(u).toContain('api_key=KEY123');
    expect(u).toContain('format=json');
  });

  it('publisher を field_list に含む（ゲートに必須）', () => {
    const u = buildSearchUrl('X', 'K');
    expect(decodeURIComponent(u)).toContain('publisher');
  });

  it('1 位だけでは誤答を落とせないため複数件を要求する', () => {
    const u = buildSearchUrl('X', 'K');
    const limit = Number(new URL(u).searchParams.get('limit'));
    expect(limit).toBeGreaterThanOrEqual(5);
  });

  it('キーが無ければ null（ネットワークを叩かせない）', () => {
    expect(buildSearchUrl('X', '')).toBeNull();
    expect(buildSearchUrl('X', null)).toBeNull();
  });

  it('検索語が空なら null', () => {
    expect(buildSearchUrl('', 'K')).toBeNull();
    expect(buildSearchUrl('   ', 'K')).toBeNull();
  });
});

// ============================================================
// parseSearchResponse
// ============================================================
describe('parseSearchResponse', () => {
  it('status_code 1 は ok', () => {
    const r = parseSearchResponse({ status_code: 1, results: [R('A', 'Marvel', 'deck')] });
    expect(r.status).toBe('ok');
    expect(r.results).toHaveLength(1);
  });

  it('status_code 107（レート制限）は一時的失敗', () => {
    expect(parseSearchResponse({ status_code: 107, error: 'Rate Limit Exceeded' }).status).toBe('transient');
  });

  it('status_code 100（キー不正）は恒久的失敗', () => {
    expect(parseSearchResponse({ status_code: 100, error: 'Invalid API Key' }).status).toBe('error');
  });

  it('results が無くても落ちない', () => {
    expect(parseSearchResponse({ status_code: 1 }).results).toEqual([]);
  });

  it('null / 非オブジェクトは error', () => {
    expect(parseSearchResponse(null).status).toBe('error');
    expect(parseSearchResponse('x').status).toBe('error');
  });
});

// ============================================================
// decodeEntities
// ============================================================
describe('decodeEntities', () => {
  it('実測で混入する &amp; を戻す', () => {
    expect(decodeEntities('Alpha &amp; Beta Flight')).toBe('Alpha & Beta Flight');
  });

  it('主要な実体参照を戻す', () => {
    expect(decodeEntities('&lt;a&gt; &quot;x&quot; &#39;y&#39;')).toBe('<a> "x" \'y\'');
  });

  it('&amp;lt; を二重復号しない（タグ生成を防ぐ）', () => {
    expect(decodeEntities('&amp;lt;script&amp;gt;')).toBe('&lt;script&gt;');
  });

  it('文字列以外は空文字', () => {
    expect(decodeEntities(null)).toBe('');
    expect(decodeEntities(undefined)).toBe('');
  });
});

// ============================================================
// passesGate
// ============================================================
describe('passesGate - 出版社', () => {
  it('期待出版社と一致すれば通る', () => {
    expect(passesGate({ term: 'ABOMINATION', name: 'Abomination', deck: FIXTURES.ABOMINATION[1].deck, publisherName: 'Marvel', publisher: 'marvel' })).toBe(true);
  });

  it('別の既知出版社は却下する（Voltron の Abomination）', () => {
    expect(passesGate({ term: 'ABOMINATION', name: 'Abomination', deck: FIXTURES.ABOMINATION[0].deck, publisherName: 'Lion Forge Comics', publisher: 'marvel' })).toBe(false);
  });

  it('表に無い出版社も却下する（Bongo の Walt）', () => {
    // Wikipedia 側は「出版社に触れない記事」を通すが、Comic Vine は publisher が
    // 常に構造化フィールドで返るため一致を要求できる。Bongo / Le Lombard を落とすのに必須
    expect(passesGate({ term: 'WALT', name: 'Walt', deck: "Mom's eldest son. He lives in Springfield with his family.", publisherName: 'Bongo', publisher: 'marvel' })).toBe(false);
  });

  it('期待出版社が不明（未知サイト）なら出版社を条件にしない', () => {
    expect(passesGate({ term: 'ABOMINATION', name: 'Abomination', deck: FIXTURES.ABOMINATION[0].deck, publisherName: 'Lion Forge Comics', publisher: null })).toBe(true);
  });

  it('publisher フィールドが無い結果は、期待出版社があるとき却下する', () => {
    expect(passesGate({ term: 'X-TERM', name: 'X-Term', deck: 'A'.repeat(60), publisherName: null, publisher: 'marvel' })).toBe(false);
  });
});

describe('passesGate - deck', () => {
  it('deck が無ければ却下（Marvel の Walt は deck が空）', () => {
    expect(passesGate({ term: 'WALT', name: 'Walt', deck: null, publisherName: 'Marvel', publisher: 'marvel' })).toBe(false);
  });

  it('deck が短すぎれば却下', () => {
    expect(passesGate({ term: 'WALT', name: 'Walt', deck: 'A hero.', publisherName: 'Marvel', publisher: 'marvel' })).toBe(false);
  });
});

describe('passesGate - 語の照合', () => {
  it('名前に語が含まれれば通る（Doctor Doom）', () => {
    expect(passesGate({ term: 'DOOM', name: 'Doctor Doom', deck: FIXTURES.DOOM[2].deck, publisherName: 'Marvel', publisher: 'marvel' })).toBe(true);
  });

  it('名前にも deck にも無ければ却下する（DOOM に対する T\'Channa）', () => {
    // 出版社は Marvel で一致するため、出版社ゲートだけでは落とせない
    expect(passesGate({ term: 'DOOM', name: "T'Channa", deck: FIXTURES.DOOM[1].deck, publisherName: 'Marvel', publisher: 'marvel' })).toBe(false);
  });

  it('deck に語が現れれば通る（TONY STARK に対する Iron Man）', () => {
    expect(passesGate({ term: 'TONY STARK', name: 'Iron Man', deck: FIXTURES['TONY STARK'][1].deck, publisherName: 'Marvel', publisher: 'marvel' })).toBe(true);
  });

  it('部分語には一致しない（BANNER が Bannerman に当たらない）', () => {
    expect(passesGate({ term: 'BANNER', name: 'Bannerman', deck: 'Bannerman is a hero of the northern kingdom and fights for justice.', publisherName: 'Marvel', publisher: 'marvel' })).toBe(false);
  });
});

// ============================================================
// pickBestResult — 実測データで誤答が落ちることを担保する
// ============================================================
describe('pickBestResult - 実測 5 語の誤答を落とす', () => {
  it('ABOMINATION は Voltron を飛ばして Marvel を採る', () => {
    const r = pickBestResult(FIXTURES.ABOMINATION, 'ABOMINATION', 'marvel');
    expect(r.name).toBe('Abomination');
    expect(r.publisher.name).toBe('Marvel');
    expect(r.deck).toContain('Emil Blonsky');
  });

  it('DOOM は DC と T\'Channa を飛ばして Doctor Doom を採る', () => {
    const r = pickBestResult(FIXTURES.DOOM, 'DOOM', 'marvel');
    expect(r.name).toBe('Doctor Doom');
  });

  it('TONY STARK は Amalgam を飛ばして Iron Man を採る', () => {
    const r = pickBestResult(FIXTURES['TONY STARK'], 'TONY STARK', 'marvel');
    expect(r.name).toBe('Iron Man');
  });

  it('WALT はどれも採らない（Marvel 版は deck が空）', () => {
    expect(pickBestResult(FIXTURES.WALT, 'WALT', 'marvel')).toBeNull();
  });

  it('BANNER はどれも採らない（Brian Banner を掴まない）', () => {
    // Wikipedia 側で実際に起きた誤答。Marvel かつ名前に Banner を含むため
    // 出版社ゲートと語の照合だけでは通ってしまう。完全一致を優先する必要がある
    const r = pickBestResult(FIXTURES.BANNER, 'BANNER', 'marvel');
    expect(r).toBeNull();
  });
});

describe('pickBestResult - 正解を採る', () => {
  it('SHADOW BASE は完全一致の team を採る', () => {
    const r = pickBestResult(FIXTURES['SHADOW BASE'], 'SHADOW BASE', 'marvel');
    expect(r.name).toBe('Shadow Base');
    expect(r.resource_type).toBe('team');
  });

  it('RED HULK は別名で立項された Thunderbolt Ross を採る', () => {
    const r = pickBestResult(FIXTURES['RED HULK'], 'RED HULK', 'marvel');
    expect(r.name).toBe('Thunderbolt Ross');
  });

  it('FORTEAN は General Fortean を採る', () => {
    const r = pickBestResult(FIXTURES.FORTEAN, 'FORTEAN', 'marvel');
    expect(r.name).toBe('General Fortean');
  });

  it('完全一致を部分一致より優先する', () => {
    const results = [
      R('Amanda Von Doom', 'Marvel', 'A government agent in charge of the Mad Squad and its operations.'),
      R('Doom', 'Marvel', 'Victor von Doom is the monarch of Latveria and a genius inventor.'),
    ];
    expect(pickBestResult(results, 'DOOM', 'marvel').name).toBe('Doom');
  });

  it('候補が空なら null', () => {
    expect(pickBestResult([], 'X', 'marvel')).toBeNull();
    expect(pickBestResult(null, 'X', 'marvel')).toBeNull();
  });
});

// ============================================================
// toMaterial
// ============================================================
describe('toMaterial', () => {
  it('deck を intro に、powers は空にする', () => {
    const m = toMaterial(FIXTURES['SHADOW BASE'][0]);
    expect(m.title).toBe('Shadow Base');
    expect(m.intro).toContain('clandestine');
    // Comic Vine の deck は一行要約で能力節に相当するものが無い。
    // buildGlossPrompt が powers を文字列として要求するため空文字を渡す
    expect(m.powers).toBe('');
  });

  it('実体参照を復号する', () => {
    const m = toMaterial(R('Gamma Flight', 'Marvel', 'Allies of the Alpha &amp; Beta Flight teams of Canada.', 'team'));
    expect(m.intro).toContain('Alpha & Beta Flight');
  });

  it('出典 URL は site_detail_url を使う', () => {
    const m = toMaterial(FIXTURES['SHADOW BASE'][0]);
    expect(m.url).toContain('comicvine.gamespot.com');
  });

  it('site_detail_url が無ければ null を返さず URL 無しにしない', () => {
    const m = toMaterial({ name: 'X', deck: 'A'.repeat(60), publisher: { name: 'Marvel' } });
    expect(typeof m.url).toBe('string');
  });
});

describe('定数', () => {
  it('権限リクエスト用のオリジンを公開する', () => {
    expect(COMICVINE_ORIGIN).toBe('https://comicvine.gamespot.com/*');
  });

  it('ソース ID を公開する', () => {
    expect(SOURCE_ID).toBe('comicvine');
  });
});

// ---------------------------------------------------------------------------
// 敬称・階級の略記（2026-08-05 実測）
//
// 用語集の "DOC DOOM" は抽出も両ソースへの問い合わせも通ったうえで失敗していた。
// 記事・候補は正式表記 "Doctor Doom" で立項されており、敬称を名前側からしか
// 外していなかったため一致しなかった。
// ---------------------------------------------------------------------------
describe('敬称・階級の略記', () => {
  it('DOC DOOM で Doctor Doom を採る', () => {
    expect(pickBestResult(FIXTURES.DOOM, 'DOC DOOM', 'marvel')?.name).toBe('Doctor Doom');
  });

  it('DR. DOOM でも同じ候補を採る', () => {
    expect(pickBestResult(FIXTURES.DOOM, 'DR. DOOM', 'marvel')?.name).toBe('Doctor Doom');
  });

  it('略記を開いても別人は採らない（Amanda Von Doom を掴まない）', () => {
    expect(pickBestResult(FIXTURES.DOOM, 'DOC DOOM', 'marvel')?.name).not.toBe('Amanda Von Doom');
  });

  it('不変条件: 略記の扱いを変えても BANNER は Brian Banner を採らない', () => {
    const hit = pickBestResult(FIXTURES.BANNER, 'BANNER', 'marvel');
    expect(hit?.name).not.toBe('Brian Banner');
    expect(hit?.name).not.toBe('Bobbi-Jo Banner');
  });

  it('不変条件: DOC BANNER でも Brian Banner を採らない', () => {
    expect(passesGate({
      term: 'DOC BANNER', name: 'Brian Banner',
      deck: FIXTURES.BANNER[3].deck, publisherName: 'Marvel', publisher: 'marvel',
    })).toBe(false);
  });

  it('出版社ゲートは略記の有無に関わらず効く（DC の Doom は採らない）', () => {
    expect(pickBestResult(FIXTURES.DOOM, 'DOC DOOM', 'marvel')?.publisher?.name).toBe('Marvel');
  });
});

describe('敬称・階級の略記 - 外しすぎない', () => {
  it('出版社が不明でも DOC DOOM は DC の Doom を採らない', () => {
    // 語側だけ敬称を外すと "doc doom" → "doom" が DC の "Doom" に当たる。
    // 候補名にも敬称がある場合に限って外すことで防ぐ
    expect(pickBestResult(FIXTURES.DOOM, 'DOC DOOM', null)?.name).toBe('Doctor Doom');
  });

  it('候補名に敬称が無ければ語の敬称は外さない', () => {
    expect(passesGate({
      term: 'DOC DOOM', name: 'Doom',
      deck: FIXTURES.DOOM[0].deck, publisherName: 'DC Comics', publisher: null,
    })).toBe(false);
  });

  it('候補名に敬称があれば語が素でも従来どおり一致する', () => {
    expect(passesGate({
      term: 'DOOM', name: 'Doctor Doom',
      deck: FIXTURES.DOOM[2].deck, publisherName: 'Marvel', publisher: 'marvel',
    })).toBe(true);
  });
});
