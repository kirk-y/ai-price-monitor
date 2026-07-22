let filterConfig = {};
let refreshConfig = {};
let storeSummaries = [];
let stores = [];
let activeStoreId = 'all';
let activeCategory = 'plus_已接码';
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
  await loadStoreSummaries();
  stores = await (await fetch('/api/stores')).json();
  storeOrder = await (await fetch('/api/store-order')).json();
  applyStoreOrder();
  const labels = await (await fetch('/api/product-labels')).json();
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
      `<span class="sk-item" onclick="addSuggestKey('${escapeHtml(k)}')">${escapeHtml(k)}</span>`
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
  const order = filterConfig.categoryOrder || Object.keys(CAT_LABELS);
  const container = document.getElementById('catVisibility');
  container.innerHTML = order.filter(k => CAT_LABELS[k]).map((k, i) =>
    `<div class="cat-vis-row" draggable="true" data-cat="${k}"
      ondragstart="catDragStart(event,'${k}')" ondragover="catDragOver(event)" ondrop="catDrop(event,'${k}')" ondragend="catDragEnd()">
      <span class="cat-drag-handle">⠿</span>
      <label style="flex:1;font-size:12px;display:flex;align-items:center;gap:4px;cursor:pointer">
        <input type="checkbox" ${hidden.includes(k) ? '' : 'checked'} onchange="toggleCatVisibility('${k}',this.checked)">
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
      `<option value="${s.id}">${escapeHtml(s.name || s.id)}</option>`
    ).join('');
}

function exportSingleStore() {
  const sel = document.getElementById('storeExportSelect');
  const id = sel.value;
  const msg = document.getElementById('storeExportMsg');
  if (!id) { msg.textContent = '请先选择店铺'; msg.style.color = '#e53935'; return; }
  window.open(`/api/stores/${id}/export`, '_blank');
  msg.textContent = '✓ 已开始下载';
  msg.style.color = '#43a047';
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
        await fetch('/api/stores', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: item.url }) });
        added++;
      } catch { skipped++; }
    }
    msg.textContent = `✓ 导入完成: 新增 ${added} 个，跳过 ${skipped} 个`;
    msg.style.color = '#43a047';
    e.target.value = '';
    storeSummaries = await (await fetch('/api/stores/summary')).json();
    stores = await (await fetch('/api/stores')).json();
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
    `<span class="chip chip-inc">${escapeHtml(w)}<span class="chip-del" onclick="removeWord('${escapeHtml(w)}','include')">&times;</span></span>`
  ).join('');

  const exc = document.getElementById('excludeChips');
  exc.innerHTML = excludeWords.map(w =>
    `<span class="chip chip-exc">${escapeHtml(w)}<span class="chip-del" onclick="removeWord('${escapeHtml(w)}','exclude')">&times;</span></span>`
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
  if (!stores.length) {
    document.getElementById('storesContainer').innerHTML = '<div class="empty-state">请添加店铺开始监控</div>';
  }
}

async function loadStoreWithProducts(storeId) {
  if (storeId === 'all') {
    stores = await (await fetch('/api/stores')).json();
    markDirty();
    return;
  }
  const full = await (await fetch(`/api/stores/${storeId}`)).json();
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
  if (activeCategory) all = all.filter(p => p.category === activeCategory);
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
  grok: 'Grok', sms: '接码', gptk12: 'K12', 其他: '其他',
};

function visibleCatEntries() {
  const hidden = filterConfig.hiddenCategories || [];
  const order = filterConfig.categoryOrder || Object.keys(CAT_LABELS);
  return order.filter(k => !hidden.includes(k) && CAT_LABELS[k]).map(k => [k, CAT_LABELS[k]]);
}

function renderCatBar() {
  const all = getAllProducts();
  const counts = {};
  for (const p of all) { counts[p.category] = (counts[p.category] || 0) + 1; }

  const bar = document.getElementById('catBar');
  bar.innerHTML = `<button class="cat-btn ${!activeCategory ? 'active' : ''}" onclick="setCategory('')">全部 <span class="cat-cnt">${all.length}</span></button>` +
    visibleCatEntries().map(([k, label]) =>
      counts[k] ? `<button class="cat-btn ${activeCategory === k ? 'active' : ''}" onclick="setCategory('${k}')">${label} <span class="cat-cnt">${counts[k]}</span></button>` : ''
    ).join('');
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
  renderBestPrices();
  renderPriceRange();
  renderCatBar();
  renderStores();
  if (anchor) {
    requestAnimationFrame(() => {
      const el = document.querySelector(`.store-card[data-store-id="${anchor.id}"]`);
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

  container.innerHTML = `<button class="store-btn ${activeStoreId === 'all' ? 'active' : ''}" onclick="switchStore('all')"><span class="sb-name">全部</span> <span class="badge">${total}</span></button>
  ${ok.map(s => {
    const isRefreshing = refreshingStores.has(s.id);
    return `<div class="store-row${isRefreshing ? ' is-refreshing' : ''}" draggable="true" data-id="${s.id}"
      ondragstart="dragStart(event,'${s.id}')" ondragover="dragOver(event)" ondrop="dropStore(event,'${s.id}')" ondragend="dragEnd()">
      <button class="store-btn ${activeStoreId === s.id ? 'active' : ''}" onclick="switchStore('${s.id}')" title="${formatTime(s.lastUpdated)}"><span class="drag-handle">⠿</span><span class="sb-name">${escapeHtml((s.name||s.id))}</span> <span class="badge">${s.productCount||0}</span></button>
      ${isRefreshing ? '<div class="refresh-bar"><div class="refresh-bar-inner"></div></div>' : ''}
    </div>`;
  }).join('')}
  ${error.map(s => {
    return `<div class="store-row store-row-error" data-id="${s.id}">
      <button class="store-btn ${activeStoreId === s.id ? 'active' : ''}" onclick="switchStore('${s.id}')" title="${escapeHtml(s.error||'刷新失败')}"><span class="drag-handle" style="color:var(--danger)">⚠</span><span class="sb-name" style="color:var(--danger)">${escapeHtml((s.name||s.id))}</span> <span class="badge badge-error">失败</span></button>
    </div>`;
  }).join('')}
  ${pend.map(s => {
    return `<div class="store-row store-row-pending" data-id="${s.id}">
      <button class="store-btn ${activeStoreId === s.id ? 'active' : ''}" onclick="switchStore('${s.id}')" title="获取中..."><span class="drag-handle" style="color:var(--text3);opacity:.5">⠿</span><span class="sb-name" style="opacity:.7">${escapeHtml((s.name||s.id))}</span> <span class="badge badge-pending">获取中</span></button>
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
  document.getElementById('bestPriceList').innerHTML = visibleCatEntries().map(([k, label]) => {
    const items = pool.filter(p => p.category === k && p.price > 0 && p.stock > 0).sort((a, b) => a.price - b.price);
    if (!items.length) return `<div class="bp-item"><div class="bp-cat">${label}</div><div class="bp-na">暂无</div></div>`;
    const item = items[0];
    return `<div class="bp-item"><div class="bp-cat">${label}</div><div class="bp-price">¥${item.price.toFixed(2)}</div><div class="bp-store">${escapeHtml(item.storeName)}</div></div>`;
  }).join('');
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
    if (s.status === 'error') return `<div class="store-card"><div class="sc-name">${escapeHtml(s.name||s.id)}</div><div class="store-error">${escapeHtml(s.error||'获取失败')}</div><button class="del-btn" onclick="deleteStore('${s.id}')">删除</button></div>`;

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
        if (hidden > 0) gridItems.push(`<div class="ns-toggle" onclick="toggleNoStock('${id}')">展开 ${noStock.length} 个无货商品...</div>`);
        if (expanded && noStock.length > 0) gridItems.push(`<div class="ns-toggle" onclick="toggleNoStock('${id}')">收起无货商品</div>`);
      }
    }
    if (reachedLimit && !gridItems.length) return '';
    return `<div class="store-card" data-store-id="${s.id}">
      <div class="sc-header">
        <span class="sc-name">${escapeHtml(s.name||s.id)}</span>
        <span class="sc-time">${formatTime(s.lastUpdated)}</span>
        <span class="sc-meta">${products.length} 个商品</span>
        <div class="sc-actions">
          <button class="ref-btn" onclick="refreshStore('${s.id}')">更新</button>
          <button class="del-btn" onclick="deleteStore('${s.id}')">删除</button>
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

function q(s) { return (s||'').replace(/'/g, "\\'").replace(/"/g, '&quot;'); }

function renderProductCard(p) {
  const inStock = p.stock > 0;
  const stockText = p.stock < 0 ? '未知' : inStock ? `有货 ${p.stock}` : `无货`;
  const confPct = p.confidence > 0 ? Math.round(p.confidence * 100) : 0;

  return `<div class="product-card ${inStock ? 'has-stock' : 'no-stock'}" data-price="${p.price}">
    <div class="pc-top">
      ${p.category !== 'other' ? `<span class="tag tag-${p.category}" onclick="editLabel('${q(p.productKey)}','${q(p.name)}','${q(p.category)}',${p.confidence})" title="点击修改分类 (置信度: ${confPct}%)">${p.category}${confPct > 0 ? `<small> ${confPct}%</small>` : ''}</span>` : `<span class="tag tag-other" onclick="editLabel('${q(p.productKey)}','${q(p.name)}','其他',0)" title="点击添加分类">其他</span>`}
      <span class="pc-name" title="${q(p.name)}">${escapeHtml(p.name)}</span>
    </div>
    <div class="pc-mid">
      <span class="pc-price">¥${p.price.toFixed(2)}</span>
      <span class="pc-stock">${stockText}</span>
    </div>
    <div class="pc-bot">
      ${p.purchaseUrl ? `<a href="${q(p.purchaseUrl)}" target="_blank" class="buy-btn">购买</a>` : ''}
      <button class="hist-btn" onclick="showHistory('${q(p.storeId)}','${q(p.id)}','${q(p.name)}')">走势</button>
    </div>
  </div>`;
}

function editLabel(productKey, name, currentCat, confidence) {
  const cats = ['plus_已接码','plus_未接码','plus_质保','gpt_pro','gpt_team','gptk12','gemini','claude','grok','sms','其他'];
  const opt = cats.map(c => `<option value="${c}" ${c === currentCat ? 'selected' : ''}>${c}</option>`).join('');
  const div = document.createElement('div');
  div.id = 'labelOverlay';
  div.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,.4);z-index:9999;display:flex;align-items:center;justify-content:center';
  div.onclick = function(e) { if (e.target === this) this.remove(); };
  div.innerHTML = `<div style="background:#fff;border-radius:8px;padding:24px;min-width:320px;position:relative">
    <div style="margin-bottom:12px;font-weight:600">修改商品分类</div>
    <div style="margin-bottom:12px;font-size:13px;color:#666;word-break:break-all">${escapeHtml(name)}</div>
    <select id="labelSelect" style="width:100%;padding:8px;border:1px solid #ddd;border-radius:4px;font-size:14px">${opt}</select>
    <div style="margin-top:16px;display:flex;gap:8px;justify-content:flex-end">
      <button onclick="document.getElementById('labelOverlay').remove()" style="padding:8px 16px;background:#f5f5f5;border:none;border-radius:4px;cursor:pointer">取消</button>
      <button onclick="saveLabel('${productKey}','${escapeHtml(name)}')" style="padding:8px 16px;background:#1a73e8;color:#fff;border:none;border-radius:4px;cursor:pointer">保存</button>
    </div>
  </div>`;
  document.body.appendChild(div);
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

function renderCatSelect(pk, name, currentCat) {
  const l1 = catL1FromFull(currentCat);
  const l2 = catL2FromFull(currentCat);
  const l1Opts = CAT_L1.map(c => `<option value="${c}" ${c === l1 ? 'selected' : ''}>${c}</option>`).join('');
  const l2Opts = (CAT_L2_MAP[l1] || ['其他']).map(c => {
    const full = l1 + '_' + c;
    return `<option value="${full}" ${full === currentCat || c === l2 ? 'selected' : ''}>${c}</option>`;
  }).join('');
  const escapedPk = pk.replace(/['"\\]/g, '');
  const escapedName = name.replace(/['"\\]/g, '');
  return `<select class="cl2-l1" onchange="onCatL1Change(this,'${escapedPk}','${escapedName}')" style="padding:2px 4px;border:1px solid var(--border);border-radius:4px;font-size:11px;background:var(--card-bg);color:var(--text)">${l1Opts}</select>
    <select class="cl2-l2" onchange="saveLabelFromSettings('${escapedPk}','${escapedName}',this.value)" style="padding:2px 4px;border:1px solid var(--border);border-radius:4px;font-size:11px;background:var(--card-bg);color:var(--text)">${l2Opts}</select>`;
}

function onCatL1Change(l1sel, pk, name) {
  const l2sel = l1sel.nextElementSibling;
  const l1 = l1sel.value;
  const subs = CAT_L2_MAP[l1] || ['其他'];
  const currentFull = l2sel.value;
  const currentL2 = currentFull.startsWith(l1 + '_') ? currentFull.slice(l1.length + 1) : '';
  l2sel.innerHTML = subs.map(c => {
    const full = l1 + '_' + c;
    return `<option value="${full}" ${c === currentL2 ? 'selected' : ''}>${c}</option>`;
  }).join('');
  saveLabelFromSettings(pk, name, l2sel.value);
}

function loadLabelManager() {
  const container = document.getElementById('labelManagerList');
  const search = document.getElementById('labelSearchInput')?.value?.toLowerCase() || '';
  const catFilter = document.getElementById('labelCatFilter')?.value || '';
  const labels = Object.values(productLabels);
  let filtered = labels.filter(l => l.category !== '其他');
  if (search) filtered = filtered.filter(l => l.name.toLowerCase().includes(search));
  if (catFilter) filtered = filtered.filter(l => l.category === catFilter);
  filtered.sort((a, b) => a.name.localeCompare(b.name));

  if (!filtered.length) {
    container.innerHTML = '<div style="padding:20px;text-align:center;color:var(--text3);font-size:13px">暂无已分类商品</div>';
    return;
  }

  container.innerHTML = filtered.map(l => {
    const pk = l.product_key.replace(/['"\\]/g, '');
    const name = l.name.replace(/['"\\]/g, '');
    return `<div style="display:flex;align-items:center;gap:4px;padding:4px 6px;border-bottom:1px solid var(--border);font-size:12px">
      <span style="flex:1;word-break:break-all;color:var(--text2);font-size:11px">${escapeHtml(l.name)}</span>
      <span style="display:flex;gap:2px;flex-shrink:0">${renderCatSelect(pk, name, l.category)}</span>
      ${l.confidence < 1 ? `<span style="font-size:10px;color:var(--text3);white-space:nowrap">${Math.round(l.confidence*100)}%</span>` : '<span style="font-size:10px;color:var(--success);flex-shrink:0">手动</span>'}
    </div>`;
  }).join('');

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
    productLabels[productKey] = { product_key: productKey, name, category, confidence: 1.0 };
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
    productLabels[productKey] = { product_key: productKey, name, category, confidence: 1.0 };
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
    const res = await fetch('/api/stores', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url }) });
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
    await fetch(`/api/stores/${id}/refresh`, { method: 'POST' });
    let n = 0;
    while (n < 30) {
      await new Promise(r => setTimeout(r, 1500));
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
      await fetch(`/api/stores/${s.id}/refresh`, { method: 'POST' });
      let n = 0;
      while (n < 30 && !_stopRefreshAll) {
        await new Promise(r => setTimeout(r, 1500));
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
  await fetch(`/api/stores/${id}`, { method: 'DELETE' });
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
  const data = await (await fetch(`/api/products/${storeId}/${productId}/history`)).json();
  document.getElementById('modalTitle').textContent = name || '价格历史';
  document.getElementById('modalProductMeta').textContent = navIndex >= 0 ? `${navIndex+1}/${navProducts.length}` : '';
  document.getElementById('prevProductBtn').style.visibility = navIndex > 0 ? 'visible' : 'hidden';
  document.getElementById('nextProductBtn').style.visibility = navIndex < navProducts.length-1 ? 'visible' : 'hidden';
  document.getElementById('historyModal').style.display = 'block';
  if (priceChart) priceChart.destroy();
  if (!data.length) { document.getElementById('priceChart').style.display = 'none'; return; }
  document.getElementById('priceChart').style.display = 'block';
  priceChart = new Chart(document.getElementById('priceChart').getContext('2d'), {
    type: 'line',
    data: { labels: data.map(d => new Date(d.date).toLocaleString('zh-CN')), datasets: [{ label: '价格 (¥)', data: data.map(d => d.price), borderColor: '#1a73e8', backgroundColor: 'rgba(26,115,232,0.1)', fill: true, tension: 0.3, pointRadius: 4 }] },
    options: { responsive: true, interaction: { intersect: false, mode: 'index' }, plugins: { legend: { display: false } }, scales: { y: { beginAtZero: false, ticks: { callback: v => '¥'+v.toFixed(2) } }, x: { ticks: { maxRotation: 45, font: { size: 10 } } } } }
  });
}
