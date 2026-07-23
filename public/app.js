let filterConfig = {};
let refreshConfig = {};
let storeSummaries = [];
let stores = [];
let activeStoreId = 'all';
let activeCategory = 'plus_未接码';
let activeCatL1 = 'gpt';
let activeCatL2 = 'plus_未接码';
let renderLimit = 30;
let expandedNoStock = {};
let includeWords = [];
let excludeWords = [];
let lastActiveSearch = 'include';
let priceChart = null;
let historyRequestId = 0;
let navProducts = [];
let navIndex = -1;
let productLabels = {};
let cachedProducts = [];
let productsDirty = true;
let storeOrder = [];
let priceRange = { min: 0, max: 0 };
let _priceTimer = null;

localStorage.removeItem('authToken');
let _authToken = sessionStorage.getItem('authToken') || '';

async function apiFetch(url, opts) {
  const h = { ...(opts?.headers || {}) };
  if (_authToken) h['x-auth-token'] = _authToken;
  const res = await fetch(url, { ...opts, headers: h });
  if (res.status === 401) {
    if (!_authToken) {
      showAuthPrompt();
    } else {
      _authToken = '';
      sessionStorage.removeItem('authToken');
      showAuthPrompt();
    }
    throw new Error('未授权');
  }
  return res;
}

function showAuthPrompt() {
  const token = prompt('请输入访问令牌:');
  if (token) {
    _authToken = token;
    sessionStorage.setItem('authToken', token);
    location.reload();
  }
}

function initTheme() {
  const saved = localStorage.getItem('theme');
  if (saved === 'dark' || (!saved && window.matchMedia('(prefers-color-scheme: dark)').matches)) {
    document.body.classList.add('dark');
    document.getElementById('themeToggle').textContent = '☀';
  }
}

function toggleTheme() {
  const isDark = document.body.classList.toggle('dark');
  localStorage.setItem('theme', isDark ? 'dark' : 'light');
  document.getElementById('themeToggle').textContent = isDark ? '☀' : '☾';
}

function handleActionClick(event) {
  const target = event.target.closest('[data-action]');
  if (!target) return;

  const { action } = target.dataset;
  const handlers = {
    'add-suggest-key': () => addSuggestKey(target.dataset.key),
    'remove-word': () => removeWord(target.dataset.word, target.dataset.type),
    'set-cat-l1': () => setCatL1(target.dataset.category),
    'set-cat-l2': () => setCatL2(target.dataset.category),
    'switch-store': () => switchStore(target.dataset.storeId),
    'go-best-price': () => goToBestPrice(target.dataset.storeId, target.dataset.category),
    'delete-store': () => deleteStore(target.dataset.storeId),
    'toggle-no-stock': () => toggleNoStock(target.dataset.storeId),
    'refresh-store': () => refreshStore(target.dataset.storeId),
    'edit-label': () => editLabel(
      target.dataset.productKey,
      target.dataset.productName,
      target.dataset.category,
      Number(target.dataset.confidence || 0),
    ),
    'show-history': () => showHistory(
      target.dataset.storeId,
      target.dataset.productId,
      target.dataset.productName,
    ),
    'close-label-editor': () => document.getElementById('labelOverlay')?.remove(),
    'save-label': () => saveLabel(
      target.dataset.productKey,
      target.dataset.productName,
      target.dataset.previousCategory,
    ),
  };

  handlers[action]?.();
}

function handleActionChange(event) {
  const target = event.target.closest('[data-change-action]');
  if (!target) return;

  const handlers = {
    'toggle-category': () => toggleCatVisibility(target.dataset.category, target.checked),
    'edit-label-l1': () => onEditL1Change(),
    'category-l1': () => onCatL1Change(target, target.dataset.productKey, target.dataset.productName),
    'save-label-settings': () => saveLabelFromSettings(
      target.dataset.productKey,
      target.dataset.productName,
      target.value,
      target.dataset.previousCategory,
      target,
    ),
    'price-number': () => onPriceInputNum(target, target.dataset.bound),
  };

  handlers[target.dataset.changeAction]?.();
}

function handleActionInput(event) {
  const target = event.target.closest('[data-input-action]');
  if (target?.dataset.inputAction === 'price-range') onPriceInput(target);
}

function handleActionDrag(event) {
  const target = event.target.closest('[data-drag-type]');
  if (!target) return;

  if (target.dataset.dragType === 'category') {
    if (event.type === 'dragstart') catDragStart(event, target.dataset.cat);
    if (event.type === 'dragover') catDragOver(event);
    if (event.type === 'drop') catDrop(event, target.dataset.cat);
    if (event.type === 'dragend') catDragEnd();
  }
  if (target.dataset.dragType === 'store') {
    if (event.type === 'dragstart') dragStart(event, target.dataset.id);
    if (event.type === 'dragover') dragOver(event);
    if (event.type === 'drop') dropStore(event, target.dataset.id);
    if (event.type === 'dragend') dragEnd();
  }
}

document.addEventListener('DOMContentLoaded', async () => {
  initTheme();
  document.getElementById('themeToggle').addEventListener('click', toggleTheme);
  document.addEventListener('click', handleActionClick);
  document.addEventListener('change', handleActionChange);
  document.addEventListener('input', handleActionInput);
  ['dragstart', 'dragover', 'drop', 'dragend'].forEach(type => {
    document.addEventListener(type, handleActionDrag);
  });
  filterConfig = await (await apiFetch('/api/filter-config')).json();
  suggestedKeywords = filterConfig.suggestedKeywords || ['GPT', 'Plus', 'Pro', 'Team', '接码', '直充', '成品', '账号', 'Claude', 'Gemini', 'OpenAI', 'SMS', '谷歌', '微软', '邮箱', 'API', '订阅', '会员', 'Access'];
  keywordUsage = filterConfig.keywordUsage || {};
  refreshConfig = await (await apiFetch('/api/refresh-config')).json();
  await loadStoreSummaries();
  stores = await (await apiFetch('/api/stores')).json();
  storeOrder = await (await apiFetch('/api/store-order')).json();
  applyStoreOrder();
  const labels = await (await apiFetch('/api/product-labels')).json();
  for (const l of labels) { productLabels[l.product_key] = l; }
  markDirty();
  render();
  document.getElementById('catBar').addEventListener('wheel', e => { e.preventDefault(); document.getElementById('catBar').scrollLeft += e.deltaY; }, { passive: false });
  document.querySelectorAll('.close').forEach(el => el.addEventListener('click', () => {
    document.getElementById('historyModal').style.display = 'none';
    document.getElementById('settingsModal').style.display = 'none';
    document.getElementById('addStoreModal').style.display = 'none';
  }));
  document.getElementById('addStoreBtn').addEventListener('click', showAddModal);
  document.getElementById('addStoreSubmit').addEventListener('click', submitAddStore);
  document.getElementById('addStoreUrl').addEventListener('keydown', e => { if (e.key === 'Enter') submitAddStore(); });
  document.getElementById('prevProductBtn').addEventListener('click', () => navigateProduct(-1));
  document.getElementById('nextProductBtn').addEventListener('click', () => navigateProduct(1));
  window.addEventListener('click', e => {
    if (e.target === document.getElementById('historyModal')) closeModal();
    if (e.target === document.getElementById('settingsModal')) closeSettings();
    if (e.target === document.getElementById('addStoreModal')) closeAddModal();
  });
  window.addEventListener('keydown', e => {
    if (document.getElementById('historyModal').style.display !== 'block') return;
    if (e.key === 'ArrowLeft') navigateProduct(-1);
    if (e.key === 'ArrowRight') navigateProduct(1);
  });

  setupSearch('includeInput', 'includeChips', 'includeWords', 'include');
  setupSearch('excludeInput', 'excludeChips', 'excludeWords', 'exclude');
  renderSuggestedKeys();
  initSettings();
});

function setupSearch(inputId, chipsId, wordsVar, type) {
  const input = document.getElementById(inputId);
  input.addEventListener('focus', () => { lastActiveSearch = type; });
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') {
      const val = input.value.trim();
      if (!val) return;
      if (type === 'include') {
        if (!includeWords.includes(val)) includeWords.push(val);
      } else {
        if (!excludeWords.includes(val)) excludeWords.push(val);
      }
      input.value = '';
      trackNewKeyword(val);
      renderChips();
      render();
    }
  });
}

let suggestedKeywords = [];
let keywordUsage = {};
let keywordSaveTimer = null;

function renderSuggestedKeys() {
  const container = document.getElementById('suggestedKeys');
  const keys = suggestedKeywords.length ? suggestedKeywords : ['GPT', 'Plus', 'Pro', 'Team', '接码', '直充'];
  const sorted = [...keys].sort((a, b) => (keywordUsage[b] || 0) - (keywordUsage[a] || 0)).slice(0, 7);
  container.innerHTML = '<span class="sk-label">常用:</span> ' +
    sorted.map(k =>
      `<span class="sk-item" data-action="add-suggest-key" data-key="${escapeHtml(k)}">${escapeHtml(k)}</span>`
    ).join('');
}

function addSuggestKey(key) {
  keywordUsage[key] = (keywordUsage[key] || 0) + 1;
  scheduleSaveKeywordUsage();
  if (lastActiveSearch === 'exclude') {
    if (!excludeWords.includes(key)) excludeWords.push(key);
  } else {
    if (!includeWords.includes(key)) includeWords.push(key);
  }
  renderChips();
  render();
}

function scheduleSaveKeywordUsage() {
  clearTimeout(keywordSaveTimer);
  keywordSaveTimer = setTimeout(() => saveKeywordUsage(), 2000);
}

async function saveKeywordUsage() {
  filterConfig.keywordUsage = keywordUsage;
  try {
    await apiFetch('/api/filter-config', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(filterConfig) });
  } catch (e) {}
}

function trackNewKeyword(key) {
  if (!suggestedKeywords.includes(key)) {
    suggestedKeywords.push(key);
    filterConfig.suggestedKeywords = suggestedKeywords;
    keywordUsage[key] = 1;
    scheduleSaveKeywordUsage();
    renderSuggestedKeys();
  }
}

