// options.js - 詳細設定画面ロジック

const $ = (id) => document.getElementById(id);

// utils/wiki-source.js の WIKIPEDIA_ORIGIN と同一値（options.js は module ではないため直書き）
const WIKIPEDIA_ORIGIN = 'https://en.wikipedia.org/*';
const COMICVINE_ORIGIN = 'https://comicvine.gamespot.com/*';

let isPulling = false;

async function loadWhitelistUI() {
  const { whitelist = [] } = await chrome.storage.sync.get('whitelist');
  const ul = $('whitelistItems');
  ul.innerHTML = '';
  if (whitelist.length === 0) {
    $('whitelistSection').style.display = 'none';
    return;
  }
  $('whitelistSection').style.display = '';
  whitelist.forEach(origin => {
    const tr = document.createElement('tr');
    const tdOrigin = document.createElement('td');
    tdOrigin.className = 'whitelist-origin';
    tdOrigin.textContent = origin.replace(/^https?:\/\//, '');
    const tdAction = document.createElement('td');
    tdAction.className = 'whitelist-action';
    const btn = document.createElement('button');
    btn.className = 'btn-icon whitelist-remove-btn';
    btn.title = '削除';
    btn.textContent = '✕';
    btn.addEventListener('click', async () => {
      try {
        await chrome.runtime.sendMessage({ type: 'REMOVE_FROM_WHITELIST', origin });
        await loadWhitelistUI();
      } catch (err) {
        showStatus('削除に失敗しました: ' + err.message, 'err');
      }
    });
    tdAction.appendChild(btn);
    tr.appendChild(tdOrigin);
    tr.appendChild(tdAction);
    ul.appendChild(tr);
  });
}

async function loadApiStats() {
  const { apiStats = {} } = await chrome.storage.local.get('apiStats');
  const tbody = document.getElementById('apiStatsItems');
  tbody.innerHTML = '';
  const providers = ['gemini', 'claude', 'openai', 'ollama'];
  const labels = { gemini: 'Gemini', claude: 'Claude', openai: 'ChatGPT', ollama: 'Ollama' };
  let total = 0;
  for (const p of providers) {
    const count = apiStats[p] || 0;
    total += count;
    const tr = document.createElement('tr');
    const tdName = document.createElement('td');
    tdName.className = 'whitelist-origin';
    tdName.textContent = labels[p];
    const tdCount = document.createElement('td');
    tdCount.style.textAlign = 'right';
    tdCount.textContent = count + ' 回';
    tr.appendChild(tdName);
    tr.appendChild(tdCount);
    tbody.appendChild(tr);
  }
  // 合計行
  const trTotal = document.createElement('tr');
  trTotal.style.fontWeight = 'bold';
  const tdLabel = document.createElement('td');
  tdLabel.textContent = '合計';
  const tdTotal = document.createElement('td');
  tdTotal.style.textAlign = 'right';
  tdTotal.textContent = total + ' 回';
  trTotal.appendChild(tdLabel);
  trTotal.appendChild(tdTotal);
  tbody.appendChild(trTotal);

  const resetDate = apiStats.lastReset
    ? new Date(apiStats.lastReset).toLocaleDateString('ja-JP')
    : null;
  document.getElementById('apiStatsResetDate').textContent = resetDate
    ? `リセット日: ${resetDate}`
    : '';
}

const PROVIDER_CONFIG = {
  gemini: { section: 'geminiKeySection', keyId: 'geminiApiKey', pattern: /^AIza[0-9A-Za-z_-]{30,256}$/, hint: 'Gemini APIキーは "AIza" で始まる39文字程度の英数字です' },
  claude: { section: 'claudeKeySection', keyId: 'claudeApiKey', pattern: /^sk-ant-[0-9A-Za-z_-]{20,256}$/, hint: 'Claude APIキーは "sk-ant-" で始まる英数字です' },
  openai: { section: 'openaiKeySection', keyId: 'openaiApiKey', pattern: /^sk-[0-9A-Za-z_-]{20,256}$/, hint: 'OpenAI APIキーは "sk-" で始まる英数字です' },
  ollama: { section: 'ollamaSection', keyId: null, pattern: null, hint: null },
};

function updateProviderUI(provider) {
  Object.values(PROVIDER_CONFIG).forEach(c => {
    $(c.section).style.display = 'none';
  });
  const config = PROVIDER_CONFIG[provider];
  if (config) {
    $(config.section).style.display = '';
  }
  if (provider === 'ollama') {
    checkOllamaStatus();
  }
}

function isValidOllamaEndpoint(url) {
  return /^https?:\/\//i.test(url);
}

async function checkOllamaStatus() {
  if (isPulling) return;
  const endpoint = ($('ollamaEndpoint').value || 'http://localhost:11434').trim();
  const model = $('ollamaModel').value;
  const statusEl = $('ollamaStatus');
  const installBtn = $('ollamaInstallBtn');
  const downloadHint = $('ollamaDownloadHint');

  statusEl.textContent = '確認中...';
  statusEl.className = 'ollama-status';
  installBtn.style.display = 'none';
  downloadHint.style.display = 'none';

  if (!isValidOllamaEndpoint(endpoint)) {
    statusEl.textContent = '⚠ エンドポイントは http:// または https:// で始まる必要があります';
    statusEl.className = 'ollama-status err';
    return;
  }

  try {
    const res = await fetch(`${endpoint}/api/tags`);
    if (res.status === 403) {
      statusEl.textContent = '⚠ Ollama のアクセス拒否 (403) — OLLAMA_ORIGINS の設定が必要です';
      statusEl.className = 'ollama-status err';
      // 値を "*" にすると閲覧中の任意のウェブページからローカルの Ollama を叩けてしまう。
      // 拡張機能のオリジンだけに絞る（Ollama の既定は 127.0.0.1 / 0.0.0.0 のみ）。
      // innerHTML は使わない（R-SEC-2）
      const cmd = document.createElement('code');
      cmd.textContent = 'launchctl setenv OLLAMA_ORIGINS "chrome-extension://*"';
      const note = document.createElement('div');
      note.className = 'field-hint';
      note.textContent = '※ Mac を再起動するとこの設定は消えます（再設定が必要）';
      downloadHint.replaceChildren(
        document.createTextNode('ターミナルで実行して Ollama を再起動:'),
        document.createElement('br'), cmd, note,
      );
      downloadHint.style.display = '';
      return;
    }
    if (!res.ok) throw new Error('接続エラー');
    const data = await res.json();
    const models = data.models || [];
    const installed = models.some(m => m.name === model);

    if (installed) {
      statusEl.textContent = `✓ Ollama 起動中 / ✓ ${model} 準備完了`;
      statusEl.className = 'ollama-status ok';
    } else {
      statusEl.textContent = `✓ Ollama 起動中 / ${model} 未インストール`;
      statusEl.className = 'ollama-status warn';
      installBtn.textContent = `${model} をインストール`;
      installBtn.style.display = '';
    }
  } catch {
    statusEl.textContent = '⚠ Ollama が起動していません';
    statusEl.className = 'ollama-status err';
    downloadHint.style.display = '';
  }
}

async function pullModel() {
  const endpoint = ($('ollamaEndpoint').value || 'http://localhost:11434').trim();
  const model = $('ollamaModel').value;
  const progressEl = $('ollamaProgress');
  const progressFill = $('ollamaProgressFill');
  const progressText = $('ollamaProgressText');
  const installBtn = $('ollamaInstallBtn');

  if (!isValidOllamaEndpoint(endpoint)) {
    showStatus('エンドポイントは http:// または https:// で始まる必要があります', 'err');
    return;
  }

  isPulling = true;
  installBtn.disabled = true;
  progressEl.style.display = '';
  progressFill.style.width = '0%';
  progressText.textContent = 'ダウンロード準備中...';

  try {
    const res = await fetch(`${endpoint}/api/pull`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, stream: true }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    if (!res.body) throw new Error('レスポンスボディが取得できません');
    const reader = res.body.getReader();
    const decoder = new TextDecoder();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const lines = decoder.decode(value, { stream: true }).split('\n').filter(l => l.trim());
      for (const line of lines) {
        try {
          const obj = JSON.parse(line);
          if (obj.total && obj.completed) {
            const pct = Math.round((obj.completed / obj.total) * 100);
            progressFill.style.width = pct + '%';
            const gb = (obj.total / 1e9).toFixed(1);
            const doneGb = (obj.completed / 1e9).toFixed(1);
            progressText.textContent = `${doneGb} GB / ${gb} GB (${pct}%)`;
          } else if (obj.status) {
            progressText.textContent = obj.status;
          }
        } catch { /* NDJSON の不完全行は無視 */ }
      }
    }

    progressFill.style.width = '100%';
    progressText.textContent = 'インストール完了！';
    installBtn.style.display = 'none';
    await checkOllamaStatus();
  } catch (err) {
    showStatus(`インストールに失敗しました: ${err.message}`, 'err');
  } finally {
    isPulling = false;
    installBtn.disabled = false;
    if (progressFill.style.width !== '100%') {
      progressEl.style.display = 'none';
    }
  }
}

