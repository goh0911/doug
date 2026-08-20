// tests/unit/translate-inflight.test.js
//
// 同じ画像の翻訳が同時に走るのを 1 回にまとめる。
//
// 先読みが P2 を翻訳している最中に利用者が P2 へ移動すると、キャッシュにまだ結果が
// 無いため通常経路がもう一度翻訳していた（API 課金 2 倍・待ち時間もそのぶん）。
//
// ただし結果をそのまま横流ししてはいけない。先読みは seriesId 無しで呼ばれるため
// 層A（用語集のプロンプト注入）も層B（訳語置換）も効いていない。共有するのは
// 「翻訳の生データ」だけで、層B の適用は呼び出しごとに行う。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const local = new Map();

const areaMock = (m) => ({
  get: async (k) => {
    if (k == null) return Object.fromEntries(m);
    if (typeof k === 'string') return m.has(k) ? { [k]: m.get(k) } : {};
    if (Array.isArray(k)) return Object.fromEntries(k.filter((x) => m.has(x)).map((x) => [x, m.get(x)]));
    return Object.fromEntries(Object.entries(k).map(([x, d]) => [x, m.has(x) ? m.get(x) : d]));
  },
  set: async (o) => { for (const [k, v] of Object.entries(o)) m.set(k, v); },
  remove: async (k) => { for (const x of [].concat(k)) m.delete(x); },
  getBytesInUse: async () => 0,
  onChanged: { addListener: () => {} },
});

globalThis.chrome = {
  runtime: { id: 'test-ext-id', lastError: null, getManifest: () => ({ version: '0.0.0-test' }) },
  storage: {
    local: areaMock(local),
    session: areaMock(new Map()),
    onChanged: { addListener: () => {} },
  },
};

const { handleImageTranslation, INFLIGHT_WAIT_TIMEOUT_MS } = await import('../../translate.js');
const { invalidateSettingsCache } = await import('../../settings.js');

const IMAGE = 'data:image/jpeg;base64,/9j/4AAQSkZJRg==';
const URL_A = 'https://example.com/page-1.jpg';
// ハングを再現するテスト専用。進行中エントリが残るので他のテストと URL を分ける
// （分けないと後続が待ち合わせに入って実時間で待たされる。これ自体が「相手が
//   返らないと後続を巻き込む」ことの証拠でもある）
const URL_STUCK = 'https://example.com/page-stuck.jpg';
const SERIES_ID = 'S1';

/** Gemini が返す形。訳文に原語が残っており、層B の置換対象になる */
const GEMINI_TEXT = JSON.stringify([
  { original: 'MEET ROXXON', translated: 'ROXXON に会え', type: 'speech', box: [100, 200, 300, 600] },
]);

function serveGemini({ delayMs = 20, fail = false } = {}) {
  globalThis.fetch = vi.fn(async () => {
    await new Promise((r) => setTimeout(r, delayMs));
    if (fail) return { ok: false, status: 500, text: async () => 'boom', json: async () => ({}) };
    return {
      ok: true,
      status: 200,
      json: async () => ({ candidates: [{ content: { parts: [{ text: GEMINI_TEXT }] } }] }),
      text: async () => GEMINI_TEXT,
    };
  });
}

beforeEach(() => {
  local.clear();
  invalidateSettingsCache();
  local.set('apiProvider', 'gemini');
  local.set('geminiApiKey', 'test-key');
  local.set('targetLang', 'ja');
  local.set(`series:${SERIES_ID}`, {
    seriesId: SERIES_ID,
    meta: { name: 'Test (2026)' },
    glossary: { ja: { ROXXON: { translated: 'ロクソン', approved: true, count: 1 } } },
    glossDefs: { ja: {} },
    recentPairs: [],
    stats: {},
  });
  serveGemini();
});

afterEach(() => {
  vi.useRealTimers();
  delete globalThis.fetch;
});