function initSettings() {
  document.getElementById('refreshAllBtn').addEventListener('click', refreshAllStores);
  document.getElementById('settingsBtn').addEventListener('click', openSettings);
  document.querySelector('.close-settings').addEventListener('click', closeSettings);
  document.getElementById('settingsExportBtn').addEventListener('click', () => downloadBlob('/api/stores/export', 'ai-price-monitor-data.json'));
  document.getElementById('settingsImportBtn').addEventListener('click', () => document.getElementById('settingsImportFile').click());
  document.getElementById('settingsImportFile').addEventListener('change', importData);
  document.getElementById('saveRefreshBtn').addEventListener('click', saveRefreshConfig);
  document.getElementById('saveKeywordsBtn').addEventListener('click', saveKeywords);
  document.getElementById('storeExportBtn').addEventListener('click', exportSingleStore);
  document.getElementById('storeListExportBtn').addEventListener('click', () => downloadBlob('/api/stores/export-list', 'stores-list.json'));
  document.getElementById('storeListImportBtn').addEventListener('click', () => document.getElementById('storeListImportFile').click());
  document.getElementById('storeListImportFile').addEventListener('change', importStoreList);
  document.getElementById('historyExportAllBtn').addEventListener('click', () => downloadBlob('/api/history/export', 'all-history.json'));
  document.getElementById('historyImportAllBtn').addEventListener('click', () => document.getElementById('historyImportAllFile').click());
  document.getElementById('historyImportAllFile').addEventListener('change', importAllHistoryFile);
  document.getElementById('storeHistoryExportBtn').addEventListener('click', exportStoreHistory);
  document.getElementById('storeHistoryImportBtn').addEventListener('click', () => document.getElementById('storeHistoryImportFile').click());
  document.getElementById('storeHistoryImportFile').addEventListener('change', importStoreHistoryFile);
  document.getElementById('labelManagerRefreshBtn').addEventListener('click', loadLabelManager);
  document.querySelectorAll('.settings-option').forEach(el => {
    el.addEventListener('click', () => switchSettingsOption(el.dataset.option));
  });
}

function openSettings() {
  const cfg = refreshConfig;
  if (cfg.mode === 'fixed') {
    document.querySelector('input[name="refreshMode"][value="fixed"]').checked = true;
  } else {
    document.querySelector('input[name="refreshMode"][value="random"]').checked = true;
  }
  document.getElementById('refreshMin').value = cfg.minMinutes || 60;
  document.getElementById('refreshMax').value = cfg.maxMinutes || 360;
  document.getElementById('refreshFixed').value = cfg.fixedMinutes || 120;
  document.getElementById('refreshSaveMsg').textContent = '';
  document.getElementById('keywordsTextarea').value = (filterConfig.suggestedKeywords || suggestedKeywords).join('\n');
  document.getElementById('keywordsSaveMsg').textContent = '';
  renderCatVisibility();
  renderNextRefresh(cfg.nextRefreshAt);
  startNextRefreshTimer(cfg.nextRefreshAt);
  renderStoreExportSelect();
  renderStoreHistorySelects();
  document.getElementById('settingsModal').style.display = 'block';
}

let _nextRefreshTimer = null;

function renderNextRefresh(ts) {
  const el = document.getElementById('nextRefreshInfo');
  if (!ts) { el.textContent = '暂无下次刷新安排'; return; }
  const diff = ts - Date.now();
  if (diff <= 0) { el.textContent = '即将刷新...'; return; }
  const min = Math.floor(diff / 60000);
  const sec = Math.floor((diff % 60000) / 1000);
  el.textContent = `⏳ 下次自动刷新: ${min} 分 ${sec} 秒后`;
}

function startNextRefreshTimer(ts) {
  clearInterval(_nextRefreshTimer);
  if (!ts) return;
  _nextRefreshTimer = setInterval(() => {
    const el = document.getElementById('nextRefreshInfo');
    if (!el || document.getElementById('settingsModal').style.display !== 'block') {
      clearInterval(_nextRefreshTimer);
      return;
    }
    renderNextRefresh(ts);
  }, 1000);
}

function renderCatVisibility() {
  const hidden = filterConfig.hiddenCategories || [];
  const order = filterConfig.categoryOrder || Object.keys(CAT_LABELS);
  const container = document.getElementById('catVisibility');
  container.innerHTML = order.filter(k => CAT_LABELS[k]).map((k, i) =>
    `<div class="cat-vis-row" draggable="true" data-drag-type="category" data-cat="${escapeHtml(k)}">
      <span class="cat-drag-handle">⠿</span>
      <label style="flex:1;font-size:12px;display:flex;align-items:center;gap:4px;cursor:pointer">
        <input type="checkbox" ${hidden.includes(k) ? '' : 'checked'} data-change-action="toggle-category" data-category="${escapeHtml(k)}">
        ${CAT_LABELS[k]}
      </label>
    </div>`
  ).join('');
}

let _catDragKey = null;
function catDragStart(e, k) { _catDragKey = k; e.dataTransfer.effectAllowed = 'move'; e.target.classList.add('dragging'); }
function catDragOver(e) { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; }
function catDragEnd() { document.querySelectorAll('.cat-vis-row.dragging').forEach(el => el.classList.remove('dragging')); _catDragKey = null; }
function catDrop(e, targetKey) {
  e.preventDefault();
  if (!_catDragKey || _catDragKey === targetKey) return;
  const order = filterConfig.categoryOrder || Object.keys(CAT_LABELS);
  const from = order.indexOf(_catDragKey);
  const to = order.indexOf(targetKey);
  if (from === -1 || to === -1) return;
  order.splice(from, 1);
  order.splice(to, 0, _catDragKey);
  filterConfig.categoryOrder = order;
  renderCatVisibility();
  apiFetch('/api/filter-config', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(filterConfig) });
  markDirty();
  render();
}

function toggleCatVisibility(k, show) {
  if (!filterConfig.hiddenCategories) filterConfig.hiddenCategories = [];
  if (show) filterConfig.hiddenCategories = filterConfig.hiddenCategories.filter(c => c !== k);
  else if (!filterConfig.hiddenCategories.includes(k)) filterConfig.hiddenCategories.push(k);
  apiFetch('/api/filter-config', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(filterConfig) });
}

function closeSettings() {
  clearInterval(_nextRefreshTimer);
  document.getElementById('settingsModal').style.display = 'none';
}

function switchSettingsOption(option) {
  document.querySelectorAll('.settings-option').forEach(el => el.classList.remove('active'));
  document.querySelector(`.settings-option[data-option="${option}"]`).classList.add('active');
  document.querySelectorAll('.settings-panel-item').forEach(el => el.classList.remove('active'));
  const panel = document.getElementById('settingsPanel' + option.charAt(0).toUpperCase() + option.slice(1));
  if (panel) panel.classList.add('active');
  if (option === 'labels') setTimeout(loadLabelManager, 50);
}

async function saveRefreshConfig() {
  const mode = document.querySelector('input[name="refreshMode"]:checked').value;
  const minMinutes = parseInt(document.getElementById('refreshMin').value) || 60;
  const maxMinutes = parseInt(document.getElementById('refreshMax').value) || 360;
  const fixedMinutes = parseInt(document.getElementById('refreshFixed').value) || 120;
  const config = { mode, minMinutes, maxMinutes, fixedMinutes };
  try {
    const res = await apiFetch('/api/refresh-config', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(config) });
    if (res.ok) {
      refreshConfig = await res.json();
      renderNextRefresh(refreshConfig.nextRefreshAt);
      startNextRefreshTimer(refreshConfig.nextRefreshAt);
      document.getElementById('refreshSaveMsg').textContent = '✓ 已保存';
      document.getElementById('refreshSaveMsg').style.color = '#43a047';
    } else {
      document.getElementById('refreshSaveMsg').textContent = '保存失败';
      document.getElementById('refreshSaveMsg').style.color = '#e53935';
    }
  } catch (e) {
    document.getElementById('refreshSaveMsg').textContent = '保存失败';
    document.getElementById('refreshSaveMsg').style.color = '#e53935';
  }
}

function renderStoreExportSelect() {
  const sel = document.getElementById('storeExportSelect');
  sel.innerHTML = '<option value="">-- 选择店铺 --</option>' +
    storeSummaries.filter(s => s.status === 'ok' || s.status === 'error').map(s =>
      `<option value="${escapeHtml(s.id)}">${escapeHtml(s.name || s.id)}</option>`
    ).join('');
}

function exportSingleStore() {
  const sel = document.getElementById('storeExportSelect');
  const id = sel.value;
  const msg = document.getElementById('storeExportMsg');
  if (!id) { msg.textContent = '请先选择店铺'; msg.style.color = '#e53935'; return; }
  downloadBlob(`/api/stores/${id}/export`, `store-${id}.json`);
  msg.textContent = '✓ 已开始下载';
  msg.style.color = '#43a047';
}

async function downloadBlob(url, filename) {
  try {
    const res = await apiFetch(url);
    if (!res.ok) throw new Error('下载失败');
    const blob = await res.blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    URL.revokeObjectURL(a.href);
  } catch (e) {
    console.error('下载失败:', e);
  }
}

async function importStoreList(e) {
  const file = e.target.files[0];
  if (!file) return;
  const msg = document.getElementById('storeListImportMsg');
  msg.textContent = '导入中...';
  msg.style.color = 'var(--primary)';
  try {
    const text = await file.text();
    const list = JSON.parse(text);
    if (!Array.isArray(list)) throw new Error('数据格式错误，应为店铺数组');
    let added = 0, skipped = 0;
    const existing = storeSummaries.map(s => s.id);
    for (const item of list) {
      if (!item.url || !item.url.startsWith('http')) { skipped++; continue; }
      if (existing.includes(item.id)) { skipped++; continue; }
      try {
        await apiFetch('/api/stores', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: item.url }) });
        added++;
      } catch { skipped++; }
    }
    msg.textContent = `✓ 导入完成: 新增 ${added} 个，跳过 ${skipped} 个`;
    msg.style.color = '#43a047';
    e.target.value = '';
    storeSummaries = await (await apiFetch('/api/stores/summary')).json();
    stores = await (await apiFetch('/api/stores')).json();
    markDirty();
    render();
    renderStoreList();
  } catch (err) {
    msg.textContent = '导入失败: ' + err.message;
    msg.style.color = '#e53935';
  }
}

async function importSingleStoreFile(e) {
  const file = e.target.files[0];
  if (!file) return;
  const msg = document.getElementById('storeImportMsg');
  msg.textContent = '导入中...';
  msg.style.color = 'var(--primary)';
  try {
    const text = await file.text();
    const data = JSON.parse(text);
    const res = await apiFetch('/api/stores/import-single', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
    if (res.ok) {
      const result = await res.json();
      msg.textContent = '✓ 导入成功，即将刷新';
      msg.style.color = '#43a047';
      storeSummaries = await (await apiFetch('/api/stores/summary')).json();
      stores = await (await apiFetch('/api/stores')).json();
      e.target.value = '';
      setTimeout(() => location.reload(), 1500);
    } else {
      const err = await res.json();
      msg.textContent = '导入失败: ' + (err.error || '');
      msg.style.color = '#e53935';
    }
  } catch (err) {
    msg.textContent = '导入失败: ' + err.message;
    msg.style.color = '#e53935';
  }
}

async function saveKeywords() {
  const text = document.getElementById('keywordsTextarea').value;
  const keys = text.split('\n').map(s => s.trim()).filter(Boolean);
  const msg = document.getElementById('keywordsSaveMsg');
  try {
    filterConfig.suggestedKeywords = keys;
    filterConfig.keywordUsage = keywordUsage;
    const res = await apiFetch('/api/filter-config', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(filterConfig) });
    if (res.ok) {
      suggestedKeywords = keys;
      renderSuggestedKeys();
      msg.textContent = '✓ 已保存';
      msg.style.color = '#43a047';
    } else {
      msg.textContent = '保存失败';
      msg.style.color = '#e53935';
    }
  } catch (e) {
    msg.textContent = '保存失败';
    msg.style.color = '#e53935';
  }
}

