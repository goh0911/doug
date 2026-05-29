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
    editBtn.textContent = '編集';
    editBtn.addEventListener('click', function() {
      location.href = 'series.html?id=' + encodeURIComponent(series.seriesId);
    });

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

// ---- 詳細・編集ビュー ----

const TONE_PRESETS = ['auto', '敬体', '常体', '硬め', '柔らかめ'];

// インラインメッセージを一時表示する（ok/err クラス）
function showInlineMsg(el, text, type, durationMs) {
  el.textContent = text;
  el.className = 'inline-msg ' + type;
  if (durationMs) {
    setTimeout(function() {
      el.textContent = '';
      el.className = 'inline-msg';
    }, durationMs);
  }
}

// 用語集リストを再描画する
function renderGlossaryRows(container, entries, seriesId, targetLang) {
  container.replaceChildren();

  const keys = entries ? Object.keys(entries) : [];
  if (keys.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'series-meta';
    empty.textContent = 'まだ用語がありません';
    container.appendChild(empty);
    return;
  }

  keys.forEach(function(original) {
    const entry = entries[original];
    const row = document.createElement('div');
    row.className = 'glossary-row';

    const text = document.createElement('span');
    text.className = 'glossary-text';
    text.textContent = original + ' → ' + (entry.translated || '');

    const delBtn = document.createElement('button');
    delBtn.className = 'btn-secondary series-edit-btn';
    delBtn.textContent = '削除';
    delBtn.addEventListener('click', async function() {
      await chrome.runtime.sendMessage({
        type: 'REMOVE_GLOSSARY_ENTRY',
        payload: { seriesId: seriesId, targetLang: targetLang, original: original }
      });
      // 行を除去
      row.remove();
      // 残りゼロなら空メッセージ表示
      if (container.querySelectorAll('.glossary-row').length === 0) {
        const empty = document.createElement('div');
        empty.className = 'series-meta';
        empty.textContent = 'まだ用語がありません';
        container.appendChild(empty);
      }
    });

    row.appendChild(text);
    row.appendChild(delBtn);
    container.appendChild(row);
  });
}

