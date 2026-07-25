// content.js - Doug コミック翻訳オーバーレイ
// Gemini/Claude/ChatGPT Vision API 翻訳

(function () {
  'use strict';

  if (window.__dougInitialized) return;
  window.__dougInitialized = true;

  let isTranslating = false;
  let overlayContainer = null;
  let toolbar = null;
  let overlaysVisible = true;
  let autoTranslate = false;
  let autoTranslateTimer = null;

  // v2 Phase 1: 検出されたシリーズ情報（ローカル保持のみ、ストレージ書き込みなし）
  let seriesInfo = null;

  // ============================================================
  // パネルbbox推定定数（フェーズ1チューニング用 — ファイル先頭集約）
  // ============================================================
  const FLOOD_COLOR_THRESHOLD         = 120;  // Flood Fill停止判定・色距離（マンハッタン）
  const CAPTION_FLOOD_COLOR_THRESHOLD = 80;   // caption用（均一背景での過展開を抑制）
  const FILL_AREA_RATIO               = 20;   // 上限: bubbleBboxArea × k
  const PAGE_AREA_MAX_RATIO           = 0.5;  // 上限: pageArea × ratio（見開き2コマ対応で0.4→0.5）
  /* eslint-disable-next-line no-unused-vars */
  const PANEL_IOU_THRESHOLD    = 0.35; // 同一パネル判定（フェーズ2で使用）
  const BBOX_STABLE_STEPS      = 30;   // 安定判定ウィンドウ数
  const BBOX_STABLE_GROWTH_MAX = 0.01; // bbox面積増加率の安定閾値（1%）
  /* eslint-disable-next-line no-unused-vars */
  const PANEL_CROP_PADDING     = 0.07; // crop時のパディング率（フェーズ4で使用）
  const BUBBLE_CROP_PADDING    = 0.15; // 吹き出し単体crop時のパディング率（個別再翻訳）
  const PANEL_HOVER_EXPAND     = 15;   // パネルホバー検出を bbox から ±N% 拡張（吹き出し bbox が小さい場合の補正）
  const SEED_SAMPLE_SIZE       = 5;    // 起点サンプル固定サイズ（5×5）
  const STABLE_CHECK_INTERVAL  = 100;  // 安定判定チェック間隔（ピクセル数、大パネルの早期終了防止で50→100）

  // グループ色パレット（フェーズ2デバッグ可視化用）
  const GROUP_COLORS = [
    [255, 100, 100],  // 赤
    [100, 160, 255],  // 青
    [ 80, 210, 120],  // 緑
    [255, 190,  60],  // 黄
    [190, 100, 255],  // 紫
    [255, 140,  50],  // 橙
    [ 60, 210, 210],  // シアン
    [255, 100, 180],  // ピンク
  ];

  // デバッグ表示用ステート（フェーズ1/2）
  let _lastImageDataUrl = null;
  let _lastTranslations = null;
  let _debugCanvas = null;
  // パネルグループ（フェーズ3）
  let _lastPanelGroups = null;

  // ============================================================
  // Ollama 直接呼び出し（Service Worker タイムアウト回避）
  // content script はページ側で動くため長時間処理でも停止しない
  // ============================================================
  const OLLAMA_LANG_NAMES = {
    ja: '日本語', ko: '韓国語', 'zh-CN': '簡体字中国語', 'zh-TW': '繁体字中国語',
    es: 'スペイン語', fr: 'フランス語', de: 'ドイツ語', pt: 'ポルトガル語',
  };

  function ollamaCleanText(text) {
    if (!text) return text;
    let s = text;
    if (s.startsWith('「') && s.endsWith('」')) s = s.slice(1, -1);
    return s.replace(/。$/, '');
  }

  function ollamaParseResponse(content) {
    const cleaned = content.replace(/```json\s*/g, '').replace(/```\s*/g, '');
    const jsonMatch = cleaned.match(/\[[\s\S]*\]/);
    if (!jsonMatch) return [];

    function removeLineComments(s)           { return s.replace(/(?<!:)\/\/.*$/gm, ''); }
    function removeControlChars(s)           { return s.replace(/[\x00-\x1F\x7F]+/g, ' '); }
    function escapeLooseBackslashes(s)       { return s.replace(/\\(?!["\\\/bfnrtu])/g, '\\\\'); }
    function removeTrailingCommas(s)         { return s.replace(/,(\s*[}\]])/g, '$1'); }
    function addMissingCommasBetweenItems(s) { return s.replace(/([}\]])\s*(["{[])/g, '$1,$2'); }

    const sanitized = [
      removeLineComments,
      removeControlChars,
      escapeLooseBackslashes,
      removeTrailingCommas,
      addMissingCommasBetweenItems,
    ].reduce((s, fn) => fn(s), jsonMatch[0]);

    const candidates = [sanitized, sanitized + '}]', sanitized + '"}]'];
    const lastObj = sanitized.lastIndexOf('},');
    if (lastObj > 0) candidates.push(sanitized.substring(0, lastObj + 1) + ']');

    let results = null;
    for (const candidate of candidates) {
      try { results = JSON.parse(candidate); break; } catch { /* 次の候補へ */ }
    }
    if (!Array.isArray(results)) return [];

    try {
      return results.filter(r => r.translated && (r.box || r.bbox)).map(r => {
        let top, left, width, height;
        if (r.box && Array.isArray(r.box) && r.box.length === 4) {
          const [yMin, xMin, yMax, xMax] = r.box;
          top = (yMin / 1000) * 100; left = (xMin / 1000) * 100;
          width = ((xMax - xMin) / 1000) * 100; height = ((yMax - yMin) / 1000) * 100;
        } else if (r.bbox) {
          const bx = r.bbox.x ?? r.bbox.left ?? 0, by = r.bbox.y ?? r.bbox.top ?? 0;
          const bw = r.bbox.w ?? r.bbox.width ?? 100, bh = r.bbox.h ?? r.bbox.height ?? 50;
          top = (by / 1500) * 100; left = (bx / 1000) * 100;
          width = (bw / 1000) * 100; height = (bh / 1500) * 100;
        }
        const result = { bbox: { top, left, width, height }, original: r.original || '', translated: ollamaCleanText(r.translated), type: r.type || 'speech' };
        return result;
      });
    } catch { return []; }
  }

  // ============================================================
  // utils/prompt-builder.js・utils/glossary-substitute.js のコピー。
  // 変更時は両方同期すること（content.js は classic script のため import 不可）。
  // ============================================================

  // プリセット口調 → 指示文（'auto' は指示なし＝''）
  const TONE_INSTRUCTIONS = {
    auto: '',
    '敬体': '全体的に「です・ます」調で翻訳してください。',
    '常体': '全体的に「だ・である」調で翻訳してください。',
    '硬め': '硬く落ち着いた文体で翻訳してください。',
    '柔らかめ': '柔らかく口語的な文体で翻訳してください。',
  };

  // 用語集をプロンプトに載せる上限
  const GLOSSARY_CAP = 30;

  // 例文をプロンプトに載せる上限（Phase 6）
  const EXAMPLES_CAP = 5;

  function buildSeriesPromptSection({ seriesName, glossaryLangMap, toneStyle, examples } = {}) {
    const entries =
      glossaryLangMap && typeof glossaryLangMap === 'object'
        ? Object.keys(glossaryLangMap)
            .map((orig) => ({ orig, ...glossaryLangMap[orig] }))
            .filter((e) => e.approved === true && typeof e.translated === 'string')
            .sort((a, b) => (b.count ?? 0) - (a.count ?? 0))
            .slice(0, GLOSSARY_CAP)
        : [];

    let toneInstruction = '';
    if (toneStyle && toneStyle !== 'auto') {
      if (Object.prototype.hasOwnProperty.call(TONE_INSTRUCTIONS, toneStyle)) {
        toneInstruction = TONE_INSTRUCTIONS[toneStyle];
      } else {
        toneInstruction = String(toneStyle);
      }
    }

    const exampleList = Array.isArray(examples)
      ? examples
          .filter((e) => e && typeof e.original === 'string' && typeof e.translated === 'string')
          .slice(0, EXAMPLES_CAP)
      : [];

    if (entries.length === 0 && !toneInstruction && exampleList.length === 0) return '';

    const lines = [];
    if (seriesName) lines.push(`このコミックは「${seriesName}」シリーズです。`);
    if (entries.length > 0) {
      lines.push('【用語集】以下の固有名詞は必ずこの訳語を使用してください:');
      entries.forEach((e, i) => lines.push(`${i + 1}. ${e.orig} → ${e.translated}`));
    }
    if (toneInstruction) lines.push(`【訳文の口調】${toneInstruction}`);
    if (exampleList.length > 0) {
      lines.push('【翻訳例】以下の対訳と同じ口調・言い回しで訳してください:');
      exampleList.forEach((e, i) => lines.push(`${i + 1}. ${e.original} → ${e.translated}`));
    }
    return lines.join('\n');
  }

  function escapeRegExp(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function substituteGlossaryTerms(translatedText, originalText, glossaryLangMap) {
    if (typeof translatedText !== 'string' || !glossaryLangMap || typeof glossaryLangMap !== 'object') {
      return { text: translatedText, hits: 0 };
    }
    const terms = Object.keys(glossaryLangMap).filter((orig) => {
      const e = glossaryLangMap[orig];
      return (
        e &&
        e.approved === true &&
        typeof e.translated === 'string' &&
        typeof originalText === 'string' &&
        orig.length > 0 &&
        originalText.includes(orig)
      );
    });
    if (terms.length === 0) return { text: translatedText, hits: 0 };
    terms.sort((a, b) => b.length - a.length);
    const re = new RegExp(terms.map(escapeRegExp).join('|'), 'g');
    let hits = 0;
    const text = translatedText.replace(re, (m) => {
      hits++;
      return glossaryLangMap[m].translated;
    });
    return { text, hits };
  }

  function applyGlossaryPostProcess(translations, glossaryLangMap) {
    if (!Array.isArray(translations) || !glossaryLangMap || typeof glossaryLangMap !== 'object') {
      return { translations, totalHits: 0 };
    }
    let totalHits = 0;
    const out = translations.map((t) => {
      if (!t || typeof t.translated !== 'string') return t;
      const { text, hits } = substituteGlossaryTerms(t.translated, t.original ?? '', glossaryLangMap);
      totalHits += hits;
      return hits > 0 ? { ...t, translated: text } : t;
    });
    return { translations: out, totalHits };
  }

  // ============================================================

  async function translateWithOllamaDirect(imageDataUrl) {
    const settings = await chrome.storage.local.get({
      ollamaModel: 'qwen3.6:35b-a3b',
      ollamaEndpoint: 'http://localhost:11434',
      targetLang: 'ja',
    });
    const { ollamaModel: model, ollamaEndpoint: endpoint, targetLang } = settings;
    // http/https スキームのみ許可（file:// 等によるローカルファイル読み取りを防ぐ）
    if (!/^https?:\/\//i.test(endpoint)) {
      throw new Error('Ollama エンドポイントは http:// または https:// で始まる必要があります。');
    }
    const langName = OLLAMA_LANG_NAMES[targetLang] || targetLang;
    const base64Data = imageDataUrl.replace(/^data:image\/\w+;base64,/, '');

    // 層A/B: シリーズ文脈ロード
    let glossaryLangMap = null;
    let seriesSection = '';
    if (seriesInfo && seriesInfo.seriesId) {
      try {
        const series = await chrome.runtime.sendMessage({ type: 'GET_SERIES', payload: { seriesId: seriesInfo.seriesId } });
        if (series) {
          glossaryLangMap = (series.glossary && series.glossary[targetLang]) || null;
          seriesSection = buildSeriesPromptSection({
            seriesName: series.meta && series.meta.name,
            glossaryLangMap,
            toneStyle: series.tone && series.tone.style,
            examples: series.examples,
          });
        }
      } catch { /* フォールバック */ }
    }

    const sectionBlock = seriesSection ? `\n\n${seriesSection}` : '';
    const prompt = `あなたはコミック翻訳の専門家です。この画像に含まれるすべてのテキストを検出・翻訳してください。${sectionBlock}

【検出ルール】
- 各パネルを上から下、左から右の順にスキャンする
- すべての吹き出し（speech balloon）、キャプション（caption box）、ナレーション、効果音を漏らさず検出する
- 小さな吹き出し、暗い背景上の吹き出し、パネルの端にある吹き出しも見逃さない

各テキスト領域についてJSON配列で返してください:
- original: 元の英語テキスト
- translated: ${langName}への自然な翻訳（短く簡潔に）
- type: "speech" / "caption" / "sfx"
- box: [y_min, x_min, y_max, x_max] — 0〜1000の正規化座標で、テキスト領域の境界を示す
  - y_min: テキスト領域の上端（0=画像上端, 1000=画像下端）
  - x_min: テキスト領域の左端（0=画像左端, 1000=画像右端）
  - y_max: テキスト領域の下端
  - x_max: テキスト領域の右端

翻訳ルール:
- コミックの文脈に合った自然な${langName}にする
- 効果音は表現豊かに翻訳（例: "BOOM" → "ドーン"）
- 感情・トーンを維持する
- 翻訳文は簡潔に。吹き出しに収まる長さにする

boxルール:
- 吹き出し内のテキスト部分を正確に囲む（尻尾は含めない）
- 隣接する吹き出しのboxが重ならないようにする
- テキストが複数行でも1つの吹き出しは1つのエントリにまとめる

JSON配列のみ返してください:
[{"original":"FIVE...?","translated":"5人…？","type":"speech","box":[20,30,80,180]},{"original":"ROYAL CONSUL...","translated":"王室顧問…","type":"caption","box":[5,10,120,480]}]`;

    let res;
    try {
      res = await fetch(`${endpoint}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt, images: [base64Data] }], stream: false }),
      });
    } catch (err) {
      throw new Error(`Ollama への接続に失敗しました（${err.message}）。起動しているか・エンドポイント設定を確認してください。`);
    }
    if (res.status === 403) throw new Error('Ollama のアクセスが拒否されました (403)。OLLAMA_ORIGINS の設定が必要です。');
    if (res.status === 404) throw new Error(`モデル "${model}" がインストールされていません。設定画面でインストールしてください。`);
    if (!res.ok) throw new Error(`Ollama エラー (${res.status})`);
    const data = await res.json();
    const text = data.message?.content;
    if (!text) throw new Error('Ollama から応答がありません');
    const parsed = ollamaParseResponse(text);
    // Phase 4: 翻訳ペア（生データ）を付与
    const pairs = parsed.map(t => ({ original: t.original, translated: t.translated })).filter(p => p.original && p.translated);
    if (glossaryLangMap) {
      const r = applyGlossaryPostProcess(parsed, glossaryLangMap);
      return { translations: r.translations, glossaryHits: r.totalHits, pairs };
    }
    return { translations: parsed, glossaryHits: 0, pairs };
  }

  // ============================================================
  // Vision API 翻訳（画像を直接送信）
  // ============================================================
  async function translateImage(imageDataUrl, imageUrl, forceRefresh = false) {
    // Ollama は content script から直接呼び出す（Service Worker タイムアウト回避）
    const { apiProvider } = await chrome.storage.local.get({ apiProvider: 'gemini' });
    if (apiProvider === 'ollama') {
      return translateWithOllamaDirect(imageDataUrl);
    }

    return new Promise((resolve, reject) => {
      const port = chrome.runtime.connect({ name: 'translate' });
      let settled = false;
      // Service Worker が 30 秒でスリープするのを防ぐため 10 秒ごとに ping
      const keepAliveId = setInterval(() => {
        try { chrome.runtime.sendMessage({ type: 'KEEP_ALIVE' }).catch(() => {}); }
        catch { clearInterval(keepAliveId); handleContextInvalidated(); }
      }, 10000);
      port.postMessage({ type: 'TRANSLATE_IMAGE', imageData: imageDataUrl, imageUrl: imageUrl, forceRefresh, seriesId: seriesInfo && seriesInfo.seriesId ? seriesInfo.seriesId : null });
      port.onMessage.addListener((response) => {
        clearInterval(keepAliveId);
        settled = true;
        port.disconnect();
        if (response.error) reject(new Error(response.error));
        else resolve(response);
      });
      port.onDisconnect.addListener(() => {
        clearInterval(keepAliveId);
        if (settled) return; // 正常解決後の disconnect は無視
        const err = chrome.runtime.lastError;
        const detail = err?.message ? `（${err.message}）` : '';
        reject(new Error(`翻訳接続が切断されました${detail}。ページをリロードして再試行してください。`));
      });
    });
  }

  // ============================================================
  // ツールバー
  // ============================================================
  function createToolbar() {
    if (toolbar) return;

    toolbar = document.createElement('div');
    toolbar.id = 'mut-toolbar';

    // ツールバーボタンをDOM APIで構築（innerHTML回避）
    const translateBtn = document.createElement('button');
    translateBtn.id = 'mut-btn-translate';
    translateBtn.className = 'mut-btn mut-btn-primary';
    translateBtn.title = 'このページを翻訳';
    translateBtn.insertAdjacentHTML('afterbegin',
      '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">' +
      '<path d="M5 8l6 6M4 14l6-6 2-3M2 5h12M7 2l1 3"/>' +
      '<path d="M14 14l3 6 3-6M15.5 18h5"/></svg>');
    translateBtn.append(' 翻訳');

    const autoBtn = document.createElement('button');
    autoBtn.id = 'mut-btn-auto';
    autoBtn.className = 'mut-btn';
    autoBtn.title = '自動翻訳: OFF（クリックでON）';
    autoBtn.insertAdjacentHTML('afterbegin',
      '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">' +
      '<polyline points="17 1 21 5 17 9"/>' +
      '<path d="M3 11V9a4 4 0 0 1 4-4h14"/>' +
      '<polyline points="7 23 3 19 7 15"/>' +
      '<path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg>');
    autoBtn.append(' 自動');

    const toggleBtn = document.createElement('button');
    toggleBtn.id = 'mut-btn-toggle';
    toggleBtn.className = 'mut-btn';
    toggleBtn.title = '翻訳の表示/非表示';
    toggleBtn.style.display = 'none';
    toggleBtn.insertAdjacentHTML('afterbegin',
      '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">' +
      '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>' +
      '<circle cx="12" cy="12" r="3"/></svg>');

    const clearBtn = document.createElement('button');
    clearBtn.id = 'mut-btn-clear';
    clearBtn.className = 'mut-btn';
    clearBtn.title = '翻訳をクリア';
    clearBtn.style.display = 'none';
    clearBtn.insertAdjacentHTML('afterbegin',
      '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">' +
      '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>');

    const debugBtn = document.createElement('button');
    debugBtn.id = 'mut-btn-debug';
    debugBtn.className = 'mut-btn';
    debugBtn.title = 'パネルbboxデバッグ（クリックで表示/非表示）';
    debugBtn.style.display = 'none';
    debugBtn.insertAdjacentHTML('afterbegin',
      '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">' +
      '<rect x="2" y="2" width="9" height="9"/><rect x="13" y="2" width="9" height="9"/>' +
      '<rect x="2" y="13" width="9" height="9"/><rect x="13" y="13" width="9" height="9"/>' +
      '</svg>');

    // v2 Phase 1: シリーズ検出デバッグ表示
    const seriesIndicator = document.createElement('span');
    seriesIndicator.id = 'mut-series-indicator';
    seriesIndicator.className = 'mut-series-indicator mut-series-indicator--none';
    seriesIndicator.textContent = '📚 検出不可';

    toolbar.append(translateBtn, autoBtn, toggleBtn, clearBtn, debugBtn, seriesIndicator);
    const parent = getUIParent();
    parent.appendChild(toolbar);

    // 先読みプログレスバー（画面下部に固定）
    const bar = document.createElement('div');
    bar.id = 'mut-prefetch-bar';
    bar.className = 'mut-prefetch-bar';
    bar.style.display = 'none';
    const fill = document.createElement('div');
    fill.id = 'mut-prefetch-fill';
    fill.className = 'mut-prefetch-fill';
    bar.appendChild(fill);
    parent.appendChild(bar);

    document.getElementById('mut-btn-translate').addEventListener('click', translateCurrentPage);
    document.getElementById('mut-btn-auto').addEventListener('click', toggleAutoTranslate);
    document.getElementById('mut-btn-toggle').addEventListener('click', toggleOverlays);
    document.getElementById('mut-btn-clear').addEventListener('click', clearOverlays);
    document.getElementById('mut-btn-debug').addEventListener('click', () => {
      if (_debugCanvas) {
        clearPanelDebug();
      } else if (_lastImageDataUrl && _lastTranslations) {
        showPanelDebug(_lastImageDataUrl, _lastTranslations);
      }
    });

    makeDraggable(toolbar);

    // v2 Phase 1: ツールバー出現直後にシリーズ検出を実行（fire-and-forget）
    detectAndUpdateSeriesIndicator();
  }

  function makeDraggable(el) {
    el.addEventListener('mousedown', (e) => {
      if (e.target.closest('.mut-btn')) return;
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const startX = e.clientX, startY = e.clientY;
      const origX = rect.left, origY = rect.top;
      const onMove = (e) => {
        el.style.right = 'auto';
        el.style.bottom = 'auto';
        el.style.left = origX + (e.clientX - startX) + 'px';
        el.style.top = origY + (e.clientY - startY) + 'px';
      };
      const onUp = () => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
  }

  function showExtraButtons() {
    document.getElementById('mut-btn-toggle').style.display = '';
    document.getElementById('mut-btn-clear').style.display = '';
    document.getElementById('mut-btn-debug').style.display = '';
  }

  // v2 Phase 1: シリーズインジケーター更新
  function updateSeriesIndicator(info) {
    const el = document.getElementById('mut-series-indicator');
    if (!el) return;
    if (info && info.series) {
      el.className = 'mut-series-indicator';
      const displayName = info.issueNumber != null
        ? `${info.series} #${info.issueNumber}`
        : info.series;
      el.textContent = `📚 ${displayName}`;
      el.title = `source: ${info.source}, confidence: ${info.confidence}`;
    } else {
      el.className = 'mut-series-indicator mut-series-indicator--none';
      el.textContent = '📚 検出不可';
      el.title = '';
    }
  }

  // v2 Phase 1: 現在ページの DETECT_SERIES をリクエストして seriesInfo / インジケーターを更新
  async function detectAndUpdateSeriesIndicator() {
    const payload = {
      title: document.title,
      url: location.href,
      h1: document.querySelector('h1')?.textContent?.trim() || null,
      ogTitle: document.querySelector('meta[property="og:title"]')?.content || null,
    };
    try {
      seriesInfo = await chrome.runtime.sendMessage({ type: 'DETECT_SERIES', payload });
      console.log('[doug] Series detected:', seriesInfo);
      updateSeriesIndicator(seriesInfo);

      // Phase 5: Regex/URL で検出できなければ Nano fallback（後追いでインジケーターを上書き）
      if (!seriesInfo) {
        const nanoResult = await chrome.runtime.sendMessage({ type: 'DETECT_SERIES_NANO', payload });
        if (nanoResult) {
          seriesInfo = nanoResult;
          console.log('[doug] Series detected via Nano:', seriesInfo);
          updateSeriesIndicator(seriesInfo);
        }
      }
    } catch {
      seriesInfo = null;
      updateSeriesIndicator(null);
    }
  }

  // ============================================================
  // コミック画像の検出（カテゴリー優先度 × カテゴリー内最大面積選択）
  // 優先度: Blob URL img（Kindle等）> SVG image（Marvel等）> 通常img > canvas
  // ============================================================
  function findLargestVisibleImage() {
    const minArea = Math.max(200 * 200, window.innerWidth * window.innerHeight * 0.1);

    function bestInGroup(els, type) {
      let best = null;
      let maxArea = 0;
      for (const el of els) {
        const rect = el.getBoundingClientRect();
        if (rect.width < 200 || rect.height < 200) continue;
        // ビューポート外（Kindleの前ページ・次ページ）を除外
        if (rect.left < 0 || rect.left >= window.innerWidth) continue;
        if (rect.top < -rect.height || rect.top >= window.innerHeight) continue;
        const area = rect.width * rect.height;
        // ビューポートの10%未満の要素（バナー等）を除外
        if (area < minArea) continue;
        if (area > maxArea) {
          maxArea = area;
          best = { type, element: el };
        }
      }
      return best;
    }

    const groups = [
      { type: 'img',    els: [...document.querySelectorAll('img')].filter(el => el.src && el.src.startsWith('blob:')) },
      { type: 'svg',    els: [...document.querySelectorAll('svg image')] },
      { type: 'img',    els: [...document.querySelectorAll('img')].filter(el => el.src && !el.src.startsWith('blob:')) },
      { type: 'canvas', els: [...document.querySelectorAll('canvas')] },
    ];

    for (const { type, els } of groups) {
      const result = bestInGroup(els, type);
      if (result) return result;
    }

    return null;
  }

  // ============================================================
  // 画像キャプチャ
  // ============================================================
  async function captureSvgImage(info, preprocess = false) {
    const imageEl = info.element;

    // まずCanvasで既レンダリング済み画像をキャプチャ（URLトークン失効でも動作する）
    try {
      const bitmap = await createImageBitmap(imageEl);
      const MAX_DIM = 1024;
      let w = bitmap.width, h = bitmap.height;
      if (w > MAX_DIM || h > MAX_DIM) {
        const scale = Math.min(MAX_DIM / w, MAX_DIM / h);
        w = Math.round(w * scale);
        h = Math.round(h * scale);
      }
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');
      if (preprocess) ctx.filter = 'contrast(1.4) brightness(1.05)';
      ctx.drawImage(bitmap, 0, 0, w, h);
      ctx.filter = 'none';
      bitmap.close();
      return canvas.toDataURL('image/webp', 0.65);
    } catch {
      // SecurityError (CORS) 等 → URLフェッチにフォールバック
    }

    // URLからフェッチ（フォールバック）
    const imageUrl = imageEl.getAttribute('xlink:href') || imageEl.getAttribute('href');
    if (!imageUrl) throw new Error('コミック画像のURLが取得できません');

    const response = await chrome.runtime.sendMessage({ type: 'FETCH_IMAGE', url: imageUrl });
    if (response.error) {
      if (response.error.includes('401') || response.error.includes('403') || response.error.includes('認証')) {
        throw new Error('画像の認証が切れています。ページを更新（F5）してから再度お試しください。');
      }
      throw new Error(response.error);
    }
    return response.imageData;
  }

  function captureRasterElement(element, preprocess = false) {
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    const srcW = element instanceof HTMLCanvasElement ? element.width : (element.naturalWidth || element.width);
    const srcH = element instanceof HTMLCanvasElement ? element.height : (element.naturalHeight || element.height);
    if (srcW === 0 || srcH === 0) {
      throw new Error('画像サイズが取得できません。画像のロードが完了していない可能性があります。');
    }

    const MAX_DIM = 1024;
    let w = srcW, h = srcH;
    if (w > MAX_DIM || h > MAX_DIM) {
      const scale = Math.min(MAX_DIM / w, MAX_DIM / h);
      w = Math.round(w * scale);
      h = Math.round(h * scale);
    }

    canvas.width = w;
    canvas.height = h;
    try {
      if (preprocess) ctx.filter = 'contrast(1.4) brightness(1.05)';
      ctx.drawImage(element, 0, 0, w, h);
      ctx.filter = 'none';
      return canvas.toDataURL('image/webp', 0.65);
    } catch (err) {
      if (err.name === 'SecurityError') throw err;
      throw new Error(`画像の変換に失敗しました: ${err.message}`);
    }
  }

  async function captureComic(info) {
    const { imagePreprocess = true } = await chrome.storage.local.get({ imagePreprocess: true });
    if (info.type === 'svg') return { imageData: await captureSvgImage(info, imagePreprocess), capturedRect: null };
    try {
      return { imageData: captureRasterElement(info.element, imagePreprocess), capturedRect: null };
    } catch (err) {
      // SecurityError (CORS) → ビューポートキャプチャ + 要素領域クロップにフォールバック
      if (err.name !== 'SecurityError') throw err;
      // img 要素かつ https URL の場合は background.js の fetch を優先する（CDNサブドメイン対応）
      const imgUrl = info.element.tagName === 'IMG'
        ? (info.element.currentSrc || info.element.src || '')
        : '';
      if (imgUrl.startsWith('https://')) {
        const fetchRes = await chrome.runtime.sendMessage({ type: 'FETCH_IMAGE', url: imgUrl });
        if (!fetchRes.error) return { imageData: fetchRes.imageData, capturedRect: null };
      }
      const rect = info.element.getBoundingClientRect();
      // CAPTURE_REGION はビューポートにクリップされた範囲のみ取得するため、
      // capturedRect にクロップ情報を記録してオーバーレイ位置合わせに使用する
      const capturedOffsetY = Math.max(0, -rect.top);
      const visibleTop = Math.max(0, rect.top);
      const capturedHeight = Math.min(rect.top + rect.height, window.innerHeight) - visibleTop;
      const response = await chrome.runtime.sendMessage({
        type: 'CAPTURE_REGION',
        elementRect: {
          x: rect.left,
          y: rect.top,
          width: rect.width,
          height: rect.height,
          dpr: window.devicePixelRatio || 1,
        },
      });
      if (response.error) {
        // 権限不足の場合はポップアップへの誘導メッセージを表示
        if (response.error.includes('all_urls') || response.error.includes('activeTab')) {
          throw new Error('スクリーンキャプチャ権限が必要です。拡張機能アイコンをクリックして「スクリーンキャプチャ権限を追加」ボタンを押してください。');
        }
        throw new Error(response.error);
      }
      return {
        imageData: response.imageData,
        capturedRect: { offsetY: capturedOffsetY, height: capturedHeight },
      };
    }
  }

  function getOverlayTarget(info) {
    return info.element;
  }

  // ============================================================
  // 翻訳メイン処理
  // ============================================================
  async function translateCurrentPage(forceRefresh = false) {
    if (isTranslating) return;

    const comicInfo = findLargestVisibleImage();
    if (!comicInfo) {
      showNotification('コミック画像が見つかりません', 'error');
      return;
    }

    // v2 Phase 1: 翻訳時にも最新の document.title で再検出（SPA でタイトルが変わる場合に追随）
    await detectAndUpdateSeriesIndicator();

    isTranslating = true;
    const btn = document.getElementById('mut-btn-translate');
    btn.classList.add('loading');
    btn.querySelector('svg').style.display = 'none';

    // 翻訳中プログレスバー（赤）を表示
    const bar = document.getElementById('mut-prefetch-bar');
    const fill = document.getElementById('mut-prefetch-fill');
    if (bar && fill) {
      fill.style.background = '#ffd700';
      fill.style.width = '0%';
      bar.style.display = '';
      bar.style.opacity = '';
      bar.classList.add('mut-prefetch-active');
    }

    try {
      showNotification('画像をキャプチャ中...', 'info');
      if (fill) fill.style.width = '30%';
      const { imageData, capturedRect } = await captureComic(comicInfo);

      let imageUrl = null;
      if (comicInfo.type === 'svg' && comicInfo.element) {
        imageUrl = comicInfo.element.getAttribute('xlink:href') || comicInfo.element.getAttribute('href');
      } else if (comicInfo.type === 'img' && comicInfo.element) {
        imageUrl = comicInfo.element.src || null;
      }

      // Gemini Vision でOCR＋翻訳を一括処理
      showNotification('テキストを認識・翻訳中...', 'info');
      if (fill) fill.style.width = '60%';
      const response = await translateImage(imageData, imageUrl, forceRefresh);

      if (!response || response.error) {
        showNotification(response?.error || '翻訳応答がありません', 'error');
        return;
      }

      if (!response.translations || !Array.isArray(response.translations) || response.translations.length === 0) {
        showNotification('翻訳結果がありません', 'warn');
        return;
      }

      if (fill) fill.style.width = '90%';
      await sampleBubbleColors(imageData, response.translations).catch(() => {});
      // フェーズ1: デバッグ用に最終翻訳状態を保存
      _lastImageDataUrl = imageData;
      _lastTranslations = response.translations;
      _lastPanelGroups = null;
      clearPanelDebug();
      const adjustments = imageUrl ? await loadAdjustments(imageUrl) : {};
      const onAdjusted = imageUrl ? (idx, style) => saveAdjustment(imageUrl, idx, style) : null;
      renderOverlays(getOverlayTarget(comicInfo), response.translations, adjustments, onAdjusted, capturedRect);
      showExtraButtons();
      // フェーズ3: パネル再翻訳ボタンを非同期で追加（翻訳表示をブロックしない）
      computePanelGroups(imageData, response.translations).then(pg => {
        _lastPanelGroups = pg;
        console.log('[doug] computePanelGroups result:', pg ? `${pg.groups.length} groups` : 'null');
        if (overlayContainer) addPanelRetranslateButtons(pg);
        else console.log('[doug] overlayContainer is null, skipping addPanelRetranslateButtons');
      }).catch((err) => { console.log('[doug] computePanelGroups error:', err); });

      // v2 Phase 2A: 翻訳成功時にシリーズを記録（seriesInfo が検出済みの場合のみ）
      if (seriesInfo && seriesInfo.seriesId) {
        chrome.runtime.sendMessage({
          type: 'RECORD_SERIES_TRANSLATION',
          payload: {
            seriesId: seriesInfo.seriesId,
            name: seriesInfo.series,
            detectionSource: seriesInfo.source,
            url: location.href,
            glossaryHits: (response && response.glossaryHits) ? response.glossaryHits : 0,
            // Phase 4: 翻訳ペア（生データ）を付与してペアバッファリングに使用
            pairs: (response && Array.isArray(response.pairs)) ? response.pairs : [],
          },
        }).catch(() => { /* 記録失敗は翻訳結果に影響させない */ });
      }

      const message = response.fromCache
        ? `${response.translations.length}件のテキストを表示しました（キャッシュ）`
        : `${response.translations.length}件のテキストを翻訳しました`;
      showNotification(message, 'success');
      // 翻訳・表示完了後に先読みをトリガー（現在ページのAPI処理が終わってから）
      triggerPrefetch(imageUrl);
    } catch (err) {
      showNotification('翻訳に失敗: ' + err.message, 'error');
    } finally {
      isTranslating = false;
      btn.classList.remove('loading');
      btn.querySelector('svg').style.display = '';
      // プログレスバー完了→フェードアウト→色をリセット
      if (bar && fill) {
        fill.style.width = '100%';
        bar.classList.remove('mut-prefetch-active');
        setTimeout(() => {
          bar.style.opacity = '0';
          setTimeout(() => {
            bar.style.display = 'none';
            bar.style.opacity = '';
            fill.style.width = '0%';
            fill.style.background = '';
          }, 400);
        }, 800);
      }
    }
  }

  // ============================================================
  // 先読み翻訳
  // ============================================================
  // PerformanceObserverでコミック画像URLを増分収集
  const comicPageUrls = new Map(); // pathname → full URL

  const perfObserver = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      const url = entry.name;
      // Blob URLはキャッシュキーに使えないためスキップ
      if (url.startsWith('blob:')) continue;
      // 画像系の拡張子のみ収集
      if (!/\.(jpg|jpeg|png|webp)(\?|$)/i.test(url)) continue;
      if (url.includes('/thumbnails/')) continue;
      let p;
      try { p = new URL(url).pathname; } catch { p = url.split('?')[0]; }
      if (!comicPageUrls.has(p)) comicPageUrls.set(p, url);
    }
  });
  perfObserver.observe({ type: 'resource', buffered: true });

  function getComicPageUrls() {
    return Array.from(comicPageUrls.values());
  }

  let lastQueueKey = '';  // 前回送信したキューのキー（重複送信防止）

  // セーフモード先読み用：viewport右外にある最も近いBlob URL imgを返す（count枚）
  // Kindleはスライダー方式（前ページ=left外、現在=center、次ページ=right外）のため
  // DOM順ではなく位置ベースで次ページを特定する
  function findNextBlobImages(count) {
    const vw = window.innerWidth;
    return [...document.querySelectorAll('img')]
      .filter(img => img.src && img.src.startsWith('blob:') && img.complete)
      .map(img => ({ img, left: img.getBoundingClientRect().left }))
      .filter(({ left }) => left >= vw)
      .sort((a, b) => a.left - b.left)
      .slice(0, count)
      .map(({ img }) => img);
  }

  let safeModePreloadTimer = null;

  async function scheduleSafeModeNextPage() {
    clearTimeout(safeModePreloadTimer);
    // prefetch設定を確認（デフォルトOFF）
    const { prefetch } = await chrome.storage.local.get({ prefetch: false });
    if (!prefetch) return;
    safeModePreloadTimer = setTimeout(async () => {
      try {
        const nextImgs = findNextBlobImages(2);
        if (nextImgs.length === 0) return;
        for (const img of nextImgs) {
          // Canvas変換してBase64取得（Blob URLはCORS制限なし）
          const imageData = captureRasterElement(img);
          // background.jsに送信（内部でキャッシュチェック・session保存）
          const port = chrome.runtime.connect({ name: 'translate' });
          port.postMessage({ type: 'TRANSLATE_IMAGE', imageData, imageUrl: img.src, seriesId: seriesInfo && seriesInfo.seriesId ? seriesInfo.seriesId : null });
          port.onMessage.addListener(() => { port.disconnect(); });
          port.onDisconnect.addListener(() => { void chrome.runtime.lastError; });
        }
      } catch(e) {
        console.error('[doug] safeMode prefetch エラー:', e.message);
      }
    }, 2000); // 2秒ディレイ（先読み：APIへの追加アクセスなし、Gemini RPMも安全圏）
  }

  function triggerPrefetch(currentImageUrl) {
    try {
      // Blob URL（Kindle等）はセーフモード先読みフローへ
      if (currentImageUrl && currentImageUrl.startsWith('blob:')) {
        scheduleSafeModeNextPage();
        return;
      }

      const allPages = getComicPageUrls();
      if (allPages.length === 0) return;

      // URLからファイル名部分を抽出（トークンを除去して比較）
      const getFilename = (url) => {
        try { return new URL(url).pathname.split('/').pop(); }
        catch { return url.split('/').pop().split('?')[0]; }
      };

      // 現在のページのindexを特定
      let currentIndex = -1;
      const currentFile = currentImageUrl ? getFilename(currentImageUrl) : null;
      if (currentFile) {
        currentIndex = allPages.findIndex(url => getFilename(url) === currentFile);
      }
      if (currentIndex === -1) return;

      // 優先度付きキュー: 現在ページ → 次2（最大3ページ）
      const queueUrls = [];
      const addIfValid = (idx) => {
        if (idx >= 0 && idx < allPages.length) {
          queueUrls.push(allPages[idx]);
        }
      };

      // 1. 現在ページ
      addIfValid(currentIndex);
      // 2. 次ページ × 2
      for (let i = 1; i <= 2; i++) addIfValid(currentIndex + i);

      if (queueUrls.length === 0) return;

      // 前回と同じキューなら送信スキップ（ファイル名ベースで比較）
      const queueKey = queueUrls.map(u => getFilename(u)).join(',');
      if (queueKey === lastQueueKey) return;
      lastQueueKey = queueKey;

      chrome.runtime.sendMessage({
        type: 'PRELOAD_QUEUE',
        imageUrls: queueUrls,
      }).catch(() => {});
    } catch {
      // 先読みトリガーの失敗は無視
    }
  }

  // ============================================================
  // 吹き出し位置・サイズ調整値の保存・復元
  // ============================================================
  async function getAdjKey(imageUrl) {
    if (!imageUrl) return null;
    let normalized;
    try { const u = new URL(imageUrl); normalized = u.origin + u.pathname; }
    catch { normalized = imageUrl.split('?')[0]; }
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(normalized));
    const hex = Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
    return `adj:${hex.substring(0, 32)}`;
  }

  async function loadAdjustments(imageUrl) {
    try {
      const key = await getAdjKey(imageUrl);
      if (!key) return {};
      const result = await chrome.storage.local.get(key);
      return result[key] || {};
    } catch { return {}; }
  }

  async function saveAdjustment(imageUrl, index, style) {
    try {
      const key = await getAdjKey(imageUrl);
      if (!key) return;
      const result = await chrome.storage.local.get(key);
      const adjs = result[key] || {};
      adjs[index] = style;
      await chrome.storage.local.set({ [key]: adjs });
    } catch { /* context invalidated 等は無視 */ }
  }

  // ============================================================
  // オーバーレイ描画
  // ============================================================
  // LLM が返す CSS 値から url() を除去してネットワーク要求を防ぐ
  function sanitizeCssValue(value) {
    if (typeof value !== 'string') return null;
    const v = value.trim();
    // HEXカラー（3桁または6桁のみ）
    if (/^#[0-9a-fA-F]{3}([0-9a-fA-F]{3})?$/.test(v)) return v;
    // rgb() / rgba()
    if (/^rgba?\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}(\s*,\s*[\d.]+)?\s*\)$/.test(v)) return v;
    // linear-gradient()（方向・HEX・rgb()/rgba()・named color・% のみ許可するホワイトリスト方式）
    if (/^linear-gradient\(\s*(?:to\s+(?:top|bottom|left|right|(?:top|bottom)\s+(?:left|right))|\d+(?:\.\d+)?deg)\s*(?:,\s*(?:#[0-9a-fA-F]{3,6}|rgba?\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}(?:\s*,\s*[\d.]+)?\s*\)|transparent|white|black)(?:\s+\d+%)?\s*)+\)$/i.test(v)) return v;
    // 安全な名前付き色
    if (/^(transparent|white|black|none)$/.test(v)) return v;
    return null;
  }

  // 背景色(CSS値)から少し暗くしたボーダー色を生成
  // 背景色から適切なテキスト色（白 or 黒）を返す
  // HEX文字列（3桁・6桁・8桁）を6桁HEXに正規化して返す。不正な場合は null
  function normalizeHex(hex) {
    if (hex.length === 4) {
      return '#' + hex[1] + hex[1] + hex[2] + hex[2] + hex[3] + hex[3];
    }
    if (hex.length === 7) return hex;
    if (hex.length === 9) return hex.slice(0, 7); // アルファを除去
    return null;
  }

  function getContrastColor(cssValue) {
    const match = cssValue.match(/#[0-9a-fA-F]{3,8}/);
    if (!match) return null;
    const hex6 = normalizeHex(match[0]);
    if (!hex6) return null;
    const r = parseInt(hex6.slice(1, 3), 16);
    const g = parseInt(hex6.slice(3, 5), 16);
    const b = parseInt(hex6.slice(5, 7), 16);
    if (isNaN(r) || isNaN(g) || isNaN(b)) return null;
    // WCAG相対輝度（0.299/0.587/0.114 近似）
    const luminance = 0.299 * r + 0.587 * g + 0.114 * b;
    return luminance < 128 ? 'white' : 'black';
  }

  function darkenColor(cssValue) {
    // linear-gradient の場合、最初のHEXを抽出
    const match = cssValue.match(/#[0-9a-fA-F]{3,8}/);
    if (!match) return null;
    const hex6 = normalizeHex(match[0]);
    if (!hex6) return null;
    // hex → RGB → 30%暗く → hex
    const r = parseInt(hex6.slice(1, 3), 16);
    const g = parseInt(hex6.slice(3, 5), 16);
    const b = parseInt(hex6.slice(5, 7), 16);
    if (isNaN(r) || isNaN(g) || isNaN(b)) return null;
    const d = (v) => Math.round(v * 0.7).toString(16).padStart(2, '0');
    return `#${d(r)}${d(g)}${d(b)}`;
  }

  // 0-255 の数値を 2桁 hex 文字列に変換
  function toHex(n) { return Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0'); }

  // テキスト bbox 内側から吹き出しの塗り色を取得（hex 文字列 or null）
  // 暗いピクセル（テキスト・枠線）を輝度フィルタで除外し、残った明るいピクセルの最頻色を返す
  function sampleBackground(ctx, x1, y1, x2, y2) {
    const w = x2 - x1;
    const h = y2 - y1;
    if (!(w >= 1) || !(h >= 1)) return null;
    const data = ctx.getImageData(x1, y1, w, h).data;
    const hist = {};
    let count = 0;
    const STEP = 2;
    for (let ly = 0; ly < h; ly += STEP) {
      for (let lx = 0; lx < w; lx += STEP) {
        const idx = (ly * w + lx) * 4;
        if (data[idx + 3] < 10) continue;
        const r = data[idx], g = data[idx + 1], b = data[idx + 2];
        // 暗いピクセル（黒テキスト・枠線）を除外
        const lum = 0.299 * r + 0.587 * g + 0.114 * b;
        if (lum < 40) continue;
        const key = ((r >> 2) << 12) | ((g >> 2) << 6) | (b >> 2);
        if (!hist[key]) hist[key] = { rSum: 0, gSum: 0, bSum: 0, count: 0 };
        hist[key].rSum += r; hist[key].gSum += g; hist[key].bSum += b;
        hist[key].count++;
        count++;
      }
    }
    if (count < 5) return null;
    const best = Object.values(hist).reduce((a, b) => a.count >= b.count ? a : b);
    if (best.count / count < 0.20) return null;
    return `#${toHex(best.rSum / best.count)}${toHex(best.gSum / best.count)}${toHex(best.bSum / best.count)}`;
  }

  // 拡張 bbox（ex1/ey1/ex2/ey2）の外縁から枠線色を取得
  // 吹き出しの枠線は拡張領域の外縁付近に位置するため、内縁ではなく外縁をスキャンする
  function sampleBorder(ctx, ex1, ey1, ex2, ey2, bgHex) {
    const bgR = parseInt(bgHex.slice(1, 3), 16);
    const bgG = parseInt(bgHex.slice(3, 5), 16);
    const bgB = parseInt(bgHex.slice(5, 7), 16);
    const bgLum = 0.299 * bgR + 0.587 * bgG + 0.114 * bgB;
    const SCAN = 3;
    const ew = ex2 - ex1;
    const eh = ey2 - ey1;
    if (!(ew >= 1) || !(eh >= 1)) return null;  // NaN も排除
    // 拡張領域を一括取得（sampleBackground と同領域なのでキャッシュ効果あり）
    const data = ctx.getImageData(ex1, ey1, ew, eh).data;
    const candidates = [];
    const STEP = 4;
    // 上下辺（各 SCAN 行）
    for (let lx = 0; lx < ew; lx += STEP) {
      for (let dy = 0; dy < Math.min(SCAN, eh); dy++) {
        for (const ly of [dy, eh - 1 - dy]) {
          if (ly < 0) continue;
          const idx = (ly * ew + lx) * 4;
          if (data[idx + 3] < 10) continue;
          const lum = 0.299 * data[idx] + 0.587 * data[idx + 1] + 0.114 * data[idx + 2];
          if (Math.abs(lum - bgLum) > 40) candidates.push({ r: data[idx], g: data[idx + 1], b: data[idx + 2], lum });
        }
      }
    }
    // 左右辺（各 SCAN 列）
    for (let ly = SCAN; ly < eh - SCAN; ly += STEP) {
      for (let dx = 0; dx < Math.min(SCAN, ew); dx++) {
        for (const lx of [dx, ew - 1 - dx]) {
          if (lx < 0) continue;
          const idx = (ly * ew + lx) * 4;
          if (data[idx + 3] < 10) continue;
          const lum = 0.299 * data[idx] + 0.587 * data[idx + 1] + 0.114 * data[idx + 2];
          if (Math.abs(lum - bgLum) > 40) candidates.push({ r: data[idx], g: data[idx + 1], b: data[idx + 2], lum });
        }
      }
    }
    if (candidates.length < 3) return null;
    candidates.sort((a, b) => a.lum - b.lum);
    const dark = candidates.slice(0, Math.ceil(candidates.length / 3));
    const n = dark.length;
    const avg = dark.reduce((acc, c) => ({ r: acc.r + c.r, g: acc.g + c.g, b: acc.b + c.b }), { r: 0, g: 0, b: 0 });
    return `#${toHex(avg.r / n)}${toHex(avg.g / n)}${toHex(avg.b / n)}`;
  }

  // imageDataUrl の Canvas から各 item の bbox ピクセルをサンプリングして
  // item.background / item.border を付与する
  async function sampleBubbleColors(imageDataUrl, items) {
    if (!imageDataUrl || !items || items.length === 0) return;
    let img;
    try {
      img = await new Promise((resolve, reject) => {
        const i = new Image();
        i.onload = () => resolve(i);
        i.onerror = reject;
        i.src = imageDataUrl;
      });
    } catch { return; }

    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0);
    const W = canvas.width;
    const H = canvas.height;

    try {
      for (const item of items) {
        if (!item.bbox || item.type === 'sfx') continue;
        // bbox は % 単位（0–100）→ ピクセル座標に変換
        const x1 = Math.round((item.bbox.left / 100) * W);
        const y1 = Math.round((item.bbox.top / 100) * H);
        const x2 = Math.round(((item.bbox.left + item.bbox.width) / 100) * W);
        const y2 = Math.round(((item.bbox.top + item.bbox.height) / 100) * H);
        // NaN や無効座標（bbox プロパティが欠落している場合）はスキップ
        if (!isFinite(x1) || !isFinite(y1) || !isFinite(x2) || !isFinite(y2) || x2 <= x1 || y2 <= y1) continue;

        const bg = sampleBackground(ctx, x1, y1, x2, y2);
        if (bg) {
          item.background = bg;
          // 枠線スキャン用に bbox を 20% 拡張した領域を計算
          const padX = Math.max(3, Math.round((x2 - x1) * 0.20));
          const padY = Math.max(3, Math.round((y2 - y1) * 0.20));
          const ex1 = Math.max(0, x1 - padX);
          const ey1 = Math.max(0, y1 - padY);
          const ex2 = Math.min(W, x2 + padX);
          const ey2 = Math.min(H, y2 + padY);
          item.border = sampleBorder(ctx, ex1, ey1, ex2, ey2, bg) || darkenColor(bg) || undefined;
        }
      }
    } catch { /* サンプリング失敗時も翻訳表示は継続 */ }
  }

  // ============================================================
  // Flood Fill — パネルbbox推定（フェーズ1）
  // ============================================================

  // Flood Fill起点（seed）を決定する
  // data: ImageData.data（Uint8ClampedArray）, W/H: 画像サイズ
  // bboxPx: { x1, y1, x2, y2 } 吹き出しピクセル座標
  // 返値: { seedX, seedY, seedColor: {r,g,b} } または null
  function findFloodSeed(data, W, H, bboxPx) {
    const { x1, y1, x2, y2 } = bboxPx;
    const cx = Math.round((x1 + x2) / 2);
    const cy = Math.round((y1 + y2) / 2);
    const half = Math.floor(SEED_SAMPLE_SIZE / 2); // 2

    const sx = Math.max(0, cx - half);
    const sy = Math.max(0, cy - half);
    const ex = Math.min(W - 1, cx + half);
    const ey = Math.min(H - 1, cy + half);

    const pixels = [];
    for (let py = sy; py <= ey; py++) {
      for (let px = sx; px <= ex; px++) {
        const idx = (py * W + px) * 4;
        if (data[idx + 3] < 10) continue;
        const r = data[idx], g = data[idx + 1], b = data[idx + 2];
        const lum = 0.299 * r + 0.587 * g + 0.114 * b;
        pixels.push({ px, py, r, g, b, lum });
      }
    }
    if (pixels.length === 0) return null;

    // 輝度上位50%を候補として絞り込む
    pixels.sort((a, b) => b.lum - a.lum);
    const candidates = pixels.slice(0, Math.max(1, Math.ceil(pixels.length * 0.5)));

    // Medoid: 全候補とのマンハッタン距離合計が最小のピクセルの色を内部色とする（O(n²)、n≤25固定）
    let medoidColor = candidates[0];
    let minTotalDist = Infinity;
    for (const a of candidates) {
      let dist = 0;
      for (const b of candidates) {
        dist += Math.abs(a.r - b.r) + Math.abs(a.g - b.g) + Math.abs(a.b - b.b);
      }
      if (dist < minTotalDist) { minTotalDist = dist; medoidColor = a; }
    }

    // Medoid色に最も近く、輝度 >= 40（濃いグレー・カラーテキストも除外）ピクセルをseedとする
    let bestDist = Infinity;
    let seed = null;
    for (const p of candidates) {
      if (p.lum < 40) continue;
      const d = Math.abs(p.r - medoidColor.r) + Math.abs(p.g - medoidColor.g) + Math.abs(p.b - medoidColor.b);
      if (d < bestDist) { bestDist = d; seed = p; }
    }
    // 候補内になければ全ピクセルから次点を探す
    if (!seed) {
      for (const p of pixels.slice(candidates.length)) {
        if (p.lum >= 40) { seed = p; break; }
      }
    }
    if (!seed) return null;

    return { seedX: seed.px, seedY: seed.py, seedColor: { r: seed.r, g: seed.g, b: seed.b } };
  }

  // イテレーティブBFSでFlood Fillを実行しパネルbboxを推定する
  // data: ImageData.data, W/H: 画像サイズ, seedX/Y: 起点座標
  // seedColor: {r,g,b}, bubbleBboxPx: {x1,y1,x2,y2} 吹き出しのピクセルbbox（上限計算用）
  // colorThreshold: 色距離停止閾値（省略時は FLOOD_COLOR_THRESHOLD、caption は低値を渡す）
  // 返値: { x1, y1, x2, y2 } ピクセル座標
  function floodFillPanel(data, W, H, seedX, seedY, seedColor, bubbleBboxPx, colorThreshold = FLOOD_COLOR_THRESHOLD) {
    const { r: r0, g: g0, b: b0 } = seedColor;
    const pageArea = W * H;
    const bubbleArea = Math.max(
      (bubbleBboxPx.x2 - bubbleBboxPx.x1) * (bubbleBboxPx.y2 - bubbleBboxPx.y1),
      1
    );
    const maxFillPixels = Math.min(bubbleArea * FILL_AREA_RATIO, pageArea * PAGE_AREA_MAX_RATIO);
    const queueSize = Math.min(Math.ceil(pageArea * 0.5), pageArea);

    const visited = new Uint8Array(W * H);
    // TypedArray キューでオブジェクト配列より高速に処理
    const qX = new Int32Array(queueSize);
    const qY = new Int32Array(queueSize);
    let head = 0, tail = 0;

    const enqueue = (x, y) => { if (tail < queueSize) { qX[tail] = x; qY[tail] = y; tail++; } };
    enqueue(seedX, seedY);
    visited[seedY * W + seedX] = 1;

    let filledCount = 0;
    let minX = seedX, maxX = seedX, minY = seedY, maxY = seedY;
    let bndTop = false, bndBottom = false, bndLeft = false, bndRight = false;

    // 安定判定用循環バッファ（BBOX_STABLE_STEPS 個の bbox 面積を保持）
    const stableWindow = new Float32Array(BBOX_STABLE_STEPS);
    let stableIdx = 0;

    // 方向: 左・右・上・下
    const DX = [-1, 1, 0, 0];
    const DY = [ 0, 0,-1, 1];

    let shouldStop = false;
    while (head < tail && !shouldStop) {
      if (filledCount >= maxFillPixels) break;

      const x = qX[head], y = qY[head]; head++;
      filledCount++;

      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;

      // STABLE_CHECK_INTERVAL ピクセルごとに安定判定
      if (filledCount % STABLE_CHECK_INTERVAL === 0) {
        const bboxArea = (maxX - minX + 1) * (maxY - minY + 1);
        const slotIdx = stableIdx % BBOX_STABLE_STEPS;
        if (stableIdx >= BBOX_STABLE_STEPS) {
          // 現在スロット位置には BBOX_STABLE_STEPS 周期前の値が残っている
          const oldest = stableWindow[slotIdx];
          const growthRate = oldest > 0 ? (bboxArea - oldest) / oldest : 1;
          if (growthRate < BBOX_STABLE_GROWTH_MAX) {
            const sides = (bndTop ? 1 : 0) + (bndBottom ? 1 : 0) + (bndLeft ? 1 : 0) + (bndRight ? 1 : 0);
            if (sides >= 3) shouldStop = true;
          }
        }
        stableWindow[slotIdx] = bboxArea;
        stableIdx++;
      }
      if (shouldStop) break;

      for (let d = 0; d < 4; d++) {
        const nx = x + DX[d];
        const ny = y + DY[d];

        // 画像外 → 境界辺を記録してスキップ
        if (nx < 0 || nx >= W || ny < 0 || ny >= H) {
          if (d === 0) bndLeft = true;
          if (d === 1) bndRight = true;
          if (d === 2) bndTop = true;
          if (d === 3) bndBottom = true;
          continue;
        }

        const nIdx = ny * W + nx;
        if (visited[nIdx]) continue;
        visited[nIdx] = 1; // 訪問済みをマーク（重複展開防止）

        const pIdx = nIdx * 4;
        const colorDist = Math.abs(data[pIdx] - r0) + Math.abs(data[pIdx + 1] - g0) + Math.abs(data[pIdx + 2] - b0);
        if (colorDist > colorThreshold) {
          // 色距離超過 → 境界と判定、展開しない
          if (d === 0) bndLeft = true;
          if (d === 1) bndRight = true;
          if (d === 2) bndTop = true;
          if (d === 3) bndBottom = true;
          continue;
        }

        enqueue(nx, ny);
      }
    }

    return { x1: minX, y1: minY, x2: maxX, y2: maxY };
  }

  // ============================================================
  // フェーズ2 — 同一パネルグルーピング
  // ============================================================

  // 2つのパネルbboxが同一パネルか判定する
  // a, b: { x1, y1, x2, y2 } ピクセル座標
  function isSamePanel(a, b) {
    const interX1 = Math.max(a.x1, b.x1);
    const interY1 = Math.max(a.y1, b.y1);
    const interX2 = Math.min(a.x2, b.x2);
    const interY2 = Math.min(a.y2, b.y2);
    const interArea = Math.max(0, interX2 - interX1) * Math.max(0, interY2 - interY1);

    const aArea = Math.max((a.x2 - a.x1) * (a.y2 - a.y1), 1);
    const bArea = Math.max((b.x2 - b.x1) * (b.y2 - b.y1), 1);
    const unionArea = Math.max(aArea + bArea - interArea, 1);
    const iou = interArea / unionArea;

    // Primary: IoU ≥ PANEL_IOU_THRESHOLD
    if (iou >= PANEL_IOU_THRESHOLD) return true;

    // Fallback: IoU 0.15〜PANEL_IOU_THRESHOLD のグレーゾーン複合判定
    if (iou >= 0.15) {
      const aCx = (a.x1 + a.x2) / 2, aCy = (a.y1 + a.y2) / 2;
      const bCx = (b.x1 + b.x2) / 2, bCy = (b.y1 + b.y2) / 2;
      const centerDist = Math.sqrt((aCx - bCx) ** 2 + (aCy - bCy) ** 2);
      const minW = Math.min(a.x2 - a.x1, b.x2 - b.x1);
      const overlapRatio = interArea / Math.min(aArea, bArea);
      if (centerDist < minW * 0.5 && overlapRatio > 0.3) return true;
    }

    return false;
  }

  // panelBboxes 配列を同一パネル判定でグルーピングする（Union-Find）
  // 返値: 各インデックスのグループID配列（find後の正規化済みルートID）
  function groupBubblesByPanel(panelBboxes) {
    const n = panelBboxes.length;
    const parent = Array.from({ length: n }, (_, i) => i);

    function find(i) {
      while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; }
      return i;
    }
    function union(i, j) {
      const ri = find(i), rj = find(j);
      if (ri !== rj) parent[ri] = rj;
    }

    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        if (isSamePanel(panelBboxes[i], panelBboxes[j])) union(i, j);
      }
    }

    return Array.from({ length: n }, (_, i) => find(i));
  }

  // ============================================================
  // フェーズ3: パネルグループ計算（flood fill + グルーピング共通処理）
  // ============================================================
  // imageDataUrl から各 bubble の flood fill を実行してグループ化する
  // 返値: { W, H, groups: Array<{ groupId, members, unionBboxPx, unionBboxPct }> }
  //   members: Array<{ item, bubbleBboxPx, seedX, seedY, seedColor, panelBboxPx }>
  //   unionBboxPct: { left, top, width, height } — % 単位（overlayContainer の % 位置指定に直結）
  async function computePanelGroups(imageDataUrl, translations) {
    if (!imageDataUrl || !translations || translations.length === 0) return null;

    let img;
    try {
      img = await new Promise((resolve, reject) => {
        const i = new Image();
        i.onload = () => resolve(i);
        i.onerror = reject;
        i.src = imageDataUrl;
      });
    } catch { return null; }

    const W = img.naturalWidth;
    const H = img.naturalHeight;
    if (W === 0 || H === 0) return null;

    const srcCanvas = document.createElement('canvas');
    srcCanvas.width = W; srcCanvas.height = H;
    const srcCtx = srcCanvas.getContext('2d', { willReadFrequently: true });
    srcCtx.drawImage(img, 0, 0);
    const data = srcCtx.getImageData(0, 0, W, H).data;

    const validItems = translations.filter(item =>
      item.bbox && item.type !== 'sfx' &&
      isFinite(item.bbox.top) && isFinite(item.bbox.left) &&
      isFinite(item.bbox.width) && isFinite(item.bbox.height) &&
      item.bbox.width > 0 && item.bbox.height > 0
    );

    // Flood fill 結果を収集
    const allMembers = [];
    for (const item of validItems) {
      const bx1 = Math.round((item.bbox.left / 100) * W);
      const by1 = Math.round((item.bbox.top / 100) * H);
      const bx2 = Math.round(((item.bbox.left + item.bbox.width) / 100) * W);
      const by2 = Math.round(((item.bbox.top + item.bbox.height) / 100) * H);
      if (bx2 <= bx1 || by2 <= by1) continue;

      const bubbleBboxPx = { x1: bx1, y1: by1, x2: bx2, y2: by2 };
      const seedResult = findFloodSeed(data, W, H, bubbleBboxPx);
      if (!seedResult) continue;

      const { seedX, seedY, seedColor } = seedResult;
      const threshold = item.type === 'caption' ? CAPTION_FLOOD_COLOR_THRESHOLD : FLOOD_COLOR_THRESHOLD;
      const panelBboxPx = floodFillPanel(data, W, H, seedX, seedY, seedColor, bubbleBboxPx, threshold);
      allMembers.push({ item, bubbleBboxPx, seedX, seedY, seedColor, panelBboxPx });
    }

    if (allMembers.length === 0) return { W, H, groups: [] };

    // グルーピング（Union-Find）
    const rawGroupIds = groupBubblesByPanel(allMembers.map(m => m.panelBboxPx));

    // gid → 連番カラーインデックス + グループデータ集約
    const groupMap = new Map();
    allMembers.forEach((m, i) => {
      const gid = rawGroupIds[i];
      if (!groupMap.has(gid)) {
        groupMap.set(gid, { members: [], unionBboxPx: { ...m.panelBboxPx } });
      }
      const g = groupMap.get(gid);
      g.members.push(m);
      g.unionBboxPx.x1 = Math.min(g.unionBboxPx.x1, m.panelBboxPx.x1);
      g.unionBboxPx.y1 = Math.min(g.unionBboxPx.y1, m.panelBboxPx.y1);
      g.unionBboxPx.x2 = Math.max(g.unionBboxPx.x2, m.panelBboxPx.x2);
      g.unionBboxPx.y2 = Math.max(g.unionBboxPx.y2, m.panelBboxPx.y2);
    });

    let colorIdx = 0;
    const groups = [];
    for (const g of groupMap.values()) {
      const { x1, y1, x2, y2 } = g.unionBboxPx;
      groups.push({
        groupId: colorIdx++,
        members: g.members,
        unionBboxPx: g.unionBboxPx,
        unionBboxPct: {
          left:   x1 / W * 100,
          top:    y1 / H * 100,
          width:  (x2 - x1) / W * 100,
          height: (y2 - y1) / H * 100,
        },
      });
    }

    return { W, H, groups };
  }

  // ============================================================
  // パネルbboxデバッグ可視化（フェーズ2: グループ色分け）
  // overlayContainer上にキャンバスを追加してseed・bbox・色見本を表示
  // ============================================================
  async function showPanelDebug(imageDataUrl, translations) {
    clearPanelDebug();
    if (!overlayContainer || !imageDataUrl || !translations || translations.length === 0) return;

    // flood fill + グルーピング（キャッシュがあれば再利用）
    const pgResult = _lastPanelGroups || await computePanelGroups(imageDataUrl, translations);
    if (!pgResult || pgResult.groups.length === 0) return;

    const { W, H, groups } = pgResult;

    // デバッグキャンバスを overlayContainer に合わせて生成
    const cW = overlayContainer.clientWidth;
    const cH = overlayContainer.clientHeight;
    if (cW === 0 || cH === 0) return;

    _debugCanvas = document.createElement('canvas');
    _debugCanvas.width = cW;
    _debugCanvas.height = cH;
    Object.assign(_debugCanvas.style, {
      position: 'absolute',
      top: '0', left: '0',
      width: '100%', height: '100%',
      pointerEvents: 'none',
      zIndex: '1000',
    });
    const ctx = _debugCanvas.getContext('2d');

    // 画像ピクセル → コンテナCSSpx のスケール
    const scaleX = cW / W;
    const scaleY = cH / H;

    // グループunion bbox を色付き塗り + 枠線で描画（背面）
    for (const group of groups) {
      const [cr, cg, cb] = GROUP_COLORS[group.groupId % GROUP_COLORS.length];
      const { x1, y1, x2, y2 } = group.unionBboxPx;
      ctx.save();
      ctx.fillStyle = `rgba(${cr},${cg},${cb},0.15)`;
      ctx.fillRect(x1 * scaleX, y1 * scaleY, (x2 - x1) * scaleX, (y2 - y1) * scaleY);
      ctx.strokeStyle = `rgba(${cr},${cg},${cb},0.75)`;
      ctx.lineWidth = 2.5;
      ctx.strokeRect(x1 * scaleX, y1 * scaleY, (x2 - x1) * scaleX, (y2 - y1) * scaleY);
      ctx.restore();
    }

    // bubble bbox・seed・スウォッチをグループ色で描画（前面）
    for (const group of groups) {
      const [cr, cg, cb] = GROUP_COLORS[group.groupId % GROUP_COLORS.length];
      for (const m of group.members) {
        const { bubbleBboxPx: bb, seedX, seedY, seedColor } = m;

        // 吹き出しbbox（グループ色・破線）
        ctx.save();
        ctx.strokeStyle = `rgba(${cr},${cg},${cb},0.9)`;
        ctx.lineWidth = 1.5;
        ctx.setLineDash([4, 4]);
        ctx.strokeRect(bb.x1 * scaleX, bb.y1 * scaleY, (bb.x2 - bb.x1) * scaleX, (bb.y2 - bb.y1) * scaleY);
        ctx.restore();

        // seed（グループ色の点 + 黒縁）
        const sx = seedX * scaleX;
        const sy = seedY * scaleY;
        ctx.save();
        ctx.beginPath();
        ctx.arc(sx, sy, 4, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(${cr},${cg},${cb},1)`;
        ctx.fill();
        ctx.strokeStyle = 'rgba(0,0,0,0.8)';
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.restore();

        // 内部色スウォッチ（seed 右上 12×12px）
        const swX = Math.min(sx + 8, cW - 14);
        const swY = Math.max(sy - 20, 2);
        ctx.save();
        ctx.fillStyle = `rgb(${seedColor.r},${seedColor.g},${seedColor.b})`;
        ctx.fillRect(swX, swY, 12, 12);
        ctx.strokeStyle = 'rgba(0,0,0,0.7)';
        ctx.lineWidth = 1;
        ctx.strokeRect(swX, swY, 12, 12);
        ctx.restore();
      }
    }

    overlayContainer.appendChild(_debugCanvas);
  }

  function clearPanelDebug() {
    if (_debugCanvas) {
      if (_debugCanvas.parentNode) _debugCanvas.remove();
      _debugCanvas = null;
    }
  }

  // ============================================================
  // フェーズ3: パネル再翻訳ボタンを overlayContainer に追加
  // mousemove で各パネル bbox 内にカーソルがあるか判定して表示/非表示を切り替える
  // ============================================================
  function addPanelRetranslateButtons(pgResult) {
    if (!overlayContainer || !pgResult || pgResult.groups.length === 0) {
      console.log('[doug] addPanelRetranslateButtons early return:', { hasContainer: !!overlayContainer, hasPgResult: !!pgResult, groupsLen: pgResult?.groups?.length });
      return;
    }
    console.log('[doug] addPanelRetranslateButtons: adding buttons for', pgResult.groups.length, 'groups');

    const btns = [];

    for (const group of pgResult.groups) {
      const { left, top, width, height } = group.unionBboxPct;
      // ホバー検出用（PANEL_HOVER_EXPAND分拡張、0〜100にクランプ）
      const hLeft   = Math.max(0,   left - PANEL_HOVER_EXPAND);
      const hTop    = Math.max(0,   top  - PANEL_HOVER_EXPAND);
      const hRight  = Math.min(100, left + width  + PANEL_HOVER_EXPAND);
      const hBottom = Math.min(100, top  + height + PANEL_HOVER_EXPAND);

      // ボタン（位置は mousemove で動的に設定）
      const btn = document.createElement('button');
      btn.className = 'mut-panel-retranslate-btn';
      btn.title = 'このパネルを再翻訳';
      btn.dataset.groupId = String(group.groupId);
      // 初期位置はオフスクリーン（mousemove 前に見えないようにするため）
      btn.style.left = '-100px';
      btn.style.top  = '-100px';
      btn.insertAdjacentHTML('afterbegin',
        '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">' +
        '<path d="M23 4v6h-6"/>' +
        '<path d="M1 20v-6h6"/>' +
        '<path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>' +
        '</svg>');

      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        retranslatePanel(group, pgResult.W, pgResult.H);
      });

      overlayContainer.appendChild(btn);
      // bbox 中心座標（距離比較用）
      const cx = left + width  / 2;
      const cy = top  + height / 2;
      btns.push({ btn, hbox: { left: hLeft, top: hTop, right: hRight, bottom: hBottom }, cx, cy });
    }

    // マウス位置でボタン表示/非表示
    // カーソルがパネル hbox に入った瞬間の座標にボタンを固定（sticky position）
    let currentGroupId = null;
    const panelMoveHandler = (e) => {
      if (!overlayContainer) return;
      const cr = overlayContainer.getBoundingClientRect();
      if (cr.width === 0 || cr.height === 0) return;
      const relX = (e.clientX - cr.left) / cr.width  * 100;
      const relY = (e.clientY - cr.top)  / cr.height * 100;

      // hbox 内にあるパネルのうち bbox 中心が最も近い1つを選択
      let bestEntry = null;
      let bestDist  = Infinity;
      for (const entry of btns) {
        const { hbox, cx, cy } = entry;
        if (relX >= hbox.left && relX <= hbox.right &&
            relY >= hbox.top  && relY <= hbox.bottom) {
          const d = (relX - cx) ** 2 + (relY - cy) ** 2;
          if (d < bestDist) { bestDist = d; bestEntry = entry; }
        }
      }

      const newGid = bestEntry ? bestEntry.btn.dataset.groupId : null;
      if (newGid !== currentGroupId) {
        currentGroupId = newGid;
        for (const { btn } of btns) btn.classList.remove('mut-panel-btn-visible');
        if (bestEntry) {
          // 吹き出しクラスターの中心に固定配置（カーソル位置に依存しない）
          bestEntry.btn.style.left      = bestEntry.cx + '%';
          bestEntry.btn.style.top       = bestEntry.cy + '%';
          bestEntry.btn.style.transform = 'translate(-50%, -50%)';
          bestEntry.btn.classList.add('mut-panel-btn-visible');
        }
      }
    };
    document.addEventListener('mousemove', panelMoveHandler, { passive: true });

    // クリーンアップを既存の _cleanup に合成
    const prevCleanup = overlayContainer._cleanup;
    overlayContainer._cleanup = () => {
      prevCleanup?.();
      document.removeEventListener('mousemove', panelMoveHandler);
    };
  }

  // ============================================================
  // フェーズ4: パネル crop / 座標変換 / マージ / 再翻訳
  // ============================================================

  // パネル bbox を PANEL_CROP_PADDING 分拡張して canvas で crop する（非同期）
  // img.onload を待ってから drawImage する必要があるため Promise を返す
  // 返値: Promise<{ dataUrl: string, cropBox: {x1,y1,x2,y2} } | null>
  function cropPanelImage(imageDataUrl, group, W, H) {
    return new Promise((resolve) => {
      if (!imageDataUrl || !group || !group.unionBboxPx) { resolve(null); return; }
      const { x1, y1, x2, y2 } = group.unionBboxPx;
      const panelW = x2 - x1;
      const panelH = y2 - y1;
      const padX = panelW * PANEL_CROP_PADDING;
      const padY = panelH * PANEL_CROP_PADDING;
      const cropX1 = Math.max(0, Math.round(x1 - padX));
      const cropY1 = Math.max(0, Math.round(y1 - padY));
      const cropX2 = Math.min(W, Math.round(x2 + padX));
      const cropY2 = Math.min(H, Math.round(y2 + padY));
      const cropW  = cropX2 - cropX1;
      const cropH  = cropY2 - cropY1;
      if (cropW <= 0 || cropH <= 0) { resolve(null); return; }

      const img = new Image();
      img.onload = () => {
        try {
          const canvas = document.createElement('canvas');
          canvas.width  = cropW;
          canvas.height = cropH;
          canvas.getContext('2d').drawImage(img, cropX1, cropY1, cropW, cropH, 0, 0, cropW, cropH);
          resolve({ dataUrl: canvas.toDataURL('image/jpeg', 0.92), cropBox: { x1: cropX1, y1: cropY1, x2: cropX2, y2: cropY2 } });
        } catch { resolve(null); }
      };
      img.onerror = () => resolve(null);
      img.src = imageDataUrl;
    });
  }

  // transformBboxToFullPage — utils/panel-utils.js と同一内容（IIFE制約のためコピー）
  // utils/panel-utils.js 側を変更した場合はこちらも必ず同期すること
  function transformBboxToFullPage(cropBbox, cropBox, W, H) {
    const cropW = cropBox.x2 - cropBox.x1;
    const cropH = cropBox.y2 - cropBox.y1;
    return {
      left:   (cropBox.x1 + cropBbox.left   / 100 * cropW) / W * 100,
      top:    (cropBox.y1 + cropBbox.top    / 100 * cropH) / H * 100,
      width:  cropBbox.width  / 100 * cropW / W * 100,
      height: cropBbox.height / 100 * cropH / H * 100,
    };
  }

  // mergeTranslations / calcIou — utils/panel-utils.js と同一内容（IIFE制約のためコピー）
  function mergeTranslations(existing, incoming) {
    const result = existing.slice();
    const changedIndices = new Set();
    for (const newItem of incoming) {
      if (!newItem.bbox) { result.push(newItem); changedIndices.add(result.length - 1); continue; }
      let bestIdx = -1, bestIou = 0;
      for (let i = 0; i < result.length; i++) {
        if (!result[i].bbox) continue;
        const iou = calcIou(result[i].bbox, newItem.bbox);
        if (iou >= 0.3 && iou > bestIou) { bestIou = iou; bestIdx = i; }
      }
      if (bestIdx >= 0) {
        result[bestIdx] = newItem; changedIndices.add(bestIdx);
      } else {
        result.push(newItem); changedIndices.add(result.length - 1);
      }
    }
    return { translations: result, changedIndices };
  }

  function calcIou(a, b) {
    const ax2 = a.left + a.width,  ay2 = a.top + a.height;
    const bx2 = b.left + b.width,  by2 = b.top + b.height;
    const ix1 = Math.max(a.left, b.left), iy1 = Math.max(a.top, b.top);
    const ix2 = Math.min(ax2, bx2),       iy2 = Math.min(ay2, by2);
    const inter = Math.max(0, ix2 - ix1) * Math.max(0, iy2 - iy1);
    if (inter === 0) return 0;
    const union = a.width * a.height + b.width * b.height - inter;
    return union <= 0 ? 0 : inter / union;
  }

  // changedIndices のオーバーレイに黄色ハイライトを付与し、3秒後フェードアウト
  // 新規追加分（既存 DOM に対応する data-index がない）はオーバーレイ要素を生成して追加
  function addRetranslatedOverlays(container, translations, changedIndices) {
    if (!container || !translations || !changedIndices || changedIndices.size === 0) return;

    for (const idx of changedIndices) {
      const item = translations[idx];
      if (!item || !item.bbox) continue;

      // 既存 DOM 要素を data-index で探す
      const existing = container.querySelector(`.mut-overlay[data-index="${idx}"]`);

      if (existing) {
        // 置き換え対象: テキストを更新してハイライト
        const textEl = existing.querySelector('.mut-overlay-text');
        const origEl = existing.querySelector('.mut-overlay-original');
        if (textEl) textEl.textContent = item.translated;
        if (origEl) origEl.textContent = item.original;
        // 即時黄色表示（transition なし）
        existing.classList.add('mut-retranslated');
        // 3秒後: transition を追加してからクラスを削除（フェードアウト）
        setTimeout(() => {
          if (textEl) textEl.style.transition = 'background-color 1s ease';
          existing.classList.remove('mut-retranslated');
          // transition 完了後にインラインスタイルをクリーンアップ
          setTimeout(() => {
            if (textEl) textEl.style.transition = '';
          }, 1100);
        }, 3000);
      } else {
        // 新規追加: オーバーレイ要素を生成（renderOverlays と同じスタイル適用）
        const overlay = document.createElement('div');
        const safeType = (item.type || 'speech').replace(/[^a-z0-9-]/gi, '') || 'speech';
        overlay.className = `mut-overlay mut-type-${safeType} mut-retranslated`;
        overlay.dataset.index = idx;
        const { left, top, width, height } = item.bbox;
        Object.assign(overlay.style, {
          position: 'absolute',
          top:    top    + '%',
          left:   left   + '%',
          width:  width  + '%',
          height: height + '%',
          pointerEvents: 'auto',
        });
        const textEl = document.createElement('div');
        textEl.className = 'mut-overlay-text';
        textEl.textContent = item.translated;
        // AI が返す background / border を適用（sanitizeCssValue は content.js 内で定義済み）
        const safeBg     = sanitizeCssValue(item.background);
        const safeBorder = sanitizeCssValue(item.border);
        if (safeBg) {
          textEl.style.background = safeBg;
          const contrastColor = getContrastColor(safeBg);
          if (contrastColor) textEl.style.color = contrastColor;
          const borderColor = safeBorder || darkenColor(safeBg);
          if (borderColor) textEl.style.border = `2px solid ${borderColor}`;
        } else if (safeBorder) {
          textEl.style.border = `2px solid ${safeBorder}`;
        }
        overlay.appendChild(textEl);
        const origEl = document.createElement('div');
        origEl.className = 'mut-overlay-original';
        origEl.textContent = item.original;
        overlay.appendChild(origEl);
        // 吹き出し単体再翻訳ボタン
        overlay.appendChild(createBubbleRetranslateButton(idx));
        container.appendChild(overlay);
        setTimeout(() => {
          if (textEl) textEl.style.transition = 'background-color 1s ease';
          overlay.classList.remove('mut-retranslated');
          setTimeout(() => {
            if (textEl) textEl.style.transition = '';
          }, 1100);
        }, 3000);
      }
    }
  }

  // パネル再翻訳のオーケストレーター
  // group: computePanelGroups の groups[] の1要素
  // W, H: フル画像のピクセルサイズ（_lastPanelGroups.W / H）
  async function retranslatePanel(group, W, H) {
    if (isTranslating) return;
    if (!_lastImageDataUrl || !_lastTranslations) {
      showNotification('翻訳データがありません。先にページ全体を翻訳してください。', 'warn');
      return;
    }

    isTranslating = true;
    try {
      // 1. crop（Promise を返すため await が必要）
      const cropResult = await cropPanelImage(_lastImageDataUrl, group, W, H);
      if (!cropResult) {
        showNotification('パネルの切り抜きに失敗しました', 'error');
        return;
      }
      const { dataUrl: cropDataUrl, cropBox } = cropResult;

      // 2. 翻訳（既存パイプライン流用、キャッシュ無効）
      const response = await translateImage(cropDataUrl, null, true);
      if (!response || response.error) {
        showNotification(response?.error || '翻訳応答がありません', 'error');
        return;
      }

      // 3. 0件チェック
      const rawItems = response.translations;
      if (!rawItems || rawItems.length === 0) {
        showNotification('このパネルにはテキストが見つかりませんでした', 'info');
        return;
      }

      // 4. 座標変換（crop % → フルページ %）
      const incoming = rawItems.map(item => ({
        ...item,
        bbox: item.bbox ? transformBboxToFullPage(item.bbox, cropBox, W, H) : item.bbox,
      }));

      // 5. マージ
      const { translations: merged, changedIndices } = mergeTranslations(_lastTranslations, incoming);

      // 6. 状態更新
      _lastTranslations = merged;

      // 7. オーバーレイ追加・更新
      if (overlayContainer) {
        addRetranslatedOverlays(overlayContainer, merged, changedIndices);
      }

      // 8. 通知
      showNotification(`${changedIndices.size}件のテキストを追加しました`, 'success');
    } catch (err) {
      showNotification('翻訳に失敗: ' + err.message, 'error');
    } finally {
      isTranslating = false;
    }
  }

  // ============================================================
  // 吹き出し単体の再翻訳
  // ============================================================

  // bboxPct(%): { left, top, width, height } 単一吹き出しを crop する
  // 返値: Promise<{ dataUrl, cropBox:{x1,y1,x2,y2}, W, H } | null>
  function cropBubbleImage(imageDataUrl, bboxPct, paddingRatio = BUBBLE_CROP_PADDING) {
    return new Promise((resolve) => {
      if (!imageDataUrl || !bboxPct) { resolve(null); return; }
      const img = new Image();
      img.onload = () => {
        try {
          const W = img.naturalWidth, H = img.naturalHeight;
          const x1px = (bboxPct.left / 100) * W;
          const y1px = (bboxPct.top  / 100) * H;
          const wpx  = (bboxPct.width  / 100) * W;
          const hpx  = (bboxPct.height / 100) * H;
          const padX = wpx * paddingRatio;
          const padY = hpx * paddingRatio;
          const cropX1 = Math.max(0, Math.round(x1px - padX));
          const cropY1 = Math.max(0, Math.round(y1px - padY));
          const cropX2 = Math.min(W, Math.round(x1px + wpx + padX));
          const cropY2 = Math.min(H, Math.round(y1px + hpx + padY));
          const cropW  = cropX2 - cropX1;
          const cropH  = cropY2 - cropY1;
          if (cropW <= 0 || cropH <= 0) { resolve(null); return; }
          const canvas = document.createElement('canvas');
          canvas.width  = cropW;
          canvas.height = cropH;
          canvas.getContext('2d').drawImage(img, cropX1, cropY1, cropW, cropH, 0, 0, cropW, cropH);
          resolve({ dataUrl: canvas.toDataURL('image/jpeg', 0.92), cropBox: { x1: cropX1, y1: cropY1, x2: cropX2, y2: cropY2 }, W, H });
        } catch { resolve(null); }
      };
      img.onerror = () => resolve(null);
      img.src = imageDataUrl;
    });
  }

  // 単一の吹き出し（_lastTranslations[origIndex]）を再翻訳して該当オーバーレイを更新する
  async function retranslateBubble(origIndex) {
    if (isTranslating) return;
    if (!_lastImageDataUrl || !_lastTranslations) {
      showNotification('翻訳データがありません。先にページ全体を翻訳してください。', 'warn');
      return;
    }
    const item = _lastTranslations[origIndex];
    if (!item || !item.bbox) {
      showNotification('対象の吹き出しが見つかりません', 'error');
      return;
    }

    isTranslating = true;
    try {
      const cropResult = await cropBubbleImage(_lastImageDataUrl, item.bbox);
      if (!cropResult) {
        showNotification('吹き出しの切り抜きに失敗しました', 'error');
        return;
      }
      const { dataUrl: cropDataUrl, cropBox, W, H } = cropResult;

      const response = await translateImage(cropDataUrl, null, true);
      if (!response || response.error) {
        showNotification(response?.error || '翻訳応答がありません', 'error');
        return;
      }

      const rawItems = response.translations;
      if (!rawItems || rawItems.length === 0) {
        showNotification('テキストが見つかりませんでした', 'info');
        return;
      }

      const incoming = rawItems.map(it => ({
        ...it,
        bbox: it.bbox ? transformBboxToFullPage(it.bbox, cropBox, W, H) : it.bbox,
      }));

      // 元 bbox に最も近い結果を1件選び、テキストのみ差し替える
      // （単体再翻訳は「この吹き出しの訳文だけ更新」が目的。
      //   AI が返す微妙にズレた bbox を採用すると旧位置の原文が露出するため、
      //   位置は元のままに固定する）
      let best = null;
      let bestIou = -1;
      for (const it of incoming) {
        if (!it.bbox) continue;
        const iou = calcIou(item.bbox, it.bbox);
        if (iou > bestIou) { bestIou = iou; best = it; }
      }
      if (!best) best = incoming[0];
      // bbox は元の overlay のものを温存
      best = { ...best, bbox: item.bbox };

      const merged = _lastTranslations.slice();
      merged[origIndex] = best;
      const changedIndices = new Set([origIndex]);
      _lastTranslations = merged;

      if (overlayContainer) {
        // 既存 DOM を残したまま addRetranslatedOverlays に渡すと、
        // 既存 overlay のテキスト更新 + ハイライトのパスに乗る（位置は維持される）
        addRetranslatedOverlays(overlayContainer, merged, changedIndices);
      }

      showNotification('テキストを更新しました', 'success');
    } catch (err) {
      showNotification('翻訳に失敗: ' + err.message, 'error');
    } finally {
      isTranslating = false;
    }
  }

  // 吹き出し単体再翻訳ボタン要素を生成（オーバーレイの子として追加する）
  function createBubbleRetranslateButton(origIndex) {
    const btn = document.createElement('button');
    btn.className = 'mut-bubble-retranslate-btn';
    btn.title = 'この吹き出しを再翻訳';
    btn.insertAdjacentHTML('afterbegin',
      '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">' +
      '<path d="M23 4v6h-6"/>' +
      '<path d="M1 20v-6h6"/>' +
      '<path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>' +
      '</svg>');
    // ドラッグ起動を抑止（overlay の mousedown ハンドラに到達させない）
    btn.addEventListener('mousedown', (e) => e.stopPropagation());
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      retranslateBubble(origIndex);
    });
    return btn;
  }

  function renderOverlays(targetEl, translations, adjustments = {}, onAdjusted = null, capturedRect = null) {
    if (!targetEl || !translations) return;
    clearOverlays();
    const rect = targetEl.getBoundingClientRect();

    // CAPTURE_REGION 使用時はビューポートにクリップされた範囲のみキャプチャしているため、
    // capturedRect がある場合はその範囲をコンテナに使用してオーバーレイ位置を合わせる
    const containerTop = capturedRect ? rect.top + capturedRect.offsetY : rect.top;
    const containerHeight = capturedRect ? capturedRect.height : rect.height;

    overlayContainer = document.createElement('div');
    overlayContainer.id = 'mut-overlay-container';
    Object.assign(overlayContainer.style, {
      position: 'fixed',
      top: containerTop + 'px',
      left: rect.left + 'px',
      width: rect.width + 'px',
      height: containerHeight + 'px',
      pointerEvents: 'none',
      zIndex: '99998',
      overflow: 'hidden',
    });

    // 各アイテムのbbox（%単位）を計算し、重なりを検出してから描画
    const expandRateX = 0.20; // 左右20%拡大
    const expandRateY = 0.35; // 上下35%拡大（日本語は縦に長くなりやすいため多めに確保）
    const layoutItems = translations
      .map((item, origIndex) => ({ ...item, origIndex }))
      .filter(item => item.bbox && item.bbox.top != null && item.bbox.left != null && item.type !== 'sfx')
      .map(item => {
        const expandX = (item.bbox.width || 5) * expandRateX;
        const expandY = (item.bbox.height || 5) * expandRateY;
        let top = (item.bbox.top || 0) - expandY;
        let left = (item.bbox.left || 0) - expandX;
        let bboxW = (item.bbox.width || 5) + expandX * 2;
        let bboxH = (item.bbox.height || 5) + expandY * 2;
        // 画像範囲内にクランプ
        if (top < 0) { bboxH += top; top = 0; }
        if (left < 0) { bboxW += left; left = 0; }
        if (left + bboxW > 100) bboxW = 100 - left;
        if (top + bboxH > 100) bboxH = 100 - top;
        return { ...item, layout: { top, left, width: bboxW, height: bboxH } };
      });

    // 重なり検出：垂直方向に重なる場合、上下を縮小（O(n²)のため50件で打ち切り、最大3パス）
    const overlapLimit = Math.min(layoutItems.length, 50);
    for (let pass = 0; pass < 3; pass++) {
      let hadOverlap = false;
      for (let i = 0; i < overlapLimit; i++) {
        for (let j = i + 1; j < overlapLimit; j++) {
          const a = layoutItems[i].layout;
          const b = layoutItems[j].layout;
          // 水平方向に重なりがあるか
          const hOverlap = a.left < b.left + b.width && a.left + a.width > b.left;
          if (!hOverlap) continue;
          // 垂直方向の重なり量
          const aBottom = a.top + a.height;
          const bBottom = b.top + b.height;
          const vOverlap = Math.min(aBottom, bBottom) - Math.max(a.top, b.top);
          if (vOverlap <= 0) continue;
          hadOverlap = true;
          // 重なりを半分ずつ縮小
          const half = vOverlap / 2 + 0.3; // 0.3%の余白
          if (a.top < b.top) {
            a.height -= half;
            b.top += half;
            b.height -= half;
          } else {
            b.height -= half;
            a.top += half;
            a.height -= half;
          }
        }
      }
      if (!hadOverlap) break;
    }

    layoutItems.forEach((item, index) => {
      const overlay = document.createElement('div');
      // type を英数字・ハイフンのみに制限してクラス名インジェクションを防ぐ
      const safeType = (item.type || 'speech').replace(/[^a-z0-9-]/gi, '') || 'speech';
      overlay.className = `mut-overlay mut-type-${safeType}`;
      overlay.dataset.index = item.origIndex;  // 再翻訳時の特定用
      const { top, left, width, height } = item.layout;
      Object.assign(overlay.style, {
        position: 'absolute',
        top: top + '%',
        left: left + '%',
        width: width + '%',
        height: height + '%',
        pointerEvents: 'auto',
      });
      // 保存済み調整値があれば上書き適用
      const adj = adjustments[index];
      if (adj) {
        if (adj.top != null)    overlay.style.top    = adj.top;
        if (adj.left != null)   overlay.style.left   = adj.left;
        if (adj.width != null)  overlay.style.width  = adj.width;
        if (adj.height != null) overlay.style.height = adj.height;
      }

      const textEl = document.createElement('div');
      textEl.className = 'mut-overlay-text';
      textEl.textContent = item.translated;
      // LLM 応答の CSS 値を sanitize（url() によるネットワーク要求を防ぐ）
      const safeBg = sanitizeCssValue(item.background);
      const safeBorder = sanitizeCssValue(item.border);
      if (safeBg) {
        textEl.style.background = safeBg;
        // 背景色のコントラストに応じてテキスト色を設定（黒背景→白文字）
        const contrastColor = getContrastColor(safeBg);
        if (contrastColor) textEl.style.color = contrastColor;
        // 背景色からボーダー色を自動生成（少し暗くした色）
        const borderColor = safeBorder || darkenColor(safeBg);
        if (borderColor) {
          textEl.style.border = `2px solid ${borderColor}`;
        }
      } else if (safeBorder) {
        textEl.style.border = `2px solid ${safeBorder}`;
      }
      overlay.appendChild(textEl);

      const origEl = document.createElement('div');
      origEl.className = 'mut-overlay-original';
      origEl.textContent = item.original;
      overlay.appendChild(origEl);

      const resizeHandle = document.createElement('div');
      resizeHandle.className = 'mut-resize-handle';
      overlay.appendChild(resizeHandle);

      // 吹き出し単体再翻訳ボタン（ホバーで右上に表示）
      overlay.appendChild(createBubbleRetranslateButton(item.origIndex));

      makeDraggableResizable(overlay, resizeHandle, index, onAdjusted);
      overlayContainer.appendChild(overlay);
    });

    // 再翻訳ボタン（右下にホバーで表示）
    const reloadBtn = document.createElement('button');
    reloadBtn.className = 'mut-reload-btn';
    reloadBtn.title = 'ページを再翻訳';
    reloadBtn.insertAdjacentHTML('afterbegin',
      '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">' +
      '<path d="M23 4v6h-6"/>' +
      '<path d="M1 20v-6h6"/>' +
      '<path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>' +
      '</svg>');
    reloadBtn.addEventListener('click', () => translateCurrentPage(true));
    overlayContainer.appendChild(reloadBtn);

    getUIParent().appendChild(overlayContainer);
    overlaysVisible = true;
    // ブラウザのレイアウト確定後にフォントフィットを実行
    requestAnimationFrame(() => fitAllOverlayText());
    observePosition(targetEl, capturedRect);
  }

  function makeDraggableResizable(overlay, resizeHandle, index = 0, onAdjusted = null) {
    const getContainerRect = () => overlayContainer.getBoundingClientRect();

    // ドラッグで移動
    overlay.addEventListener('mousedown', (e) => {
      if (e.target === resizeHandle) return;
      e.preventDefault();
      e.stopPropagation();
      overlay.dataset.dragging = '1';
      const rect = getContainerRect();
      const startX = e.clientX, startY = e.clientY;
      const startLeft = parseFloat(overlay.style.left);
      const startTop = parseFloat(overlay.style.top);
      const onMove = (e) => {
        overlay.style.left = Math.max(0, startLeft + (e.clientX - startX) / rect.width * 100) + '%';
        overlay.style.top  = Math.max(0, startTop  + (e.clientY - startY) / rect.height * 100) + '%';
      };
      const onUp = () => {
        delete overlay.dataset.dragging;
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        if (onAdjusted) onAdjusted(index, {
          top: overlay.style.top, left: overlay.style.left,
          width: overlay.style.width, height: overlay.style.height,
        });
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });

    // 右下ハンドルでリサイズ
    resizeHandle.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const rect = getContainerRect();
      const startX = e.clientX, startY = e.clientY;
      const startW = parseFloat(overlay.style.width);
      const startH = parseFloat(overlay.style.height);
      const onMove = (e) => {
        overlay.style.width  = Math.max(5, startW + (e.clientX - startX) / rect.width  * 100) + '%';
        overlay.style.height = Math.max(3, startH + (e.clientY - startY) / rect.height * 100) + '%';
      };
      const onUp = () => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        requestAnimationFrame(() => fitAllOverlayText());
        if (onAdjusted) onAdjusted(index, {
          top: overlay.style.top, left: overlay.style.left,
          width: overlay.style.width, height: overlay.style.height,
        });
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
  }

  function fitAllOverlayText() {
    if (!overlayContainer) return;
    const overlays = overlayContainer.querySelectorAll('.mut-overlay');

    // フェーズ1: 読み取り（ボックスサイズ取得）+ 初期フォントサイズ設定
    const items = [];
    overlays.forEach((overlay) => {
      const textEl = overlay.querySelector('.mut-overlay-text');
      if (!textEl) return;
      const boxW = overlay.clientWidth;
      const boxH = overlay.clientHeight;
      if (boxW === 0 || boxH === 0) return;
      // padding(5px*2)+border(2px*2)=14px 水平、padding(5px*2)+border(2px*2)=14px 垂直
      const innerW = Math.max(boxW - 18, 10);
      const innerH = Math.max(boxH - 14, 10);
      const charCount = (textEl.textContent || '').length;
      // 0.58: 日本語は英語より文字幅が大きいため保守的な初期値にする
      let fontSize = Math.min(Math.sqrt((innerW * innerH) / Math.max(charCount, 1)) * 0.58, 16);
      fontSize = Math.max(fontSize, 11);
      textEl.style.fontSize = fontSize + 'px';
      items.push({ overlay, textEl, boxW, boxH, fontSize });
    });

    // フェーズ2: 読み取り→書き込みを要素ごとに縮小（バッチ化で最小限のリフロー）
    for (const item of items) {
      for (let i = 0; i < 30; i++) {
        if (item.textEl.scrollWidth <= item.boxW + 1 && item.textEl.scrollHeight <= item.boxH + 1) break;
        item.fontSize -= 0.3;
        if (item.fontSize < 11) break;
        item.textEl.style.fontSize = item.fontSize + 'px';
      }
      // フィット後に15%縮小して余裕を確保（最低11px）
      const relaxed = Math.max(item.fontSize * 0.85, 11);
      item.textEl.style.fontSize = relaxed + 'px';
    }

    // フェーズ3: テキストがボックスに収まらない場合にボックスを拡大
    const cW = overlayContainer.clientWidth || 1;
    const cH = overlayContainer.clientHeight || 1;
    for (const item of items) {
      // 現在の left/top を取得（%文字列→数値）
      const curLeft = parseFloat(item.overlay.style.left) || 0;
      const curTop  = parseFloat(item.overlay.style.top)  || 0;
      // 高さ拡大: height:auto でテキストが増えた場合は常に拡大
      if (item.textEl.scrollHeight > item.boxH + 1) {
        const newH = (item.textEl.scrollHeight + 8) / cH * 100;
        item.overlay.style.height = Math.min(newH, 100 - curTop) + '%';
      }
      // 幅拡大: 最小フォントでも幅が足りない場合のみ拡大
      if (item.fontSize <= 12 && item.textEl.scrollWidth > item.boxW + 1) {
        const newW = (item.textEl.scrollWidth + 8) / cW * 100;
        item.overlay.style.width = Math.min(newW, 100 - curLeft) + '%';
      }
      // 折り返し過多チェック: 1行に伸ばしたときの自然幅がボックスの2倍を超える場合は幅を広げる
      item.textEl.style.whiteSpace = 'nowrap';
      const naturalW = item.textEl.scrollWidth;
      item.textEl.style.whiteSpace = '';
      if (naturalW > item.boxW * 1.5) {
        const targetW = Math.min(naturalW + 10, cW * 0.30, cW - item.overlay.offsetLeft);
        item.overlay.style.width = (targetW / cW * 100) + '%';
      }
    }
  }

  function observePosition(targetEl, capturedRect = null) {
    function updatePosition() {
      if (!overlayContainer) return;
      const rect = targetEl.getBoundingClientRect();
      const containerTop = capturedRect ? rect.top + capturedRect.offsetY : rect.top;
      const containerHeight = capturedRect ? capturedRect.height : rect.height;
      Object.assign(overlayContainer.style, {
        top: containerTop + 'px',
        left: rect.left + 'px',
        width: rect.width + 'px',
        height: containerHeight + 'px',
      });
    }
    updatePosition();
    const resizeObserver = new ResizeObserver(() => updatePosition());
    resizeObserver.observe(targetEl);
    const scrollHandler = () => updatePosition();
    window.addEventListener('scroll', scrollHandler, { passive: true });
    window.addEventListener('resize', scrollHandler, { passive: true });

    // マウス位置でリロードボタンを表示/非表示
    let reloadHideTimer = null;
    const mouseMoveHandler = (e) => {
      if (!overlayContainer) return;
      const btn = overlayContainer.querySelector('.mut-reload-btn');
      if (!btn) return;
      const r = targetEl.getBoundingClientRect();
      const inRect = e.clientX >= r.left && e.clientX <= r.right &&
                     e.clientY >= r.top  && e.clientY <= r.bottom;
      if (inRect) {
        clearTimeout(reloadHideTimer);
        btn.classList.add('mut-reload-visible');
      } else {
        clearTimeout(reloadHideTimer);
        reloadHideTimer = setTimeout(() => btn.classList.remove('mut-reload-visible'), 300);
      }
    };
    document.addEventListener('mousemove', mouseMoveHandler, { passive: true });

    overlayContainer._cleanup = () => {
      resizeObserver.disconnect();
      window.removeEventListener('scroll', scrollHandler);
      window.removeEventListener('resize', scrollHandler);
      document.removeEventListener('mousemove', mouseMoveHandler);
      clearTimeout(reloadHideTimer);
    };
  }

  function toggleOverlays() {
    if (!overlayContainer) return;
    overlaysVisible = !overlaysVisible;
    overlayContainer.style.display = overlaysVisible ? '' : 'none';
  }

  function clearOverlays() {
    clearPanelDebug();
    _lastPanelGroups = null;
    if (overlayContainer) {
      if (overlayContainer._cleanup) overlayContainer._cleanup();
      overlayContainer.remove();
      overlayContainer = null;
    }
    const toggleBtn = document.getElementById('mut-btn-toggle');
    const clearBtn = document.getElementById('mut-btn-clear');
    const debugBtn = document.getElementById('mut-btn-debug');
    if (toggleBtn) toggleBtn.style.display = 'none';
    if (clearBtn) clearBtn.style.display = 'none';
    if (debugBtn) debugBtn.style.display = 'none';
  }

  function toggleAutoTranslate() {
    autoTranslate = !autoTranslate;
    const btn = document.getElementById('mut-btn-auto');
    if (!btn) return;
    btn.classList.toggle('mut-btn-active', autoTranslate);
    btn.title = autoTranslate ? '自動翻訳: ON（クリックでOFF）' : '自動翻訳: OFF（クリックでON）';
    if (autoTranslate && !overlayContainer && !isTranslating) {
      scheduleAutoTranslate();
    }
  }

  function scheduleAutoTranslate() {
    clearTimeout(autoTranslateTimer);
    // 画像が完全にロードされるまで少し待ってから翻訳を実行
    autoTranslateTimer = setTimeout(() => {
      translateCurrentPage();
    }, 600);
  }

  // ============================================================
  // 通知
  // ============================================================
  let contextInvalidatedShown = false;
  function handleContextInvalidated() {
    if (contextInvalidatedShown) return;
    contextInvalidatedShown = true;
    stopPrefetchKeepAlive();
    showNotification('拡張機能が更新されました。ページを再読み込みしてください。', 'error');
  }

  function showNotification(message, type = 'info') {
    let notif = document.getElementById('mut-notification');
    if (!notif) {
      notif = document.createElement('div');
      notif.id = 'mut-notification';
      getUIParent().appendChild(notif);
    }
    notif.textContent = message;
    notif.className = `mut-notif-${type}`;
    notif.classList.add('mut-notif-show');
    clearTimeout(notif._timer);
    if (type !== 'error') {
      notif._timer = setTimeout(() => notif.classList.remove('mut-notif-show'), 4000);
    }
  }

  // ============================================================
  // UI配置
  // ============================================================
  function getUIParent() {
    // showModal()で開いたdialogはtop-layerを使うため、body配置のUIが隠れる
    return document.querySelector('dialog[open]') || document.body;
  }

  // ============================================================
  // 汎用ページ遷移検知
  // ============================================================
  function startUniversalPageWatcher() {
    // URL変化を検知（念のため: Marvel等でのSPA遷移に対応）
    const onUrlChange = () => {
      clearOverlays();
      isTranslating = false;
      lastQueueKey = '';
      if (autoTranslate) scheduleAutoTranslate();
    };
    window.addEventListener('popstate', onUrlChange);
    window.addEventListener('hashchange', onUrlChange);

    // Blob URL img / SVG image 要素の新規追加を監視
    // ※ Kindleはページをめくるたびに新しいBlob URL imgを3〜4件DOM追加する
    // ※ Marvel ULはページ遷移時に SVG <image> 要素を削除→新規追加で入れ替える
    let clearTimer = null;
    const bodyObserver = new MutationObserver((mutations) => {
      for (const m of mutations) {
        for (const node of m.addedNodes) {
          if (node.nodeType !== 1) continue;
          const hasBlobImg =
            (node.tagName === 'IMG' && node.src?.startsWith('blob:')) ||
            node.querySelector?.('img[src^="blob:"]');
          // SVG image要素の追加（オーバーレイ表示中 or 自動翻訳ON のみ反応して誤発火を防ぐ）
          const hasSvgImage = (overlayContainer || autoTranslate) && (
            node.tagName?.toLowerCase() === 'image' ||
            !!node.querySelector?.('image')
          );
          if (hasBlobImg || hasSvgImage) {
            // デバウンス: 複数追加を1回のclearにまとめる
            clearTimeout(clearTimer);
            clearTimer = setTimeout(() => {
              clearOverlays();
              isTranslating = false;
              lastQueueKey = '';
              if (autoTranslate) scheduleAutoTranslate();
            }, 100);
            return;
          }
        }
      }
    });
    bodyObserver.observe(document.body, { childList: true, subtree: true });

    // SVG image要素のhref変化を監視（Marvel等でのSPA内ページ遷移に対応）
    // ※ MutationObserver の attributeFilter は xlink:href を直接監視できないブラウザもあるため
    //   href と xlink:href の両方を指定し、SVG image要素のみでclearする
    const svgObserver = new MutationObserver((mutations) => {
      for (const m of mutations) {
        if (m.target.tagName?.toLowerCase() === 'image') {
          clearOverlays();
          isTranslating = false;
          lastQueueKey = '';
          if (autoTranslate) scheduleAutoTranslate();
          return;
        }
      }
    });
    svgObserver.observe(document.body, {
      subtree: true,
      attributes: true,
      attributeFilter: ['href', 'xlink:href'],
    });

    // 通常img要素のsrc変化を監視（ComicBookPlus等のimg.src直接書き換えに対応）
    // ※ turnpage() は document.getElementById("maincomic").src を直接書き換えてページ遷移する
    const imgSrcObserver = new MutationObserver((mutations) => {
      // 翻訳オーバーレイ表示中 or 自動翻訳ON のみ反応（遅延ロードやバナー差し替えによる誤発火を防ぐ）
      if (!overlayContainer && !autoTranslate) return;
      for (const m of mutations) {
        if (m.target.tagName === 'IMG') {
          const rect = m.target.getBoundingClientRect();
          if (rect.width > 200 && rect.height > 200) {
            clearOverlays();
            isTranslating = false;
            lastQueueKey = '';
            if (autoTranslate) scheduleAutoTranslate();
            return;
          }
        }
      }
    });
    imgSrcObserver.observe(document.body, {
      subtree: true,
      attributes: true,
      attributeFilter: ['src'],
    });

    // dialog[open]の変化を監視してtoolbarを適切な親に移動
    // ※ showModal()で開いたdialogはtop-layerを使うためbody配置のUIが隠れる
    const dialogWatcher = new MutationObserver(() => {
      if (!toolbar) return;
      const parent = document.querySelector('dialog[open]') || document.body;
      if (toolbar.parentElement !== parent) {
        parent.appendChild(toolbar);
      }
    });
    dialogWatcher.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['open'],
    });
  }

  // ============================================================
  // 初期化
  // ============================================================
  function init() {
    createToolbar();
    startUniversalPageWatcher();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // 先読み中のService Worker Keepalive（4.2秒待機中のスリープ防止）
  let prefetchKeepAliveId = null;
  let prefetchKeepAliveTimeout = null;

  function startPrefetchKeepAlive() {
    if (prefetchKeepAliveId) return;
    prefetchKeepAliveId = setInterval(() => {
      try { chrome.runtime.sendMessage({ type: 'KEEP_ALIVE' }).catch(() => {}); }
      catch { stopPrefetchKeepAlive(); handleContextInvalidated(); }
    }, 10000);
    // 安全弁: 5分後に強制停止
    prefetchKeepAliveTimeout = setTimeout(stopPrefetchKeepAlive, 5 * 60 * 1000);
  }

  function stopPrefetchKeepAlive() {
    clearInterval(prefetchKeepAliveId);
    clearTimeout(prefetchKeepAliveTimeout);
    prefetchKeepAliveId = null;
    prefetchKeepAliveTimeout = null;
  }

  // background.js からのメッセージ受信
  chrome.runtime.onMessage.addListener((message) => {
    if (message.type === 'SITE_DISABLED') {
      // サイトがホワイトリストから削除された → UI全撤去
      clearOverlays();
      stopPrefetchKeepAlive();
      if (toolbar) { toolbar.remove(); toolbar = null; }
      const bar = document.getElementById('mut-prefetch-bar');
      if (bar) bar.remove();
      const notif = document.getElementById('mut-notification');
      if (notif) notif.remove();
      // 再有効化時に再注入できるようフラグをリセット
      window.__dougInitialized = false;
      return;
    }

    if (message.type === 'PRELOAD_PROGRESS') {
      const bar = document.getElementById('mut-prefetch-bar');
      const fill = document.getElementById('mut-prefetch-fill');
      if (!bar || !fill) return;

      const { state, current, total } = message;
      if (total <= 0) return;

      if (state === 'active') {
        startPrefetchKeepAlive();
        fill.style.background = '';  // 白（CSS既定）に戻す
        bar.style.display = '';
        bar.style.opacity = '';
        bar.classList.add('mut-prefetch-active');
        const pct = Math.round((current / total) * 100);
        fill.style.width = Math.max(pct, 2) + '%';
      }

      if (state === 'done') {
        stopPrefetchKeepAlive();
        fill.style.width = '100%';
        bar.classList.remove('mut-prefetch-active');
        setTimeout(() => {
          bar.style.opacity = '0';
          setTimeout(() => {
            bar.style.display = 'none';
            bar.style.opacity = '';
            fill.style.width = '0%';
          }, 400);
        }, 800);
      }
    }
  });
})();
