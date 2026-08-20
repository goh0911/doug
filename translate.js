// translate.js - 翻訳処理・4プロバイダーAPI呼び出し・サイト解析

import { parseVisionResponse } from './utils/parse-utils.js';
import { getSettings } from './settings.js';
import { computeImageDataHash, generateCacheKey, getCachedTranslation, saveCachedTranslation } from './cache.js';
import { incrementApiStats } from './stats.js';
import { getSeries } from './series-store.js';
import { buildSeriesPromptSection } from './utils/prompt-builder.js';
import { applyGlossaryPostProcess } from './utils/glossary-substitute.js';
import { maskSecrets } from './utils/mask-secrets.js';
import { supportsThinking, buildOllamaChatBody, pickOllamaResponseText, ollamaParseResponse } from './utils/ollama.js';

const LANG_NAMES = {
  ja: '日本語', ko: '韓国語', 'zh-CN': '簡体字中国語', 'zh-TW': '繁体字中国語',
  es: 'スペイン語', fr: 'フランス語', de: 'ドイツ語', pt: 'ポルトガル語',
};

const PROVIDER_LABELS = { gemini: 'Gemini', claude: 'Claude', openai: 'ChatGPT', ollama: 'Ollama' };

/**
 * 進行中の翻訳。キー（キャッシュと同じ粒度）→ 生の translations を解決する Promise。
 *
 * 先読みが次のページを翻訳している最中に利用者がそのページへ移動すると、キャッシュには
 * まだ結果が無いため通常経路がもう一度翻訳していた（課金 2 倍・待ち時間もそのぶん）。
 *
 * 共有するのは **翻訳の生データだけ**。先読みは seriesId 無しで呼ばれるので層A も層B も
 * 効いておらず、結果をそのまま横流しすると訳語置換の掛かっていない訳文が利用者に出る。
 * 層B の適用は呼び出しごとに行う。
 */
const inFlightTranslations = new Map();

/**
 * 【一時】待ち合わせで防いだ二重翻訳の回数を数える。
 *
 * キャッシュの時刻だけでは、ある翻訳が先読み由来か通常経路かを区別できない。直した
 * 効果を「体感が良くなった」以上の根拠で言えるようにするための計測で、確認が済んだら
 * この関数ごと外す。失敗しても翻訳には影響させない。
 */
async function bumpPrefetchSaves() {
  try {
    const KEY = 'prefetchDedupStats';
    const cur = (await chrome.storage.local.get(KEY))[KEY] || {};
    await chrome.storage.local.set({
      [KEY]: { saved: (cur.saved || 0) + 1, lastAt: Date.now() },
    });
  } catch { /* 測定用。失敗は無視する */ }
}
export const PROVIDER_KEY_MAP = { gemini: 'geminiApiKey', claude: 'claudeApiKey', openai: 'openaiApiKey', ollama: null };

