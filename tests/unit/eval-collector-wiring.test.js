// tests/unit/eval-collector-wiring.test.js
// 【一時措置】tmp/eval-collector ブランチ限定。master には載せない。
//
// 判定ロジック（eval-signals）とは別に、**配線**を確かめる。ここが黙って壊れると
// 「候補が貯まらない」を「難しいページが無い」と読み違える（CLAUDE.md 測定規律）。
import { describe, it, expect, vi } from 'vitest';

// 実 API を叩かせない。翻訳結果はテストごとに差し替える
const fakeResult = { current: { translations: [], pairs: [] } };
vi.mock('../../translate.js', () => ({
  handleImageTranslation: vi.fn(async () => fakeResult.current),
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
    onConnect: { addListener: (fn) => { listeners.connect = fn; } },
    onMessage: noopEvent,
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

/** Port を模して TRANSLATE_IMAGE を 1 回流す */
async function translateOnce(translations, { imageUrl = 'https://img.example.com/p1.jpg' } = {}) {
  fakeResult.current = { translations, pairs: [] };
  let onMessage;
  const port = {
    name: 'translate',
    sender: { id: 'test-ext-id', tab: { url: 'https://example.com/comic/1' } },
    onMessage: { addListener: (fn) => { onMessage = fn; } },
    onDisconnect: { addListener: () => {} },
    postMessage: () => {},
    disconnect: () => {},
  };
  listeners.connect(port);
  await onMessage({ type: 'TRANSLATE_IMAGE', imageData: 'data:image/jpeg;base64,AAA', imageUrl, imageDims: { w: 100, h: 100 } });
  // 記録は await されない（翻訳の応答を待たせない）ので、マイクロタスクを流す
  await new Promise((r) => setTimeout(r, 0));
  return local.get('evalCandidates');
}

describe('評価候補の記録が Port 経路に配線されている', () => {
  it('検出ゼロのページは候補として保存される', async () => {
    const saved = await translateOnce([]);
    expect(saved).toBeTruthy();
    const entry = saved['https://img.example.com/p1.jpg'];
    expect(entry.reasons).toContain('empty');
    expect(entry.pageUrl).toBe('https://example.com/comic/1');
  });

  it('陰性対照: 正常な翻訳は保存されない', async () => {
    local.delete('evalCandidates');
    const items = ['あ', 'い', 'う', 'え', 'お'].map((x, i) => ({ original: `W${i}`, translated: x }));
    const saved = await translateOnce(items, { imageUrl: 'https://img.example.com/p2.jpg' });
    expect(saved).toBeUndefined();
  });
});
