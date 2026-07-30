// tests/unit/cache.test.js
// cleanOldCache のふるまい（chrome.storage.local のメモリモック）

import { describe, it, expect, beforeEach } from 'vitest';

let _store = {};
let _bytesInUse = 0;

const chromeMock = {
  storage: {
    local: {
      QUOTA_BYTES: 10 * 1024 * 1024,
      async get(key) {
        if (key === null) return { ..._store };
        if (typeof key === 'string') return { [key]: _store[key] };
        const out = {};
        for (const k of key) out[k] = _store[k];
        return out;
      },
      async set(obj) { Object.assign(_store, obj); },
      async remove(key) {
        if (typeof key === 'string') delete _store[key];
        else key.forEach((k) => delete _store[k]);
      },
      async getBytesInUse() { return _bytesInUse; },
    },
  },
};

beforeEach(() => {
  _store = {};
  _bytesInUse = 0;
  globalThis.chrome = chromeMock;
});

async function loadCache() {
  return import('../../cache.js');
}

const DAY = 24 * 60 * 60 * 1000;

/** 有効なキャッシュ n 件（新しい順に 1 日ずつ古くなる） */
function seedFresh(n) {
  const now = Date.now();
  for (let i = 0; i < n; i++) {
    _store[`cache:fresh${i}`] = { translations: [], timestamp: now - i * DAY, version: '1.1' };
  }
}

function cacheKeys() {
  return Object.keys(_store).filter((k) => k.startsWith('cache:'));
}

describe('cleanOldCache', () => {
  it('TTL 超過のキャッシュを削除する', async () => {
    const { cleanOldCache } = await loadCache();
    _store['cache:expired'] = { translations: [], timestamp: Date.now() - 31 * DAY, version: '1.1' };
    seedFresh(4);

    await cleanOldCache();

    expect(cacheKeys()).not.toContain('cache:expired');
  });

  // 無条件に半分を消していたため、targetLang を切り替えるたび他言語分も半減していた
  it('圧迫していなければ有効なキャッシュは残す', async () => {
    const { cleanOldCache } = await loadCache();
    seedFresh(10);
    _bytesInUse = 1 * 1024 * 1024; // 1 MB

    await cleanOldCache();

    expect(cacheKeys()).toHaveLength(10);
  });

  it('TTL 削除後も圧迫が続くなら古い半分を削除する', async () => {
    const { cleanOldCache } = await loadCache();
    seedFresh(10);
    _bytesInUse = 9 * 1024 * 1024; // 9 MB

    await cleanOldCache();

    const keys = cacheKeys();
    expect(keys).toHaveLength(5);
    // 新しい 5 件（fresh0〜fresh4）が残る
    expect(keys).toContain('cache:fresh0');
    expect(keys).not.toContain('cache:fresh9');
  });

  it('force 指定なら圧迫の有無に関係なく古い半分を削除する', async () => {
    const { cleanOldCache } = await loadCache();
    seedFresh(10);
    _bytesInUse = 0;

    await cleanOldCache({ force: true });

    expect(cacheKeys()).toHaveLength(5);
  });

  it('cache: 以外のキーは触らない', async () => {
    const { cleanOldCache } = await loadCache();
    seedFresh(10);
    _store['series:abc'] = { meta: { name: 'x' } };
    _store.targetLang = 'ja';
    _bytesInUse = 9 * 1024 * 1024;

    await cleanOldCache({ force: true });

    expect(_store['series:abc']).toBeDefined();
    expect(_store.targetLang).toBe('ja');
  });
});