async function importData(e) {
  const file = e.target.files[0];
  if (!file) return;
  const msg = document.getElementById('importMsg');
  msg.textContent = '导入中...';
  msg.style.color = '#1a73e8';
  try {
    const text = await file.text();
    const data = JSON.parse(text);
    const res = await apiFetch('/api/stores/import', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
    if (res.ok) {
      msg.textContent = '✓ 导入成功，页面即将刷新';
      msg.style.color = '#43a047';
      setTimeout(() => location.reload(), 1500);
    } else {
      const err = await res.json();
      msg.textContent = '导入失败: ' + (err.error || '');
      msg.style.color = '#e53935';
    }
  } catch (e) {
    msg.textContent = '导入失败: ' + e.message;
    msg.style.color = '#e53935';
  }
  e.target.value = '';
}

function renderStoreHistorySelects() {
  const stores = storeSummaries.filter(s => s.status === 'ok' || s.status === 'error');
  const html = stores.map(s => `<option value="${escapeHtml(s.id)}">${escapeHtml(s.name || s.id)}</option>`).join('');
  document.getElementById('storeHistoryExportSelect').innerHTML = '<option value="">-- 选择店铺 --</option>' + html;
  document.getElementById('storeHistoryImportSelect').innerHTML = '<option value="">-- 选择店铺 --</option>' + html;
}

function exportStoreHistory() {
  const sel = document.getElementById('storeHistoryExportSelect');
  const id = sel.value;
  const msg = document.getElementById('historyMsg');
  if (!id) { msg.textContent = '请先选择店铺'; msg.style.color = '#e53935'; return; }
  downloadBlob(`/api/stores/${encodeURIComponent(id)}/history/export`, `history-${id}.json`);
  msg.textContent = '✓ 已开始下载';
  msg.style.color = '#43a047';
}

async function importStoreHistoryFile(e) {
  const file = e.target.files[0];
  if (!file) return;
  const sel = document.getElementById('storeHistoryImportSelect');
  const id = sel.value;
  const msg = document.getElementById('historyMsg');
  if (!id) { msg.textContent = '请先选择店铺'; msg.style.color = '#e53935'; return; }
  msg.textContent = '导入中...';
  msg.style.color = 'var(--primary)';
  try {
    const text = await file.text();
    const data = JSON.parse(text);
    const res = await apiFetch(`/api/stores/${encodeURIComponent(id)}/history/import`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
    if (res.ok) {
      msg.textContent = '✓ 历史数据导入成功';
      msg.style.color = '#43a047';
    } else {
      const err = await res.json();
      msg.textContent = '导入失败: ' + (err.error || '');
      msg.style.color = '#e53935';
    }
  } catch (err) {
    msg.textContent = '导入失败: ' + err.message;
    msg.style.color = '#e53935';
  }
  e.target.value = '';
}

async function importAllHistoryFile(e) {
  const file = e.target.files[0];
  if (!file) return;
  const msg = document.getElementById('historyMsg');
  msg.textContent = '导入中...';
  msg.style.color = 'var(--primary)';
  try {
    const text = await file.text();
    const data = JSON.parse(text);
    const res = await apiFetch('/api/history/import', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
    if (res.ok) {
      msg.textContent = '✓ 全量历史数据导入成功';
      msg.style.color = '#43a047';
    } else {
      const err = await res.json();
      msg.textContent = '导入失败: ' + (err.error || '');
      msg.style.color = '#e53935';
    }
  } catch (err) {
    msg.textContent = '导入失败: ' + err.message;
    msg.style.color = '#e53935';
  }
  e.target.value = '';
}

function removeWord(word, type) {
  if (type === 'include') includeWords = includeWords.filter(w => w !== word);
  else excludeWords = excludeWords.filter(w => w !== word);
  renderChips();
  render();
}

function renderChips() {
  const inc = document.getElementById('includeChips');
  inc.innerHTML = includeWords.map(w =>
    `<span class="chip chip-inc">${escapeHtml(w)}<span class="chip-del" data-action="remove-word" data-word="${escapeHtml(w)}" data-type="include">&times;</span></span>`
  ).join('');

  const exc = document.getElementById('excludeChips');
  exc.innerHTML = excludeWords.map(w =>
    `<span class="chip chip-exc">${escapeHtml(w)}<span class="chip-del" data-action="remove-word" data-word="${escapeHtml(w)}" data-type="exclude">&times;</span></span>`
  ).join('');
}

function closeModal() {
  historyRequestId++;
  document.getElementById('historyModal').style.display = 'none';
}

function navigateProduct(dir) {
  const newIdx = navIndex + dir;
  if (newIdx < 0 || newIdx >= navProducts.length) return;
  navIndex = newIdx;
  const p = navProducts[navIndex];
  showHistory(p.storeId, p.id, p.name, true);
}

async function loadStoreSummaries() {
  storeSummaries = await (await apiFetch('/api/stores/summary')).json();
  renderStoreList();
  renderBestPrices();
  renderPriceRange();
  if (!stores.length) {
    document.getElementById('storesContainer').innerHTML = '<div class="empty-state">请添加店铺开始监控</div>';
  }
}

async function loadStoreWithProducts(storeId) {
  if (storeId === 'all') {
    stores = await (await apiFetch('/api/stores')).json();
    markDirty();
    return;
  }
  const full = await (await apiFetch(`/api/stores/${storeId}`)).json();
  const idx = stores.findIndex(s => s.id === storeId);
  if (idx >= 0) stores[idx] = full;
  else stores.push(full);
  markDirty();
}

function needsAutoRefresh(lastUpdated) {
  if (!lastUpdated) return true;
  return Date.now() - new Date(lastUpdated).getTime() > 10 * 60 * 1000;
}

function categorize(name) {
  for (const [cat, patterns] of Object.entries(filterConfig.filterPatterns || {})) {
    for (const p of patterns) {
      try { if (new RegExp(p, 'i').test(name)) return cat; } catch (_) { }
    }
  }
  return 'other';
}

function matchesSearch(name) {
  const lower = name.toLowerCase();
  if (includeWords.length && !includeWords.every(w => lower.includes(w.toLowerCase()))) return false;
  if (excludeWords.length && excludeWords.some(w => lower.includes(w.toLowerCase()))) return false;
  return true;
}

function getAllProducts() {
  if (!productsDirty) return cachedProducts;
  const all = [];
  for (const s of stores) {
    for (const p of (s.products || [])) {
      const pk = `${s.id}:${p.id}`;
      const label = productLabels[pk];
      const cat = label ? label.category : categorize(p.name);
      const conf = label ? label.confidence : 0;
      all.push({ ...p, category: cat, confidence: conf, productKey: pk, storeName: s.name, storeId: s.id });
    }
  }
  cachedProducts = all;
  productsDirty = false;
  return all;
}

function markDirty() { productsDirty = true; }

function applyStoreOrder() {
  if (!storeOrder.length) return;
  const sortByOrder = (a, b) => {
    const ai = storeOrder.indexOf(a.id);
    const bi = storeOrder.indexOf(b.id);
    if (ai === -1 && bi === -1) return 0;
    if (ai === -1) return 1;
    if (bi === -1) return -1;
    return ai - bi;
  };
  storeSummaries.sort(sortByOrder);
  stores.sort(sortByOrder);
}

function getFilteredProducts() {
  let all = getAllProducts();
  if (activeStoreId !== 'all') all = all.filter(p => p.storeId === activeStoreId);
  if (activeCatL2) {
    all = all.filter(p => p.category === activeCatL2);
  } else if (activeCatL1) {
    all = all.filter(p => catL1Display(catL1FromFull(p.category)) === activeCatL1);
  }
  if (includeWords.length || excludeWords.length) all = all.filter(p => matchesSearch(p.name));
  all.sort((a, b) => {
    if ((a.stock > 0) !== (b.stock > 0)) return a.stock > 0 ? -1 : 1;
    return a.price - b.price;
  });
  return all;
}

function computeBestPrices() {
  const cats = ['gpt_plus', 'gpt_pro', 'gpt_team', 'sms'];
  const all = (includeWords.length || excludeWords.length) ? getFilteredProducts() : getAllProducts();
  const result = {};
  for (const cat of cats) {
    const items = all.filter(p => p.category === cat && p.price > 0);
    if (items.length) {
      items.sort((a, b) => a.price - b.price);
      result[cat] = items[0];
    } else result[cat] = null;
  }
  return result;
}

const CAT_LABELS = {
  plus_已接码: 'Plus已接码', plus_未接码: 'Plus未接码', plus_质保: 'Plus质保',
  gpt_pro: 'GPT Pro', gpt_team: 'GPT Team', gemini: 'Gemini', claude: 'Claude',
  grok: 'Grok', sms: '接码', gptk12: 'K12', gpt_free: 'GPT Free', gpt_go: 'GPT GO',
  gpt_max: 'GPT Max', gpt_image2: 'GPT Image2', gpt_cyber: 'GPT Cyber',
  claude_pro: 'Claude Pro', claude_max: 'Claude Max',
  gemini_优惠链接: 'Gemini优惠', gemini_成品号: 'Gemini成品',
  ai_platform_cursor: 'Cursor', ai_platform_perplexity: 'Perplexity',
  ai_platform_kiro: 'KIRO',
  邮箱_gmail: 'Gmail', 邮箱_outlook: 'Outlook', 邮箱_icloud: 'iCloud',
  邮箱_hotmail: 'Hotmail', 邮箱_教育邮箱: '教育邮箱', 邮箱_企业邮箱: '企业邮箱',
  号码_美国: '美国号码', 号码_印度: '印度号码', 号码_英国: '英国号码',
  号码_香港: '香港号码',
  社交账号_twitter: 'Twitter', 社交账号_telegram: 'Telegram', 社交账号_tiktok: 'TikTok',
  视频会员_腾讯视频: '腾讯视频', 视频会员_bilibili: 'B站', 视频会员_华为视频: '华为视频',
  网盘_百度网盘: '百度网盘', 网盘_夸克网盘: '夸克网盘',
  阅读会员_百度文库: '百度文库', 阅读会员_咪咕阅读: '咪咕阅读',
  QQ会员_黄钻: 'QQ黄钻',
  中转额度_额度充值: '额度充值', 中转额度_中转券: '中转券',
  卡密兑换_兑换码: '兑换码', 卡密兑换_有效期卡密: '有效期卡密',
  虚拟卡_visa虚拟卡: 'VISA虚拟卡',
  开发工具_api: 'API', 开发工具_codex: 'Codex', 开发工具_cursor: 'Cursor',
  生活券_美团: '美团', 生活券_古茗: '古茗', 生活券_霸王茶姬: '霸王茶姬',
  电商工具_闲鱼助手: '闲鱼助手',
  反重力_Antigravity: '反重力',
  Adobe_Firefly: 'Adobe Firefly',
  其他: '其他',
};

function visibleCatEntries() {
  const hidden = filterConfig.hiddenCategories || [];
  const order = filterConfig.categoryOrder || Object.keys(CAT_LABELS);
  return order.filter(k => !hidden.includes(k) && CAT_LABELS[k]).map(k => [k, CAT_LABELS[k]]);
}

const CAT_L1_DISPLAY = ['gpt', 'claude', 'gemini', 'grok', '邮箱', '接码', '中转', '其他'];

const CAT_L1_LABELS = {
  gpt: 'GPT', claude: 'Claude', gemini: 'Gemini', grok: 'Grok',
  ai_platform: 'AI平台', 邮箱: '邮箱', 号码: '号码', 社交账号: '社交',
  视频会员: '视频', 音乐会员: '音乐', 生活券: '生活券', 网盘: '网盘',
  阅读会员: '阅读', QQ会员: 'QQ', 云服务: '云服务', 中转额度: '中转',
  教程服务: '教程', IP代理: 'IP/代理', 卡密兑换: '卡密', 虚拟卡: '虚拟卡',
  开发工具: '开发', 电商工具: '电商', 企业服务: '企业', 反重力: '反重力',
  Adobe: 'Adobe', 修图剪辑: '修图', AI平台: 'AI平台', sms: '接码', 其他: '其他',
  接码: '接码', 中转: '中转',
};

const CAT_L2_LABELS = {
  'plus_已接码': 'Plus已接码', 'plus_未接码': 'Plus未接码', 'plus_质保': 'Plus质保',
  'pro': 'Pro', 'team': 'Team', 'k12': 'K12', 'free': 'Free', 'go': 'GO', 'max': 'Max',
  'image2': 'Image2', 'cyber': 'Cyber',
  'pro年卡': 'Pro年卡', '优惠链接': '优惠链接', '成品号': '成品号',
  'super_grok': 'Super Grok', '普号': '普号',
  'gmail': 'Gmail', 'outlook': 'Outlook', 'icloud': 'iCloud', 'hotmail': 'Hotmail',
  '教育邮箱': '教育邮箱', '企业邮箱': '企业邮箱', '其他邮箱': '其他邮箱',
  '美国': '美国', '印度': '印度', '英国': '英国', '巴西': '巴西', '印尼': '印尼',
  '随机国家': '随机', '香港': '香港', '其他号码': '其他号码',
  'twitter': 'Twitter', 'telegram': 'Telegram', 'discord': 'Discord',
  'tiktok': 'TikTok', 'instagram': 'Instagram', 'facebook': 'Facebook',
  'YouTube': 'YouTube', '其他社交': '其他社交',
  '腾讯视频': '腾讯', 'bilibili': 'B站', '芒果TV': '芒果', '华为视频': '华为',
  '咪咕视频': '咪咕', '埋堆堆': '埋堆堆', '剪映': '剪映', '醒图': '醒图',
  '其他视频': '其他视频',
  '酷狗音乐': '酷狗', '网易云': '网易云', 'QQ音乐': 'QQ音乐', '其他音乐': '其他音乐',
  '美团': '美团', '瑞幸': '瑞幸', '古茗': '古茗', '星巴克': '星巴克', '霸王茶姬': '霸王茶姬',
  '其他券': '其他券',
  '百度网盘': '百度网盘', '夸克网盘': '夸克网盘', '其他网盘': '其他网盘',
  '百度文库': '百度文库', '咪咕阅读': '咪咕阅读', '其他阅读': '其他阅读',
  '黄钻': '黄钻', '其他': '其他',
  '云手机': '云手机', '星辰之恋': '星辰之恋',
  '中转券': '中转券', '额度充值': '额度充值',
  '教程': '教程',
  '住宅IP': '住宅IP', '机房IP': '机房IP', 'vpn': 'VPN', '其他网络': '其他网络',
  '有效期卡密': '有效期卡密', '兑换码': '兑换码', '充值码': '充值码',
  'visa虚拟卡': 'VISA', '其他虚拟卡': '其他虚拟卡',
  'cursor': 'Cursor', 'codex': 'Codex', 'api': 'API',
  '闲鱼助手': '闲鱼助手', '其他电商': '其他电商',
  '公司注册': '公司注册', '营业执照': '营业执照', '其他企业': '其他企业',
  'Antigravity': 'Antigravity',
  'Firefly': 'Firefly',
  '云梦AI': '云梦AI', '咕噜咕噜AI': '咕噜咕噜AI',
  '接码': '接码',
  'cursor': 'Cursor', 'perplexity': 'Perplexity', 'kiro': 'KIRO', 'koro': 'KORO',
  '其他AI平台': '其他', '其他': '其他',
};

function catL2Label(l1, l2) {
  return CAT_L2_LABELS[l2] || l2;
}

function renderCatBar() {
  const all = getAllProducts();
  const counts = {};
  const l1Counts = {};
  for (const p of all) {
    counts[p.category] = (counts[p.category] || 0) + 1;
    const l1 = catL1FromFull(p.category);
    const dl1 = catL1Display(l1);
    l1Counts[dl1] = (l1Counts[dl1] || 0) + 1;
  }

  const bar = document.getElementById('catBar');

  // Row 1: Display Level 1 (7 major categories)
  const l1Buttons = CAT_L1_DISPLAY.map(l1 =>
    l1Counts[l1] ? `<button class="cat-btn ${activeCatL1 === l1 && !activeCatL2 ? 'active' : ''}" data-action="set-cat-l1" data-category="${escapeHtml(l1)}">${CAT_L1_LABELS[l1]||l1} <span class="cat-cnt">${l1Counts[l1]}</span></button>` : ''
  ).filter(Boolean).join('');

  // Row 2: Level 2 subcategories (visible only when L1 is selected)
  let l2Buttons = '';
  if (activeCatL1) {
    const subs = new Set();
    for (const p of all) {
      if (catL1Display(catL1FromFull(p.category)) === activeCatL1) subs.add(p.category);
    }
    const sorted = [...subs].sort((a, b) => (counts[b]||0) - (counts[a]||0));
    l2Buttons = sorted.map(full => {
      const l2 = catL2FromFull(full);
      return `<button class="cat-btn cat-btn-l2 ${activeCatL2 === full ? 'active' : ''}" data-action="set-cat-l2" data-category="${escapeHtml(full)}">${catL2Label(activeCatL1, l2)} <span class="cat-cnt">${counts[full]||0}</span></button>`;
    }).join('');
  }

  bar.innerHTML = `<div class="cat-bar-row">${l1Buttons}</div>` +
    (l2Buttons ? `<div class="cat-bar-row cat-bar-row-l2">${l2Buttons}</div>` : '');
}

function setCatL1(l1) {
  activeCatL1 = l1;
  activeCatL2 = '';
  activeCategory = '';
  renderLimit = 30;
  priceRange = { min: 0, max: 0 };
  render();
}

function setCatL2(full) {
  activeCatL2 = full;
  activeCategory = full;
  renderLimit = 30;
  priceRange = { min: 0, max: 0 };
  render();
}

function setCategory(cat) {
  activeCategory = cat;
  renderLimit = 30;
  priceRange = { min: 0, max: 0 };
  render();
}

function render() {
  renderLimit = 30;
  const scrollHost = document.getElementById('storesContainer');
  const hostRect = scrollHost?.getBoundingClientRect();
  const cards = document.querySelectorAll('.store-card');
  let anchor = null;
  for (const c of cards) {
    const r = c.getBoundingClientRect();
    if (hostRect && r.top < hostRect.bottom && r.bottom > hostRect.top) {
      anchor = { id: c.dataset.storeId, offset: r.top - hostRect.top };
      break;
    }
  }
  renderStoreList();
  renderBestPrices();
  renderPriceRange();
  renderCatBar();
  document.querySelectorAll('.cat-bar-row').forEach(makeDragScroll);
  renderStores();
  if (anchor) {
    requestAnimationFrame(() => {
      const el = document.querySelector(`.store-card[data-store-id="${anchor.id}"]`);
      const nextHostRect = scrollHost?.getBoundingClientRect();
      if (el && scrollHost && nextHostRect) scrollHost.scrollBy(0, el.getBoundingClientRect().top - nextHostRect.top - anchor.offset);
    });
  }

let _dragClick = true;

function makeDragScroll(el) {
  let isDown = false, startX, scrollLeft, dragDist;
  el.addEventListener('mousedown', e => {
    isDown = true;
    dragDist = 0;
    _dragClick = false;
    el.classList.add('dragging');
    startX = e.pageX - el.offsetLeft;
    scrollLeft = el.scrollLeft;
  });
  const up = () => {
    isDown = false;
    el.classList.remove('dragging');
    if (dragDist <= 5) _dragClick = true;
  };
  el.addEventListener('mouseleave', up);
  el.addEventListener('mouseup', up);
  el.addEventListener('mousemove', e => {
    if (!isDown) return;
    e.preventDefault();
    const x = e.pageX - el.offsetLeft;
    const dx = x - startX;
    dragDist = Math.abs(dx);
    el.scrollLeft = scrollLeft - dx;
  });
  el.addEventListener('click', e => {
    if (!_dragClick) { e.stopPropagation(); _dragClick = true; }
  }, true);
}
}

let dragId = null;

function renderStoreList() {
  const container = document.getElementById('storeList');
  const ok = storeSummaries.filter(s => s.status === 'ok');
  const error = storeSummaries.filter(s => s.status === 'error');
  const pend = storeSummaries.filter(s => s.status === 'pending');
  const total = storeSummaries.reduce((s, st) => s + (st.productCount || 0), 0);

  container.innerHTML = `<button class="store-btn store-btn-all ${activeStoreId === 'all' ? 'active' : ''}" data-action="switch-store" data-store-id="all"><span class="sb-name">全部</span> <span class="badge">${total}</span></button>
  ${ok.map(s => {
    const sid = escapeHtml(s.id);
    const isRefreshing = refreshingStores.has(s.id);
    return `<div class="store-row${isRefreshing ? ' is-refreshing' : ''}" draggable="true" data-drag-type="store" data-id="${sid}">
      <button class="store-btn ${activeStoreId === s.id ? 'active' : ''}" data-action="switch-store" data-store-id="${sid}" title="${formatTime(s.lastUpdated)}"><span class="drag-handle">⠿</span><span class="sb-name">${escapeHtml((s.name||s.id))}</span> <span class="badge">${s.productCount||0}</span></button>
      ${isRefreshing ? '<div class="refresh-bar"><div class="refresh-bar-inner"></div></div>' : ''}
    </div>`;
  }).join('')}
  ${error.map(s => {
    const sid = escapeHtml(s.id);
    return `<div class="store-row store-row-error" data-id="${escapeHtml(s.id)}">
      <button class="store-btn ${activeStoreId === s.id ? 'active' : ''}" data-action="switch-store" data-store-id="${sid}" title="${escapeHtml(s.error||'刷新失败')}"><span class="drag-handle" style="color:var(--danger)">⚠</span><span class="sb-name" style="color:var(--danger)">${escapeHtml((s.name||s.id))}</span> <span class="badge badge-error">失败</span></button>
    </div>`;
  }).join('')}
  ${pend.map(s => {
    const sid = escapeHtml(s.id);
    return `<div class="store-row store-row-pending" data-id="${escapeHtml(s.id)}">
      <button class="store-btn ${activeStoreId === s.id ? 'active' : ''}" data-action="switch-store" data-store-id="${sid}" title="获取中..."><span class="drag-handle" style="color:var(--text3);opacity:.5">⠿</span><span class="sb-name" style="opacity:.7">${escapeHtml((s.name||s.id))}</span> <span class="badge badge-pending">获取中</span></button>
    </div>`;
  }).join('')}`;
  updateDashboardChrome(total, ok.length, error.length, pend.length);
}

function updateDashboardChrome(totalProducts, healthyCount, errorCount, pendingCount) {
  const activeStore = activeStoreId === 'all' ? null : storeSummaries.find(s => s.id === activeStoreId);
  const title = activeStore ? (activeStore.name || activeStore.id) : '全部商品';
  const viewCount = activeStore ? (activeStore.productCount || 0) : totalProducts;
  document.getElementById('headerStoreCount').textContent = storeSummaries.length;
  document.getElementById('headerProductCount').textContent = totalProducts;
  document.getElementById('activeViewTitle').textContent = title;
  document.getElementById('activeViewMeta').textContent = `${viewCount} 个商品`;

  const healthText = document.getElementById('headerHealthText');
  const healthDot = document.querySelector('.health-dot');
  healthDot.classList.remove('warning', 'error');
  if (errorCount > 0) {
    healthText.textContent = `${errorCount} 个店铺异常`;
    healthDot.classList.add('error');
  } else if (pendingCount > 0) {
    healthText.textContent = `${pendingCount} 个店铺同步中`;
    healthDot.classList.add('warning');
  } else {
    healthText.textContent = `${healthyCount} 个店铺正常`;
  }
}

function dragStart(e, id) {
  dragId = id;
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', id);
  e.target.classList.add('dragging');
}

function dragOver(e) {
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
}

function dropStore(e, targetId) {
  e.preventDefault();
  if (!dragId || dragId === targetId) return;
  const from = storeSummaries.findIndex(s => s.id === dragId);
  const to = storeSummaries.findIndex(s => s.id === targetId);
  if (from === -1 || to === -1) return;
  const [moved] = storeSummaries.splice(from, 1);
  storeSummaries.splice(to, 0, moved);
  const [movedStore] = stores.splice(from, 1);
  stores.splice(to, 0, movedStore);
  storeOrder = storeSummaries.filter(s => s.status === 'ok').map(s => s.id);
  apiFetch('/api/store-order', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(storeOrder) })
    .then(res => { if (!res.ok) throw new Error('保存店铺排序失败'); })
    .catch(err => console.error(err.message));
  markDirty();
  render();
}

function dragEnd() {
  document.querySelectorAll('.store-row.dragging').forEach(el => el.classList.remove('dragging'));
  dragId = null;
}

async function switchStore(storeId) {
  if (storeId === activeStoreId) return;
  activeStoreId = storeId;
  priceRange = { min: 0, max: 0 };
  document.querySelectorAll('.store-btn').forEach(b => b.classList.remove('active'));
  document.querySelectorAll('.store-btn').forEach(b => {
    if (b.dataset.storeId === storeId) b.classList.add('active');
  });

  const area = document.getElementById('storesContainer');
  area.style.opacity = '0'; area.style.transform = 'translateX(20px)';

  if (storeId === 'all') {
    await loadStoreWithProducts('all');
  } else {
    const summary = storeSummaries.find(s => s.id === storeId);
    const existing = stores.find(s => s.id === storeId);
    const isError = summary?.status === 'error';
    const isPending = summary?.status === 'pending';
    if (isError || isPending || !existing || needsAutoRefresh(summary?.lastUpdated)) {
      if ((isError || isPending) && existing) {
        renderStores();
      }
      await refreshStore(storeId, true);
    }
    if (!stores.find(s => s.id === storeId)) {
      await loadStoreWithProducts(storeId);
    }
  }

  renderStoreList();
  renderBestPrices();
  setTimeout(() => { renderStores(); area.style.opacity = '1'; area.style.transform = 'translateX(0)'; }, 150);
}

function renderBestPrices() {
  let pool = getAllProducts();
  if (activeStoreId !== 'all') pool = pool.filter(p => p.storeId === activeStoreId);
  if (includeWords.length || excludeWords.length) pool = pool.filter(p => matchesSearch(p.name));
  document.getElementById('bestPriceList').innerHTML = visibleCatEntries().map(([k, label]) => {
    const items = pool.filter(p => p.category === k && p.price > 0 && p.stock > 0).sort((a, b) => a.price - b.price);
    if (!items.length) return `<div class="bp-item"><div class="bp-cat">${label}</div><div class="bp-na">暂无</div></div>`;
    const item = items[0];
    const storeId = item.storeId;
    const catFull = item.category;
    return `<div class="bp-item" data-action="go-best-price" data-store-id="${escapeHtml(storeId)}" data-category="${escapeHtml(catFull)}">
      <div class="bp-cat">${label}</div>
      <div class="bp-row"><span class="bp-price">¥${item.price.toFixed(2)}</span><span class="bp-store" title="${escapeHtml(item.storeName)}">${escapeHtml(item.storeName)}</span></div>
    </div>`;
  }).join('');
}

function goToBestPrice(storeId, category) {
  activeCatL1 = catL1FromFull(category);
  activeCatL2 = category;
  activeCategory = category;
  switchStore(storeId);
}

function renderStores() {
  const container = document.getElementById('storesContainer');
  const filtered = getFilteredProducts();
  const ids = activeStoreId === 'all' ? storeSummaries.filter(s => s.status === 'ok').map(s => s.id) : [activeStoreId];
  if (storeOrder.length && activeStoreId === 'all') ids.sort((a, b) => { const ai = storeOrder.indexOf(a); const bi = storeOrder.indexOf(b); if (ai === -1 && bi === -1) return 0; if (ai === -1) return 1; if (bi === -1) return -1; return ai - bi; });

  if (!stores.length && !storeSummaries.length) { container.innerHTML = '<div class="empty-state">请添加店铺开始监控</div>'; return; }
  if (!stores.length && storeSummaries.length) { container.innerHTML = '<div class="empty-state">请选择店铺查看商品</div>'; return; }
  if (!ids.length) { container.innerHTML = '<div class="empty-state">无匹配商品</div>'; return; }

  let cardCount = 0;
  let reachedLimit = false;
  const html = ids.map(id => {
    if (reachedLimit) return '';
    const s = stores.find(st => st.id === id);
    if (!s) return '';
    if (s.status === 'pending') return `<div class="store-card"><div class="sc-name">${escapeHtml(s.name||s.id)}</div><div class="store-loading">正在获取商品数据...</div></div>`;
    if (s.status === 'error') return `<div class="store-card"><div class="sc-name">${escapeHtml(s.name||s.id)}</div><div class="store-error">${escapeHtml(s.error||'获取失败')}</div><button class="del-btn" data-action="delete-store" data-store-id="${escapeHtml(s.id)}">删除</button></div>`;

    let products = filtered.filter(p => p.storeId === id);
    const storePrices = products.map(p => p.price).filter(v => v > 0);
    const storePriceMin = storePrices.length ? Math.min(...storePrices) : 0;
    const storePriceMax = storePrices.length ? Math.max(...storePrices) : 100;
    let gridItems = [];
    if (!products.length) {
      gridItems.push('<div class="empty-grid">该分类下无商品</div>');
    } else {
      const inStock = products.filter(p => p.stock > 0);
      const noStock = products.filter(p => !(p.stock > 0));
      const expanded = expandedNoStock[id];
      const showNoStock = expanded ? noStock : noStock.slice(0, 3);
      const hidden = noStock.length - showNoStock.length;
      const allCards = inStock.map(p => renderProductCard(p)).concat(showNoStock.map(p => renderProductCard(p)));
      for (const card of allCards) {
        if (cardCount >= renderLimit) { reachedLimit = true; break; }
        gridItems.push(card);
        cardCount++;
      }
      if (!reachedLimit) {
        if (hidden > 0) gridItems.push(`<div class="ns-toggle" data-action="toggle-no-stock" data-store-id="${escapeHtml(id)}">展开 ${noStock.length} 个无货商品...</div>`);
        if (expanded && noStock.length > 0) gridItems.push(`<div class="ns-toggle" data-action="toggle-no-stock" data-store-id="${escapeHtml(id)}">收起无货商品</div>`);
      }
    }
    if (reachedLimit && !gridItems.length) return '';
    return `<div class="store-card" data-store-id="${escapeHtml(s.id)}">
      <div class="sc-header">
        <span class="sc-name">${escapeHtml(s.name||s.id)}</span>
        <span class="sc-time">${formatTime(s.lastUpdated)}</span>
        <span class="sc-meta">${products.length} 个商品</span>
        <div class="sc-actions">
          <button class="ref-btn" data-action="refresh-store" data-store-id="${escapeHtml(s.id)}">更新</button>
          <button class="del-btn" data-action="delete-store" data-store-id="${escapeHtml(s.id)}">删除</button>
        </div>
      </div>
      <div class="product-grid">${gridItems.join('')}</div>
    </div>`;
  }).join('');
  const hasMore = cardCount >= renderLimit && filtered.length > cardCount;
  container.innerHTML = html + (hasMore ? '<div class="scroll-sentinel"></div>' : '');
  observeSentinel();
}

let _loadingMore = false;

function observeSentinel() {
  if (window._scrollObs) window._scrollObs.disconnect();
  const el = document.querySelector('.scroll-sentinel');
  if (!el) return;
  window._scrollObs = new IntersectionObserver(entries => {
    if (_loadingMore) return;
    if (entries[0].isIntersecting) {
      _loadingMore = true;
      window._scrollObs.disconnect();
      renderLimit += 30;
      const sy = window.scrollY;
      renderStores();
      requestAnimationFrame(() => { window.scrollTo(0, sy); _loadingMore = false; });
    }
  }, { rootMargin: '400px' });
  window._scrollObs.observe(el);
}

function safeUrl(url) {
  if (!url) return '';
  try {
    const parsed = new URL(String(url));
    if (['http:', 'https:'].includes(parsed.protocol)) return escapeHtml(parsed.toString());
  } catch (_) { }
  return '';
}

function safeCssToken(value) {
  return String(value || 'other').replace(/[^\p{L}\p{N}_-]/gu, '') || 'other';
}

function renderProductCard(p) {
  const inStock = p.stock > 0;
  const stockText = p.stock < 0 ? '未知' : inStock ? `有货 ${p.stock}` : `无货`;
  const confidence = Number.isFinite(Number(p.confidence)) ? Number(p.confidence) : 0;
  const confPct = confidence > 0 ? Math.round(confidence * 100) : 0;
  const category = String(p.category || 'other');
  const categoryText = escapeHtml(category);
  const categoryClass = safeCssToken(category);
  const price = Number.isFinite(Number(p.price)) ? Number(p.price) : 0;

  return `<div class="product-card ${inStock ? 'has-stock' : 'no-stock'}" data-price="${price}">
    <div class="pc-top">
      ${category !== 'other' ? `<span class="tag tag-${categoryClass}" data-action="edit-label" data-product-key="${escapeHtml(p.productKey)}" data-product-name="${escapeHtml(p.name)}" data-category="${escapeHtml(category)}" data-confidence="${confidence}" title="点击修改分类 (置信度: ${confPct}%)">${categoryText}${confPct > 0 ? `<small> ${confPct}%</small>` : ''}</span>` : `<span class="tag tag-other" data-action="edit-label" data-product-key="${escapeHtml(p.productKey)}" data-product-name="${escapeHtml(p.name)}" data-category="其他" data-confidence="0" title="点击添加分类">其他</span>`}
      <span class="pc-name" title="${escapeHtml(p.name)}">${escapeHtml(p.name)}</span>
    </div>
    <div class="pc-mid">
      <span class="pc-price">¥${price.toFixed(2)}</span>
      <span class="pc-stock">${stockText}</span>
    </div>
    <div class="pc-bot">
      ${p.purchaseUrl && safeUrl(p.purchaseUrl) ? `<a href="${safeUrl(p.purchaseUrl)}" target="_blank" rel="noopener noreferrer" class="buy-btn">购买</a>` : ''}
      <button class="hist-btn" data-action="show-history" data-store-id="${escapeHtml(p.storeId)}" data-product-id="${escapeHtml(p.id)}" data-product-name="${escapeHtml(p.name)}">走势</button>
    </div>
  </div>`;
}

function categoryKey(l1, l2) {
  if (l1 === '其他') return '其他';
  if (l1 === 'gpt' && l2.startsWith('plus_')) return l2;
  if (l1 === 'gpt' && l2 === 'k12') return 'gptk12';
  if (l1 === 'sms' && l2 === '接码') return 'sms';
  return `${l1}_${l2}`;
}

function editLabel(productKey, name, currentCat, confidence) {
  const l1 = catL1FromFull(currentCat);
  const l2 = catL2FromFull(currentCat);
  const l1Opts = CAT_L1.map(c => `<option value="${c}" ${c === l1 ? 'selected' : ''}>${c}</option>`).join('');
  const l2List = CAT_L2_MAP[l1] || ['其他'];
  const l2Opts = l2List.map(c => {
    const full = categoryKey(l1, c);
    return `<option value="${full}" ${full === currentCat || c === l2 ? 'selected' : ''}>${c}</option>`;
  }).join('');
  const div = document.createElement('div');
  div.id = 'labelOverlay';
  div.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,.4);z-index:9999;display:flex;align-items:center;justify-content:center';
  div.onclick = function(e) { if (e.target === this) this.remove(); };
  div.innerHTML = `<div style="background:var(--card-bg);border-radius:8px;padding:24px;min-width:340px;position:relative;box-shadow:0 4px 20px var(--shadow)">
    <div style="margin-bottom:12px;font-weight:600;font-size:15px;color:var(--text)">修改商品分类</div>
    <div style="margin-bottom:14px;font-size:13px;color:var(--text2);word-break:break-all">${escapeHtml(name)}</div>
    <div style="display:flex;gap:6px;margin-bottom:16px">
      <select id="labelSelectL1" data-change-action="edit-label-l1" style="flex:1;padding:8px;border:1px solid var(--border2);border-radius:6px;font-size:13px;background:var(--card-bg);color:var(--text)">${l1Opts}</select>
      <select id="labelSelect" style="flex:1;padding:8px;border:1px solid var(--border2);border-radius:6px;font-size:13px;background:var(--card-bg);color:var(--text)">${l2Opts}</select>
    </div>
    <div style="display:flex;gap:8px;justify-content:flex-end">
      <button data-action="close-label-editor" style="padding:8px 16px;background:var(--bg);color:var(--text);border:1px solid var(--border);border-radius:6px;cursor:pointer;font-size:13px">取消</button>
      <button data-action="save-label" data-product-key="${escapeHtml(productKey)}" data-product-name="${escapeHtml(name)}" data-previous-category="${escapeHtml(currentCat)}" style="padding:8px 16px;background:var(--primary);color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:13px;font-weight:600">保存</button>
    </div>
  </div>`;
  document.body.appendChild(div);
}

function onEditL1Change() {
  const l1 = document.getElementById('labelSelectL1').value;
  const l2sel = document.getElementById('labelSelect');
  const subs = CAT_L2_MAP[l1] || ['其他'];
  l2sel.innerHTML = subs.map(c => `<option value="${categoryKey(l1, c)}">${c}</option>`).join('');
}

const CAT_L1 = ['gpt','claude','gemini','grok','ai_platform','邮箱','号码','社交账号','视频会员','音乐会员','生活券','网盘','阅读会员','QQ会员','云服务','中转额度','教程服务','IP代理','卡密兑换','虚拟卡','开发工具','电商工具','企业服务','反重力','Adobe','修图剪辑','AI平台','sms','其他'];

const CAT_L2_MAP = {
  'gpt': ['plus_已接码','plus_未接码','plus_质保','pro','team','k12','free','go','max','image2','cyber','其他'],
  'claude': ['pro','max','其他'],
  'gemini': ['pro年卡','优惠链接','成品号','其他'],
  'grok': ['super_grok','普号','其他'],
  'ai_platform': ['cursor','perplexity','kiro','koro','其他AI平台','其他'],
  '邮箱': ['gmail','outlook','icloud','hotmail','教育邮箱','企业邮箱','其他邮箱','其他'],
  '号码': ['美国','印度','英国','巴西','印尼','随机国家','香港','其他号码','其他'],
  '社交账号': ['twitter','telegram','discord','tiktok','instagram','facebook','YouTube','其他社交','其他'],
  '视频会员': ['腾讯视频','bilibili','芒果TV','华为视频','咪咕视频','埋堆堆','剪映','醒图','其他视频','其他'],
  '音乐会员': ['酷狗音乐','网易云','QQ音乐','其他音乐','其他'],
  '生活券': ['美团','瑞幸','古茗','星巴克','霸王茶姬','其他券','其他'],
  '网盘': ['百度网盘','夸克网盘','其他网盘','其他'],
  '阅读会员': ['百度文库','咪咕阅读','其他阅读','其他'],
  'QQ会员': ['黄钻','其他'],
  '云服务': ['云手机','星辰之恋','其他'],
  '中转额度': ['中转券','额度充值','其他'],
  '教程服务': ['教程','其他'],
  'IP代理': ['住宅IP','机房IP','vpn','其他网络','其他'],
  '卡密兑换': ['有效期卡密','兑换码','充值码','其他'],
  '虚拟卡': ['visa虚拟卡','其他虚拟卡','其他'],
  '开发工具': ['cursor','codex','api','其他'],
  '电商工具': ['闲鱼助手','其他电商','其他'],
  '企业服务': ['公司注册','营业执照','其他企业','其他'],
  '反重力': ['Antigravity','其他'],
  'Adobe': ['Firefly','其他'],
  '修图剪辑': ['剪映','醒图','其他'],
  'AI平台': ['云梦AI','咕噜咕噜AI','其他'],
  'sms': ['接码','其他'],
  '其他': ['其他'],
};

function catL1FromFull(full) {
  if (!full) return '其他';
  for (const l1 of CAT_L1) {
    if (full.startsWith(l1 + '_') || full === l1) return l1;
  }
  if (full.startsWith('plus_') || full.startsWith('gpt_') || full === 'gptk12') return 'gpt';
  if (full.startsWith('反重力') || full.startsWith('Antigravity')) return '反重力';
  return '其他';
}

function catL1Display(l1) {
  if (!l1) return '其他';
  if (CAT_L1_DISPLAY.includes(l1)) return l1;
  const map = {
    '号码': '接码', '反重力': 'gemini', 'sms': '接码',
    'ai_platform': 'gpt', '开发工具': 'gpt', '卡密兑换': 'gpt',
    '虚拟卡': 'gpt', '电商工具': 'gpt',
    '视频会员': '其他', '音乐会员': '其他', '生活券': '其他',
    '网盘': '其他', '阅读会员': '其他', 'QQ会员': '其他',
    '云服务': '其他', '教程服务': '其他', 'IP代理': '其他',
    '社交账号': '其他', '企业服务': '其他', 'Adobe': '其他',
    '修图剪辑': '其他', 'AI平台': '其他',
  };
  return map[l1] || '其他';
}

function catL2FromFull(full) {
  if (!full) return '其他';
  const l1 = catL1FromFull(full);
  const prefix = l1 + '_';
  if (full.startsWith(prefix)) return full.slice(prefix.length);
  if (l1 === 'gpt') {
    if (full === 'gptk12') return 'k12';
    if (full.startsWith('plus_')) return full.replace('plus_', 'plus_');
    if (full.startsWith('gpt_')) return full.slice(4);
    return full;
  }
  return full;
}

function renderCatSelect(pk, name, currentCat) {
  const l1 = catL1FromFull(currentCat);
  const l2 = catL2FromFull(currentCat);
  const l1Opts = CAT_L1.map(c => `<option value="${c}" ${c === l1 ? 'selected' : ''}>${c}</option>`).join('');
  const l2Opts = (CAT_L2_MAP[l1] || ['其他']).map(c => {
    const full = categoryKey(l1, c);
    return `<option value="${full}" ${full === currentCat || c === l2 ? 'selected' : ''}>${c}</option>`;
  }).join('');
  const epk = escapeHtml(pk), ename = escapeHtml(name);
  const previous = escapeHtml(currentCat);
  return `<select class="cl2-l1" data-change-action="category-l1" data-product-key="${epk}" data-product-name="${ename}" data-previous-category="${previous}" style="padding:2px 4px;border:1px solid var(--border);border-radius:4px;font-size:11px;background:var(--card-bg);color:var(--text)">${l1Opts}</select>
    <select class="cl2-l2" data-change-action="save-label-settings" data-product-key="${epk}" data-product-name="${ename}" data-previous-category="${previous}" style="padding:2px 4px;border:1px solid var(--border);border-radius:4px;font-size:11px;background:var(--card-bg);color:var(--text)">${l2Opts}</select>`;
}

function onCatL1Change(l1sel, pk, name) {
  const l2sel = l1sel.nextElementSibling;
  const l1 = l1sel.value;
  const subs = CAT_L2_MAP[l1] || ['其他'];
  const currentFull = l2sel.value;
  const currentL2 = currentFull.startsWith(l1 + '_') ? currentFull.slice(l1.length + 1) : '';
  l2sel.innerHTML = subs.map(c => {
    const full = categoryKey(l1, c);
    return `<option value="${full}" ${c === currentL2 ? 'selected' : ''}>${c}</option>`;
  }).join('');
  saveLabelFromSettings(pk, name, l2sel.value, l1sel.dataset.previousCategory, l2sel);
}

function loadLabelManager() {
  const container = document.getElementById('labelManagerList');
  const search = document.getElementById('labelSearchInput')?.value?.toLowerCase() || '';
  const catFilter = document.getElementById('labelCatFilter')?.value || '';

  if (!search && !catFilter) {
    container.innerHTML = '<div style="padding:24px;text-align:center;color:var(--text3);font-size:13px">请输入关键词或选择分类后点击刷新</div>';
    loadLabelChanges();
    return;
  }

  const labels = Object.values(productLabels);
  let filtered = labels.filter(l => l.category !== '其他');
  if (search) filtered = filtered.filter(l => l.name.toLowerCase().includes(search));
  if (catFilter) filtered = filtered.filter(l => l.category === catFilter);
  filtered.sort((a, b) => a.name.localeCompare(b.name));

  if (!filtered.length) {
    container.innerHTML = '<div style="padding:20px;text-align:center;color:var(--text3);font-size:13px">无匹配商品</div>';
    loadLabelChanges();
    return;
  }

  const maxShow = 100;
  const showing = filtered.slice(0, maxShow);
  const more = filtered.length - maxShow;

  container.innerHTML = (filtered.length > maxShow ? `<div style="padding:4px 6px;font-size:11px;color:var(--text3)">共 ${filtered.length} 条，显示前 ${maxShow} 条</div>` : '') +
    showing.map(l => {
    const pk = l.product_key.replace(/['"\\]/g, '');
    const name = l.name.replace(/['"\\]/g, '');
    return `<div style="display:flex;align-items:center;gap:4px;padding:4px 6px;border-bottom:1px solid var(--border);font-size:12px">
      <span style="flex:1;word-break:break-all;color:var(--text2);font-size:11px">${escapeHtml(l.name)}</span>
      <span style="display:flex;gap:2px;flex-shrink:0">${renderCatSelect(pk, name, l.category)}</span>
      ${l.confidence < 1 ? `<span style="font-size:10px;color:var(--text3);white-space:nowrap">${Math.round(l.confidence*100)}%</span>` : '<span style="font-size:10px;color:var(--success);flex-shrink:0">手动</span>'}
    </div>`;
  }).join('') + (more > 0 ? `<div style="padding:6px;text-align:center;font-size:11px;color:var(--text3)">还有 ${more} 条，请精确搜索</div>` : '');

  loadLabelChanges();
}

async function loadLabelChanges() {
  const el = document.getElementById('labelChangeLog');
  try {
    const changes = await (await apiFetch('/api/label-changes')).json();
    el.innerHTML = changes.slice(0, 30).map(c =>
      `<div style="padding:3px 0;border-bottom:1px solid var(--border)">${escapeHtml(c.name)}: <span style="color:var(--danger)">${escapeHtml(c.old_category||'?')}</span> → <span style="color:var(--success)">${escapeHtml(c.new_category)}</span> <span style="color:var(--text3);font-size:10px">${escapeHtml(c.changed_at)}</span></div>`
    ).join('');
    if (!changes.length) el.innerHTML = '<div style="color:var(--text3);padding:4px">暂无调整记录</div>';
  } catch { el.innerHTML = ''; }
}

async function saveLabelFromSettings(productKey, name, category, previousCategory, source) {
  const res = await apiFetch(`/api/product-labels/${encodeURIComponent(productKey)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ category, name, previousCategory }),
  });
  if (res.ok) {
    const result = await res.json();
    productLabels[productKey] = result.label || { product_key: productKey, name, category, confidence: 1.0 };
    if (source) {
      source.dataset.previousCategory = category;
      const sibling = source.previousElementSibling || source.nextElementSibling;
      if (sibling?.dataset) sibling.dataset.previousCategory = category;
    }
    markDirty();
    renderCatBar();
    renderBestPrices();
  }
}

async function saveLabel(productKey, name, previousCategory) {
  const select = document.getElementById('labelSelect');
  const category = select.value;
  const res = await apiFetch(`/api/product-labels/${encodeURIComponent(productKey)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ category, name, previousCategory }),
  });
  if (res.ok) {
    const result = await res.json();
    productLabels[productKey] = result.label || { product_key: productKey, name, category, confidence: 1.0 };
    markDirty();
    document.getElementById('labelOverlay')?.remove();
    render();
  }
}

function escapeHtml(s) {
  if (!s) return '';
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

function formatTime(iso) {
  if (!iso) return '暂无更新';
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60000) return '刚刚更新';
  if (diff < 3600000) return Math.floor(diff / 60000) + ' 分钟前更新';
  if (diff < 86400000) return Math.floor(diff / 3600000) + ' 小时前更新';
  return new Date(iso).toLocaleDateString('zh-CN') + ' 更新';
}

function showAddModal() {
  document.getElementById('addStoreUrl').value = '';
  document.getElementById('addStoreMsg').textContent = '';
  document.getElementById('addStoreSubmit').disabled = false;
  document.getElementById('addStoreSubmit').textContent = '添加';
  document.getElementById('addStoreModal').style.display = 'block';
  setTimeout(() => document.getElementById('addStoreUrl').focus(), 100);
}

function closeAddModal() {
  document.getElementById('addStoreModal').style.display = 'none';
}

async function submitAddStore() {
  const url = document.getElementById('addStoreUrl').value.trim();
  if (!url) return;
  const btn = document.getElementById('addStoreSubmit');
  const msg = document.getElementById('addStoreMsg');
  btn.disabled = true; btn.textContent = '获取中...';
  msg.textContent = '';
  try {
    const res = await apiFetch('/api/stores', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url }) });
    if (!res.ok) {
      const e = await res.json();
      msg.textContent = e.error || '添加失败';
      msg.style.color = '#e53935';
      btn.disabled = false; btn.textContent = '添加';
      return;
    }
    const storeData = await res.json();
    msg.textContent = '正在获取商品数据...';
    msg.style.color = '#1a73e8';
    let n = 0;
    while (n < 30) {
      await new Promise(r => setTimeout(r, 1500));
      const check = await (await apiFetch('/api/stores/summary')).json();
      const updated = check.find(s => s.id === storeData.id);
      if (updated && updated.status === 'ok') {
        storeSummaries = check;
        await loadStoreWithProducts(storeData.id);
        const newLabels = await (await apiFetch('/api/product-labels')).json();
        for (const l of newLabels) { productLabels[l.product_key] = l; }
        markDirty();
        if (activeStoreId === 'all' || activeStoreId === storeData.id) {
          render();
        } else {
          renderStoreList();
          renderBestPrices();
        }
        closeAddModal();
        return;
      }
      if (updated && updated.status === 'error') {
        msg.textContent = '获取失败: ' + (updated.error || '未知错误');
        msg.style.color = '#e53935';
        btn.disabled = false; btn.textContent = '重试';
        storeSummaries = check;
        renderStoreList();
        return;
      }
      n++;
    }
    msg.textContent = '获取超时，请稍后手动刷新';
    msg.style.color = '#e53935';
    btn.disabled = false; btn.textContent = '重试';
    storeSummaries = await (await apiFetch('/api/stores/summary')).json();
    renderStoreList();
  } catch (e) {
    msg.textContent = '添加失败: ' + e.message;
    msg.style.color = '#e53935';
    btn.disabled = false; btn.textContent = '重试';
  }
}

