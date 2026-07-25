// settings.js - アプリ設定の取得・キャッシュ管理

export const SETTINGS_DEFAULTS = {
  apiProvider: 'gemini',
  geminiApiKey: '',
  claudeApiKey: '',
  openaiApiKey: '',
  geminiModel: 'gemini-3.6-flash',
  claudeModel: 'claude-sonnet-5',
  openaiModel: 'gpt-5.6-sol',
  ollamaModel: 'qwen3.6:35b-a3b',
  ollamaEndpoint: 'http://localhost:11434',
  targetLang: 'ja',
  prefetch: false,
  imagePreprocess: true,
};

let settingsCache = null;

export async function getSettings() {
  if (settingsCache) return settingsCache;
  settingsCache = await chrome.storage.local.get(SETTINGS_DEFAULTS);
  return settingsCache;
}

export function invalidateSettingsCache() {
  settingsCache = null;
}
