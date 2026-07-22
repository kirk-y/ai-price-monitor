let filterConfig = {};
let refreshConfig = {};
let storeSummaries = [];
let stores = [];
let activeStoreId = 'all';
let activeCategory = 'plus_已接码';
let activeCatL1 = 'gpt';
let activeCatL2 = 'plus_已接码';
let renderLimit = 30;
let expandedNoStock = {};
let includeWords = [];
let excludeWords = [];
let lastActiveSearch = 'include';
let priceChart = null;
let navProducts = [];
let navIndex = -1;
let productLabels = {};
let cachedProducts = [];
let productsDirty = true;
let storeOrder = [];
let priceRange = { min: 0, max: 0 };
let _priceTimer = null;
let queueStatus = null;
let queueStatusTimer = null;
const STORE_POLL_INTERVAL_MS = 1500;
const STORE_POLL_ATTEMPTS = 90;

function initTheme() {
  const saved = localStorage.getItem('theme');
  if (saved === 'dark' || (!saved && window.matchMedia('(prefers-color-scheme: dark)').matches)) {
    document.body.classList.add('dark');
    document.getElementById('themeToggle').textContent = '☀️';
  }
}

function toggleTheme() {
  const isDark = document.body.classList.toggle('dark');
  localStorage.setItem('theme', isDark ? 'dark' : 'light');
  document.getElementById('themeToggle').textContent = isDark ? '☀️' : '🌙';
}