async function refreshStore(id, silent) {
  refreshingStores.add(id);
  renderStoreList();
  try {
    await apiFetch(`/api/stores/${id}/refresh`, { method: 'POST' });
    let n = 0;
    while (n < 30) {
      await new Promise(r => setTimeout(r, 1500));
      const summary = await (await apiFetch('/api/stores/summary')).json();
      const updated = summary.find(s => s.id === id);
      if (updated) {
        storeSummaries = summary.map(s => s.id === id ? updated : s);
        applyStoreOrder();
        if (updated.status === 'ok') {
          await loadStoreWithProducts(id);
          const newLabels = await (await apiFetch('/api/product-labels')).json();
          for (const l of newLabels) { productLabels[l.product_key] = l; }
          markDirty();
          flashSuccess(id);
          if (!silent) renderStores();
          return;
        }
        if (updated.status === 'error') {
          refreshingStores.delete(id);
          renderStoreList();
          break;
        }
      }
      n++;
    }
  } catch (e) {
    refreshingStores.delete(id);
    renderStoreList();
    if (!silent) alert('更新失败: ' + e.message);
  }
}

let _refreshingAll = false;
let _stopRefreshAll = false;
let refreshingStores = new Set();

async function refreshAllStores() {
  if (_refreshingAll) return;
  _refreshingAll = true;
  _stopRefreshAll = false;
  const btn = document.getElementById('refreshAllBtn');
  btn.textContent = '停止刷新';
  btn.disabled = false;
  btn.onclick = stopRefreshAll;
  const order = [...storeSummaries].filter(s => s.status === 'ok').sort((a, b) => (a.lastUpdated || '').localeCompare(b.lastUpdated || ''));
  for (const s of order) {
    if (_stopRefreshAll) break;
    refreshingStores.add(s.id);
    renderStoreList();
    try {
      await apiFetch(`/api/stores/${s.id}/refresh`, { method: 'POST' });
      let n = 0;
      while (n < 30 && !_stopRefreshAll) {
        await new Promise(r => setTimeout(r, 1500));
        if (_stopRefreshAll) break;
        const summary = await (await apiFetch('/api/stores/summary')).json();
        const updated = summary.find(x => x.id === s.id);
        if (updated) {
          storeSummaries = summary.map(x => x.id === s.id ? updated : x);
          applyStoreOrder();
          if (updated.status === 'ok') {
            await loadStoreWithProducts(s.id);
            const newLabels = await (await apiFetch('/api/product-labels')).json();
            for (const l of newLabels) { productLabels[l.product_key] = l; }
            markDirty();
            flashSuccess(s.id);
            break;
          }
          if (updated.status === 'error') {
            refreshingStores.delete(s.id);
            renderStoreList();
            break;
          }
        }
        n++;
      }
    } catch (_) {
      refreshingStores.delete(s.id);
      renderStoreList();
    }
    await new Promise(r => setTimeout(r, 1000));
  }
  finishRefreshAll();
}

