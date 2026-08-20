// tests/unit/gloss-backoff-wiring.test.js
//
// 失敗の再試行バックオフ（A-6）の**配線**を確かめる。判定そのものは
// gloss-cache.test.js が pure 関数として押さえているが、background.js が
// failCount を載せ忘れると待機は永久に 24 時間のままで、しかも
// 「バックオフが効いている」ように見えてしまう（失敗が減ったのか、
// 単に読んでいないだけなのか区別できない）。CLAUDE.md の測定規律に従い、
// 「引き直さない」ことを見るテストには必ず陽性対照（1 回目は実際に fetch している）を
// 同じ実行に入れる。fetch 0 回は「待機が効いた」とも「配線が死んでいる」とも読めるため。
// 実際、このテストを書いた初回は sender.id を渡し忘れて全リクエストが送信元検証で
// 弾かれており、陽性対照が無ければ「バックオフが効いている」と誤読していた。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../translate.js', () => ({
  handleImageTranslation: vi.fn(),
  callTextOnlyProvider: vi.fn(),
  PROVIDER_KEY_MAP: { gemini: 'geminiApiKey', claude: 'claudeApiKey', openai: 'openaiApiKey', ollama: null },
}));

const local = new Map();
const sync = new Map([['whitelist', ['https://example.com']]]);

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

const listeners = {};
const noopEvent = { addListener: () => {}, removeListener: () => {}, hasListener: () => false };

globalThis.chrome = {
  runtime: {
    id: 'test-ext-id',
    onConnect: noopEvent,
    onMessage: { addListener: (fn) => { listeners.message = fn; } },
    onInstalled: noopEvent,
    onStartup: noopEvent,
    getManifest: () => ({ version: '0.0.0-test' }),
    lastError: null,
  },
  storage: {
    local: areaMock(local),
    sync: areaMock(sync),
    session: areaMock(new Map()),
    onChanged: { addListener: () => {} },
  },
  action: { onClicked: noopEvent, setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {}, setTitle: async () => {} },
  tabs: { onUpdated: noopEvent, onRemoved: noopEvent, onActivated: noopEvent, sendMessage: async () => {}, query: async () => [], get: async () => ({}) },
  alarms: { create: () => {}, onAlarm: noopEvent, clear: async () => {} },
  scripting: { executeScript: async () => {}, insertCSS: async () => {} },
  contextMenus: { create: () => {}, onClicked: noopEvent, removeAll: (cb) => cb && cb() },
  windows: { onFocusChanged: noopEvent },
  permissions: { contains: async () => true },
};

await import('../../background.js');

const SERIES_ID = 'backoff-test';
const TERM = 'SHOCK ROXX RADIO'; // 実機で記事が存在しなかった語（作中架空のラジオ局）

/** Wikipedia が 404 を返す＝「記事が無い」。一時的失敗ではないので失敗として記録される */
function serveNotFound() {
  globalThis.fetch = vi.fn(async () => ({
    ok: false,
    status: 404,
    headers: { get: () => null },
    json: async () => ({}),
  }));
}

function seedSeries() {
  local.clear();
  local.set(`series:${SERIES_ID}`, {
    seriesId: SERIES_ID,
    meta: { name: 'Backoff Test (2026)' },
    glossary: { ja: {} },
    glossDefs: { ja: {} },
    recentPairs: [],
    rejectedOriginals: [],
    urlPatterns: [],
    stats: {},
  });
}

/** GET_GLOSS_DEFS を 1 回叩いて、保存された自シリーズの解説キャッシュを返す */
async function askForDefs() {
  await new Promise((resolve) => {
    listeners.message(
      {
        type: 'GET_GLOSS_DEFS',
        seriesId: SERIES_ID,
        seriesName: 'Backoff Test (2026)',
        terms: [TERM],
        targetLang: 'ja',
        langLabel: '日本語',
      },
      { id: 'test-ext-id', tab: { id: 1, url: 'https://example.com/p' } },
      resolve
    );
  });
  return (local.get(`series:${SERIES_ID}`)?.glossDefs?.ja) ?? {};
}

describe('解説の失敗バックオフ — background.js の配線', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-08-20T00:00:00Z'));
    seedSeries();
    serveNotFound();
  });

  afterEach(() => {
    vi.useRealTimers();
    delete globalThis.fetch;
  });

  it('記事が無い語は失敗として記録され、初回の failCount は 1', async () => {
    const defs = await askForDefs();
    expect(defs[TERM]).toMatchObject({ failed: true, failCount: 1 });
  });

  it('24 時間以内は引き直さない（fetch が増えない）', async () => {
    await askForDefs();
    const calls = globalThis.fetch.mock.calls.length;
    expect(calls).toBeGreaterThan(0); // 陽性対照: 1 回目は実際に引きにいっている

    vi.setSystemTime(new Date('2026-08-20T12:00:00Z'));
    await askForDefs();
    expect(globalThis.fetch.mock.calls.length).toBe(calls);
  });

  it('24 時間を過ぎて再び失敗すると failCount が 2 になる', async () => {
    await askForDefs();
    vi.setSystemTime(new Date('2026-08-21T01:00:00Z')); // 25 時間後
    const defs = await askForDefs();
    expect(defs[TERM]).toMatchObject({ failed: true, failCount: 2 });
  });

  it('failCount 2 の語は 24 時間では引き直さない（待機が伸びている）', async () => {
    await askForDefs();
    vi.setSystemTime(new Date('2026-08-21T01:00:00Z'));
    await askForDefs(); // failCount 2
    const calls = globalThis.fetch.mock.calls.length;

    vi.setSystemTime(new Date('2026-08-22T02:00:00Z')); // さらに 25 時間後（通算 48h 未満）
    await askForDefs();
    expect(globalThis.fetch.mock.calls.length).toBe(calls);
  });
});
