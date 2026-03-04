// stats.js - API 呼び出し統計の管理

// Read-Modify-Write の競合を防ぐためにシリアライズする
let _lock = Promise.resolve();

export function incrementApiStats(provider) {
  _lock = _lock.then(async () => {
    try {
      const { apiStats = {} } = await chrome.storage.local.get('apiStats');
      apiStats[provider] = (apiStats[provider] || 0) + 1;
      if (!apiStats.lastReset) apiStats.lastReset = Date.now();
      await chrome.storage.local.set({ apiStats });
    } catch { /* storage エラーは無視 */ }
  });
  return _lock;
}