function stopRefreshAll() {
  _stopRefreshAll = true;
  const btn = document.getElementById('refreshAllBtn');
  btn.textContent = '正在停止...';
  btn.disabled = true;
}

function finishRefreshAll() {
  refreshingStores.clear();
  markDirty();
  render();
  const btn = document.getElementById('refreshAllBtn');
  btn.textContent = '全局刷新';
  btn.disabled = false;
  btn.onclick = refreshAllStores;
  _refreshingAll = false;
}

function flashSuccess(id) {
  const row = document.querySelector(`.store-row[data-id="${id}"]`);
  if (row) { row.classList.add('flash-ok'); setTimeout(() => row.classList.remove('flash-ok'), 1200); }
  refreshingStores.delete(id);
  renderStoreList();
}

function sliderToPrice(val) { return Math.round(200 * Math.pow(val / 200, 2.5)); }
function priceToSlider(val) { return Math.round(200 * Math.pow(Math.min(val, 200) / 200, 0.4)); }

function renderPriceRange() {
  const container = document.getElementById('rbPriceRange');
  const min = priceRange.min || 0;
  const max = priceRange.max || 200;
  const rawMin = priceToSlider(min);
  const rawMax = priceToSlider(max);
  container.innerHTML = `
    <div class="pr-header">
      <span class="pr-label">价格区间</span>
      <span class="pr-value">¥${min} - ¥${max}</span>
    </div>
    <div class="pr-track-wrap">
      <div class="pr-track">
        <div class="pr-track-bg"></div>
        <div class="pr-fill" style="left:${rawMin/2}%;right:${100-rawMax/2}%"></div>
        <input type="range" min="0" max="200" value="${rawMin}" step="1" class="pr-min" id="prMinSlider" data-input-action="price-range">
        <input type="range" min="0" max="200" value="${rawMax}" step="1" class="pr-max" id="prMaxSlider" data-input-action="price-range">
      </div>
    </div>
    <div class="pr-inputs">
      <div class="pr-input-group">
        <span class="pr-input-symbol">¥</span>
        <input class="pr-min-input" type="number" min="0" max="200" value="${min}" data-change-action="price-number" data-bound="min">
      </div>
      <span class="pr-input-sep">—</span>
      <div class="pr-input-group">
        <span class="pr-input-symbol">¥</span>
        <input class="pr-max-input" type="number" min="0" max="200" value="${max}" data-change-action="price-number" data-bound="max">
      </div>
    </div>
  `;
}