document.addEventListener('DOMContentLoaded', async () => {
  initTheme();
  filterConfig = await (await fetch('/api/filter-config')).json();
  suggestedKeywords = filterConfig.suggestedKeywords || ['GPT', 'Plus', 'Pro', 'Team', '接码', '直充', '成品', '账号', 'Claude', 'Gemini', 'OpenAI', 'SMS', '谷歌', '微软', '邮箱', 'API', '订阅', '会员', 'Access'];
  keywordUsage = filterConfig.keywordUsage || {};
  refreshConfig = await (await fetch('/api/refresh-config')).json();
  queueStatus = await fetchRefreshQueueStatus();
  await loadStoreSummaries();
  stores = await (await fetch('/api/stores')).json();
  storeOrder = await (await fetch('/api/store-order')).json();
  applyStoreOrder();
  const labels = await (await fetch('/api/product-labels')).json();
  for (const l of labels) { productLabels[l.product_key] = l; }
  markDirty();
  render();
  startQueueStatusPolling();
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
      `<span class="sk-item" onclick="${jsCall('addSuggestKey', k)}">${escapeHtml(k)}</span>`
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
    await fetch('/api/filter-config', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(filterConfig) });
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
  document.getElementById('settingsExportBtn').addEventListener('click', () => window.open('/api/stores/export', '_blank'));
  document.getElementById('settingsImportBtn').addEventListener('click', () => document.getElementById('settingsImportFile').click());
  document.getElementById('settingsImportFile').addEventListener('change', importData);
  document.getElementById('saveRefreshBtn').addEventListener('click', saveRefreshConfig);
  document.getElementById('saveKeywordsBtn').addEventListener('click', saveKeywords);
  document.getElementById('storeExportBtn').addEventListener('click', exportSingleStore);
  document.getElementById('storeListExportBtn').addEventListener('click', () => window.open('/api/stores/export-list', '_blank'));
  document.getElementById('storeListImportBtn').addEventListener('click', () => document.getElementById('storeListImportFile').click());
  document.getElementById('storeListImportFile').addEventListener('change', importStoreList);
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
  const order = getCategoryOrder();
  const container = document.getElementById('catVisibility');
  container.innerHTML = order.filter(k => CAT_LABELS[k]).map((k, i) =>
    `<div class="cat-vis-row" draggable="true" data-cat="${escapeAttr(k)}"
      ondragstart="${jsCall('catDragStart', { raw: 'event' }, k)}" ondragover="${jsCall('catDragOver', { raw: 'event' })}" ondrop="${jsCall('catDrop', { raw: 'event' }, k)}" ondragend="catDragEnd()">
      <span class="cat-drag-handle">⠿</span>
      <label style="flex:1;font-size:12px;display:flex;align-items:center;gap:4px;cursor:pointer">
        <input type="checkbox" ${hidden.includes(k) ? '' : 'checked'} onchange="${jsCall('toggleCatVisibility', k, { raw: 'this.checked' })}">
        ${escapeHtml(CAT_LABELS[k])}
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
  const order = getCategoryOrder();
  const from = order.indexOf(_catDragKey);
  const to = order.indexOf(targetKey);
  if (from === -1 || to === -1) return;
  order.splice(from, 1);
  order.splice(to, 0, _catDragKey);
  filterConfig.categoryOrder = order;
  renderCatVisibility();
  fetch('/api/filter-config', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(filterConfig) });
  markDirty();
  render();
}

function toggleCatVisibility(k, show) {
  if (!filterConfig.hiddenCategories) filterConfig.hiddenCategories = [];
  if (show) filterConfig.hiddenCategories = filterConfig.hiddenCategories.filter(c => c !== k);
  else if (!filterConfig.hiddenCategories.includes(k)) filterConfig.hiddenCategories.push(k);
  fetch('/api/filter-config', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(filterConfig) });
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
    const res = await fetch('/api/refresh-config', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(config) });
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
      `<option value="${escapeAttr(s.id)}">${escapeHtml(s.name || s.id)}</option>`
    ).join('');
}

function exportSingleStore() {
  const sel = document.getElementById('storeExportSelect');
  const id = sel.value;
  const msg = document.getElementById('storeExportMsg');
  if (!id) { msg.textContent = '请先选择店铺'; msg.style.color = '#e53935'; return; }
  window.open(`/api/stores/${encodeURIComponent(id)}/export`, '_blank');
  msg.textContent = '✓ 已开始下载';
  msg.style.color = '#43a047';
}

function storeIdFromUrl(url) {
  const m = String(url || '').match(/\/shop\/([^/?#]+)/);
  return m ? decodeURIComponent(m[1]) : String(url || '').replace(/\/+$/, '').split('/').pop() || '';
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
    const res = await fetch('/api/stores/import-list', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(list),
    });
    const result = await res.json();
    if (!res.ok) throw new Error(result.error || '导入失败');

    msg.textContent = `✓ 导入完成: 新增 ${result.added || 0} 个并排队刷新，跳过 ${result.skipped || 0} 个${result.failed ? `，失败 ${result.failed} 个` : ''}`;
    msg.style.color = result.failed ? '#e53935' : '#43a047';
    e.target.value = '';
    storeSummaries = await (await fetch('/api/stores/summary')).json();
    stores = await (await fetch('/api/stores')).json();
    queueStatus = await fetchRefreshQueueStatus();
    applyStoreOrder();
    markDirty();
    render();
    watchPendingStores((result.stores || []).map(s => s.id));
  } catch (err) {
    msg.textContent = '导入失败: ' + err.message;
    msg.style.color = '#e53935';
  }
}

let pendingWatchIds = new Set();
let pendingWatchTimer = null;

function watchPendingStores(ids) {
  for (const id of ids || []) {
    if (id) pendingWatchIds.add(id);
  }
  if (!pendingWatchIds.size || pendingWatchTimer) return;
  pendingWatchTimer = setTimeout(pollPendingStores, 3000);
}

async function pollPendingStores() {
  pendingWatchTimer = null;
  if (!pendingWatchIds.size) return;
  try {
    const summary = await (await fetch('/api/stores/summary')).json();
    queueStatus = await fetchRefreshQueueStatus();
    storeSummaries = summary;
    applyStoreOrder();
    const watched = [...pendingWatchIds];
    const finished = watched.filter(id => {
      const s = summary.find(x => x.id === id);
      return s && s.status !== 'pending';
    });
    for (const id of finished) pendingWatchIds.delete(id);
    if (finished.some(id => summary.find(s => s.id === id)?.status === 'ok')) {
      stores = await (await fetch('/api/stores')).json();
      const newLabels = await (await fetch('/api/product-labels')).json();
      for (const l of newLabels) { productLabels[l.product_key] = l; }
      markDirty();
    }
    render();
  } catch (_) {}
  if (pendingWatchIds.size) pendingWatchTimer = setTimeout(pollPendingStores, 3000);
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
    const res = await fetch('/api/stores/import-single', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
    if (res.ok) {
      const result = await res.json();
      msg.textContent = '✓ 导入成功，即将刷新';
      msg.style.color = '#43a047';
      storeSummaries = await (await fetch('/api/stores/summary')).json();
      stores = await (await fetch('/api/stores')).json();
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
    const res = await fetch('/api/filter-config', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(filterConfig) });
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
    if (Array.isArray(data)) throw new Error('这是店铺列表文件，请在“店铺导出”中使用“导入店铺列表”');
    const res = await fetch('/api/stores/import', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
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

function removeWord(word, type) {
  if (type === 'include') includeWords = includeWords.filter(w => w !== word);
  else excludeWords = excludeWords.filter(w => w !== word);
  renderChips();
  render();
}

function renderChips() {
  const inc = document.getElementById('includeChips');
  inc.innerHTML = includeWords.map(w =>
    `<span class="chip chip-inc">${escapeHtml(w)}<span class="chip-del" onclick="${jsCall('removeWord', w, 'include')}">&times;</span></span>`
  ).join('');

  const exc = document.getElementById('excludeChips');
  exc.innerHTML = excludeWords.map(w =>
    `<span class="chip chip-exc">${escapeHtml(w)}<span class="chip-del" onclick="${jsCall('removeWord', w, 'exclude')}">&times;</span></span>`
  ).join('');
}

function closeModal() {
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
  storeSummaries = await (await fetch('/api/stores/summary')).json();
  renderStoreList();
  renderBestPrices();
  renderPriceRange();
  renderDashboardStrip();
  if (!stores.length) {
    document.getElementById('storesContainer').innerHTML = '<div class="empty-state">请添加店铺开始监控</div>';
  }
}

async function fetchRefreshQueueStatus() {
  try {
    const res = await fetch('/api/refresh-queue');
    if (!res.ok) return queueStatus;
    return await res.json();
  } catch (_) {
    return queueStatus;
  }
}

function startQueueStatusPolling() {
  clearInterval(queueStatusTimer);
  queueStatusTimer = setInterval(async () => {
    queueStatus = await fetchRefreshQueueStatus();
    renderDashboardStrip();
    renderStoreList();
  }, 3000);
}

function queueReasonLabel(reason) {
  const map = {
    'import-list': '批量导入',
    'add-store': '新增店铺',
    'manual-refresh': '手动刷新',
    'auto-refresh': '自动刷新',
  };
  return map[reason] || '刷新任务';
}

function formatCountdown(ts) {
  if (!ts) return '未安排';
  const diff = ts - Date.now();
  if (diff <= 0) return '即将刷新';
  const min = Math.floor(diff / 60000);
  const sec = Math.floor((diff % 60000) / 1000);
  if (min >= 60) return `${Math.floor(min / 60)}小时${min % 60}分`;
  return `${min}分${sec}秒`;
}

function renderDashboardStrip() {
  const el = document.getElementById('dashboardStrip');
  if (!el) return;
  const totalStores = storeSummaries.length;
  const totalProducts = storeSummaries.reduce((n, s) => n + (s.productCount || 0), 0);
  const failed = storeSummaries.filter(s => s.status === 'error').length;
  const pending = storeSummaries.filter(s => s.status === 'pending').length;
  const active = queueStatus?.active;
  const queuedCount = queueStatus?.queuedCount || 0;
  const queueText = active
    ? `${queueReasonLabel(active.reason)}：${active.name}`
    : queuedCount
      ? `排队 ${queuedCount} 个任务`
      : '队列空闲';
  const queueClass = active || queuedCount || pending ? 'is-active' : '';
  document.querySelector('.brand-status').textContent = active ? '刷新中' : '本地运行';
  el.innerHTML = `
    <div class="metric-card">
      <span class="metric-label">店铺</span>
      <strong>${totalStores}</strong>
    </div>
    <div class="metric-card">
      <span class="metric-label">商品</span>
      <strong>${totalProducts}</strong>
    </div>
    <div class="metric-card ${failed ? 'metric-danger' : ''}">
      <span class="metric-label">失败</span>
      <strong>${failed}</strong>
    </div>
    <div class="metric-card ${pending ? 'metric-warn' : ''}">
      <span class="metric-label">Pending</span>
      <strong>${pending}</strong>
    </div>
    <div class="queue-card ${queueClass}">
      <div class="queue-main">
        <span class="queue-dot"></span>
        <span>${escapeHtml(queueText)}</span>
      </div>
      <span class="queue-sub">下次 ${escapeHtml(formatCountdown(refreshConfig.nextRefreshAt))}</span>
    </div>
  `;
}

async function loadStoreWithProducts(storeId) {
  if (storeId === 'all') {
    stores = await (await fetch('/api/stores')).json();
    markDirty();
    return;
  }
  const full = await (await fetch(`/api/stores/${encodeURIComponent(storeId)}`)).json();
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
  return '其他';
}

function normalizeCategory(category) {
  return category === 'other' ? '其他' : category;
}

function matchesSearch(name) {
  const lower = name.toLowerCase();
  if (includeWords.length && !includeWords.every(w => lower.includes(w.toLowerCase()))) return false;
  if (excludeWords.length && excludeWords.some(w => lower.includes(w.toLowerCase()))) return false;
  return true;
}

function priceMatches(price) {
  const p = Number(price) || 0;
  if (priceRange.min && p < priceRange.min) return false;
  if (priceRange.max && p > priceRange.max) return false;
  return true;
}

function getAllProducts() {
  if (!productsDirty) return cachedProducts;
  const all = [];
  for (const s of stores) {
    for (const p of (s.products || [])) {
      const pk = `${s.id}:${p.id}`;
      const label = productLabels[pk];
      const cat = normalizeCategory(label ? label.category : categorize(p.name));
      const conf = label ? Number(label.confidence) || 0 : 0;
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
  const orderIndex = new Map(storeOrder.map((id, index) => [id, index]));
  const sortByOrder = (a, b) => {
    const ai = orderIndex.has(a.id) ? orderIndex.get(a.id) : -1;
    const bi = orderIndex.has(b.id) ? orderIndex.get(b.id) : -1;
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
    all = all.filter(p => catL1FromFull(p.category) === activeCatL1);
  }
  if (includeWords.length || excludeWords.length) all = all.filter(p => matchesSearch(p.name));
  if (priceRange.min || priceRange.max) all = all.filter(p => priceMatches(p.price));
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
  codex: 'Codex',
  其他: '其他',
};

function visibleCatEntries() {
  const hidden = filterConfig.hiddenCategories || [];
  const order = getCategoryOrder();
  return order.filter(k => !hidden.includes(k) && CAT_LABELS[k]).map(k => [k, CAT_LABELS[k]]);
}

function getCategoryOrder() {
  const configured = filterConfig.categoryOrder || [];
  return configured.length
    ? [...configured, ...Object.keys(CAT_LABELS).filter(k => !configured.includes(k))]
    : Object.keys(CAT_LABELS);
}

const CAT_L1_LABELS = {
  gpt: 'GPT', claude: 'Claude', gemini: 'Gemini', grok: 'Grok',
  ai_platform: 'AI平台', 邮箱: '邮箱', 号码: '号码', 社交账号: '社交',
  视频会员: '视频', 音乐会员: '音乐', 生活券: '生活券', 网盘: '网盘',
  阅读会员: '阅读', QQ会员: 'QQ', 云服务: '云服务', 中转额度: '中转',
  教程服务: '教程', IP代理: 'IP/代理', 卡密兑换: '卡密', 虚拟卡: '虚拟卡',
  开发工具: '开发', 电商工具: '电商', 企业服务: '企业', 反重力: '反重力',
  Adobe: 'Adobe', 修图剪辑: '修图', AI平台: 'AI平台', sms: '接码', 其他: '其他',
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
    l1Counts[l1] = (l1Counts[l1] || 0) + 1;
  }

  const bar = document.getElementById('catBar');

  const l1Buttons = CAT_L1.map(l1 =>
    l1Counts[l1] ? `<button class="cat-btn ${activeCatL1 === l1 && !activeCatL2 ? 'active' : ''}" onclick="${jsCall('setCatL1', l1)}">${escapeHtml(CAT_L1_LABELS[l1] || l1)} <span class="cat-cnt">${l1Counts[l1]}</span></button>` : ''
  ).filter(Boolean).join('');

  let l2Buttons = '';
  if (activeCatL1) {
    const subs = new Set();
    for (const p of all) {
      if (catL1FromFull(p.category) === activeCatL1) subs.add(p.category);
    }
    const sorted = [...subs].sort((a, b) => (counts[b]||0) - (counts[a]||0));
    l2Buttons = sorted.map(full => {
      const l2 = catL2FromFull(full);
      return `<button class="cat-btn cat-btn-l2 ${activeCatL2 === full ? 'active' : ''}" onclick="${jsCall('setCatL2', full)}">${escapeHtml(catL2Label(activeCatL1, l2))} <span class="cat-cnt">${counts[full]||0}</span></button>`;
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
  const cards = document.querySelectorAll('.store-card');
  let anchor = null;
  for (const c of cards) {
    const r = c.getBoundingClientRect();
    if (r.top < window.innerHeight && r.bottom > 0) {
      anchor = { id: c.dataset.storeId, offset: r.top };
      break;
    }
  }
  renderStoreList();
  renderDashboardStrip();
  renderBestPrices();
  renderPriceRange();
  renderCatBar();
  renderStores();
  if (anchor) {
    requestAnimationFrame(() => {
      const el = [...document.querySelectorAll('.store-card')].find(card => card.dataset.storeId === anchor.id);
      if (el) window.scrollBy(0, el.getBoundingClientRect().top - anchor.offset);
    });
  }
}

let dragId = null;

function renderStoreList() {
  const container = document.getElementById('storeList');
  const ok = storeSummaries.filter(s => s.status === 'ok');
  const error = storeSummaries.filter(s => s.status === 'error');
  const pend = storeSummaries.filter(s => s.status === 'pending');
  const total = storeSummaries.reduce((s, st) => s + (st.productCount || 0), 0);

  container.innerHTML = `<button class="store-btn ${activeStoreId === 'all' ? 'active' : ''}" onclick="${jsCall('switchStore', 'all')}"><span class="sb-name">全部</span> <span class="badge">${total}</span></button>
  ${ok.map(s => {
    const isRefreshing = refreshingStores.has(s.id);
    return `<div class="store-row${isRefreshing ? ' is-refreshing' : ''}" draggable="true" data-id="${escapeAttr(s.id)}"
      ondragstart="${jsCall('dragStart', { raw: 'event' }, s.id)}" ondragover="${jsCall('dragOver', { raw: 'event' })}" ondrop="${jsCall('dropStore', { raw: 'event' }, s.id)}" ondragend="dragEnd()">
      <button class="store-btn ${activeStoreId === s.id ? 'active' : ''}" onclick="${jsCall('switchStore', s.id)}" title="${escapeAttr(formatTime(s.lastUpdated))}"><span class="drag-handle">⠿</span><span class="sb-name">${escapeHtml((s.name||s.id))}</span> <span class="badge">${s.productCount||0}</span></button>
      ${isRefreshing ? '<div class="refresh-bar"><div class="refresh-bar-inner"></div></div>' : ''}
    </div>`;
  }).join('')}
  ${error.map(s => {
    const isRefreshing = refreshingStores.has(s.id);
    return `<div class="store-row store-row-error${isRefreshing ? ' is-refreshing' : ''}" data-id="${escapeAttr(s.id)}">
      <button class="store-btn ${activeStoreId === s.id ? 'active' : ''}" onclick="${jsCall('switchStore', s.id)}" title="${escapeAttr(s.error||'刷新失败')}"><span class="drag-handle" style="color:var(--danger)">⚠</span><span class="sb-name" style="color:var(--danger)">${escapeHtml((s.name||s.id))}</span> <span class="badge">${s.productCount||0}</span><span class="badge-error">失败</span></button>
      ${isRefreshing ? '<div class="refresh-bar"><div class="refresh-bar-inner"></div></div>' : ''}
    </div>`;
  }).join('')}
  ${pend.map(s => {
    const isRefreshing = refreshingStores.has(s.id);
    return `<div class="store-row store-row-pending${isRefreshing ? ' is-refreshing' : ''}" data-id="${escapeAttr(s.id)}">
      <button class="store-btn ${activeStoreId === s.id ? 'active' : ''}" onclick="${jsCall('switchStore', s.id)}" title="获取中..."><span class="drag-handle" style="color:var(--text3);opacity:.5">⠿</span><span class="sb-name" style="opacity:.7">${escapeHtml((s.name||s.id))}</span> <span class="badge">${s.productCount||0}</span><span class="badge-pending">获取中</span></button>
      ${isRefreshing ? '<div class="refresh-bar"><div class="refresh-bar-inner"></div></div>' : ''}
    </div>`;
  }).join('')}`;
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

function reorderByIds(items, ids) {
  const byId = new Map(items.map(item => [item.id, item]));
  const seen = new Set();
  const ordered = [];
  for (const id of ids) {
    const item = byId.get(id);
    if (item) {
      ordered.push(item);
      seen.add(id);
    }
  }
  return ordered.concat(items.filter(item => !seen.has(item.id)));
}

function moveIdBefore(ids, id, targetId) {
  const next = ids.filter(x => x !== id);
  const to = next.indexOf(targetId);
  if (to === -1) return ids;
  next.splice(to, 0, id);
  return next;
}

function dropStore(e, targetId) {
  e.preventDefault();
  if (!dragId || dragId === targetId) return;
  const ids = storeSummaries.map(s => s.id);
  if (!ids.includes(dragId) || !ids.includes(targetId)) return;
  storeOrder = moveIdBefore(ids, dragId, targetId);
  storeSummaries = reorderByIds(storeSummaries, storeOrder);
  stores = reorderByIds(stores, storeOrder);
  fetch('/api/store-order', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(storeOrder) });
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
    if ((storeId === 'all' && b.textContent.includes('全部')) || b.getAttribute('onclick')?.includes(storeId)) b.classList.add('active');
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
  if (priceRange.min || priceRange.max) pool = pool.filter(p => priceMatches(p.price));
  document.getElementById('bestPriceList').innerHTML = visibleCatEntries().map(([k, label]) => {
    const items = pool.filter(p => p.category === k && p.price > 0 && p.stock > 0).sort((a, b) => a.price - b.price);
    if (!items.length) {
      return `<div class="bp-item bp-empty">
        <div class="bp-head"><span class="bp-cat">${escapeHtml(label)}</span><span class="bp-state">暂无</span></div>
        <div class="bp-na">无可用库存</div>
      </div>`;
    }
    const item = items[0];
    const stockText = Number(item.stock) > 0 ? `有货 ${item.stock}` : '库存未知';
    return `<div class="bp-item">
      <div class="bp-head"><span class="bp-cat">${escapeHtml(label)}</span><span class="bp-state is-ok">${escapeHtml(stockText)}</span></div>
      <div class="bp-price">¥${item.price.toFixed(2)}</div>
      <div class="bp-store">${escapeHtml(item.storeName)}</div>
    </div>`;
  }).join('');
}

function renderStores() {
  const container = document.getElementById('storesContainer');
  const filtered = getFilteredProducts();
  const idsWithProducts = new Set(filtered.map(p => p.storeId));
  const ids = activeStoreId === 'all'
    ? storeSummaries
      .filter(s => s.status === 'ok' || s.status === 'pending' || idsWithProducts.has(s.id))
      .map(s => s.id)
    : [activeStoreId];
  if (storeOrder.length && activeStoreId === 'all') {
    const orderIndex = new Map(storeOrder.map((id, index) => [id, index]));
    ids.sort((a, b) => {
      const ai = orderIndex.has(a) ? orderIndex.get(a) : -1;
      const bi = orderIndex.has(b) ? orderIndex.get(b) : -1;
      if (ai === -1 && bi === -1) return 0;
      if (ai === -1) return 1;
      if (bi === -1) return -1;
      return ai - bi;
    });
  }

  if (!stores.length && !storeSummaries.length) { container.innerHTML = '<div class="empty-state">请添加店铺开始监控</div>'; return; }
  if (!stores.length && storeSummaries.length) { container.innerHTML = '<div class="empty-state">请选择店铺查看商品</div>'; return; }
  if (!ids.length) { container.innerHTML = '<div class="empty-state">无匹配商品</div>'; return; }

  let cardCount = 0;
  let reachedLimit = false;
  const html = ids.map(id => {
    if (reachedLimit) return '';
    const s = stores.find(st => st.id === id);
    if (!s) return '';
    const summary = storeSummaries.find(st => st.id === id);
    const status = summary?.status || s.status;
    const error = summary?.error || s.error;
    const isRefreshing = refreshingStores.has(id) || status === 'pending';
    let products = filtered.filter(p => p.storeId === id);
    const hasCachedProducts = (s.products || []).length > 0;
    if (status === 'pending' && !hasCachedProducts) {
      return `<div class="store-card" data-store-id="${escapeAttr(s.id)}"><div class="sc-name">${escapeHtml(s.name||s.id)}</div><div class="store-loading">正在获取商品数据...</div></div>`;
    }
    if (status === 'error' && !hasCachedProducts) {
      return `<div class="store-card" data-store-id="${escapeAttr(s.id)}"><div class="sc-name">${escapeHtml(s.name||s.id)}</div><div class="store-error">${escapeHtml(error||'获取失败')}</div><button class="del-btn" onclick="${jsCall('deleteStore', s.id)}">删除</button></div>`;
    }
    const statusNotice = status === 'error'
      ? `<div class="store-cache-warning">刷新失败，正在显示缓存商品：${escapeHtml(error || '未知错误')}</div>`
      : isRefreshing
        ? '<div class="store-cache-warning store-cache-pending">正在刷新，当前显示上次缓存商品</div>'
        : '';
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
        if (hidden > 0) gridItems.push(`<div class="ns-toggle" onclick="${jsCall('toggleNoStock', id)}">展开 ${noStock.length} 个无货商品...</div>`);
        if (expanded && noStock.length > 0) gridItems.push(`<div class="ns-toggle" onclick="${jsCall('toggleNoStock', id)}">收起无货商品</div>`);
      }
    }
    if (reachedLimit && !gridItems.length) return '';
    return `<div class="store-card ${isRefreshing ? 'is-card-refreshing' : ''}" data-store-id="${escapeAttr(s.id)}">
      <div class="sc-header">
        <span class="sc-name">${escapeHtml(s.name||s.id)}</span>
        <span class="sc-time">${formatTime(s.lastUpdated)}</span>
        <span class="sc-meta">${products.length} 个商品</span>
        <div class="sc-actions">
          <button class="ref-btn ${isRefreshing ? 'loading' : ''}" ${isRefreshing ? 'disabled' : ''} onclick="${jsCall('refreshStore', s.id)}">${isRefreshing ? '刷新中' : '更新'}</button>
          <button class="del-btn" onclick="${jsCall('deleteStore', s.id)}">删除</button>
        </div>
      </div>
      ${statusNotice}
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

function safeTagClass(category) {
  return String(category || 'other').replace(/[^\w\u4e00-\u9fff-]/g, '_');
}

function safeHref(url) {
  try {
    const parsed = new URL(String(url || ''), window.location.origin);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') return parsed.href;
  } catch (_) {}
  return '';
}

function isOtherCategory(category) {
  return category === 'other' || category === '其他';
}

function renderProductCard(p) {
  const stock = Number(p.stock);
  const inStock = stock > 0;
  const stockText = !Number.isFinite(stock) || stock < 0 ? '未知' : inStock ? `有货 ${stock}` : `无货`;
  const confidence = Number(p.confidence) || 0;
  const confPct = confidence > 0 ? Math.round(confidence * 100) : 0;
  const category = normalizeCategory(p.category);
  const price = Number(p.price) || 0;
  const href = safeHref(p.purchaseUrl);
  const tagHtml = isOtherCategory(category)
    ? `<span class="tag tag-other" onclick="${jsCall('editLabel', p.productKey, p.name, '其他', 0)}" title="点击添加分类">其他</span>`
    : `<span class="tag tag-${escapeAttr(safeTagClass(category))}" onclick="${jsCall('editLabel', p.productKey, p.name, category, confidence)}" title="${escapeAttr(`点击修改分类 (置信度: ${confPct}%)`)}">${escapeHtml(category)}${confPct > 0 ? `<small> ${confPct}%</small>` : ''}</span>`;

  return `<div class="product-card ${inStock ? 'has-stock' : 'no-stock'}" data-price="${price}">
    <div class="pc-head">
      ${tagHtml}
      <span class="pc-stock ${inStock ? 'is-stocked' : 'is-empty'}">${stockText}</span>
    </div>
    <div class="pc-name" title="${escapeAttr(p.name)}">${escapeHtml(p.name)}</div>
    <div class="pc-foot">
      <span class="pc-price">¥${price.toFixed(2)}</span>
      <div class="pc-actions">
        ${href ? `<a href="${escapeAttr(href)}" target="_blank" rel="noopener noreferrer" class="buy-btn">购买</a>` : ''}
        <button class="hist-btn" onclick="${jsCall('showHistory', p.storeId, p.id, p.name)}">走势</button>
      </div>
    </div>
  </div>`;
}

function editLabel(productKey, name, currentCat, confidence) {
  const current = normalizeCategory(currentCat);
  const l1 = catL1FromFull(current);
  const l2 = catL2FromFull(current);
  const l1Opts = CAT_L1.map(c => `<option value="${escapeAttr(c)}" ${c === l1 ? 'selected' : ''}>${escapeHtml(CAT_L1_LABELS[c] || c)}</option>`).join('');
  const l2List = CAT_L2_MAP[l1] || ['其他'];
  const l2Opts = l2List.map(c => {
    const full = fullCategoryFromParts(l1, c);
    return `<option value="${escapeAttr(full)}" ${full === current || c === l2 ? 'selected' : ''}>${escapeHtml(catL2Label(l1, c))}</option>`;
  }).join('');
  const div = document.createElement('div');
  div.id = 'labelOverlay';
  div.className = 'label-overlay';
  div.onclick = function(e) { if (e.target === this) this.remove(); };
  div.innerHTML = `<div class="label-editor-card">
    <div class="label-editor-title">修改商品分类</div>
    <div class="label-editor-name">${escapeHtml(name)}</div>
    <div class="label-editor-select-row">
      <select id="labelSelectL1" class="label-editor-select" onchange="onEditL1Change()">${l1Opts}</select>
      <select id="labelSelect" class="label-editor-select">${l2Opts}</select>
    </div>
    <div class="label-editor-actions">
      <button class="label-editor-secondary" onclick="document.getElementById('labelOverlay').remove()">取消</button>
      <button class="label-editor-primary" onclick="${jsCall('saveLabel', productKey, name)}">保存</button>
    </div>
  </div>`;
  document.body.appendChild(div);
}

function onEditL1Change() {
  const l1 = document.getElementById('labelSelectL1').value;
  const l2sel = document.getElementById('labelSelect');
  const subs = CAT_L2_MAP[l1] || ['其他'];
  l2sel.innerHTML = subs.map(c => `<option value="${escapeAttr(fullCategoryFromParts(l1, c))}">${escapeHtml(catL2Label(l1, c))}</option>`).join('');
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
  return '其他';
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

function fullCategoryFromParts(l1, l2) {
  if (!l1 || !l2 || l1 === '其他' || l2 === '其他') return '其他';
  if (l1 === 'gpt') {
    if (l2.startsWith('plus_')) return l2;
    if (l2 === 'pro') return 'gpt_pro';
    if (l2 === 'team') return 'gpt_team';
    if (l2 === 'k12') return 'gptk12';
    return `gpt_${l2}`;
  }
  if (l1 === 'sms' && l2 === '接码') return 'sms';
  return `${l1}_${l2}`;
}

function renderCatSelect(pk, name, currentCat) {
  const l1 = catL1FromFull(currentCat);
  const l2 = catL2FromFull(currentCat);
  const current = normalizeCategory(currentCat);
  const l1Opts = CAT_L1.map(c => `<option value="${escapeAttr(c)}" ${c === l1 ? 'selected' : ''}>${escapeHtml(CAT_L1_LABELS[c] || c)}</option>`).join('');
  const l2Opts = (CAT_L2_MAP[l1] || ['其他']).map(c => {
    const full = fullCategoryFromParts(l1, c);
    return `<option value="${escapeAttr(full)}" ${full === current || c === l2 ? 'selected' : ''}>${escapeHtml(catL2Label(l1, c))}</option>`;
  }).join('');
  return `<select class="cl2-l1" onchange="${jsCall('onCatL1Change', { raw: 'this' }, pk, name)}" style="padding:2px 4px;border:1px solid var(--border);border-radius:4px;font-size:11px;background:var(--card-bg);color:var(--text)">${l1Opts}</select>
    <select class="cl2-l2" onchange="${jsCall('saveLabelFromSettings', pk, name, { raw: 'this.value' })}" style="padding:2px 4px;border:1px solid var(--border);border-radius:4px;font-size:11px;background:var(--card-bg);color:var(--text)">${l2Opts}</select>`;
}

function onCatL1Change(l1sel, pk, name) {
  const l2sel = l1sel.nextElementSibling;
  const l1 = l1sel.value;
  const subs = CAT_L2_MAP[l1] || ['其他'];
  const currentFull = l2sel.value;
  const currentL2 = catL2FromFull(currentFull);
  l2sel.innerHTML = subs.map(c => {
    const full = fullCategoryFromParts(l1, c);
    return `<option value="${escapeAttr(full)}" ${c === currentL2 ? 'selected' : ''}>${escapeHtml(catL2Label(l1, c))}</option>`;
  }).join('');
  saveLabelFromSettings(pk, name, l2sel.value);
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
  let filtered = labels.filter(l => !isOtherCategory(l.category));
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
      const confidence = Number(l.confidence) || 0;
      return `<div style="display:flex;align-items:center;gap:4px;padding:4px 6px;border-bottom:1px solid var(--border);font-size:12px">
        <span style="flex:1;word-break:break-all;color:var(--text2);font-size:11px">${escapeHtml(l.name)}</span>
        <span style="display:flex;gap:2px;flex-shrink:0">${renderCatSelect(l.product_key, l.name, l.category)}</span>
        ${confidence < 1 ? `<span style="font-size:10px;color:var(--text3);white-space:nowrap">${Math.round(confidence*100)}%</span>` : '<span style="font-size:10px;color:var(--success);flex-shrink:0">手动</span>'}
      </div>`;
    }).join('') + (more > 0 ? `<div style="padding:6px;text-align:center;font-size:11px;color:var(--text3)">还有 ${more} 条，请精确搜索</div>` : '');

  loadLabelChanges();
}

async function loadLabelChanges() {
  const el = document.getElementById('labelChangeLog');
  try {
    const changes = await (await fetch('/api/label-changes')).json();
    el.innerHTML = changes.slice(0, 30).map(c =>
      `<div style="padding:3px 0;border-bottom:1px solid var(--border)">${escapeHtml(c.name)}: <span style="color:var(--danger)">${c.old_category||'?'}</span> → <span style="color:var(--success)">${c.new_category}</span> <span style="color:var(--text3);font-size:10px">${c.changed_at}</span></div>`
    ).join('');
    if (!changes.length) el.innerHTML = '<div style="color:var(--text3);padding:4px">暂无调整记录</div>';
  } catch { el.innerHTML = ''; }
}

async function saveLabelFromSettings(productKey, name, category) {
  const res = await fetch(`/api/product-labels/${encodeURIComponent(productKey)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ category, name }),
  });
  if (res.ok) {
    productLabels[productKey] = { product_key: productKey, name, category, confidence: 1.0, manual: 1 };
    markDirty();
  }
}

async function saveLabel(productKey, name) {
  const select = document.getElementById('labelSelect');
  const category = select.value;
  const res = await fetch(`/api/product-labels/${encodeURIComponent(productKey)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ category, name }),
  });
  if (res.ok) {
    productLabels[productKey] = { product_key: productKey, name, category, confidence: 1.0, manual: 1 };
    markDirty();
    document.getElementById('labelOverlay')?.remove();
    render();
  }
}