document.addEventListener('DOMContentLoaded', async () => {
  await loadWhitelistUI();
  await loadApiStats();

  const settings = await chrome.storage.local.get({
    apiProvider: 'gemini',
    geminiApiKey: '',
    claudeApiKey: '',
    openaiApiKey: '',
    geminiModel: 'gemini-3.6-flash',
    claudeModel: 'claude-sonnet-5',
    openaiModel: 'gpt-5.6-sol',
    ollamaModel: 'qwen3.6:35b-a3b',
    ollamaEndpoint: 'http://localhost:11434',
    prefetch: false,
    imagePreprocess: true,
    glossEnabled: false,
    glossEngine: 'auto',
    comicvineApiKey: '',
  });

  $('apiProvider').value = settings.apiProvider;
  $('geminiApiKey').value = settings.geminiApiKey;
  $('claudeApiKey').value = settings.claudeApiKey;
  $('openaiApiKey').value = settings.openaiApiKey;
  $('geminiModel').value = settings.geminiModel;
  $('claudeModel').value = settings.claudeModel;
  $('openaiModel').value = settings.openaiModel;
  $('ollamaModel').value = settings.ollamaModel;
  $('ollamaEndpoint').value = settings.ollamaEndpoint;
  $('prefetch').checked = settings.prefetch;
  $('imagePreprocess').checked = settings.imagePreprocess;
  // 保存値だけでなく実際の権限保有も突き合わせる（chrome://extensions から後で剥奪されている場合に
  // チェックが入ったまま表示されてしまう「嘘」を防ぐ。background.js:688/:707 と同じパターン）
  const glossHasPermission = await chrome.permissions.contains({ origins: [WIKIPEDIA_ORIGIN] }).catch(() => false);
  $('glossEnabled').checked = settings.glossEnabled && glossHasPermission;
  $('glossEngine').value = settings.glossEngine;
  $('comicvineApiKey').value = settings.comicvineApiKey;

  updateProviderUI(settings.apiProvider);

  // プロバイダー切替
  $('apiProvider').addEventListener('change', () => {
    updateProviderUI($('apiProvider').value);
  });

  // APIキー表示/非表示トグル
  document.querySelectorAll('.toggle-key-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const input = $(btn.dataset.target);
      input.type = input.type === 'password' ? 'text' : 'password';
    });
  });

  // Ollama: モデル変更・エンドポイント変更で再チェック
  $('ollamaModel').addEventListener('change', checkOllamaStatus);
  $('ollamaEndpoint').addEventListener('blur', checkOllamaStatus);

  // Ollama: インストールボタン
  $('ollamaInstallBtn').addEventListener('click', pullModel);

  // API使用回数リセット
  $('apiStatsResetBtn').addEventListener('click', async () => {
    await chrome.storage.local.set({ apiStats: { lastReset: Date.now() } });
    await loadApiStats();
    showStatus('API使用回数をリセットしました', 'ok');
  });

  // 固有名詞解説ポップアップ: 有効化時に en.wikipedia.org のホスト権限を要求する
  $('glossEnabled').addEventListener('change', async () => {
    const el = $('glossEnabled');
    if (!el.checked) {
      // OFF は権限操作を伴わないため即座に保存
      await chrome.storage.local.set({ glossEnabled: false });
      return;
    }
    // ユーザー操作の直後でなければ権限ダイアログが失敗するため、await を挟まず直接呼ぶ
    let granted = false;
    try {
      granted = await chrome.permissions.request({ origins: [WIKIPEDIA_ORIGIN] });
    } catch (err) {
      el.checked = false;
      await chrome.storage.local.set({ glossEnabled: false });
      showStatus('権限の取得に失敗しました: ' + err.message, 'err');
      return;
    }
    if (!granted) {
      el.checked = false;
      await chrome.storage.local.set({ glossEnabled: false });
      showStatus('en.wikipedia.org へのアクセスが許可されなかったため、機能は無効のままです', 'err');
      return;
    }
    await chrome.storage.local.set({ glossEnabled: true });
    showStatus('解説ポップアップを有効にしました', 'ok');
  });

  // 生成エンジンの切り替えは即座に保存
  $('glossEngine').addEventListener('change', async () => {
    await chrome.storage.local.set({ glossEngine: $('glossEngine').value });
  });

  // Comic Vine APIキー: 入力が確定したら権限を要求し、テスト呼び出しで検証してから保存する。
  // 未設定でも Wikipedia だけで動くため、失敗しても他の設定は巻き込まない
  $('comicvineApiKey').addEventListener('change', async () => {
    const key = $('comicvineApiKey').value.trim();
    const status = $('comicvineStatus');
    if (key === '') {
      await chrome.storage.local.set({ comicvineApiKey: '' });
      status.textContent = '';
      return;
    }

    // 権限要求はユーザー操作の直後でないと失敗するため、await を挟まず先に呼ぶ
    let granted = false;
    try {
      granted = await chrome.permissions.request({ origins: [COMICVINE_ORIGIN] });
    } catch (err) {
      status.textContent = '権限の取得に失敗しました: ' + err.message;
      return;
    }
    if (!granted) {
      status.textContent = 'comicvine.gamespot.com へのアクセスが許可されなかったため、保存していません';
      return;
    }

    status.textContent = 'キーを検証しています…';
    const ok = await verifyComicVineKey(key);
    if (ok === true) {
      await chrome.storage.local.set({ comicvineApiKey: key });
      status.textContent = 'キーを確認しました。Wikipedia に無い語を Comic Vine で補います';
    } else if (ok === 'invalid') {
      status.textContent = 'キーが無効です。保存していません';
    } else {
      // 通信断・レート制限は「無効」と断定できない。保存はするが結果は伝える
      await chrome.storage.local.set({ comicvineApiKey: key });
      status.textContent = '検証できませんでした（通信エラーかレート制限）。キーは保存しました';
    }
  });

  // シリーズ管理を開く
  document.getElementById('openSeriesManagerBtn')?.addEventListener('click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('series.html') });
  });

  // 保存ボタン
  $('saveBtn').addEventListener('click', async () => {
    const provider = $('apiProvider').value;

    // Ollama 以外は API キーをバリデーション
    if (provider !== 'ollama') {
      const config = PROVIDER_CONFIG[provider];
      const apiKey = $(config.keyId).value.trim();
      if (!apiKey) {
        showStatus('APIキーを入力してください', 'err');
        return;
      }
      if (config.pattern && !config.pattern.test(apiKey)) {
        showStatus(config.hint, 'err');
        return;
      }
    }

    const ollamaEndpoint = ($('ollamaEndpoint').value || 'http://localhost:11434').trim();
    if (!isValidOllamaEndpoint(ollamaEndpoint)) {
      showStatus('Ollama エンドポイントは http:// または https:// で始まる必要があります', 'err');
      return;
    }

    await chrome.storage.local.set({
      apiProvider: provider,
      geminiApiKey: $('geminiApiKey').value.trim(),
      claudeApiKey: $('claudeApiKey').value.trim(),
      openaiApiKey: $('openaiApiKey').value.trim(),
      geminiModel: $('geminiModel').value,
      claudeModel: $('claudeModel').value,
      openaiModel: $('openaiModel').value,
      ollamaModel: $('ollamaModel').value,
      ollamaEndpoint,
      prefetch: $('prefetch').checked,
      imagePreprocess: $('imagePreprocess').checked,
    });
    showStatus('設定を保存しました', 'ok');
  });
});

/**
 * Comic Vine のキーを 1 件だけ検索して検証する。
 * Comic Vine は HTTP 200 のまま status_code でエラーを返す（100 = Invalid API Key）
 * @returns {Promise<true|'invalid'|'unknown'>}
 */
async function verifyComicVineKey(key) {
  const params = new URLSearchParams({
    api_key: key, format: 'json', query: 'hulk',
    resources: 'character', field_list: 'name', limit: '1',
  });
  try {
    const res = await fetch(`https://comicvine.gamespot.com/api/search/?${params.toString()}`);
    if (!res.ok) return 'unknown';
    const json = await res.json();
    if (json && json.status_code === 1) return true;
    if (json && json.status_code === 100) return 'invalid';
    return 'unknown';
  } catch {
    return 'unknown';
  }
}

const _statusTimers = new WeakMap();

function showStatus(msg, type) {
  const el = $('status');
  el.textContent = msg;
  el.style.color = type === 'err' ? '#f44336' : '#4caf50';
  el.classList.add('show');
  clearTimeout(_statusTimers.get(el));
  _statusTimers.set(el, setTimeout(() => el.classList.remove('show'), 5000));
}