function onPriceInput(input) {
  const minS = document.getElementById('prMinSlider');
  const maxS = document.getElementById('prMaxSlider');
  let rawMin = parseFloat(minS.value);
  let rawMax = parseFloat(maxS.value);
  if (rawMin > rawMax) {
    if (input === minS) { rawMax = rawMin; maxS.value = rawMin; }
    else { rawMin = rawMax; minS.value = rawMax; }
  }
  const min = sliderToPrice(rawMin);
  const max = sliderToPrice(rawMax);
  const fill = document.querySelector('.pr-fill');
  fill.style.left = (rawMin / 2) + '%';
  fill.style.right = (100 - rawMax / 2) + '%';
  document.querySelector('.pr-min-input').value = min;
  document.querySelector('.pr-max-input').value = max;
  priceRange.min = min; priceRange.max = max;
  clearTimeout(_priceTimer);
  _priceTimer = setTimeout(applyPriceFilter, 100);
}

function onPriceInputNum(input, which) {
  let val = parseFloat(input.value);
  if (isNaN(val) || val < 0) val = 0;
  if (val > 200) val = 200;
  input.value = val;
  if (which === 'min') {
    document.getElementById('prMinSlider').value = priceToSlider(val);
  } else {
    document.getElementById('prMaxSlider').value = priceToSlider(val);
  }
  onPriceInput(document.getElementById('pr' + (which === 'min' ? 'Min' : 'Max') + 'Slider'));
}