export async function handleImageTranslation(imageData, imageUrl, imageDims, options) {
  const settings = await getSettings();
  const provider = settings.apiProvider || 'gemini';

  // キャッシュキー用：現在有効なモデル名を取得
  const MODEL_KEY_MAP = {
    gemini: settings.geminiModel || 'gemini-3.6-flash',
    claude: settings.claudeModel || 'claude-sonnet-5',
    openai: settings.openaiModel || 'gpt-5.6-sol',
    ollama: settings.ollamaModel || 'qwen3.6:35b-a3b',
  };
  const activeModel = MODEL_KEY_MAP[provider] || '';

  // BlobURLはページ遷移で変わるため、imageDataのコンテンツハッシュをキャッシュキーとして使用
  const cacheKey = (imageUrl && imageUrl.startsWith('blob:') && imageData)
    ? await computeImageDataHash(imageData)
    : imageUrl;

  // シリーズ文脈ロード（層A/B 共通）
  let glossaryLangMap = null;
  let seriesSection = '';
  if (options?.seriesId) {
    try {
      const series = await getSeries(options.seriesId);
      if (series) {
        glossaryLangMap = (series.glossary && series.glossary[settings.targetLang]) || null;
        seriesSection = buildSeriesPromptSection({
          seriesName: series.meta && series.meta.name,
          glossaryLangMap,
          toneStyle: series.tone && series.tone.style,
          examples: series.examples,
        });
      }
    } catch { /* フォールバック: 層A/Bなし */ }
  }

  // 用語抽出に渡すペア（original/translated の組、層B 適用前の raw）
  const toPairs = (items) => (Array.isArray(items) ? items : [])
    .map((t) => ({ original: t.original, translated: t.translated }))
    .filter((p) => p.original && p.translated);

  // 層B適用ヘルパ
  const applyLayerB = (translations) => {
    if (!glossaryLangMap) return { translations, glossaryHits: 0 };
    const r = applyGlossaryPostProcess(translations, glossaryLangMap);
    return { translations: r.translations, glossaryHits: r.totalHits };
  };

  // キャッシュ確認（forceRefresh 時はスキップ）
  if (cacheKey && !options?.forceRefresh) {
    const cached = await getCachedTranslation(cacheKey, settings.targetLang, provider, activeModel);
    if (cached) {
      const r = applyLayerB(cached);
      // キャッシュヒットでも pairs を返す。返さないと、一度読んだページを読み直しても
      // 用語抽出の材料が一切増えず、用語集が育たない（実機で recentPairs が枯れていた）
      return {
        translations: r.translations,
        fromCache: true,
        glossaryHits: r.glossaryHits,
        pairs: toPairs(cached),
      };
    }
  }

  // 同じ画像の翻訳が進行中なら、その結果を待って共有する（自分では API を叩かない）
  const dedupKey = cacheKey
    ? await generateCacheKey(cacheKey, settings.targetLang, provider, activeModel).catch(() => null)
    : null;
  if (dedupKey && !options?.forceRefresh) {
    const running = inFlightTranslations.get(dedupKey);
    if (running) {
      // 失敗・空振りは共有しない。握りつぶして自分で引き直す（下へ落ちる）
      const raw = await running.catch(() => null);
      if (Array.isArray(raw) && raw.length > 0) {
        const r = applyLayerB(raw);
        await bumpPrefetchSaves();
        return {
          translations: r.translations,
          fromCache: true,
          glossaryHits: r.glossaryHits,
          pairs: toPairs(raw),
        };
      }
    }
  }

  // Ollama 以外はAPIキーをチェック
  let apiKey;
  if (provider !== 'ollama') {
    apiKey = settings[PROVIDER_KEY_MAP[provider]];
    if (!apiKey) {
      return { error: `${PROVIDER_LABELS[provider]} APIキーが設定されていません。拡張機能の設定画面でAPIキーを入力してください。` };
    }
  }

  try {
    let translations;

    // parseは1回だけ実行して各API関数に渡す
    const parsed = parseImageDataUrl(imageData);
    // OpenAI は data URL をそのまま受け取るため parsed は Gemini/Claude のみ使用
    const prompt = buildTranslationPrompt(settings.targetLang, seriesSection);

    // 保存まで含めて 1 本の Promise にする。待ち合わせ側がこれを await した時点で
    // キャッシュにも入っている（先に resolve すると読み直しでレースになる）
    const work = (async () => {
      let out;
      if (provider === 'ollama') {
        out = await translateImageWithOllama(
          settings.ollamaEndpoint || 'http://localhost:11434',
          settings.ollamaModel || 'qwen3.6:35b-a3b',
          imageData,
          buildTranslationPrompt(settings.targetLang, seriesSection, { namedCoords: true }),
          imageDims
        );
      } else if (provider === 'claude') {
        out = await translateImageWithClaude(apiKey, parsed, prompt, imageDims, settings.claudeModel);
      } else if (provider === 'openai') {
        out = await translateImageWithOpenAI(apiKey, imageData, prompt, imageDims, settings.openaiModel);
      } else {
        out = await translateImageWithGemini(apiKey, parsed, prompt, imageDims, settings.geminiModel);
      }
      if (out.length > 0 && cacheKey) {
        await saveCachedTranslation(cacheKey, settings.targetLang, out, provider, activeModel, {
          viaPrefetch: options?.prefetch === true,
        });
      }
      // 翻訳成功時のみカウント（キャッシュヒット・エラー時はカウントしない）
      await incrementApiStats(provider);
      return out;
    })();

    if (dedupKey) inFlightTranslations.set(dedupKey, work);
    try {
      translations = await work;
    } finally {
      if (dedupKey) inFlightTranslations.delete(dedupKey);
    }
    const r = applyLayerB(translations);
    // Phase 4: 翻訳ペアを返す（original/translated の組、layer B 適用前の raw）
    return { translations: r.translations, glossaryHits: r.glossaryHits, pairs: toPairs(translations) };
  } catch (err) {
    // APIキー等の機密情報が含まれないようサニタイズしてから返す
    const safeMsg = err.message
      .replace(/key=[^&\s"]+/gi, 'key=***')
      .replace(/sk-[^\s"]+/g, 'sk-***')
      .substring(0, 200);
    return { error: safeMsg };
  }
}

// 画像データURLからbase64とMIMEタイプを抽出
function parseImageDataUrl(imageDataUrl) {
  const mimeMatch = imageDataUrl.match(/^data:(image\/\w+);base64,/);
  const mimeType = mimeMatch ? mimeMatch[1] : 'image/jpeg';
  const base64Data = imageDataUrl.replace(/^data:image\/\w+;base64,/, '');
  return { mimeType, base64Data };
}

// 全プロバイダー共通の翻訳プロンプト
// namedCoords: 座標を box 配列ではなく x_min/y_min/x_max/y_max で返させる。
// 位置引数の配列だと軸の順序がモデルの流儀に左右される（実測: qwen3-vl は
// [x_min, y_min, x_max, y_max] を返し、Doug の [y_min, x_min, ...] と食い違っていた）。
// Ollama だけこちらを使う（OLLAMA_TRANSLATION_SCHEMA と対）
function buildTranslationPrompt(targetLang, seriesSection = '', { namedCoords = false } = {}) {
  const langName = LANG_NAMES[targetLang] || targetLang;
  const sectionBlock = seriesSection ? `\n\n${seriesSection}` : '';
  const coordSpec = namedCoords
    ? `- x_min, y_min, x_max, y_max: テキスト領域の境界。画像の左上を (0,0)、右下を (1000,1000) とする正規化座標
  - x_min / x_max: 左端・右端
  - y_min / y_max: 上端・下端`
    : `- box: [y_min, x_min, y_max, x_max] — 0〜1000の正規化座標で、テキスト領域の境界を示す
  - y_min: テキスト領域の上端（0=画像上端, 1000=画像下端）
  - x_min: テキスト領域の左端（0=画像左端, 1000=画像右端）
  - y_max: テキスト領域の下端
  - x_max: テキスト領域の右端`;
  const example = namedCoords
    ? `[{"original":"FIVE...?","translated":"5人…？","type":"speech","x_min":30,"y_min":20,"x_max":180,"y_max":80}]`
    : `[{"original":"FIVE...?","translated":"5人…？","type":"speech","box":[20,30,80,180]},{"original":"ROYAL CONSUL...","translated":"王室顧問…","type":"caption","box":[5,10,120,480]}]`;
  return `あなたはコミック翻訳の専門家です。この画像に含まれるすべてのテキストを検出・翻訳してください。${sectionBlock}

【検出ルール】
- 各パネルを上から下、左から右の順にスキャンする
- すべての吹き出し（speech balloon）、キャプション（caption box）、ナレーション、効果音を漏らさず検出する
- 小さな吹き出し、暗い背景上の吹き出し、パネルの端にある吹き出しも見逃さない

各テキスト領域についてJSON配列で返してください:
- original: 元の英語テキスト
- translated: ${langName}への自然な翻訳（短く簡潔に）
- type: "speech" / "caption" / "sfx"
${coordSpec}

翻訳ルール:
- コミックの文脈に合った自然な${langName}にする
- 効果音は表現豊かに翻訳（例: "BOOM" → "ドーン"）
- 感情・トーンを維持する
- 翻訳文は簡潔に。吹き出しに収まる長さにする

座標ルール:
- 吹き出し内のテキスト部分を正確に囲む（尻尾は含めない）
- 隣接する吹き出しの領域が重ならないようにする
- テキストが複数行でも1つの吹き出しは1つのエントリにまとめる

JSON配列のみ返してください:
${example}`;
}

// レスポンスをパースする共通処理
function parseAndLogResults(providerName, content, imageDims) {
  return parseVisionResponse(content, imageDims);
}

// 429リトライ付きfetch（共通）
async function fetchWithRetry(url, options, providerName) {
  let res;
  for (let attempt = 0; attempt < 3; attempt++) {
    res = await fetch(url, options);
    if (res.status !== 429 && res.status !== 503) break;
    await res.text().catch(() => '');
    // Retry-After ヘッダーがあればそれを使用、なければ固定バックオフ
    // 503（高負荷）は短めに待機、429（レート制限）は長めに待機
    const retryAfter = res.headers.get('Retry-After');
    const baseWait = res.status === 503 ? 3000 : 10000;
    const retryAfterSec = Math.min(parseInt(retryAfter, 10) || 0, 60); // 上限60秒
    const wait = retryAfterSec > 0 ? retryAfterSec * 1000 : (attempt + 1) * baseWait;
    // 中断シグナルが渡されている場合はバックオフ待機も打ち切る（signalなしの場合は従来と同一動作）
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, wait);
      const signal = options && options.signal;
      if (!signal) return;
      if (signal.aborted) { clearTimeout(timer); resolve(); return; }
      signal.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
    });
    if (options && options.signal && options.signal.aborted) break;
  }
  // 3回リトライしても失敗の場合、明示的なメッセージで通知
  if (res.status === 429) {
    throw new Error(`${providerName} APIがレート制限中です。しばらく時間をおいてから再度お試しください。`);
  }
  if (res.status === 503) {
    throw new Error(`${providerName} APIが高負荷状態です。しばらく時間をおいてから再度お試しください。`);
  }
  return res;
}

// APIエラーから機密情報を除去して安全なメッセージを抽出
// ※ 2026-07-25 監査 F-3: マスクを JSON 分岐にも適用（maskSecrets は utils/mask-secrets.js）
function extractSafeErrorMessage(errBody) {
  try {
    const parsed = JSON.parse(errBody);
    const msg = parsed?.error?.message || parsed?.error?.type || '';
    if (msg) return maskSecrets(String(msg)).substring(0, 150);
  } catch { /* JSONでない場合はフォールバック */ }
  // 生テキストからAPIキーやURLを除去して短縮
  return maskSecrets(errBody).substring(0, 150);
}

// ============================================================
// Gemini API
// ============================================================
async function translateImageWithGemini(apiKey, parsed, prompt, imageDims, model) {
  const { mimeType, base64Data } = parsed;

  const modelName = model || 'gemini-3.6-flash';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(modelName)}:generateContent`;
  const body = JSON.stringify({
    contents: [{
      parts: [
        { inline_data: { mime_type: mimeType, data: base64Data } },
        { text: prompt },
      ],
    }],
    generationConfig: {
      temperature: 0.2,
      maxOutputTokens: 32000,
    },
  });

  const res = await fetchWithRetry(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': apiKey,
    },
    body,
  }, 'Gemini');

  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    const safeMsg = extractSafeErrorMessage(errBody);
    console.error(`[Doug bg] Gemini APIエラー (${res.status}):`, safeMsg);
    throw new Error(`Gemini API エラー (${res.status}): ${safeMsg}`);
  }

  const data = await res.json();
  const content = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!content) throw new Error('Gemini APIから応答がありません');

  return parseAndLogResults('Gemini', content, imageDims);
}

// ============================================================
// Claude (Anthropic) API
// ============================================================
async function translateImageWithClaude(apiKey, parsed, prompt, imageDims, model) {
  const { mimeType, base64Data } = parsed;

  const url = 'https://api.anthropic.com/v1/messages';
  const body = JSON.stringify({
    model: model || 'claude-sonnet-5',
    max_tokens: 32000,
    messages: [{
      role: 'user',
      content: [
        {
          type: 'image',
          source: {
            type: 'base64',
            media_type: mimeType,
            data: base64Data,
          },
        },
        {
          type: 'text',
          text: prompt,
        },
      ],
    }],
  });

  const res = await fetchWithRetry(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body,
  }, 'Claude');

  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    const safeMsg = extractSafeErrorMessage(errBody);
    console.error(`[Doug bg] Claude APIエラー (${res.status}):`, safeMsg);
    throw new Error(`Claude API エラー (${res.status}): ${safeMsg}`);
  }

  const data = await res.json();
  const content = data.content?.[0]?.text;
  if (!content) throw new Error('Claude APIから応答がありません');

  return parseAndLogResults('Claude', content, imageDims);
}

// ============================================================
// OpenAI (ChatGPT) API
// ============================================================
async function translateImageWithOpenAI(apiKey, imageDataUrl, prompt, imageDims, model) {

  const url = 'https://api.openai.com/v1/chat/completions';
  const body = JSON.stringify({
    model: model || 'gpt-5.6-sol',
    // GPT-5 系（推論モデル）は max_tokens を 400 で拒否する。Chat Completions では
    // max_completion_tokens が正（Claude の /v1/messages は max_tokens のままなので注意）
    max_completion_tokens: 32000,
    messages: [{
      role: 'user',
      content: [
        {
          type: 'image_url',
          image_url: {
            url: imageDataUrl,
          },
        },
        {
          type: 'text',
          text: prompt,
        },
      ],
    }],
  });

  const res = await fetchWithRetry(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body,
  }, 'ChatGPT');

  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    const safeMsg = extractSafeErrorMessage(errBody);
    console.error(`[Doug bg] OpenAI APIエラー (${res.status}):`, safeMsg);
    throw new Error(`ChatGPT API エラー (${res.status}): ${safeMsg}`);
  }

  const data = await res.json();
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error('ChatGPT APIから応答がありません');

  return parseAndLogResults('ChatGPT', content, imageDims);
}

// ============================================================
// Ollama API
// ============================================================
// モデルごとの thinking 対応可否。Service Worker が生きている間は使い回す
const ollamaThinkingCache = new Map();

/**
 * thinking 対応モデルに think:false を送らないと推論に入り実用にならない
 * （実測: 文字の無いアイコン 1 枚で 539.7 秒 → think:false で 0.57 秒）。
 * 判定できないときは false を返して think を送らない（非対応モデルを壊さない）
 */
async function ollamaSupportsThinking(endpoint, model) {
  if (ollamaThinkingCache.has(model)) return ollamaThinkingCache.get(model);
  let thinking = false;
  try {
    const res = await fetch(`${endpoint}/api/show`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model }),
    });
    if (res.ok) thinking = supportsThinking(await res.json());
  } catch { /* 判定できなければ送らない */ }
  ollamaThinkingCache.set(model, thinking);
  return thinking;
}

async function translateImageWithOllama(endpoint, model, imageData, prompt, imageDims) {
  // http/https スキームのみ許可（SSRF 対策 — content.js:95 と対称）
  if (!/^https?:\/\//i.test(endpoint)) {
    throw new Error('Ollama エンドポイントは http:// または https:// で始まる必要があります。');
  }
  // data:image/jpeg;base64, プレフィックスを除去
  const base64Data = imageData.replace(/^data:image\/\w+;base64,/, '');

  const thinking = await ollamaSupportsThinking(endpoint, model);
  let res;
  try {
    res = await fetch(`${endpoint}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(buildOllamaChatBody({ model, prompt, base64: base64Data, thinking })),
    });
  } catch {
    throw new Error('Ollama に接続できません。起動しているか、OLLAMA_ORIGINS が設定されているか確認してください。');
  }

  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    if (res.status === 403) {
      // "*" を勧めない。閲覧中の任意のウェブページからローカルの Ollama を叩けてしまう
      throw new Error('Ollama のアクセスが拒否されました (403)。ターミナルで'
        + '「launchctl setenv OLLAMA_ORIGINS "chrome-extension://*"」を実行して'
        + ' Ollama を再起動してください（Mac の再起動でこの設定は消えます）。');
    }
    if (res.status === 404) {
      throw new Error(`モデル "${model}" がインストールされていません。設定画面でインストールしてください。`);
    }
    const safeMsg = extractSafeErrorMessage(errBody);
    throw new Error(`Ollama エラー (${res.status}): ${safeMsg}`);
  }

  const data = await res.json();
  // qwen3-vl は think:false を送っても答えを thinking に入れ content を空で返す
  const content = pickOllamaResponseText(data.message);
  if (!content) throw new Error('Ollama から応答がありません');

  // 名前付き座標（OLLAMA_TRANSLATION_SCHEMA）を解釈できるのは ollamaParseResponse だけ。
  // parseVisionResponse は box 配列を前提にしており、この経路では 0 件になる
  return ollamaParseResponse(content);
}