function escapeHtml(s) {
  if (s === undefined || s === null) return '';
  const d = document.createElement('div');
  d.textContent = String(s);
  return d.innerHTML;
}

function escapeAttr(s) {
  return escapeHtml(s).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function jsValue(value) {
  if (value && typeof value === 'object' && Object.prototype.hasOwnProperty.call(value, 'raw')) {
    return value.raw;
  }
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '0';
  return JSON.stringify(String(value ?? ''))
    .replace(/</g, '\\u003C')
    .replace(/>/g, '\\u003E')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

function jsCall(name, ...args) {
  return escapeAttr(`${name}(${args.map(jsValue).join(',')})`);
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
    const res = await fetch('/api/stores', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url }) });
    if (!res.ok) {
      const e = await res.json();
      msg.textContent = e.error || '添加失败';
      msg.style.color = '#e53935';
      btn.disabled = false; btn.textContent = '添加';
      return;
    }
    const storeData = await res.json();
    queueStatus = await fetchRefreshQueueStatus();
    renderDashboardStrip();
    msg.textContent = '正在获取商品数据...';
    msg.style.color = '#1a73e8';
    let n = 0;
    while (n < STORE_POLL_ATTEMPTS) {
      await new Promise(r => setTimeout(r, STORE_POLL_INTERVAL_MS));
      const check = await (await fetch('/api/stores/summary')).json();
      const updated = check.find(s => s.id === storeData.id);
      if (updated && updated.status === 'ok') {
        storeSummaries = check;
        await loadStoreWithProducts(storeData.id);
        const newLabels = await (await fetch('/api/product-labels')).json();
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
    storeSummaries = await (await fetch('/api/stores/summary')).json();
    renderStoreList();
    watchPendingStores([storeData.id]);
  } catch (e) {
    msg.textContent = '添加失败: ' + e.message;
    msg.style.color = '#e53935';
    btn.disabled = false; btn.textContent = '重试';
  }
}