function applyPriceFilter() {
  document.querySelectorAll('.product-card').forEach(el => {
    const p = parseFloat(el.dataset.price);
    const show = (!priceRange.min || p >= priceRange.min) && (!priceRange.max || p <= priceRange.max) || p > 200;
    el.style.display = show ? '' : 'none';
  });
}

function toggleNoStock(id) {
  expandedNoStock[id] = !expandedNoStock[id];
  renderStores();
}

async function deleteStore(id) {
  if (!confirm('确定删除?')) return;
  await apiFetch(`/api/stores/${id}`, { method: 'DELETE' });
  storeSummaries = storeSummaries.filter(s => s.id !== id);
  stores = stores.filter(s => s.id !== id);
  markDirty();
  if (activeStoreId === id) activeStoreId = 'all';
  if (activeStoreId === 'all') {
    await loadStoreWithProducts('all');
  }
  render();
}

function compactHistory(entries) {
  const points = (Array.isArray(entries) ? entries : [])
    .map(entry => ({ price: Number(entry.price), date: new Date(entry.date) }))
    .filter(entry => Number.isFinite(entry.price) && !Number.isNaN(entry.date.getTime()))
    .sort((a, b) => a.date - b.date);
  const compact = [];
  for (let start = 0; start < points.length;) {
    let end = start;
    while (end + 1 < points.length && points[end + 1].price === points[start].price) end++;
    compact.push(points[start]);
    if (end !== start) compact.push(points[end]);
    start = end + 1;
  }
  return { points, compact };
}