// 詳細ビューを描画する
async function renderDetail(seriesId) {
  const detailView = document.getElementById('detailView');
  detailView.replaceChildren();

  // GET_SERIES
  const series = await chrome.runtime.sendMessage({
    type: 'GET_SERIES',
    payload: { seriesId: seriesId }
  });

  // 存在しない場合
  if (!series) {
    const msg = document.createElement('div');
    msg.className = 'series-meta';
    msg.textContent = 'シリーズが見つかりません。';

    const backLink = document.createElement('a');
    backLink.className = 'back-link';
    backLink.textContent = '← 一覧へ戻る';
    backLink.href = 'series.html';

    detailView.appendChild(backLink);
    detailView.appendChild(msg);
    return;
  }

  // 現在の対象言語を取得
  const stored = await chrome.storage.local.get({ targetLang: 'ja' });
  const targetLang = stored.targetLang;

  // ---- 戻るリンク ----
  const backLink = document.createElement('a');
  backLink.className = 'back-link';
  backLink.textContent = '← 一覧へ戻る';
  backLink.href = 'series.html';
  detailView.appendChild(backLink);

  // ---- シリーズ名見出し ----
  const titleEl = document.createElement('h2');
  titleEl.className = 'detail-title';
  titleEl.textContent = (series.meta && series.meta.name) ? series.meta.name : seriesId;
  detailView.appendChild(titleEl);

  // 読み取り専用メタ
  const metaEl = document.createElement('div');
  metaEl.className = 'series-meta detail-meta-block';
  const issueCount = (series.meta && series.meta.issueCount != null) ? series.meta.issueCount : 0;
  const detectionSource = (series.meta && series.meta.detectionSource) ? series.meta.detectionSource : '-';
  const lastVisited = (series.meta && series.meta.lastVisitedAt) ? formatDateTime(series.meta.lastVisitedAt) : '-';
  const detectedAt = (series.meta && series.meta.detectedAt) ? formatDateTime(series.meta.detectedAt) : '-';
  metaEl.textContent = `話数: ${issueCount} ／ 検出: ${detectionSource} ／ 検出日: ${detectedAt} ／ 最終: ${lastVisited}`;
  detailView.appendChild(metaEl);

  // ---- 表示名フィールド ----
  const nameSection = document.createElement('div');
  nameSection.className = 'section detail-field';

  const nameLabel = document.createElement('label');
  nameLabel.textContent = '表示名';
  nameSection.appendChild(nameLabel);

  const nameRow = document.createElement('div');
  nameRow.className = 'detail-input-row';

  const nameInput = document.createElement('input');
  nameInput.type = 'text';
  nameInput.value = (series.meta && series.meta.name) ? series.meta.name : '';
  nameRow.appendChild(nameInput);

  const nameSaveBtn = document.createElement('button');
  nameSaveBtn.className = 'btn-primary detail-save-btn';
  nameSaveBtn.textContent = '保存';
  nameRow.appendChild(nameSaveBtn);

  nameSection.appendChild(nameRow);

  const nameMsg = document.createElement('div');
  nameMsg.className = 'inline-msg';
  nameSection.appendChild(nameMsg);

  nameSaveBtn.addEventListener('click', async function() {
    const val = nameInput.value;
    const ok = await chrome.runtime.sendMessage({
      type: 'UPDATE_SERIES_FIELD',
      payload: { seriesId: seriesId, fieldPath: 'meta.name', value: val }
    });
    if (ok) {
      showInlineMsg(nameMsg, '保存しました', 'ok', 3000);
      titleEl.textContent = val;
    } else {
      showInlineMsg(nameMsg, '保存できませんでした（使用できない文字／100字超）', 'err', 0);
    }
  });

  detailView.appendChild(nameSection);

  // ---- 口調フィールド ----
  const toneSection = document.createElement('div');
  toneSection.className = 'section detail-field';

  const toneLabel = document.createElement('label');
  toneLabel.textContent = '口調';
  toneSection.appendChild(toneLabel);

  const toneSelect = document.createElement('select');
  ['auto', '敬体', '常体', '硬め', '柔らかめ', 'カスタム'].forEach(function(opt) {
    const o = document.createElement('option');
    o.value = opt;
    o.textContent = opt;
    toneSelect.appendChild(o);
  });

  const currentTone = (series.tone && series.tone.style) ? series.tone.style : 'auto';
  if (TONE_PRESETS.indexOf(currentTone) !== -1) {
    toneSelect.value = currentTone;
  } else {
    toneSelect.value = 'カスタム';
  }
  toneSection.appendChild(toneSelect);

  const toneCustomArea = document.createElement('textarea');
  toneCustomArea.className = 'detail-tone-custom';
  toneCustomArea.maxLength = 200;
  toneCustomArea.placeholder = '例: 落ち着いた敬語で';
  toneCustomArea.rows = 2;
  if (TONE_PRESETS.indexOf(currentTone) === -1) {
    toneCustomArea.value = currentTone;
    toneCustomArea.style.display = '';
  } else {
    toneCustomArea.style.display = 'none';
  }
  toneSection.appendChild(toneCustomArea);

  toneSelect.addEventListener('change', function() {
    if (toneSelect.value === 'カスタム') {
      toneCustomArea.style.display = '';
    } else {
      toneCustomArea.style.display = 'none';
    }
  });

  const toneRow = document.createElement('div');
  toneRow.className = 'detail-input-row';

  const toneSaveBtn = document.createElement('button');
  toneSaveBtn.className = 'btn-primary detail-save-btn';
  toneSaveBtn.textContent = '保存';
  toneRow.appendChild(toneSaveBtn);
  toneSection.appendChild(toneRow);

  const toneMsg = document.createElement('div');
  toneMsg.className = 'inline-msg';
  toneSection.appendChild(toneMsg);

  toneSaveBtn.addEventListener('click', async function() {
    let val;
    if (toneSelect.value === 'カスタム') {
      val = toneCustomArea.value;
    } else {
      val = toneSelect.value;
    }
    const ok = await chrome.runtime.sendMessage({
      type: 'UPDATE_SERIES_FIELD',
      payload: { seriesId: seriesId, fieldPath: 'tone.style', value: val }
    });
    if (ok) {
      showInlineMsg(toneMsg, '保存しました', 'ok', 3000);
    } else {
      showInlineMsg(toneMsg, '保存できませんでした（使用できない文字／200字超）', 'err', 0);
    }
  });

  detailView.appendChild(toneSection);

  // ---- 用語集セクション ----
  const glossarySection = document.createElement('div');
  glossarySection.className = 'section detail-field';

  const glossaryLabel = document.createElement('label');
  glossaryLabel.textContent = `用語集（${targetLang}）`;
  glossarySection.appendChild(glossaryLabel);

  const glossaryRows = document.createElement('div');
  glossaryRows.id = 'glossaryRows';
  const langEntries = (series.glossary && series.glossary[targetLang]) ? series.glossary[targetLang] : null;
  renderGlossaryRows(glossaryRows, langEntries, seriesId, targetLang);
  glossarySection.appendChild(glossaryRows);

  // 追加フォーム
  const addRow = document.createElement('div');
  addRow.className = 'glossary-add-row';

  const origInput = document.createElement('input');
  origInput.type = 'text';
  origInput.placeholder = '原文';
  origInput.className = 'glossary-add-input';
  addRow.appendChild(origInput);

  const transInput = document.createElement('input');
  transInput.type = 'text';
  transInput.placeholder = '訳語';
  transInput.className = 'glossary-add-input';
  addRow.appendChild(transInput);

  const addBtn = document.createElement('button');
  addBtn.className = 'btn-primary detail-save-btn';
  addBtn.textContent = '+ 追加';
  addRow.appendChild(addBtn);

  glossarySection.appendChild(addRow);

  const glossaryMsg = document.createElement('div');
  glossaryMsg.className = 'inline-msg';
  glossarySection.appendChild(glossaryMsg);

  addBtn.addEventListener('click', async function() {
    const original = origInput.value.trim();
    const translated = transInput.value.trim();
    if (!original || !translated) {
      showInlineMsg(glossaryMsg, '原文と訳語を両方入力してください', 'err', 3000);
      return;
    }
    const ok = await chrome.runtime.sendMessage({
      type: 'ADD_GLOSSARY_ENTRY',
      payload: { seriesId: seriesId, targetLang: targetLang, original: original, translated: translated }
    });
    if (ok) {
      origInput.value = '';
      transInput.value = '';
      // リストを再取得して再描画
      const updated = await chrome.runtime.sendMessage({
        type: 'GET_SERIES',
        payload: { seriesId: seriesId }
      });
      const updatedEntries = (updated && updated.glossary && updated.glossary[targetLang]) ? updated.glossary[targetLang] : null;
      renderGlossaryRows(glossaryRows, updatedEntries, seriesId, targetLang);
      showInlineMsg(glossaryMsg, '追加しました', 'ok', 3000);
    } else {
      showInlineMsg(glossaryMsg, '追加できませんでした（使用できない文字／100字超／用語集が2KBを超過）', 'err', 0);
    }
  });

  detailView.appendChild(glossarySection);

  // ---- 削除ボタン ----
  const deleteSection = document.createElement('div');
  deleteSection.className = 'section detail-field';

  const deleteBtn = document.createElement('button');
  deleteBtn.className = 'btn-danger';
  deleteBtn.textContent = 'このシリーズを削除';
  deleteBtn.addEventListener('click', async function() {
    if (!window.confirm('このシリーズの用語集・口調設定を削除します。よろしいですか？')) {
      return;
    }
    const res = await chrome.runtime.sendMessage({
      type: 'DELETE_SERIES',
      payload: { seriesId: seriesId }
    });
    if (res && res.ok) {
      location.href = 'series.html';
    }
  });

  deleteSection.appendChild(deleteBtn);
  detailView.appendChild(deleteSection);
}

// ---- エントリポイント ----

window.addEventListener('DOMContentLoaded', async function() {
  const seriesId = new URLSearchParams(location.search).get('id');

  if (seriesId) {
    // 詳細・編集ビュー
    document.getElementById('listView').style.display = 'none';
    document.getElementById('detailView').style.display = '';
    await renderDetail(seriesId);
  } else {
    // 一覧ビュー（既存の処理）
    const usage = await chrome.runtime.sendMessage({ type: 'GET_STORAGE_USAGE' });
    renderUsage(usage);

    const list = await chrome.runtime.sendMessage({ type: 'LIST_SERIES' });
    renderList(list);
  }
});