describe('同じ画像の同時翻訳', () => {
  it('先読みと通常経路が同時に走っても API 呼び出しは 1 回', async () => {
    const [prefetch, normal] = await Promise.all([
      handleImageTranslation(IMAGE, URL_A, { width: 1000, height: 1000 }, { prefetch: true }),
      handleImageTranslation(IMAGE, URL_A, { width: 1000, height: 1000 }, { seriesId: SERIES_ID }),
    ]);
    expect(globalThis.fetch.mock.calls.length).toBe(1);
    expect(prefetch.translations).toHaveLength(1);
    expect(normal.translations).toHaveLength(1);
  });

  it('待った側にも層B が適用される（先読みの結果をそのまま返さない）', async () => {
    const [, normal] = await Promise.all([
      handleImageTranslation(IMAGE, URL_A, { width: 1000, height: 1000 }, { prefetch: true }),
      handleImageTranslation(IMAGE, URL_A, { width: 1000, height: 1000 }, { seriesId: SERIES_ID }),
    ]);
    expect(normal.translations[0].translated).toBe('ロクソン に会え');
    expect(normal.glossaryHits).toBe(1);
  });

  it('先読み側は層B を適用しない（seriesId が無いので用語集を持たない）', async () => {
    const [prefetch] = await Promise.all([
      handleImageTranslation(IMAGE, URL_A, { width: 1000, height: 1000 }, { prefetch: true }),
      handleImageTranslation(IMAGE, URL_A, { width: 1000, height: 1000 }, { seriesId: SERIES_ID }),
    ]);
    expect(prefetch.translations[0].translated).toBe('ROXXON に会え');
  });

  it('進行中の翻訳が失敗したら、待った側は自分で翻訳する', async () => {
    serveGemini({ fail: true });
    const first = handleImageTranslation(IMAGE, URL_A, { width: 1000, height: 1000 }, { prefetch: true });
    await new Promise((r) => setTimeout(r, 5)); // 1 本目を進行中にする
    const second = await handleImageTranslation(IMAGE, URL_A, { width: 1000, height: 1000 }, { seriesId: SERIES_ID });
    await first;
    // 失敗を共有して終わりにしない。2 本目は自分で引き直す（合計 2 回）
    expect(globalThis.fetch.mock.calls.length).toBe(2);
    expect(second.error).toBeTruthy();
  });

  it('別の画像は待ち合わせない', async () => {
    await Promise.all([
      handleImageTranslation(IMAGE, URL_A, { width: 1000, height: 1000 }, { prefetch: true }),
      handleImageTranslation(IMAGE, 'https://example.com/page-2.jpg', { width: 1000, height: 1000 }, { prefetch: true }),
    ]);
    expect(globalThis.fetch.mock.calls.length).toBe(2);
  });

  // Codex 指摘。background.js:1025（解説側）は
  //   if (glossInFlight.get(lockKey) === run) glossInFlight.delete(lockKey)
  // と「自分より後に入った run を消さない」ようにしているのに、こちらは無条件 delete
  // だった。再翻訳ボタン（forceRefresh）は待ち合わせを飛ばして同じキーに登録するため、
  // 先に終わった通常翻訳がその登録を消してしまう。
  it('再翻訳（forceRefresh）の登録を、先に終わった通常翻訳が消さない', async () => {
    let call = 0;
    globalThis.fetch = vi.fn(async () => {
      const n = ++call;
      if (n === 1) {
        // 1 本目（通常）は速く失敗する。キャッシュに何も残らないのが要点
        await new Promise((r) => setTimeout(r, 10));
        return { ok: false, status: 500, text: async () => 'boom', json: async () => ({}) };
      }
      await new Promise((r) => setTimeout(r, 80));
      return {
        ok: true,
        status: 200,
        json: async () => ({ candidates: [{ content: { parts: [{ text: GEMINI_TEXT }] } }] }),
        text: async () => GEMINI_TEXT,
      };
    });

    const failing = handleImageTranslation(IMAGE, URL_A, { width: 1000, height: 1000 }, { prefetch: true });
    await new Promise((r) => setTimeout(r, 2));
    const refresh = handleImageTranslation(IMAGE, URL_A, { width: 1000, height: 1000 }, { seriesId: SERIES_ID, forceRefresh: true });

    await failing;                              // ここで 1 本目が finally に入る
    await new Promise((r) => setTimeout(r, 5)); // 3 本目が来るのは 1 本目の後片付けより後

    const late = await handleImageTranslation(IMAGE, URL_A, { width: 1000, height: 1000 }, { seriesId: SERIES_ID });
    await refresh;

    // 3 本目は再翻訳の完了を待つべき。待てないと自分で叩いて 3 回になる
    expect(globalThis.fetch.mock.calls.length).toBe(2);
    expect(late.translations).toHaveLength(1);
  });

  // Codex 指摘。翻訳の fetch にはタイムアウトが無く、解決も拒否もされない通信に当たると
  // 待ち合わせ側が永久に戻れない。二重翻訳を防ぐために「相手を待つ」ようにした結果、
  // 1 本のハングが後続を巻き込むようになった。待つのをやめる出口を用意する。
  it('進行中の翻訳が返ってこなければ、待機を打ち切って自分で翻訳する', async () => {
    vi.useFakeTimers();
    let call = 0;
    globalThis.fetch = vi.fn(async () => {
      if (++call === 1) return new Promise(() => { /* 解決も拒否もしない */ });
      return {
        ok: true,
        status: 200,
        json: async () => ({ candidates: [{ content: { parts: [{ text: GEMINI_TEXT }] } }] }),
        text: async () => GEMINI_TEXT,
      };
    });

    handleImageTranslation(IMAGE, URL_STUCK, { width: 1000, height: 1000 }, { prefetch: true });
    await vi.advanceTimersByTimeAsync(1); // 1 本目を進行中にする

    const waiter = handleImageTranslation(IMAGE, URL_STUCK, { width: 1000, height: 1000 }, { seriesId: SERIES_ID });
    // 待機側が Promise.race のタイマーを登録するまで microtask を流す。
    // 先に時計を進めても、まだ登録されていないタイマーは進まない
    for (let i = 0; i < 5; i++) await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(INFLIGHT_WAIT_TIMEOUT_MS + 1);

    const r = await waiter;
    expect(globalThis.fetch.mock.calls.length).toBe(2);
    expect(r.translations).toHaveLength(1);
    expect(r.translations[0].translated).toBe('ロクソン に会え'); // 層B は効いたまま
  });

  it('待機の上限は 2 分', () => {
    expect(INFLIGHT_WAIT_TIMEOUT_MS).toBe(120_000);
  });

  it('翻訳が終わったあとの呼び出しはキャッシュで返る（待ち合わせが居座らない）', async () => {
    await handleImageTranslation(IMAGE, URL_A, { width: 1000, height: 1000 }, { prefetch: true });
    const again = await handleImageTranslation(IMAGE, URL_A, { width: 1000, height: 1000 }, { seriesId: SERIES_ID });
    expect(globalThis.fetch.mock.calls.length).toBe(1);
    expect(again.fromCache).toBe(true);
  });
});