async function refreshStore(id, silent) {
  refreshingStores.add(id);
  renderStoreList();
  renderStores();
  try {
    const startRes = await fetch(`/api/stores/${encodeURIComponent(id)}/refresh`, { method: 'POST' });
    if (!startRes.ok) throw new Error('刷新请求失败');
    queueStatus = await fetchRefreshQueueStatus();
    renderDashboardStrip();
    let n = 0;
    while (n < STORE_POLL_ATTEMPTS) {
      await new Promise(r => setTimeout(r, STORE_POLL_INTERVAL_MS));
      const summary = await (await fetch('/api/stores/summary')).json();
      const updated = summary.find(s => s.id === id);
      if (updated) {
        storeSummaries = summary.map(s => s.id === id ? updated : s);
        applyStoreOrder();
        if (updated.status === 'ok') {
          await loadStoreWithProducts(id);
          const newLabels = await (await fetch('/api/product-labels')).json();
          for (const l of newLabels) { productLabels[l.product_key] = l; }
          markDirty();
          queueStatus = await fetchRefreshQueueStatus();
          renderDashboardStrip();
          flashSuccess(id);
          if (!silent) renderStores();
          return;
        }
        if (updated.status === 'error') {
          refreshingStores.delete(id);
          queueStatus = await fetchRefreshQueueStatus();
          renderStoreList();
          renderDashboardStrip();
          renderStores();
          if (!silent) alert('更新失败: ' + (updated.error || '未知错误'));
          return;
        }
      }
      n++;
    }
    refreshingStores.delete(id);
    queueStatus = await fetchRefreshQueueStatus();
    renderStoreList();
    renderDashboardStrip();
    watchPendingStores([id]);
    if (!silent) alert('更新超时，请稍后重试');
  } catch (e) {
    refreshingStores.delete(id);
    queueStatus = await fetchRefreshQueueStatus();
    renderStoreList();
    renderDashboardStrip();
    renderStores();
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
  const order = [...storeSummaries].filter(s => s.status !== 'pending').sort((a, b) => (a.lastUpdated || '').localeCompare(b.lastUpdated || ''));
  for (const s of order) {
    if (_stopRefreshAll) break;
    refreshingStores.add(s.id);
    renderStoreList();
    renderStores();
    try {
      const startRes = await fetch(`/api/stores/${encodeURIComponent(s.id)}/refresh`, { method: 'POST' });
      if (!startRes.ok) throw new Error('刷新请求失败');
      queueStatus = await fetchRefreshQueueStatus();
      renderDashboardStrip();
      let n = 0;
      let done = false;
      while (n < STORE_POLL_ATTEMPTS && !_stopRefreshAll) {
        await new Promise(r => setTimeout(r, STORE_POLL_INTERVAL_MS));
        if (_stopRefreshAll) break;
        const summary = await (await fetch('/api/stores/summary')).json();
        const updated = summary.find(x => x.id === s.id);
        if (updated) {
          storeSummaries = summary.map(x => x.id === s.id ? updated : x);
          applyStoreOrder();
          if (updated.status === 'ok') {
            await loadStoreWithProducts(s.id);
            const newLabels = await (await fetch('/api/product-labels')).json();
            for (const l of newLabels) { productLabels[l.product_key] = l; }
            markDirty();
            queueStatus = await fetchRefreshQueueStatus();
            renderDashboardStrip();
            flashSuccess(s.id);
            done = true;
            break;
          }
          if (updated.status === 'error') {
            refreshingStores.delete(s.id);
            queueStatus = await fetchRefreshQueueStatus();
            renderStoreList();
            renderDashboardStrip();
            done = true;
            break;
          }
        }
        n++;
      }
      if (!done) {
        refreshingStores.delete(s.id);
        queueStatus = await fetchRefreshQueueStatus();
        renderStoreList();
        renderDashboardStrip();
      }
    } catch (_) {
      refreshingStores.delete(s.id);
      queueStatus = await fetchRefreshQueueStatus();
      renderStoreList();
      renderDashboardStrip();
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
  const row = [...document.querySelectorAll('.store-row')].find(el => el.dataset.id === id);
  if (row) { row.classList.add('flash-ok'); setTimeout(() => row.classList.remove('flash-ok'), 1200); }
  refreshingStores.delete(id);
  renderStoreList();
  renderBestPrices();
  renderPriceRange();
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
    <div class="pr-row pr-row-top"><input class="pr-input pr-max-input" type="number" min="0" max="200" value="${max}" onchange="onPriceInputNum(this,'max')"></div>
    <div class="pr-row pr-row-mid">
      <div class="pr-track">
        <input type="range" min="0" max="200" value="${rawMin}" step="1" class="pr-min" id="prMinSlider" oninput="onPriceInput(this)">
        <input type="range" min="0" max="200" value="${rawMax}" step="1" class="pr-max" id="prMaxSlider" oninput="onPriceInput(this)">
        <div class="pr-fill" style="left:${rawMin/2}%;right:${100-rawMax/2}%"></div>
      </div>
    </div>
    <div class="pr-row pr-row-bot"><input class="pr-input pr-min-input" type="number" min="0" max="200" value="${min}" onchange="onPriceInputNum(this,'min')"></div>
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
  renderBestPrices();
  renderStores();
}

function toggleNoStock(id) {
  expandedNoStock[id] = !expandedNoStock[id];
  renderStores();
}

async function deleteStore(id) {
  if (!confirm('确定删除?')) return;
  await fetch(`/api/stores/${encodeURIComponent(id)}`, { method: 'DELETE' });
  storeSummaries = storeSummaries.filter(s => s.id !== id);
  stores = stores.filter(s => s.id !== id);
  markDirty();
  if (activeStoreId === id) activeStoreId = 'all';
  if (activeStoreId === 'all') {
    await loadStoreWithProducts('all');
  }
  render();
}

async function showHistory(storeId, productId, name, isNav) {
  if (!isNav) {
    const all = getFilteredProducts();
    navProducts = all;
    navIndex = all.findIndex(p => p.storeId === storeId && p.id === productId);
  }
  const data = await (await fetch(`/api/products/${encodeURIComponent(storeId)}/${encodeURIComponent(productId)}/history`)).json();
  document.getElementById('modalTitle').textContent = name || '价格历史';
  document.getElementById('modalProductMeta').textContent = navIndex >= 0 ? `${navIndex+1}/${navProducts.length}` : '';
  document.getElementById('prevProductBtn').style.visibility = navIndex > 0 ? 'visible' : 'hidden';
  document.getElementById('nextProductBtn').style.visibility = navIndex < navProducts.length-1 ? 'visible' : 'hidden';
  document.getElementById('historyModal').style.display = 'block';
  if (priceChart) priceChart.destroy();
  if (!data.length) { document.getElementById('priceChart').style.display = 'none'; return; }
  if (typeof Chart === 'undefined') {
    document.getElementById('priceChart').style.display = 'none';
    document.getElementById('modalProductMeta').textContent = '图表库加载失败';
    return;
  }
  document.getElementById('priceChart').style.display = 'block';
  priceChart = new Chart(document.getElementById('priceChart').getContext('2d'), {
    type: 'line',
    data: { labels: data.map(d => new Date(d.date).toLocaleString('zh-CN')), datasets: [{ label: '价格 (¥)', data: data.map(d => d.price), borderColor: '#1a73e8', backgroundColor: 'rgba(26,115,232,0.1)', fill: true, tension: 0.3, pointRadius: 4 }] },
    options: { responsive: true, interaction: { intersect: false, mode: 'index' }, plugins: { legend: { display: false } }, scales: { y: { beginAtZero: false, ticks: { callback: v => '¥'+v.toFixed(2) } }, x: { ticks: { maxRotation: 45, font: { size: 10 } } } } }
  });
}