// ============================================================
// Phase 7: テキスト専用のプロバイダ呼び出し（解説生成のフォールバック用）
// 画像翻訳の経路（handleImageTranslation）とは独立させる（R-SEC-1a）
// ============================================================

// 解説生成のフォールバック呼び出し全体（設定取得〜応答受信）を打ち切るまでの上限
// （レビュー Important 1: fetchWithRetry の 429/503 バックオフが無制限に伸びるのを防ぐ）
const GLOSS_API_TIMEOUT_MS = 30_000;

/**
 * 設定済みプロバイダにテキストのみのプロンプトを投げ、生の応答文字列を返す。
 * @param {string} prompt
 * @returns {Promise<string|null>} 失敗時は null（例外を投げない）
 */
export async function callTextOnlyProvider(prompt) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), GLOSS_API_TIMEOUT_MS);
  try {
    // getSettings() の失敗も「例外を投げない」契約に含める（try の外だった旧実装は JSDoc と矛盾）
    const settings = await getSettings();
    const provider = settings.apiProvider || 'gemini';

    let apiKey = null;
    if (provider !== 'ollama') {
      apiKey = settings[PROVIDER_KEY_MAP[provider]];
      if (!apiKey) return null;
    }

    if (provider === 'gemini') {
      const model = settings.geminiModel || 'gemini-3.6-flash';
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
      const res = await fetchWithRetry(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          // 解説は identity 110 字 + powers 150 字の日本語 JSON で、本文だけで 512 をほぼ使い切る。
          // 加えて Flash 系は thinking が既定 medium で、その分もこの上限と出力課金に乗る。
          // 512 のままだと finishReason: MAX_TOKENS で candidates ごと欠けて解説が出ない
          generationConfig: { temperature: 0, maxOutputTokens: 4096 },
        }),
        signal: controller.signal,
      }, 'Gemini');
      if (!res.ok) return null;
      const data = await res.json();
      // 打ち切られると parts が欠けるか空文字になる。?? は空文字を素通りさせて
      // 「失敗時は null」の契約を破るので || で倒す（OpenAI 側と対称）
      return data.candidates?.[0]?.content?.parts?.[0]?.text || null;
    }

    if (provider === 'claude') {
      const res = await fetchWithRetry('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          // ブラウザ（拡張機能）オリジンからの直接呼び出しに必須（translateImageWithClaude と対称）
          'anthropic-dangerous-direct-browser-access': 'true',
        },
        body: JSON.stringify({
          model: settings.claudeModel || 'claude-sonnet-5',
          // Claude は extended thinking がオプトインなので推論分は乗らないが、
          // 日本語 260 字の JSON を返すには 512 では余裕が無い（Gemini/OpenAI と同じ理由）
          max_tokens: 4096,
          messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
        }),
        signal: controller.signal,
      }, 'Claude');
      if (!res.ok) return null;
      const data = await res.json();
      return data.content?.[0]?.text || null;
    }

    if (provider === 'openai') {
      const res = await fetchWithRetry('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model: settings.openaiModel || 'gpt-5.6-sol',
          // translateImageWithOpenAI と同じく max_completion_tokens（max_tokens ではない）。
          // GPT-5 系は推論トークンもこの上限に数えるため、512 だと推論だけで使い切って
          // content が空文字で返る（finish_reason: 'length'）。解説 JSON 用に余裕を持たせる
          max_completion_tokens: 4096,
          messages: [{ role: 'user', content: prompt }],
        }),
        signal: controller.signal,
      }, 'ChatGPT');
      if (!res.ok) return null;
      const data = await res.json();
      // 推論だけで上限に達すると content は空文字で返る。?? では素通りして
      // 「失敗時は null」の契約を破るため、空文字も null に倒す
      return data.choices?.[0]?.message?.content || null;
    }

    if (provider === 'ollama') {
      const endpoint = settings.ollamaEndpoint || 'http://localhost:11434';
      // http/https スキームのみ許可（SSRF 対策 — translateImageWithOllama / content.js:95 と対称）
      if (!/^https?:\/\//i.test(endpoint)) return null;
      // translateImageWithOllama と同じく /api/chat + messages 形式（/api/generate ではない）
      const res = await fetchWithRetry(`${endpoint}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: settings.ollamaModel || 'qwen3.6:35b-a3b',
          messages: [{ role: 'user', content: prompt }],
          stream: false,
        }),
        signal: controller.signal,
      }, 'Ollama');
      if (!res.ok) return null;
      const data = await res.json();
      // 画像翻訳側（:452）と同じく thinking も拾う。既定の qwen3.6 を含む thinking 対応モデルは
      // 答えを message.thinking に入れて content を空文字で返すことがあり、
      // content だけを見ていると解説が一度も取れない
      return pickOllamaResponseText(data.message) || null;
    }
  } catch {
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
  return null;
}

