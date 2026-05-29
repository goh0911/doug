// series.js - シリーズ管理ページロジック

function formatBytes(n) {
  if (n < 1024 * 1024) {
    return (n / 1024).toFixed(1) + ' KB';
  }
  return (n / (1024 * 1024)).toFixed(1) + ' MB';
}

function formatDateTime(ts) {
  const d = new Date(ts);
  const yyyy = d.getFullYear();
  const MM = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${yyyy}-${MM}-${dd} ${hh}:${mm}`;
}

function renderUsage(usage) {
  const usageText = document.getElementById('usageText');
  const usageBarFill = document.getElementById('usageBarFill');

  if (!usage) {
    usageText.textContent = '使用量を取得できませんでした';
    return;
  }

  const used = formatBytes(usage.usedBytes);
  const total = formatBytes(usage.totalBytes);
  usageText.textContent = `容量: ${used} / ${total}（${usage.seriesCount} シリーズ）`;

  const pct = Math.min(100, usage.usedBytes / usage.totalBytes * 100);
  usageBarFill.style.width = pct + '%';

  if (usage.isNearArchive) {
    usageBarFill.classList.add('usage-bar-fill--archive');
  } else if (usage.isNearWarn) {
    usageBarFill.classList.add('usage-bar-fill--warn');
  }

  const warnBanner = document.getElementById('warnBanner');
  if (usage.isNearArchive) {
    warnBanner.textContent = '容量が上限に近づき、古いシリーズが自動削除されています。';
    warnBanner.style.display = '';
  } else if (usage.isNearWarn) {
    warnBanner.textContent = '容量が増えてきました。不要なシリーズは削除を検討してください。';
    warnBanner.style.display = '';
  }
}

function renderList(list) {
  const seriesList = document.getElementById('seriesList');
  const emptyState = document.getElementById('emptyState');

  if (!list || list.length === 0) {
    emptyState.style.display = '';
    return;
  }

  list.forEach(function(series) {
    const card = document.createElement('div');
    card.className = 'series-card';

    // タイトル行
    const head = document.createElement('div');
    head.className = 'series-card-head';

    const nameSpan = document.createElement('span');
    nameSpan.className = 'series-name';
    nameSpan.textContent = (series.meta && series.meta.name) ? series.meta.name : series.seriesId;

    const editBtn = document.createElement('button');
    editBtn.className = 'btn-secondary series-edit-btn';
    editBtn.disabled = true;
    editBtn.title = 'Phase 2C で実装予定';
    editBtn.textContent = '編集';

    head.appendChild(nameSpan);
    head.appendChild(editBtn);

    // メタ行1
    const meta1 = document.createElement('div');
    meta1.className = 'series-meta';
    const issueCount = (series.meta && series.meta.issueCount != null) ? series.meta.issueCount : 0;
    const detectionSource = (series.meta && series.meta.detectionSource) ? series.meta.detectionSource : '-';
    meta1.textContent = `話数: ${issueCount} ／ 検出: ${detectionSource}`;

    // メタ行2
    const meta2 = document.createElement('div');
    meta2.className = 'series-meta';
    const lastVisited = (series.meta && series.meta.lastVisitedAt) ? formatDateTime(series.meta.lastVisitedAt) : '-';
    const siteCount = (series.urlPatterns && series.urlPatterns.length != null) ? series.urlPatterns.length : 0;
    meta2.textContent = `最終: ${lastVisited} ／ サイト: ${siteCount}`;

    // 用語数
    const meta3 = document.createElement('div');
    meta3.className = 'series-meta';
    let glossaryTotal = 0;
    if (series.glossary && typeof series.glossary === 'object') {
      Object.values(series.glossary).forEach(function(langEntries) {
        if (langEntries && typeof langEntries === 'object') {
          glossaryTotal += Object.keys(langEntries).length;
        }
      });
    }
    meta3.textContent = `用語: ${glossaryTotal} 件`;

    card.appendChild(head);
    card.appendChild(meta1);
    card.appendChild(meta2);
    card.appendChild(meta3);

    seriesList.appendChild(card);
  });
}

window.addEventListener('DOMContentLoaded', async function() {
  const usage = await chrome.runtime.sendMessage({ type: 'GET_STORAGE_USAGE' });
  renderUsage(usage);

  const list = await chrome.runtime.sendMessage({ type: 'LIST_SERIES' });
  renderList(list);
});
