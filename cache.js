// cache.js - 翻訳結果のキャッシュ管理

import { normalizeImageUrl, isSessionOnlyUrl } from './utils/url-utils.js';

const CACHE_TTL = 30 * 24 * 60 * 60 * 1000; // 30日
const CACHE_VERSION = '1.1';

// ストレージ圧迫とみなすバイト数（QUOTA_BYTES 10 MB の 80%）
const CACHE_PRESSURE_BYTES = 8 * 1024 * 1024;

// 翻訳結果に影響する設定キー（変更時に古いキャッシュを削除）
export const CACHE_AFFECTING_KEYS = ['apiProvider', 'geminiModel', 'claudeModel', 'openaiModel', 'ollamaModel', 'targetLang'];

// Blob画像のコンテンツからSHA-256ハッシュを生成（BlobURLはページ遷移で変わるため内容で同一性を判定）
export async function computeImageDataHash(imageData) {
  const base64 = imageData.indexOf(',') >= 0 ? imageData.slice(imageData.indexOf(',') + 1) : imageData;
  const encoder = new TextEncoder();
  const bytes = encoder.encode(base64);
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return 'img-hash:' + Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function generateCacheKey(imageUrl, targetLang, provider = '', model = '') {
  if (!imageUrl) throw new Error('imageUrl is required');
  // トークン等を除去したURLでハッシュ生成（先読みと通常翻訳でキャッシュを共有）
  const normalized = normalizeImageUrl(imageUrl);
  const encoder = new TextEncoder();
  const data = encoder.encode(normalized);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  return `cache:${hashHex.substring(0, 32)}:${targetLang}:${provider}:${model}`;
}

export async function getCachedTranslation(imageUrl, targetLang, provider = '', model = '') {
  const cacheKey = await generateCacheKey(imageUrl, targetLang, provider, model);
  try {
    const storage = isSessionOnlyUrl(imageUrl) ? chrome.storage.session : chrome.storage.local;
    const result = await storage.get(cacheKey);
    const cached = result[cacheKey];
    if (!cached) return null;
    if (cached.version !== CACHE_VERSION) {
      await storage.remove(cacheKey);
      return null;
    }
    // sessionキャッシュはTTL不要（セッション終了で自動破棄）
    if (!isSessionOnlyUrl(imageUrl) && Date.now() - cached.timestamp > CACHE_TTL) {
      await chrome.storage.local.remove(cacheKey);
      return null;
    }
    return cached.translations;
  } catch (err) {
    console.error('キャッシュ読み込みエラー:', err);
    return null;
  }
}

export async function saveCachedTranslation(imageUrl, targetLang, translations, provider = '', model = '') {
  const cacheKey = await generateCacheKey(imageUrl, targetLang, provider, model);
  const cacheData = { translations, timestamp: Date.now(), version: CACHE_VERSION };
  const storage = isSessionOnlyUrl(imageUrl) ? chrome.storage.session : chrome.storage.local;
  try {
    await storage.set({ [cacheKey]: cacheData });
    if (!isSessionOnlyUrl(imageUrl)) {
      const usage = await chrome.storage.local.getBytesInUse();
      if (usage > CACHE_PRESSURE_BYTES) await cleanOldCache();
    }
  } catch {
    if (!isSessionOnlyUrl(imageUrl)) {
      // 書き込み自体が失敗した＝空きが足りない。圧迫の再計測を待たずに空けにいく
      await cleanOldCache({ force: true });
      try { await chrome.storage.local.set({ [cacheKey]: cacheData }); } catch { /* 諦める */ }
    }
  }
}

/**
 * 翻訳キャッシュを整理する。
 * @param {{ force?: boolean }} [options] force:true で圧迫の有無に関係なく古い半分を削除
 */
export async function cleanOldCache({ force = false } = {}) {
  try {
    const allData = await chrome.storage.local.get(null);
    const cacheEntries = Object.keys(allData)
      .filter(key => key.startsWith('cache:'))
      .map(key => ({ key, timestamp: allData[key].timestamp || 0 }));

    // まずTTL超過のキーを削除
    const now = Date.now();
    const expiredKeys = new Set(
      cacheEntries.filter(e => now - e.timestamp > CACHE_TTL).map(e => e.key)
    );
    if (expiredKeys.size > 0) {
      await chrome.storage.local.remove([...expiredKeys]);
    }

    // TTL 削除だけで圧迫が解消したなら、まだ有効なキャッシュは残す。
    // 以前は無条件に古い半分を消していたため、targetLang やモデルを切り替えるたびに
    // 切り替え先とは無関係の有効なキャッシュまで半減し、読み直すたび再課金していた。
    // 測定できなかった場合も削除しない（消し過ぎより残し過ぎを選ぶ。書き込み失敗時は
    // 呼び出し側が force:true を渡す）
    if (!force) {
      let usage = 0;
      try { usage = await chrome.storage.local.getBytesInUse(); } catch { usage = 0; }
      if (usage <= CACHE_PRESSURE_BYTES) return;
    }

    // 圧迫が続く場合の最終手段として残りの古い半分を削除
    const remaining = cacheEntries
      .filter(e => !expiredKeys.has(e.key))
      .sort((a, b) => a.timestamp - b.timestamp);
    const toDelete = remaining.slice(0, Math.ceil(remaining.length / 2)).map(e => e.key);
    if (toDelete.length > 0) {
      await chrome.storage.local.remove(toDelete);
    }
  } catch (err) {
    console.error('キャッシュクリーンアップエラー:', err);
  }
}