function setHistoryState(message, isError = false) {
  const state = document.getElementById('historyState');
  const canvas = document.getElementById('priceChart');
  state.textContent = message;
  state.classList.toggle('error', isError);
  state.hidden = false;
  canvas.hidden = true;
}

function formatHistoryTime(date, includeDate = true) {
  return new Intl.DateTimeFormat('zh-CN', includeDate
    ? { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }
    : { hour: '2-digit', minute: '2-digit' }
  ).format(date);
}

function renderHistorySummary(points) {
  const prices = points.map(point => point.price);
  const first = prices[0];
  const current = prices[prices.length - 1];
  const difference = current - first;
  const percent = first ? difference / first * 100 : 0;
  const change = document.getElementById('historyPriceChange');
  document.getElementById('historyCurrentPrice').textContent = `¥${current.toFixed(2)}`;
  document.getElementById('historyMinPrice').textContent = `¥${Math.min(...prices).toFixed(2)}`;
  document.getElementById('historyMaxPrice').textContent = `¥${Math.max(...prices).toFixed(2)}`;
  change.textContent = `${difference > 0 ? '+' : ''}${difference.toFixed(2)} (${percent > 0 ? '+' : ''}${percent.toFixed(1)}%)`;
  change.classList.toggle('price-up', difference > 0);
  change.classList.toggle('price-down', difference < 0);
  document.getElementById('historySummary').hidden = false;
}

async function showHistory(storeId, productId, name, isNav) {
  if (!isNav) {
    const all = getFilteredProducts();
    navProducts = all;
    navIndex = all.findIndex(p => p.storeId === storeId && p.id === productId);
  }
  const requestId = ++historyRequestId;
  const modal = document.getElementById('historyModal');
  const canvas = document.getElementById('priceChart');
  document.getElementById('modalTitle').textContent = name || '价格历史';
  document.getElementById('modalProductMeta').textContent = navIndex >= 0 ? `${navIndex+1}/${navProducts.length}` : '';
  document.getElementById('prevProductBtn').style.visibility = navIndex > 0 ? 'visible' : 'hidden';
  document.getElementById('nextProductBtn').style.visibility = navIndex < navProducts.length-1 ? 'visible' : 'hidden';
  document.getElementById('historySummary').hidden = true;
  modal.style.display = 'block';
  modal.setAttribute('aria-busy', 'true');
  if (priceChart) {
    priceChart.destroy();
    priceChart = null;
  }
  setHistoryState('正在加载价格记录...');

  try {
    const response = await apiFetch(`/api/products/${encodeURIComponent(storeId)}/${encodeURIComponent(productId)}/history`);
    if (!response.ok) throw new Error('价格记录请求失败');
    const { points, compact } = compactHistory(await response.json());
    if (requestId !== historyRequestId) return;
    if (!points.length) {
      setHistoryState('暂无价格记录');
      return;
    }
    if (typeof globalThis.Chart !== 'function') throw new Error('走势图组件加载失败');

    renderHistorySummary(points);
    const firstDate = points[0].date;
    const lastDate = points[points.length - 1].date;
    const navMeta = navIndex >= 0 ? `${navIndex+1}/${navProducts.length} · ` : '';
    document.getElementById('modalProductMeta').textContent = `${navMeta}${points.length} 条记录 · ${formatHistoryTime(firstDate)} - ${formatHistoryTime(lastDate)}`;
    document.getElementById('historyState').hidden = true;
    canvas.hidden = false;

    const styles = getComputedStyle(document.body);
    const primary = styles.getPropertyValue('--primary').trim() || '#1677ff';
    const grid = styles.getPropertyValue('--border').trim() || '#e5e7eb';
    const text = styles.getPropertyValue('--text3').trim() || '#8c8c8c';
    const oneDay = lastDate - firstDate < 24 * 60 * 60 * 1000;
    priceChart = new globalThis.Chart(canvas.getContext('2d'), {
    type: 'line',
    data: {
      labels: compact.map(point => formatHistoryTime(point.date, !oneDay)),
      datasets: [{
        label: '价格',
        data: compact.map(point => point.price),
        borderColor: primary,
        backgroundColor: `${primary}18`,
        fill: true,
        stepped: 'after',
        borderWidth: 2,
        pointRadius: compact.length > 24 ? 0 : 3,
        pointHoverRadius: 4,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { intersect: false, mode: 'index' },
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: context => ` ¥${Number(context.raw).toFixed(2)}` } },
      },
      scales: {
        y: {
          beginAtZero: false,
          grid: { color: grid },
          ticks: { color: text, callback: value => `¥${Number(value).toFixed(2)}` },
        },
        x: {
          grid: { display: false },
          ticks: { color: text, maxRotation: 0, autoSkip: true, maxTicksLimit: 7, font: { size: 10 } },
        },
      },
    },
    });
  } catch (error) {
    if (requestId !== historyRequestId) return;
    console.error('加载价格走势失败:', error);
    setHistoryState(error.message || '价格走势加载失败', true);
  } finally {
    if (requestId === historyRequestId) modal.removeAttribute('aria-busy');
  }
}
