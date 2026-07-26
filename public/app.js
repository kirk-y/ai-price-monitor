let filterConfig = {};
let classificationConfig = { version: 2, taxonomy: [], rules: [] };
let refreshConfig = {};
let storeSummaries = [];
let stores = [];
let activeStoreId = 'all';
let activeBrowseStoreId = '';
let hiddenStoreIds = [];
let userPreferences = {};
let storeWindowStart = 0;
let storeWindowEnd = 4;
let storeWindowBusy = false;
let activeCategory = 'gpt_plus';
let activeCatL1 = 'gpt';
let activeCatL2 = 'gpt_plus';
let plusDetailsExpanded = activeCatL2 === 'gpt_plus';
let activePlusDetail = localStorage.getItem('activePlusDetail') || 'all';
let bestPricePlusExpanded = localStorage.getItem('bestPricePlusExpanded') === 'true';
let renderLimit = 30;
let expandedNoStock = {};
let includeWords = [];
let excludeWords = [];
let lastActiveSearch = 'include';
let priceChart = null;
let historyRequestId = 0;
let historyBestChart = null;
let historyBestCharts = [];
let historyBestData = null;
let activeHistoryBestCategory = 'plus_未接码';
let historicalBestMode = false;
let historyBestStoreId = '';
let navProducts = [];
let navIndex = -1;
let productLabels = {};
let cachedProducts = [];
let productsDirty = true;
let storeOrder = [];
let dragDropPosition = 'before';
let priceRange = { min: 0, max: 0 };
let _priceTimer = null;

localStorage.removeItem('authToken');
let _authToken = sessionStorage.getItem('authToken') || '';
let _userRole = sessionStorage.getItem('userRole') || '';
let _currentUser = null;

async function apiFetch(url, opts) {
  const h = { ...(opts?.headers || {}) };
  if (_authToken) h['x-auth-token'] = _authToken;
  const res = await fetch(url, { ...opts, headers: h });
  if (res.status === 401) {
    clearAuthSession();
    document.getElementById('authOverlay')?.classList.add('visible');
    throw new Error('未授权');
  }
  if (res.status === 403) {
    alert('权限不足，该操作需要管理员权限');
    throw new Error('权限不足');
  }
  return res;
}

function isAdmin() {
  return _userRole === 'admin';
}

function canOperate() {
  return _userRole === 'admin' || _userRole === 'operator';
}

function clearAuthSession() {
  _authToken = '';
  _userRole = '';
  _currentUser = null;
  sessionStorage.removeItem('authToken');
  sessionStorage.removeItem('userRole');
}

async function fetchUserRole() {
  try {
    const res = await apiFetch('/api/auth/me');
    const data = await res.json();
    _currentUser = data.user || null;
    _userRole = _currentUser?.role || '';
    sessionStorage.setItem('userRole', _userRole);
    applyRoleRestrictions();
    return true;
  } catch (e) { return false; }
}

function applyRoleRestrictions() {
  document.body.classList.toggle('role-admin', isAdmin());
  document.body.classList.toggle('role-operator', _userRole === 'operator');
  document.body.classList.toggle('role-viewer', _userRole === 'viewer');
  const badge = document.getElementById('roleBadge');
  if (badge) {
    const roleLabels = { admin: '管理员', operator: '操作员', viewer: '访客' };
    badge.textContent = `${_currentUser?.username || ''} · ${roleLabels[_userRole] || ''}`;
    badge.className = 'role-badge ' + (_userRole || 'viewer');
  }
}

async function ensureAuthenticated() {
  if (_authToken && await fetchUserRole()) return;
  clearAuthSession();
  const status = await fetch('/api/auth/status').then(response => response.json());
  const setup = Boolean(status.setupRequired);
  const overlay = document.getElementById('authOverlay');
  const title = document.getElementById('authTitle');
  const hint = document.getElementById('authHint');
  const submit = document.getElementById('authSubmit');
  const username = document.getElementById('authUsername');
  const password = document.getElementById('authPassword');
  const message = document.getElementById('authMessage');
  title.textContent = setup ? '创建管理员' : '登录价格监控';
  hint.textContent = setup ? '首次使用，请创建平台管理员账户。' : '使用平台账户继续。';
  submit.textContent = setup ? '创建并进入' : '登录';
  overlay.classList.add('visible');
  await new Promise(resolve => {
    document.getElementById('authForm').onsubmit = async event => {
      event.preventDefault();
      message.textContent = '';
      submit.disabled = true;
      try {
        const response = await fetch(setup ? '/api/auth/bootstrap' : '/api/auth/login', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: username.value.trim(), password: password.value }),
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || '登录失败');
        _authToken = data.token;
        _currentUser = data.user;
        _userRole = data.user.role;
        sessionStorage.setItem('authToken', _authToken);
        sessionStorage.setItem('userRole', _userRole);
        password.value = '';
        overlay.classList.remove('visible');
        applyRoleRestrictions();
        resolve();
      } catch (error) { message.textContent = error.message; }
      finally { submit.disabled = false; }
    };
  });
}

async function logout() {
  try { await apiFetch('/api/auth/logout', { method: 'POST' }); } catch (_) {}
  clearAuthSession();
  location.reload();
}

const THEME_ICONS = {
  sun: '<svg viewBox="0 0 24 24" aria-hidden="true"><g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="4" fill="currentColor" stroke="none"></circle><path d="M12 2v2m0 16v2M2 12h2m16 0h2M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"></path></g></svg>',
  moon: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3a9 9 0 1 0 9 9c0-.46-.04-.92-.1-1.36a5.39 5.39 0 0 1-4.4 2.26 5.4 5.4 0 0 1-3.14-9.8c-.44-.06-.9-.1-1.36-.1z" fill="currentColor"></path></svg>',
};

function initTheme() {
  const saved = localStorage.getItem('theme');
  if (saved === 'dark' || (!saved && window.matchMedia('(prefers-color-scheme: dark)').matches)) {
    document.body.classList.add('dark');
    document.getElementById('themeToggle').innerHTML = THEME_ICONS.sun;
  }
}

function toggleTheme() {
  const isDark = document.body.classList.toggle('dark');
  localStorage.setItem('theme', isDark ? 'dark' : 'light');
  document.getElementById('themeToggle').innerHTML = isDark ? THEME_ICONS.sun : THEME_ICONS.moon;
  refreshOpenCharts();
}

// Charts read CSS variables at creation time, so rebuild any visible chart
// after a theme switch to pick up the new palette.
function refreshOpenCharts() {
  if (historicalBestMode) renderHistoricalBestPrices();
  const modalOpen = document.getElementById('historyModal').style.display === 'block';
  if (modalOpen && navIndex >= 0 && navProducts[navIndex]) {
    const p = navProducts[navIndex];
    showHistory(p.storeId, p.id, p.name, true);
  }
}

function isFilterDrawerMode() {
  return window.matchMedia('(max-width: 1120px)').matches;
}

function openFilterDrawer() {
  document.getElementById('rightBar').classList.add('drawer-open');
  document.getElementById('drawerBackdrop').classList.add('visible');
  document.getElementById('filterToggleBtn').setAttribute('aria-expanded', 'true');
}

function closeFilterDrawer() {
  document.getElementById('rightBar').classList.remove('drawer-open');
  document.getElementById('drawerBackdrop').classList.remove('visible');
  document.getElementById('filterToggleBtn').setAttribute('aria-expanded', 'false');
}

function toggleFilterDrawer() {
  if (document.getElementById('rightBar').classList.contains('drawer-open')) closeFilterDrawer();
  else openFilterDrawer();
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
    'set-plus-detail': () => setPlusDetail(target.dataset.detail),
    'toggle-best-plus': () => toggleBestPricePlus(),
    'set-cat-all': () => setAllCategories(),
    'switch-store': () => switchStore(target.dataset.storeId),
    'go-best-price': () => goToBestPrice(target.dataset.storeId, target.dataset.category, target.dataset.productId, target.dataset.detail),
    'history-cat': () => selectHistoryBestCategory(target.dataset.category),
    'open-history-best': () => openHistoricalBestView(),
    'open-history-store': () => openHistoricalBestForStore(target.dataset.storeId),
    'open-history-global': () => openHistoricalBestGlobal(),
    'toggle-history-cat': () => toggleHistoryBestCategory(target.dataset.category),
    'exit-history-best': () => exitHistoricalBestView(),
    'delete-store': () => deleteStore(target.dataset.storeId),
    'toggle-no-stock': () => toggleNoStock(target.dataset.storeId),
    'hide-store': () => hideStore(target.dataset.storeId),
    'copy-store-link': () => copyStoreLink(target.dataset.storeUrl),
    'restore-store': () => restoreStore(target.dataset.storeId),
    'save-user': () => saveManagedUser(target.dataset.userId),
    'delete-user': () => deleteManagedUser(target.dataset.userId),
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
    'delete-category-definition': () => deleteCategoryDefinition(target.dataset.category),
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
    'category-parent': () => moveCategoryDefinition(target.dataset.category, target.value),
    'category-visibility': () => toggleCatVisibility(target.dataset.category, target.checked),
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
    if (event.type === 'dragover') dragOver(event, target.dataset.id);
    if (event.type === 'drop') dropStore(event, target.dataset.id);
    if (event.type === 'dragend') dragEnd();
  }
  if (target.dataset.dragType === 'history-category') {
    if (event.type === 'dragstart') historyCatDragStart(event, target.dataset.category);
    if (event.type === 'dragover') historyCatDragOver(event);
    if (event.type === 'drop') historyCatDrop(event, target.dataset.category);
    if (event.type === 'dragend') historyCatDragEnd();
  }
}

document.addEventListener('DOMContentLoaded', async () => {
  initTheme();
  await ensureAuthenticated();
  document.getElementById('themeToggle').addEventListener('click', toggleTheme);
  document.getElementById('logoutBtn').addEventListener('click', logout);
  document.addEventListener('click', handleActionClick);
  document.addEventListener('change', handleActionChange);
  document.addEventListener('input', handleActionInput);
  ['dragstart', 'dragover', 'drop', 'dragend'].forEach(type => {
    document.addEventListener(type, handleActionDrag);
  });
  filterConfig = await (await apiFetch('/api/filter-config')).json();
  userPreferences = await (await apiFetch('/api/preferences')).json();
  classificationConfig = await (await apiFetch('/api/classification/config')).json();
  syncCategoryDefinitions();
  hiddenStoreIds = Array.isArray(userPreferences.hiddenStoreIds)
    ? userPreferences.hiddenStoreIds
    : (Array.isArray(filterConfig.hiddenStoreIds) ? filterConfig.hiddenStoreIds : []);
  suggestedKeywords = filterConfig.suggestedKeywords || ['GPT', 'Plus', 'Pro', 'Team', '接码', '直充', '成品', '账号', 'Claude', 'Gemini', 'OpenAI', 'SMS', '谷歌', '微软', '邮箱', 'API', '订阅', '会员', 'Access'];
  keywordUsage = filterConfig.keywordUsage || {};
  refreshConfig = await (await apiFetch('/api/refresh-config')).json();
  await loadStoreSummaries();
  stores = await (await apiFetch('/api/stores')).json();
  const sharedStoreOrder = await (await apiFetch('/api/store-order')).json();
  storeOrder = Array.isArray(userPreferences.storeOrder) ? userPreferences.storeOrder : sharedStoreOrder;
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
    if (e.key === 'Escape') {
      closeFilterDrawer();
      if (document.getElementById('historyModal').style.display === 'block') { closeModal(); return; }
      if (document.getElementById('settingsModal').style.display === 'block') { closeSettings(); return; }
      if (document.getElementById('addStoreModal').style.display === 'block') { closeAddModal(); return; }
      document.getElementById('labelOverlay')?.remove();
      return;
    }
    if (document.getElementById('historyModal').style.display !== 'block') return;
    if (e.key === 'ArrowLeft') navigateProduct(-1);
    if (e.key === 'ArrowRight') navigateProduct(1);
  });
  document.getElementById('filterToggleBtn').addEventListener('click', toggleFilterDrawer);
  document.getElementById('drawerBackdrop').addEventListener('click', closeFilterDrawer);
  window.addEventListener('resize', () => { if (!isFilterDrawerMode()) closeFilterDrawer(); });

  setupSearch('includeInput', 'includeChips', 'includeWords', 'include');
  setupSearch('excludeInput', 'excludeChips', 'excludeWords', 'exclude');
  renderSuggestedKeys();
  initSettings();
  setupStoreScrollTracking();
  startStoreStatusPolling();
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
  if (!canOperate()) return;
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
  document.getElementById('historyBestBtn').addEventListener('click', openHistoricalBestGlobal);
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
  document.getElementById('aiClassifyBtn').addEventListener('click', runAiClassification);
  document.getElementById('historyExportAllBtn').addEventListener('click', () => downloadBlob('/api/history/export', 'all-history.json'));
  document.getElementById('historyImportAllBtn').addEventListener('click', () => document.getElementById('historyImportAllFile').click());
  document.getElementById('historyImportAllFile').addEventListener('change', importAllHistoryFile);
  document.getElementById('storeHistoryExportBtn').addEventListener('click', exportStoreHistory);
  document.getElementById('storeHistoryImportBtn').addEventListener('click', () => document.getElementById('storeHistoryImportFile').click());
  document.getElementById('storeHistoryImportFile').addEventListener('change', importStoreHistoryFile);
  document.getElementById('labelManagerRefreshBtn').addEventListener('click', loadLabelManager);
  document.getElementById('categoryManagerAdd').addEventListener('click', addCategoryDefinition);
  document.getElementById('categoryManagerFilter').addEventListener('change', renderCategoryManager);
  document.getElementById('categoryManagerSearch').addEventListener('input', renderCategoryManager);
  document.getElementById('classificationDimensionFilter').addEventListener('change', renderClassificationRules);
  document.getElementById('classificationSaveBtn').addEventListener('click', saveClassificationRules);
  document.getElementById('classificationPreviewBtn').addEventListener('click', previewClassificationRules);
  document.getElementById('classificationApplyBtn').addEventListener('click', applyClassificationRules);
  document.getElementById('createUserBtn').addEventListener('click', createManagedUser);
  document.querySelectorAll('.settings-option').forEach(el => {
    el.addEventListener('click', () => switchSettingsOption(el.dataset.option));
  });
}

function openSettings() {
  if (!isAdmin() && document.querySelector('.settings-option.active')?.dataset.option === 'export') {
    switchSettingsOption('storeexport');
  }
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
  const ai = filterConfig.aiClassify || {};
  document.getElementById('aiClassifyUrl').value = ai.url || '';
  document.getElementById('aiClassifyKey').value = ai.key || '';
  document.getElementById('aiClassifyModel').value = ai.model || 'gpt-4o-mini';
  document.getElementById('aiClassifyMsg').textContent = '';
  renderCatVisibility();
  renderCategoryManager();
  renderNextRefresh(cfg.nextRefreshAt);
  startNextRefreshTimer(cfg.nextRefreshAt);
  renderStoreExportSelect();
  renderStoreHistorySelects();
  document.getElementById('settingsModal').style.display = 'block';
}

let _nextRefreshTimer = null;
let _refreshConfigReloading = false;

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
    if (ts <= Date.now()) {
      if (_refreshConfigReloading) return;
      _refreshConfigReloading = true;
      apiFetch('/api/refresh-config')
        .then(response => response.json())
        .then(config => {
          refreshConfig = config;
          renderNextRefresh(config.nextRefreshAt);
          startNextRefreshTimer(config.nextRefreshAt);
        })
        .catch(() => renderNextRefresh(ts))
        .finally(() => { _refreshConfigReloading = false; });
      return;
    }
    renderNextRefresh(ts);
  }, 1000);
}

function categoryDefinitionSeed() {
  const entries = [];
  for (const parent of CAT_L1) {
    for (const child of (CAT_L2_MAP[parent] || [])) {
      const id = categoryKey(parent, child);
      entries.push({ id, name: CAT_LABELS[id] || child, parent, builtin: true });
    }
  }
  return entries;
}

function getCategoryDefinitions() {
  if (!Array.isArray(filterConfig.categoryDefinitions) || !filterConfig.categoryDefinitions.length) {
    filterConfig.categoryDefinitions = categoryDefinitionSeed();
  }
  return filterConfig.categoryDefinitions;
}

function categoryDefinitionsForParent(parent) {
  return getCategoryDefinitions().filter(item => item.parent === parent);
}

function syncCategoryDefinitions() {
  const definitions = getCategoryDefinitions();
  if (Number(filterConfig.classificationCatalogVersion || 0) < 3) {
    const known = new Set(definitions.map(item => item.id));
    for (const item of categoryDefinitionSeed()) {
      if (!known.has(item.id)) definitions.push(item);
    }
    const preferredGptOrder = ['gpt_plus', 'gpt_pro', 'gpt_team', 'gpt_k12', 'gpt_free', 'gpt_go', 'gpt_other'];
    const existingOrder = Array.isArray(filterConfig.categoryOrder) ? filterConfig.categoryOrder : [];
    filterConfig.categoryOrder = [...preferredGptOrder, ...existingOrder.filter(id => !preferredGptOrder.includes(id))];
    filterConfig.classificationCatalogVersion = 3;
  }
  for (const item of definitions) {
    CAT_LABELS[item.id] = item.name;
  }
  for (const parent of CAT_L1) {
    const custom = definitions.filter(item => item.parent === parent).map(item => item.name);
    if (custom.length) CAT_L2_MAP[parent] = custom;
  }
}

async function persistCategoryDefinitions() {
  filterConfig.categoryDefinitions = getCategoryDefinitions();
  await apiFetch('/api/filter-config', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(filterConfig) });
  syncCategoryDefinitions();
  markDirty();
  render();
  renderCatVisibility();
  renderCategoryManager();
}

function renderCategoryManager() {
  const parentSelect = document.getElementById('categoryManagerParent');
  const list = document.getElementById('categoryManagerList');
  if (!parentSelect || !list || typeof CAT_L1 === 'undefined') return;
  parentSelect.innerHTML = CAT_L1.map(parent => `<option value="${escapeHtml(parent)}">${escapeHtml(CAT_L1_LABELS[parent] || parent)}</option>`).join('');
  const definitions = getCategoryDefinitions();
  const managerFilter = document.getElementById('categoryManagerFilter');
  const selectedParent = managerFilter?.value || '';
  if (managerFilter) {
    managerFilter.innerHTML = '<option value="">全部一级分类</option>' + CAT_L1.map(parent => `<option value="${escapeHtml(parent)}">${escapeHtml(CAT_L1_LABELS[parent] || parent)}</option>`).join('');
    managerFilter.value = CAT_L1.includes(selectedParent) ? selectedParent : '';
  }
  const search = String(document.getElementById('categoryManagerSearch')?.value || '').trim().toLowerCase();
  const catFilter = document.getElementById('labelCatFilter');
  if (catFilter) {
    const selected = catFilter.value;
    catFilter.innerHTML = '<option value="">全部分类</option>' + definitions.map(item => `<option value="${escapeHtml(item.id)}">${escapeHtml(categoryDisplayLabel(item.id))}</option>`).join('');
    catFilter.value = definitions.some(item => item.id === selected) ? selected : '';
  }
  const hidden = filterConfig.hiddenCategories || [];
  const order = categoryOrderWithDefinitions();
  const visibleDefinitions = order.map(id => definitions.find(item => item.id === id)).filter(Boolean)
    .filter(item => !selectedParent || item.parent === selectedParent)
    .filter(item => !search || `${item.name} ${categoryDisplayLabel(item.id)}`.toLowerCase().includes(search));
  list.innerHTML = visibleDefinitions.map(item => {
    const parentOptions = CAT_L1.map(parent => `<option value="${escapeHtml(parent)}" ${parent === item.parent ? 'selected' : ''}>${escapeHtml(CAT_L1_LABELS[parent] || parent)}</option>`).join('');
    return `<div class="category-manager-row"><span title="${escapeHtml(item.id)}">${escapeHtml(categoryDisplayLabel(item.id))}</span><select data-change-action="category-parent" data-category="${escapeHtml(item.id)}">${parentOptions}</select><button type="button" data-action="delete-category-definition" data-category="${escapeHtml(item.id)}" title="删除分类">删除</button></div>`;
  }).join('') || '<div style="padding:12px;color:var(--text3);text-align:center">暂无二级分类</div>';
  list.querySelectorAll('.category-manager-row').forEach(row => {
    const category = row.querySelector('[data-category]')?.dataset.category;
    if (!category) return;
    row.setAttribute('draggable', 'true');
    row.dataset.dragType = 'category';
    row.dataset.cat = category;
    row.insertAdjacentHTML('afterbegin', '<span class="category-manager-drag" title="拖动调整顺序">☷</span>');
    row.insertAdjacentHTML('beforeend', `<label class="category-manager-visible"><input type="checkbox" ${hidden.includes(category) ? '' : 'checked'} data-change-action="category-visibility" data-category="${escapeHtml(category)}">显示</label>`);
  });
}

async function addCategoryDefinition() {
  const parent = document.getElementById('categoryManagerParent')?.value;
  const input = document.getElementById('categoryManagerName');
  const name = String(input?.value || '').trim();
  const msg = document.getElementById('categoryManagerMsg');
  if (!parent || !name) { if (msg) msg.textContent = '请输入分类名称'; return; }
  const definitions = getCategoryDefinitions();
  if (definitions.some(item => item.parent === parent && item.name === name)) { if (msg) msg.textContent = '该一级分类下已存在同名分类'; return; }
  const id = `custom_${Date.now().toString(36)}`;
  definitions.push({ id, name, parent, builtin: false });
  input.value = '';
  if (msg) msg.textContent = '已添加';
  await persistCategoryDefinitions();
}

async function moveCategoryDefinition(category, parent) {
  const item = getCategoryDefinitions().find(entry => entry.id === category);
  if (!item || !CAT_L1.includes(parent) || item.parent === parent) return;
  const oldParent = item.parent;
  item.parent = parent;
  const changed = Object.values(productLabels).filter(label => label.category === category);
  for (const label of changed) {
    await saveLabelFromSettings(label.product_key, label.name, category, category);
  }
  const msg = document.getElementById('categoryManagerMsg');
  if (msg) msg.textContent = `已将“${item.name}”从${oldParent}调整到${parent}`;
  await persistCategoryDefinitions();
}

async function deleteCategoryDefinition(category) {
  const item = getCategoryDefinitions().find(entry => entry.id === category);
  if (!item) return;
  if (!confirm(`确定删除二级分类“${item.name}”？使用中的商品将归入其他`)) return;
  const definitions = getCategoryDefinitions();
  filterConfig.categoryDefinitions = definitions.filter(entry => entry.id !== category);
  const changed = Object.values(productLabels).filter(label => label.category === category);
  for (const label of changed) {
    await saveLabelFromSettings(label.product_key, label.name, '其他', category);
  }
  const hidden = filterConfig.hiddenCategories || [];
  filterConfig.hiddenCategories = hidden.filter(key => key !== category);
  await persistCategoryDefinitions();
}

function renderCatVisibility() {
  const hidden = filterConfig.hiddenCategories || [];
  const order = categoryOrderWithDefinitions();
  const container = document.getElementById('catVisibility');
  if (!container) return;
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

function categoryOrderWithDefinitions() {
  const configured = Array.isArray(filterConfig.categoryOrder) ? [...filterConfig.categoryOrder] : Object.keys(CAT_LABELS);
  for (const item of getCategoryDefinitions()) if (!configured.includes(item.id)) configured.push(item.id);
  return configured;
}

let _catDragKey = null;
function catDragStart(e, k) { _catDragKey = k; e.dataTransfer.effectAllowed = 'move'; e.target.closest('[data-drag-type]')?.classList.add('dragging'); }
function catDragOver(e) { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; }
function catDragEnd() { document.querySelectorAll('.cat-vis-row.dragging, .category-manager-row.dragging').forEach(el => el.classList.remove('dragging')); _catDragKey = null; }
function catDrop(e, targetKey) {
  e.preventDefault();
  if (!_catDragKey || _catDragKey === targetKey) return;
  const order = categoryOrderWithDefinitions();
  const from = order.indexOf(_catDragKey);
  const to = order.indexOf(targetKey);
  if (from === -1 || to === -1) return;
  order.splice(from, 1);
  order.splice(to, 0, _catDragKey);
  filterConfig.categoryOrder = order;
  renderCategoryManager();
  apiFetch('/api/filter-config', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(filterConfig) });
  markDirty();
  render();
}

function toggleCatVisibility(k, show) {
  if (!filterConfig.hiddenCategories) filterConfig.hiddenCategories = [];
  if (show) filterConfig.hiddenCategories = filterConfig.hiddenCategories.filter(c => c !== k);
  else if (!filterConfig.hiddenCategories.includes(k)) filterConfig.hiddenCategories.push(k);
  apiFetch('/api/filter-config', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(filterConfig) });
  markDirty();
  render();
  renderCategoryManager();
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
  if (option === 'classification') setTimeout(renderClassificationRules, 0);
  if (option === 'users') setTimeout(loadManagedUsers, 0);
}

const USER_ROLE_LABELS = { admin: '管理员', operator: '操作员', viewer: '访客' };

async function loadManagedUsers() {
  if (!isAdmin()) return;
  const host = document.getElementById('userList');
  try {
    const response = await apiFetch('/api/users');
    const users = await response.json();
    host.innerHTML = users.map(user => `<div class="user-row" data-user-id="${user.id}">
      <div class="user-identity"><strong>${escapeHtml(user.username)}</strong><span>${user.lastLoginAt ? `最近登录 ${formatTime(user.lastLoginAt)}` : '尚未登录'}</span></div>
      <select class="settings-select user-role-select" aria-label="${escapeHtml(user.username)}的角色">
        ${Object.entries(USER_ROLE_LABELS).map(([role, label]) => `<option value="${role}" ${user.role === role ? 'selected' : ''}>${label}</option>`).join('')}
      </select>
      <label class="user-enabled"><input type="checkbox" ${user.enabled ? 'checked' : ''}>启用</label>
      <input class="settings-text-input user-password-reset" type="password" maxlength="128" placeholder="留空则不改密码">
      <button type="button" class="settings-action-btn" data-action="save-user" data-user-id="${user.id}">保存</button>
      <button type="button" class="settings-action-btn danger" data-action="delete-user" data-user-id="${user.id}" ${user.id === _currentUser?.id ? 'disabled' : ''}>删除</button>
    </div>`).join('');
  } catch (error) { host.innerHTML = `<div class="settings-msg">${escapeHtml(error.message)}</div>`; }
}

async function createManagedUser() {
  const message = document.getElementById('userManageMsg');
  const username = document.getElementById('newUsername');
  const password = document.getElementById('newUserPassword');
  try {
    const response = await apiFetch('/api/users', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: username.value.trim(), password: password.value, role: document.getElementById('newUserRole').value }) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || '创建失败');
    username.value = ''; password.value = '';
    message.textContent = `已创建用户 ${data.username}`;
    await loadManagedUsers();
  } catch (error) { message.textContent = error.message; }
}

async function saveManagedUser(userId) {
  const row = document.querySelector(`.user-row[data-user-id="${CSS.escape(String(userId))}"]`);
  if (!row) return;
  const password = row.querySelector('.user-password-reset').value;
  const body = { role: row.querySelector('.user-role-select').value, enabled: row.querySelector('.user-enabled input').checked };
  if (password) body.password = password;
  const response = await apiFetch(`/api/users/${encodeURIComponent(userId)}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await response.json();
  document.getElementById('userManageMsg').textContent = response.ok ? `已更新 ${data.username}` : (data.error || '更新失败');
  if (response.ok) await loadManagedUsers();
}

async function deleteManagedUser(userId) {
  if (!confirm('确定删除这个用户？该用户的所有登录会话会立即失效。')) return;
  const response = await apiFetch(`/api/users/${encodeURIComponent(userId)}`, { method: 'DELETE' });
  const data = await response.json();
  document.getElementById('userManageMsg').textContent = response.ok ? '用户已删除' : (data.error || '删除失败');
  if (response.ok) await loadManagedUsers();
}

const CLASSIFICATION_DIMENSION_LABELS = {
  product: '主产品', tier: '套餐', subtype: '二级分类', verification: '接码状态',
  activation: '开通方式', warranty: '质保', usage: '使用方式', qualification: '账号资格',
};

function renderClassificationRules() {
  const container = document.getElementById('classificationRuleList');
  if (!container) return;
  const selected = document.getElementById('classificationDimensionFilter')?.value || '';
  const rules = (classificationConfig.rules || []).filter(rule => !selected || rule.dimension === selected);
  container.innerHTML = rules.map((rule, index) => `
    <div class="classification-rule" data-rule-id="${escapeHtml(rule.id)}" data-rule-dimension="${escapeHtml(rule.dimension)}">
      <div class="classification-rule-head">
        <label><input type="checkbox" data-rule-field="enabled" ${rule.enabled !== false ? 'checked' : ''}>启用</label>
        <strong>${escapeHtml(rule.label || rule.id)}</strong>
        <span>${escapeHtml(CLASSIFICATION_DIMENSION_LABELS[rule.dimension] || rule.dimension)}</span>
        <label>优先级 <input type="number" data-rule-field="priority" value="${Number(rule.priority) || 0}" min="-1000" max="1000"></label>
      </div>
      <div class="classification-rule-fields">
        <label>适用产品<input data-rule-field="products" value="${escapeHtml((rule.products || []).join(', '))}" placeholder="gpt, claude"></label>
        <label>必须包含<input data-rule-field="all" value="${escapeHtml((rule.all || []).join(', '))}" placeholder="所有词都要命中"></label>
        <label>任一包含<input data-rule-field="any" value="${escapeHtml((rule.any || []).join(', '))}" placeholder="命中任意一个"></label>
        <label>必须排除<input data-rule-field="exclude" value="${escapeHtml((rule.exclude || []).join(', '))}" placeholder="命中后立即排除"></label>
        <label>降低权重<input data-rule-field="negative" value="${escapeHtml((rule.negative || []).join(', '))}" placeholder="命中后扣分"></label>
      </div>
    </div>`).join('') || '<div class="empty-grid">该维度暂无规则</div>';
}

function splitRuleTerms(value) {
  return String(value || '').split(/[,，\n]/).map(term => term.trim()).filter(Boolean);
}

function collectClassificationRules() {
  const edited = new Map();
  document.querySelectorAll('.classification-rule').forEach(row => {
    const key = `${row.dataset.ruleDimension}:${row.dataset.ruleId}`;
    const current = (classificationConfig.rules || []).find(rule => `${rule.dimension}:${rule.id}` === key);
    if (!current) return;
    const read = field => row.querySelector(`[data-rule-field="${field}"]`);
    edited.set(key, {
      ...current,
      enabled: read('enabled').checked,
      priority: Number(read('priority').value) || 0,
      products: splitRuleTerms(read('products').value),
      all: splitRuleTerms(read('all').value),
      any: splitRuleTerms(read('any').value),
      exclude: splitRuleTerms(read('exclude').value),
      negative: splitRuleTerms(read('negative').value),
    });
  });
  return {
    ...classificationConfig,
    rules: (classificationConfig.rules || []).map(rule => edited.get(`${rule.dimension}:${rule.id}`) || rule),
  };
}

async function saveClassificationRules() {
  const msg = document.getElementById('classificationMsg');
  try {
    const response = await apiFetch('/api/classification/config', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(collectClassificationRules()),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || '保存失败');
    classificationConfig = result;
    msg.textContent = '规则已保存';
    renderClassificationRules();
    return true;
  } catch (error) {
    msg.textContent = `保存失败：${error.message}`;
    return false;
  }
}

async function previewClassificationRules() {
  const msg = document.getElementById('classificationMsg');
  const output = document.getElementById('classificationPreview');
  msg.textContent = '正在对现有商品进行影子分类...';
  try {
    const [response, suggestionResponse] = await Promise.all([apiFetch('/api/classification/preview', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ config: collectClassificationRules() }),
    }), apiFetch('/api/classification/suggestions')]);
    const data = await response.json();
    const suggestionData = suggestionResponse.ok ? await suggestionResponse.json() : { suggestions: [] };
    if (!response.ok) throw new Error(data.error || '预览失败');
    const summary = data.summary;
    msg.textContent = `预览完成：${summary.total} 件商品`;
    const examples = data.items.filter(item => item.result.needsReview || (item.currentCategory && item.currentCategory !== item.result.category)).slice(0, 30);
    const suggestions = (suggestionData.suggestions || []).slice(0, 12);
    output.innerHTML = `<div class="classification-summary">
      <span>保持 ${summary.unchanged}</span><span>可能变化 ${summary.changed}</span><span>未分类 ${summary.unclassified}</span><span>待确认 ${summary.needsReview}</span>
    </div>${suggestions.length ? `<div class="classification-suggestions"><strong>根据人工反馈生成的建议</strong>${suggestions.map(item => `<span>${item.type === 'exclude' ? '排除' : '包含'} · ${escapeHtml(item.dimension)} / ${escapeHtml(item.value)}：${escapeHtml(item.term)}（${item.support}次）</span>`).join('')}</div>` : ''}${examples.map(item => `<div class="classification-preview-row"><span title="${escapeHtml(item.name)}">${escapeHtml(item.name)}</span><code>${escapeHtml(item.currentCategory || '未分类')}</code><span>→</span><code>${escapeHtml(item.result.category)}</code>${item.result.needsReview ? '<em>待确认</em>' : ''}</div>`).join('')}`;
  } catch (error) {
    msg.textContent = `预览失败：${error.message}`;
  }
}

async function applyClassificationRules() {
  const msg = document.getElementById('classificationMsg');
  if (!confirm('将使用当前规则更新非人工标签。人工确认过的分类不会被覆盖，是否继续？')) return;
  if (!await saveClassificationRules()) return;
  msg.textContent = '正在应用可靠分类结果...';
  try {
    const response = await apiFetch('/api/classification/apply', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || '应用失败');
    msg.textContent = `已更新 ${result.saved} 件，跳过人工标签 ${result.skippedManual} 件，待确认 ${result.needsReview} 件`;
    productLabels = {};
    const labels = await (await apiFetch('/api/product-labels')).json();
    for (const label of labels) productLabels[label.product_key] = label;
    markDirty();
    render();
  } catch (error) {
    msg.textContent = `应用失败：${error.message}`;
  }
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
    const response = await apiFetch('/api/stores/import-list', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ stores: list }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || '批量导入失败');
    const added = Number(result.addedIds?.length || 0);
    const skipped = Number(result.skipped || 0);
    const importedIds = result.addedIds || [];
    msg.textContent = `✓ 导入完成: 新增 ${added} 个，跳过 ${skipped} 个`;
    msg.style.color = '#43a047';
    e.target.value = '';
    await waitForImportedStores(importedIds, msg, skipped);
  } catch (err) {
    msg.textContent = '导入失败: ' + err.message;
    msg.style.color = '#e53935';
  }
}

async function waitForImportedStores(ids, msg, skipped) {
  for (let attempt = 0; attempt < 30; attempt++) {
    storeSummaries = await (await apiFetch('/api/stores/summary')).json();
    stores = await (await apiFetch('/api/stores')).json();
    markDirty();
    render();
    const pending = ids.some(id => storeSummaries.find(store => store.id === id)?.status === 'pending');
    if (!pending) break;
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  const ok = ids.filter(id => storeSummaries.find(store => store.id === id)?.status === 'ok').length;
  msg.textContent = `导入完成：新增 ${ids.length} 家，已完成 ${ok} 家，跳过 ${skipped} 家`;
  msg.style.color = '#43a047';
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

async function runAiClassification() {
  const url = document.getElementById('aiClassifyUrl').value.trim();
  const key = document.getElementById('aiClassifyKey').value.trim();
  const model = document.getElementById('aiClassifyModel').value.trim() || 'gpt-4o-mini';
  const msg = document.getElementById('aiClassifyMsg');
  const button = document.getElementById('aiClassifyBtn');
  if (!url || !key) { msg.textContent = '请填写接口 URL 和 API Key'; return; }
  const products = getAllProducts().map(product => ({ productKey: product.productKey, name: product.name, category: product.category }));
  const categories = Object.keys(CAT_LABELS);
  button.disabled = true;
  msg.textContent = `正在请求大模型分类（${products.length} 件）...`;
  try {
    filterConfig.aiClassify = { url, key, model };
    await apiFetch('/api/filter-config', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(filterConfig) });
    const response = await apiFetch('/api/ai-classify', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url, key, model, products, categories }) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || '分类请求失败');
    let saved = 0;
    for (const item of result.items || []) {
      const product = products.find(candidate => candidate.productKey === item.productKey);
      if (!product) continue;
      const labelResponse = await apiFetch(`/api/product-labels/${encodeURIComponent(item.productKey)}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ category: item.category, name: product.name, previousCategory: product.category }) });
      if (labelResponse.ok) {
        productLabels[item.productKey] = { product_key: item.productKey, name: product.name, category: item.category, confidence: 1, manual: 1 };
        saved++;
      }
    }
    markDirty();
    render();
    msg.textContent = `分类完成，已保存 ${saved} 件商品`;
  } catch (error) {
    msg.textContent = `分类失败：${error.message}`;
  } finally {
    button.disabled = false;
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
      historyBestData = null;
      markDirty();
      renderHistoricalBestPrices();
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
      historyBestData = null;
      markDirty();
      renderHistoricalBestPrices();
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
  renderHistoricalBestPrices();
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

function resolveProductCategory(name, labelCategory) {
  const category = labelCategory || categorize(name);
  // Explicit free-account wording is stronger than a stale Plus subcategory label.
  if (/free\s*号|free\s*账号|普号|普通号|白号/i.test(String(name)) && /^plus_/.test(category)) return 'gpt_free';
  if (!labelCategory && /\bk12\b/i.test(String(name))) return 'gpt_k12';
  return category;
}

function canonicalLegacyCategory(category, name = '') {
  const definition = Array.isArray(filterConfig.categoryDefinitions)
    ? filterConfig.categoryDefinitions.find(item => item.id === category)
    : null;
  if (definition?.name === '自助充值') {
    const inferred = categorize(name);
    return inferred && inferred !== category && inferred !== 'other' ? canonicalLegacyCategory(inferred, name) : 'gpt_other';
  }
  if (definition?.parent === 'gpt' && (definition.name === '其他' || definition.name === '其他GPT')) return 'gpt_other';
  const map = {
    'plus_已接码': 'gpt_plus', 'plus_未接码': 'gpt_plus', 'plus_质保': 'gpt_plus',
    gpt_business: 'gpt_team', gpt_edu: 'gpt_k12', gptk12: 'gpt_k12', gpt_其他: 'gpt_other', gpt其他: 'gpt_other', gemini: 'gemini_other',
    claude: 'claude_other', grok: 'grok_other', sms: 'sms_sms', gpt_image2: 'gpt_other', gpt_cyber: 'gpt_other',
    ai_platform_cursor: 'developer_tools_cursor', ai_platform_kiro: 'developer_tools_kiro',
    ai_platform_perplexity: 'other_ai_perplexity', 开发工具_codex: 'developer_tools_codex',
    邮箱_gmail: 'email_gmail', 邮箱_outlook: 'email_outlook', 邮箱_icloud: 'email_icloud',
    中转额度: 'relay_api_relay', 中转额度_额度充值: 'relay_api_relay', 中转额度_中转券: 'relay_api_relay',
  };
  if (map[category]) return map[category];
  if (category.startsWith('视频会员_')) return 'digital_membership_video';
  if (category.startsWith('音乐会员_')) return 'digital_membership_music';
  if (category.startsWith('网盘_')) return 'digital_membership_cloud_drive';
  if (category.startsWith('阅读会员_')) return 'digital_membership_reading';
  if (category.startsWith('Adobe_') || category.startsWith('修图剪辑_')) return 'digital_membership_software';
  if (category.startsWith('生活券_')) return 'recharge_life_coupon';
  if (category.startsWith('卡密兑换_')) return 'recharge_life_redeem_code';
  if (category.startsWith('电商工具_')) return 'recharge_life_ecommerce';
  if (category.startsWith('虚拟卡_')) return 'network_cloud_virtual_card';
  if (category.startsWith('IP代理_')) return category.toLowerCase().includes('vpn') ? 'network_cloud_vpn' : 'network_cloud_proxy';
  if (category.startsWith('云服务_')) return 'network_cloud_cloud_server';
  if (category.startsWith('号码_')) return 'sms_number_rental';
  if (category.startsWith('开发工具_')) return `developer_tools_${category.slice('开发工具_'.length)}`;
  return category;
}

function legacyClassification(category, name = '') {
  const attributes = {};
  if (category === 'plus_未接码') attributes.verification = 'unverified';
  if (category === 'plus_已接码') attributes.verification = 'verified';
  if (category === 'plus_质保') attributes.warranty = 'warranty';
  if (category === 'gptk12' || category === 'gpt_k12') attributes.qualification = 'k12';
  if (definitionNameForCategory(category) === '自助充值') attributes.activation = 'self_service';
  return { category: canonicalLegacyCategory(category, name), attributes, legacy: true };
}

function definitionNameForCategory(category) {
  return filterConfig.categoryDefinitions?.find(item => item.id === category)?.name || '';
}

function normalizeStoredClassification(classification, fallbackCategory, name) {
  if (!classification?.category) return legacyClassification(fallbackCategory, name);
  const legacy = legacyClassification(classification.category, name);
  return {
    ...classification,
    category: legacy.category,
    attributes: { ...legacy.attributes, ...(classification.attributes || {}) },
  };
}

function getAllProducts() {
  if (!productsDirty) return cachedProducts;
  const all = [];
  for (const s of stores) {
    for (const p of (s.products || [])) {
      const pk = `${s.id}:${p.id}`;
      const label = productLabels[pk];
      const legacyCategory = resolveProductCategory(p.name, label ? label.category : '');
      const classification = normalizeStoredClassification(label?.classification, legacyCategory, p.name);
      const cat = classification.category || canonicalLegacyCategory(legacyCategory, p.name);
      const conf = label ? label.confidence : 0;
      all.push({ ...p, category: cat, legacyCategory, confidence: conf, classification, productKey: pk, storeName: s.name, storeId: s.id });
    }
  }
  cachedProducts = all;
  productsDirty = false;
  return all;
}

function markDirty() { productsDirty = true; }

function applyStoreOrder() {
  const knownIds = new Set([...storeSummaries, ...stores].map(store => store.id));
  storeOrder = [...new Set(storeOrder.filter(id => knownIds.has(id)))];
  for (const item of [...storeSummaries, ...stores]) {
    if (!storeOrder.includes(item.id)) storeOrder.push(item.id);
  }
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
  let all = getAllProducts().filter(p => !isStoreHidden(p.storeId));
  if (activeCatL2) {
    const detail = activeCatL2 === 'gpt_plus' ? activePlusDetail : 'all';
    all = all.filter(product => matchesCategorySelection(product, activeCatL2, detail));
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
  const all = (includeWords.length || excludeWords.length) ? getFilteredProducts() : getAllProducts().filter(p => !isStoreHidden(p.storeId));
  const result = {};
  for (const cat of cats) {
    const detail = cat === 'gpt_plus' && activeCatL2 === 'gpt_plus' ? activePlusDetail : 'all';
    const items = all.filter(product => matchesCategorySelection(product, cat, detail) && product.price > 0 && product.stock > 0);
    if (items.length) {
      items.sort((a, b) => a.price - b.price);
      result[cat] = items[0];
    } else result[cat] = null;
  }
  return result;
}

const CAT_LABELS = {
  gpt_plus: 'GPT Plus', gpt_team: 'GPT Team', gpt_k12: 'GPT K12', gpt_business: 'GPT Team', gpt_edu: 'GPT K12', gpt_other: '其他GPT',
  claude_free: 'Claude Free', claude_team: 'Claude Team', claude_enterprise: 'Claude Enterprise', claude_other: '其他Claude',
  gemini_free: 'Gemini Free', gemini_ai_pro: 'Google AI Pro', gemini_ai_ultra: 'Google AI Ultra', gemini_workspace: 'Gemini Workspace', gemini_other: '其他Gemini',
  grok_free: 'Grok Free', grok_supergrok: 'SuperGrok', grok_other: '其他Grok',
  plus_已接码: 'Plus已接码', plus_未接码: 'Plus未接码', plus_质保: 'Plus质保',
  gpt_pro: 'GPT Pro', gpt_team: 'GPT Team', gemini: 'Gemini', claude: 'Claude',
  grok: 'Grok', sms: '接码', gptk12: 'K12', gpt_free: 'GPT Free', gpt_go: 'GPT GO',
  gpt_max: 'GPT Max', gpt_image2: 'GPT Image2', gpt_cyber: 'GPT Cyber',
  claude_pro: 'Claude Pro', claude_max: 'Claude Max',
  gemini_优惠链接: 'Gemini优惠', gemini_成品号: 'Gemini成品',
  ai_platform_cursor: 'Cursor', ai_platform_perplexity: 'Perplexity',
  ai_platform_kiro: 'KIRO',
  developer_tools_cursor: 'Cursor', developer_tools_codex: 'Codex', developer_tools_kiro: 'Kiro', developer_tools_copilot: 'GitHub Copilot',
  other_ai_perplexity: 'Perplexity', other_ai_poe: 'Poe', other_ai_midjourney: 'Midjourney', other_ai_suno: 'Suno',
  email_gmail: 'Gmail', email_outlook: 'Outlook', email_icloud: 'iCloud', email_enterprise: '企业邮箱',
  sms_sms: '短信接码', sms_number_rental: '号码租用', sms_esim: '实体卡/eSIM',
  relay_api_relay: 'API中转', relay_official_api: '官方API额度', relay_web_mirror: '网页镜像', relay_shared_gateway: '共享网关',
  digital_membership_video: '视频会员', digital_membership_music: '音乐会员', digital_membership_cloud_drive: '网盘会员',
  network_cloud_proxy: 'IP代理', network_cloud_vpn: 'VPN/加速', network_cloud_cloud_server: '云服务器', network_cloud_virtual_card: '虚拟卡',
  recharge_life_game: '游戏充值', recharge_life_platform: '平台充值', recharge_life_redeem_code: '卡密兑换', recharge_life_coupon: '生活券',
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
  const order = categoryOrderWithDefinitions();
  return order.filter(k => !hidden.includes(k) && CAT_LABELS[k]).map(k => [k, categoryDisplayLabel(k)]);
}

function isGptCategory(category) {
  return catL1FromFull(category) === 'gpt'
    || String(category).startsWith('plus_')
    || String(category).startsWith('gpt_')
    || category === 'gptk12';
}

const CAT_L1_DISPLAY = ['gpt', 'claude', 'gemini', 'grok', 'other_ai', 'developer_tools', 'sms', 'email', 'relay', 'digital_membership', 'network_cloud', 'recharge_life', 'other'];

const CAT_L1_LABELS = {
  gpt: 'GPT', claude: 'Claude', gemini: 'Gemini', grok: 'Grok',
  other_ai: '其他 AI', developer_tools: 'AI开发工具', sms: '接码', email: '邮箱', relay: '中转/镜像',
  digital_membership: '数字会员', network_cloud: '网络与云服务', recharge_life: '充值与生活', other: '其他',
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

function categoryDisplayLabel(full) {
  const configured = Array.isArray(filterConfig.categoryDefinitions)
    ? filterConfig.categoryDefinitions.find(item => item.id === full)
    : null;
  const l2 = configured ? configured.name : catL2FromFull(full);
  return CAT_L2_LABELS[l2] || CAT_LABELS[full] || l2 || full;
}

function renderCatBar() {
  const all = getAllProducts().filter(product => !isStoreHidden(product.storeId));
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
  const allButton = `<button class="cat-btn ${!activeCatL1 && !activeCatL2 ? 'active' : ''}" data-action="set-cat-all">全部 <span class="cat-cnt">${all.length}</span></button>`;
  const l1Buttons = [allButton, ...CAT_L1_DISPLAY.map(l1 =>
    l1Counts[l1] ? `<button class="cat-btn ${activeCatL1 === l1 ? 'active' : ''} ${activeCatL1 === l1 && activeCatL2 ? 'has-sub-selection' : ''}" data-action="set-cat-l1" data-category="${escapeHtml(l1)}">${CAT_L1_LABELS[l1]||l1} <span class="cat-cnt">${l1Counts[l1]}</span></button>` : ''
  )].filter(Boolean).join('');

  // Row 2: Level 2 subcategories (visible only when L1 is selected)
  let l2Buttons = '';
  if (activeCatL1) {
    const hidden = new Set(filterConfig.hiddenCategories || []);
    const definitions = getCategoryDefinitions();
    const configuredIds = categoryOrderWithDefinitions().filter(id => !hidden.has(id));
    const sorted = configuredIds.filter(full => {
      const definition = definitions.find(item => item.id === full);
      return definition && counts[full] && catL1Display(definition.parent) === activeCatL1;
    });
    l2Buttons = sorted.map(full => {
      const button = `<button class="cat-btn cat-btn-l2 ${activeCatL2 === full ? 'active' : ''}" data-action="set-cat-l2" data-category="${escapeHtml(full)}">${escapeHtml(categoryDisplayLabel(full))} <span class="cat-cnt">${counts[full]||0}</span></button>`;
      return full === 'gpt_plus' && plusDetailsExpanded ? button + renderPlusDetails(all) : button;
    }).join('');
  }

  bar.innerHTML = `<div class="cat-bar-row">${l1Buttons}</div>` +
    (l2Buttons ? `<div class="cat-bar-row cat-bar-row-l2">${l2Buttons}</div>` : '');
}

function setCatL1(l1) {
  historicalBestMode = false;
  historyBestStoreId = '';
  activeCatL1 = l1;
  activeCatL2 = '';
  activeCategory = '';
  plusDetailsExpanded = false;
  renderLimit = 30;
  priceRange = { min: 0, max: 0 };
  render();
}

function setAllCategories() {
  historicalBestMode = false;
  historyBestStoreId = '';
  activeCatL1 = '';
  activeCatL2 = '';
  activeCategory = '';
  plusDetailsExpanded = false;
  renderLimit = 30;
  priceRange = { min: 0, max: 0 };
  render();
}

function setCatL2(full) {
  historicalBestMode = false;
  historyBestStoreId = '';
  if (full === 'gpt_plus') {
    plusDetailsExpanded = activeCatL2 === 'gpt_plus' ? !plusDetailsExpanded : true;
  } else {
    plusDetailsExpanded = false;
  }
  activeCatL2 = full;
  activeCategory = full;
  renderLimit = 30;
  priceRange = { min: 0, max: 0 };
  render();
}

const PLUS_DETAIL_OPTIONS = [
  ['all', '全部Plus'],
  ['unverified', '未接码'],
  ['verified', '已接码'],
  ['self_service', '自助开通'],
  ['warranty', '有质保'],
];
if (!PLUS_DETAIL_OPTIONS.some(([key]) => key === activePlusDetail)) activePlusDetail = 'all';

function matchesPlusDetail(product, detail) {
  const attributes = product.classification?.attributes || {};
  if (detail === 'unverified' || detail === 'verified') return attributes.verification === detail;
  if (detail === 'self_service') return attributes.activation === detail;
  if (detail === 'warranty') return attributes.warranty === detail;
  return true;
}

function matchesCategorySelection(product, category, plusDetail = 'all') {
  if (!product || !category) return false;
  const canonical = canonicalLegacyCategory(category, product.name);
  if (product.category !== canonical && product.legacyCategory !== category) return false;
  if (canonical === 'gpt_plus' && plusDetail !== 'all') return matchesPlusDetail(product, plusDetail);
  return true;
}

function renderPlusDetails(products) {
  const plusProducts = products.filter(product => product.category === 'gpt_plus');
  return `<span class="plus-detail-group">${PLUS_DETAIL_OPTIONS.map(([key, label]) => {
    const count = key === 'all' ? plusProducts.length : plusProducts.filter(product => matchesPlusDetail(product, key)).length;
    return `<button class="cat-btn plus-detail-btn ${activePlusDetail === key ? 'active' : ''}" data-action="set-plus-detail" data-detail="${key}">${label} <span class="cat-cnt">${count}</span></button>`;
  }).join('')}</span>`;
}

function setPlusDetail(detail) {
  if (!PLUS_DETAIL_OPTIONS.some(([key]) => key === detail)) return;
  activeCatL1 = 'gpt';
  activeCatL2 = 'gpt_plus';
  activeCategory = 'gpt_plus';
  plusDetailsExpanded = true;
  activePlusDetail = detail;
  localStorage.setItem('activePlusDetail', detail);
  renderLimit = 30;
  priceRange = { min: 0, max: 0 };
  render();
  requestAnimationFrame(ensurePlusDetailsVisible);
}

function setCategory(cat) {
  activeCategory = cat;
  renderLimit = 30;
  priceRange = { min: 0, max: 0 };
  render();
  if (full === 'gpt_plus' && plusDetailsExpanded) requestAnimationFrame(ensurePlusDetailsVisible);
}

function ensurePlusDetailsVisible() {
  const group = document.querySelector('.plus-detail-group');
  const row = group?.closest('.cat-bar-row-l2');
  if (!group || !row) return;
  const groupBox = group.getBoundingClientRect();
  const rowBox = row.getBoundingClientRect();
  if (groupBox.right > rowBox.right) row.scrollBy({ left: groupBox.right - rowBox.right + 16, behavior: 'smooth' });
  else if (groupBox.left < rowBox.left) row.scrollBy({ left: groupBox.left - rowBox.left - 16, behavior: 'smooth' });
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
  renderHistoricalBestPrices();
  renderPriceRange();
  if (historicalBestMode) renderHistoryBestControls();
  else renderCatBar();
  const historyMain = document.getElementById('historicalBestMain');
  const storesHost = document.getElementById('storesContainer');
  if (historyMain && storesHost) {
    historyMain.hidden = !historicalBestMode;
    storesHost.hidden = historicalBestMode;
  }
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

function isStoreHidden(storeId) {
  return hiddenStoreIds.includes(storeId);
}

function visibleStoreSummaries() {
  return storeSummaries.filter(summary => !isStoreHidden(summary.id));
}

function browseStoreIsActive(storeId) {
  return activeBrowseStoreId === storeId;
}

function renderStoreList() {
  applyStoreOrder();
  const container = document.getElementById('storeList');
  const visible = visibleStoreSummaries();
  const ok = visible.filter(s => s.status === 'ok');
  const error = visible.filter(s => s.status === 'error');
  const pend = visible.filter(s => s.status === 'pending');
  const total = visible.reduce((s, st) => s + (st.productCount || 0), 0);

  container.innerHTML = `<button class="store-btn store-btn-all ${!activeBrowseStoreId ? 'active' : ''}" data-action="switch-store" data-store-id="all"><span class="sb-name">顶部</span> <span class="badge">${total}</span></button>
  ${visible.map(s => {
    const sid = escapeHtml(s.id);
    const isRefreshing = refreshingStores.has(s.id);
    const isPending = s.status === 'pending';
    const isError = s.status === 'error';
    const rowClass = `${isRefreshing ? ' is-refreshing' : ''}${isPending ? ' store-row-pending' : ''}${isError ? ' store-row-error' : ''}`;
    const badge = isError ? '<span class="badge badge-error">失败</span>' : isPending ? '<span class="badge badge-pending">获取中</span>' : `<span class="badge">${s.productCount||0}</span>`;
    const title = isError ? escapeHtml(s.error || '刷新失败') : isPending ? '获取中...' : formatTime(s.lastUpdated);
    return `<div class="store-row${rowClass}" draggable="true" data-drag-type="store" data-id="${sid}">
      <button class="store-btn ${browseStoreIsActive(s.id) ? 'active' : ''}" data-action="switch-store" data-store-id="${sid}" title="${title}"><span class="drag-handle">⠿</span><span class="sb-name">${escapeHtml((s.name||s.id))}</span>${badge}</button>
      ${isRefreshing ? '<div class="refresh-bar"><div class="refresh-bar-inner"></div></div>' : ''}
    </div>`;
  }).join('')}`;
  updateDashboardChrome(total, ok.length, error.length, pend.length);
}

function renderActiveStoreCard() {
  const card = document.getElementById('activeStoreCard');
  const meta = document.getElementById('browseStoreMeta');
  if (card && meta) {
    const summary = storeSummaries.find(store => store.id === activeBrowseStoreId);
    if (!summary || isStoreHidden(summary.id)) {
      meta.textContent = '顶部';
      card.innerHTML = '<div class="active-store-empty">当前浏览全部店铺</div>';
    } else {
      meta.textContent = `${summary.productCount || 0} 个商品`;
      card.innerHTML = `<div class="active-store-name">${escapeHtml(summary.name || summary.id)}</div>
        <div class="active-store-meta">${summary.productCount || 0} 个商品 · ${formatTime(summary.lastUpdated)}</div>
        <button class="active-store-hide" data-action="hide-store" data-store-id="${escapeHtml(summary.id)}">隐藏店铺</button>`;
    }
  }

  const hiddenList = document.getElementById('hiddenStoreList');
  if (!hiddenList) return;
  const hidden = storeSummaries.filter(store => isStoreHidden(store.id));
  hiddenList.innerHTML = hidden.length
    ? hidden.map(store => `<div class="hidden-store-item"><span title="${escapeHtml(store.name || store.id)}">${escapeHtml(store.name || store.id)}</span><button data-action="restore-store" data-store-id="${escapeHtml(store.id)}">恢复</button></div>`).join('')
    : '<div class="hidden-store-empty">暂无隐藏店铺</div>';
}

function persistHiddenStores() {
  userPreferences.hiddenStoreIds = [...hiddenStoreIds];
  saveUserPreferences();
}

function saveUserPreferences() {
  apiFetch('/api/preferences', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(userPreferences),
  }).catch(error => console.error('保存用户偏好失败:', error.message));
}

function showToast(message) {
  let toast = document.getElementById('appToast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'appToast';
    toast.className = 'app-toast';
    document.body.appendChild(toast);
  }
  toast.textContent = message;
  toast.classList.add('visible');
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.remove('visible'), 3600);
}

function hideStore(storeId) {
  if (isStoreHidden(storeId)) return;
  hiddenStoreIds.push(storeId);
  if (activeBrowseStoreId === storeId) activeBrowseStoreId = '';
  persistHiddenStores();
  render();
  showToast('店铺已隐藏，可在右侧“隐藏店铺”中找回');
}

function restoreStore(storeId) {
  hiddenStoreIds = hiddenStoreIds.filter(id => id !== storeId);
  persistHiddenStores();
  render();
  showToast('店铺已恢复显示');
}

function updateDashboardChrome(totalProducts, healthyCount, errorCount, pendingCount) {
  const activeStore = storeSummaries.find(s => s.id === activeBrowseStoreId);
  const visible = visibleStoreSummaries();
  document.getElementById('headerStoreCount').textContent = visible.length;
  document.getElementById('headerProductCount').textContent = totalProducts;
  renderActiveStoreCard();

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

function dragOver(e, targetId) {
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  const row = e.target.closest('.store-row');
  if (!row || !dragId || targetId === dragId) return;
  const rect = row.getBoundingClientRect();
  dragDropPosition = e.clientY < rect.top + rect.height / 2 ? 'before' : 'after';
  document.querySelectorAll('.store-row.drop-before, .store-row.drop-after').forEach(item => item.classList.remove('drop-before', 'drop-after'));
  row.classList.add(dragDropPosition === 'before' ? 'drop-before' : 'drop-after');
}

function dropStore(e, targetId) {
  e.preventDefault();
  if (!dragId || dragId === targetId) return;
  applyStoreOrder();
  const order = [...storeOrder];
  const from = order.indexOf(dragId);
  if (from < 0 || !order.includes(targetId)) return;
  order.splice(from, 1);
  let to = order.indexOf(targetId);
  if (dragDropPosition === 'after') to += 1;
  order.splice(to, 0, dragId);
  storeOrder = order;
  userPreferences.storeOrder = [...storeOrder];
  saveUserPreferences();
  applyStoreOrder();
  markDirty();
  render();
}

function dragEnd() {
  document.querySelectorAll('.store-row.dragging, .store-row.drop-before, .store-row.drop-after').forEach(el => el.classList.remove('dragging', 'drop-before', 'drop-after'));
  dragId = null;
}

function setupStoreScrollTracking() {
  const container = document.getElementById('storesContainer');
  if (!container) return;
  let frame = 0;
  let previousScrollTop = container.scrollTop;
  const expandPreviousStores = () => {
    if (storeWindowStart <= 0 || storeWindowBusy) return false;
    storeWindowBusy = true;
    const anchor = container.querySelector('.store-card[data-store-id]');
    const host = container.getBoundingClientRect();
    const anchorId = anchor?.dataset.storeId;
    const anchorOffset = anchor ? anchor.getBoundingClientRect().top - host.top : 0;
    storeWindowStart = Math.max(0, storeWindowStart - 4);
    renderStores();
    requestAnimationFrame(() => {
      const nextAnchor = anchorId
        ? container.querySelector(`.store-card[data-store-id="${CSS.escape(anchorId)}"]`)
        : null;
      if (!nextAnchor) {
        storeWindowBusy = false;
        return;
      }
      const nextHost = container.getBoundingClientRect();
      container.scrollTop += nextAnchor.getBoundingClientRect().top - nextHost.top - anchorOffset;
      requestAnimationFrame(() => { storeWindowBusy = false; });
    });
    return true;
  };
  const update = () => {
    frame = 0;
    if (storeWindowBusy) return;
    const currentScrollTop = container.scrollTop;
    const scrollingUp = currentScrollTop < previousScrollTop;
    previousScrollTop = currentScrollTop;
    const atTop = container.scrollTop <= 4;
    const cards = [...container.querySelectorAll('.store-card[data-store-id]')];
    if (!cards.length) return;
    if (container.scrollTop + container.clientHeight >= container.scrollHeight - 180) {
      const max = visibleStoreSummaries().length - 1;
      if (storeWindowEnd < max) {
        storeWindowBusy = true;
        storeWindowEnd = Math.min(max, storeWindowEnd + 4);
        renderStores();
        requestAnimationFrame(() => requestAnimationFrame(() => { storeWindowBusy = false; }));
      }
    } else if ((scrollingUp || atTop) && container.scrollTop <= 120 && storeWindowStart > 0) {
      expandPreviousStores();
    }
    if (atTop) {
      if (activeBrowseStoreId) {
        activeBrowseStoreId = '';
        renderStoreList();
        renderActiveStoreCard();
      }
      return;
    }
    const host = container.getBoundingClientRect();
    if (scrollingUp && storeWindowStart > 0) {
      const firstRect = cards[0].getBoundingClientRect();
      if (firstRect.top >= host.top - 20) expandPreviousStores();
    }
    const visible = cards.filter(card => {
      const rect = card.getBoundingClientRect();
      return rect.bottom > host.top + 12 && rect.top < host.bottom - 12;
    });
    if (!visible.length) return;
    const current = visible.reduce((best, card) => {
      const distance = Math.abs(card.getBoundingClientRect().top - host.top - 12);
      return distance < best.distance ? { card, distance } : best;
    }, { card: visible[0], distance: Infinity }).card;
    const nextId = current.dataset.storeId || '';
    if (nextId !== activeBrowseStoreId) {
      activeBrowseStoreId = nextId;
      renderStoreList();
      renderActiveStoreCard();
    }
  };
  container.addEventListener('scroll', () => {
    if (!frame) frame = requestAnimationFrame(update);
  }, { passive: true });
  container.addEventListener('wheel', event => {
    if (storeWindowBusy) {
      event.preventDefault();
      return;
    }
    if (event.deltaY < 0 && container.scrollTop <= 160 && storeWindowStart > 0) {
      const first = container.querySelector('.store-card[data-store-id]');
      const host = container.getBoundingClientRect();
      if (!first || first.getBoundingClientRect().top >= host.top - 20) expandPreviousStores();
    }
  }, { passive: true });
  requestAnimationFrame(update);
}

async function switchStore(storeId) {
  const container = document.getElementById('storesContainer');
  if (!container) return;
  if (historicalBestMode) {
    historyBestStoreId = storeId === 'all' ? '' : storeId;
    activeBrowseStoreId = historyBestStoreId;
    renderStoreList();
    renderHistoryBestControls();
    renderHistoricalBestPrices();
    return;
  }
  historicalBestMode = false;
  if (storeId === 'all') {
    activeBrowseStoreId = '';
    storeWindowStart = 0;
    storeWindowEnd = Math.max(4, storeWindowEnd);
    renderStores();
    container.scrollTo({ top: 0, behavior: 'smooth' });
    renderStoreList();
    renderActiveStoreCard();
    return;
  }
  const summary = storeSummaries.find(s => s.id === storeId);
  if (!summary || isStoreHidden(storeId)) return;
  const loadedStore = stores.find(store => store.id === storeId);
  if (!loadedStore || loadedStore.status === 'pending' || loadedStore.status === 'error') {
    showStoreLoadingOverlay('正在加载店铺数据…');
    try {
      await loadStoreWithProducts(storeId);
    } catch (error) {
      showStoreLoadingOverlay(`加载失败：${error.message || '请稍后重试'}`, true);
      setTimeout(() => hideStoreLoadingOverlay(), 2200);
      return;
    }
    hideStoreLoadingOverlay();
  }
  const visibleIds = visibleStoreSummaries().map(s => s.id);
  const targetIndex = visibleIds.indexOf(storeId);
  if (targetIndex < 0) return;
  storeWindowStart = Math.max(0, targetIndex - 4);
  storeWindowEnd = Math.min(visibleIds.length - 1, targetIndex + 4);
  renderStores();
  let target = container.querySelector(`.store-card[data-store-id="${CSS.escape(storeId)}"]`);
  if (!target) {
    renderLimit = Math.max(renderLimit, getFilteredProducts().length + 1);
    renderStores();
    target = container.querySelector(`.store-card[data-store-id="${CSS.escape(storeId)}"]`);
  }
  if (!target) return;
  const hostRect = container.getBoundingClientRect();
  const targetRect = target.getBoundingClientRect();
  const direction = targetRect.top < hostRect.top ? 'up' : 'down';
  activeBrowseStoreId = storeId;
  target.classList.remove('store-target-up', 'store-target-down');
  target.classList.add(`store-target-${direction}`);
  setTimeout(() => target.classList.remove(`store-target-${direction}`), 500);
  const targetTop = container.scrollTop + target.getBoundingClientRect().top - container.getBoundingClientRect().top - 12;
  container.scrollTo({ top: Math.max(0, targetTop), behavior: 'smooth' });
  renderStoreList();
  renderActiveStoreCard();
}

function showStoreLoadingOverlay(message, failed = false) {
  const container = document.getElementById('storesContainer');
  if (!container) return;
  let overlay = document.getElementById('storeLoadingOverlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'storeLoadingOverlay';
    overlay.className = 'store-loading-overlay';
    container.appendChild(overlay);
  }
  overlay.classList.toggle('failed', failed);
  overlay.innerHTML = `<div class="store-loading-box"><span class="store-loading-spinner"></span><span>${escapeHtml(message)}</span></div>`;
  overlay.hidden = false;
}

function hideStoreLoadingOverlay() {
  const overlay = document.getElementById('storeLoadingOverlay');
  if (overlay) overlay.hidden = true;
}

function renderBestPrices() {
  let pool = getAllProducts().filter(p => !isStoreHidden(p.storeId));
  if (includeWords.length || excludeWords.length) pool = pool.filter(p => matchesSearch(p.name));
  const gptEntries = visibleCatEntries().filter(([k]) => isGptCategory(k) && pool.some(product => product.category === k));
  const renderItem = (category, label, detail = 'all', child = false) => {
    const items = pool.filter(product => matchesCategorySelection(product, category, detail) && product.price > 0 && product.stock > 0).sort((a, b) => a.price - b.price);
    if (!items.length) return `<div class="bp-item ${child ? 'bp-detail-item' : ''}"><div class="bp-cat">${label}</div><div class="bp-na">暂无</div></div>`;
    const item = items[0];
    return `<div class="bp-item ${child ? 'bp-detail-item' : ''}" data-action="go-best-price" data-store-id="${escapeHtml(item.storeId)}" data-category="${escapeHtml(category)}" data-detail="${escapeHtml(detail)}" data-product-id="${escapeHtml(item.id)}">
      <div class="bp-cat">${label}</div>
      <div class="bp-row"><span class="bp-price">¥${item.price.toFixed(2)}</span><span class="bp-store" title="${escapeHtml(item.storeName)}">${escapeHtml(item.storeName)}</span></div>
    </div>`;
  };
  document.getElementById('bestPriceList').innerHTML = gptEntries.map(([category, label]) => {
    if (category !== 'gpt_plus') return renderItem(category, label);
    const details = PLUS_DETAIL_OPTIONS.filter(([detail]) => detail !== 'all');
    return `<div class="bp-plus-group">
      <div class="bp-plus-head">
        ${renderItem(category, label)}
        <button type="button" class="bp-plus-toggle ${bestPricePlusExpanded ? 'expanded' : ''}" data-action="toggle-best-plus" title="${bestPricePlusExpanded ? '收起 Plus 详细类目' : '展开 Plus 详细类目'}" aria-label="${bestPricePlusExpanded ? '收起 Plus 详细类目' : '展开 Plus 详细类目'}" aria-expanded="${bestPricePlusExpanded}">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 18 6-6-6-6"></path></svg>
        </button>
      </div>
      ${bestPricePlusExpanded ? `<div class="bp-plus-details">${details.map(([detail, detailLabel]) => renderItem(category, detailLabel, detail, true)).join('')}</div>` : ''}
    </div>`;
  }).join('');
}

function toggleBestPricePlus() {
  bestPricePlusExpanded = !bestPricePlusExpanded;
  localStorage.setItem('bestPricePlusExpanded', String(bestPricePlusExpanded));
  renderBestPrices();
}

const HISTORY_BEST_CATEGORIES = [
  ['plus_未接码', 'GPT Plus 未接码', 'gpt_plus', 'unverified'],
  ['plus_已接码', 'GPT Plus 已接码', 'gpt_plus', 'verified'],
  ['plus_质保', 'GPT Plus 质保', 'gpt_plus', 'warranty'],
  ['gpt_free', 'GPT Free', 'gpt_free'],
  ['gpt_k12', 'GPT K12', 'gpt_k12'],
  ['gpt_team', 'GPT Team', 'gpt_team'],
  ['claude_pro', 'Claude Pro', 'claude_pro'],
  ['claude_max', 'Claude MAX', 'claude_max'],
  ['developer_tools_kiro', 'Kiro', 'developer_tools_kiro'],
];

function matchesHistoricalCategory(product, category) {
  if (!product) return false;
  const definition = HISTORY_BEST_CATEGORIES.find(([key]) => key === category);
  if (!definition) return false;
  const [, , canonicalCategory, plusDetail = 'all'] = definition;
  return matchesCategorySelection(product, canonicalCategory, plusDetail);
}

function visibleHistoryBestCategories() {
  const saved = userPreferences.historyBestVisibleCategories || filterConfig.historyBestVisibleCategories;
  const visible = Array.isArray(saved) ? new Set(saved.map(key => key === 'gptk12' ? 'gpt_k12' : key)) : null;
  return historyBestCategoriesInOrder().filter(([key]) => !visible || visible.has(key));
}

function historyBestCategoriesInOrder() {
  const known = new Map(HISTORY_BEST_CATEGORIES.map(entry => [entry[0], entry]));
  const savedOrder = userPreferences.historyBestCategoryOrder || filterConfig.historyBestCategoryOrder;
  const order = Array.isArray(savedOrder)
    ? savedOrder.map(key => key === 'gptk12' ? 'gpt_k12' : key)
    : HISTORY_BEST_CATEGORIES.map(([key]) => key);
  return [...new Set([...order, ...HISTORY_BEST_CATEGORIES.map(([key]) => key)])]
    .filter(key => known.has(key))
    .map(key => known.get(key));
}

function renderHistoryBestControls() {
  const bar = document.getElementById('catBar');
  if (!bar) return;
  const visible = new Set(visibleHistoryBestCategories().map(([key]) => key));
  const storeLabel = historyBestStoreId ? (storeSummaries.find(store => store.id === historyBestStoreId)?.name || '当前店铺') : '全部店铺';
  bar.innerHTML = `<div class="history-view-toolbar"><button class="history-back-btn" data-action="exit-history-best" title="返回商品列表" aria-label="返回商品列表"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 19-7-7 7-7"></path><path d="M19 12H5"></path></svg></button><span class="history-scope-label">${escapeHtml(storeLabel)}</span></div><div class="cat-bar-row history-category-controls">${historyBestCategoriesInOrder().map(([key, label]) => `<button draggable="true" data-drag-type="history-category" data-category="${escapeHtml(key)}" class="cat-btn history-cat-toggle ${visible.has(key) ? 'active' : ''}" data-action="toggle-history-cat">${label}</button>`).join('')}</div>`;
}

let historyCatDragKey = null;
function historyCatDragStart(event, key) { historyCatDragKey = key; event.dataTransfer.effectAllowed = 'move'; event.currentTarget.classList.add('dragging'); }
function historyCatDragOver(event) { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; }
function historyCatDragEnd() { document.querySelectorAll('.history-cat-toggle.dragging').forEach(el => el.classList.remove('dragging')); historyCatDragKey = null; }
function historyCatDrop(event, targetKey) {
  event.preventDefault();
  if (!historyCatDragKey || historyCatDragKey === targetKey) return;
  const order = historyBestCategoriesInOrder().map(([key]) => key);
  const from = order.indexOf(historyCatDragKey);
  const to = order.indexOf(targetKey);
  if (from < 0 || to < 0) return;
  order.splice(from, 1); order.splice(to, 0, historyCatDragKey);
  userPreferences.historyBestCategoryOrder = order;
  saveUserPreferences();
  renderHistoryBestControls();
  renderHistoricalBestPrices();
}

function exitHistoricalBestView() {
  const storeId = historyBestStoreId;
  historicalBestMode = false;
  historyBestStoreId = '';
  render();
  if (storeId) requestAnimationFrame(() => switchStore(storeId));
}

function toggleHistoryBestCategory(category) {
  const visible = new Set(visibleHistoryBestCategories().map(([key]) => key));
  if (visible.has(category)) {
    if (visible.size <= 1) return;
    visible.delete(category);
  } else visible.add(category);
  userPreferences.historyBestVisibleCategories = HISTORY_BEST_CATEGORIES.map(([key]) => key).filter(key => visible.has(key));
  saveUserPreferences();
  renderHistoryBestControls();
  renderHistoricalBestPrices();
}

async function renderHistoricalBestPrices() {
  const controls = document.getElementById('historyBestControls');
  const canvas = document.getElementById('historyBestChart');
  if (!historicalBestMode && !controls) return;
  if (!historicalBestMode) {
    if (historyBestChart) historyBestChart.destroy();
    historyBestChart = null;
    historyBestCharts.forEach(chart => chart.destroy());
    historyBestCharts = [];
    return;
  }
  if (!historyBestData) {
    try {
      const response = await apiFetch('/api/history/export');
      if (!response.ok) throw new Error('暂无历史数据');
      historyBestData = (await response.json()).priceHistory || {};
    } catch (_) {
      if (historyBestChart) historyBestChart.destroy();
      historyBestChart = null;
      if (canvas) canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height);
      return;
    }
  }
  const products = getAllProducts().filter(product => !historyBestStoreId || product.storeId === historyBestStoreId);
  const productMap = new Map(products.map(product => [product.productKey, product]));
  const datasets = visibleHistoryBestCategories().map(([category, label], index) => {
    const daily = new Map();
    for (const [productKey, entries] of Object.entries(historyBestData)) {
      const product = productMap.get(productKey);
      const categoryMatches = matchesHistoricalCategory(product, category);
      if (!categoryMatches) continue;
      for (const entry of entries || []) {
        const price = Number(entry.price);
        const date = new Date(entry.date);
        const historicalStock = entry.stock === null || entry.stock === undefined ? null : Number(entry.stock);
        // Legacy records have no stock snapshot; keep them visible instead of
        // incorrectly filtering them using the product's current stock.
        if (!(price > 0) || Number.isNaN(date.getTime()) || (historicalStock !== null && !(historicalStock > 0))) continue;
        const hour = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')} ${String(date.getHours()).padStart(2, '0')}:00`;
        daily.set(hour, Math.min(daily.get(hour) ?? Infinity, price));
      }
    }
    const colors = ['#1677ff', '#13c2c2', '#52c41a', '#faad14', '#722ed1', '#eb2f96', '#2f54eb', '#fa541c', '#08979c'];
    return { label, daily, color: colors[index] };
  });
  const labels = [...new Set(datasets.flatMap(dataset => [...dataset.daily.keys()]))].sort();
  const chartHost = document.getElementById('historyBestMainCharts');
  if (!chartHost) return;
  if (historyBestChart) historyBestChart.destroy();
  historyBestCharts.forEach(chart => chart.destroy());
  historyBestCharts = [];
  chartHost.innerHTML = datasets.map((dataset, index) => `<div class="historical-mini-card"><div class="historical-mini-title"><span class="historical-mini-dot" style="background:${dataset.color}"></span>${dataset.label}</div><div class="historical-mini-canvas"><canvas id="historyMiniChart${index}"></canvas></div></div>`).join('');
  const text2 = getComputedStyle(document.body).getPropertyValue('--text2');
  const text3 = getComputedStyle(document.body).getPropertyValue('--text3');
  historyBestCharts = datasets.map((dataset, index) => new globalThis.Chart(document.getElementById(`historyMiniChart${index}`).getContext('2d'), {
    type: 'line',
    data: { labels, datasets: [{ label: dataset.label, data: labels.map(day => dataset.daily.get(day) ?? null), borderColor: dataset.color, backgroundColor: dataset.color, borderWidth: 2.2, pointRadius: 0, pointHoverRadius: 4, tension: .35, spanGaps: true }] },
    options: { responsive: true, maintainAspectRatio: false, interaction: { mode: 'index', intersect: false }, animation: { duration: 450, easing: 'easeOutQuart' }, plugins: { legend: { display: false }, tooltip: { backgroundColor: 'rgba(31, 35, 41, .92)', padding: 8, cornerRadius: 6, callbacks: { label: context => `¥${Number(context.parsed.y).toFixed(2)}` } } }, scales: { x: { display: true, grid: { display: false }, border: { display: false }, ticks: { maxTicksLimit: 8, color: text3, font: { size: 9 }, callback: (value, index) => labels[index] || '' } }, y: { beginAtZero: false, grid: { color: 'rgba(145, 158, 171, .16)' }, border: { display: false }, ticks: { color: text2, padding: 5, maxTicksLimit: 5, callback: value => `¥${Number(value).toFixed(2)}` } } } },
  }))
}

function openHistoricalBestView() {
  historicalBestMode = true;
  historyBestStoreId = activeBrowseStoreId || '';
  markDirty();
  markDirty();
  render();
  renderHistoricalBestPrices();
}

function openHistoricalBestForStore(storeId) {
  historyBestStoreId = storeId;
  historicalBestMode = true;
  activeBrowseStoreId = storeId;
  markDirty();
  render();
  renderHistoricalBestPrices();
}

function openHistoricalBestGlobal() {
  historicalBestMode = true;
  historyBestStoreId = '';
  activeBrowseStoreId = '';
  markDirty();
  render();
  renderHistoricalBestPrices();
}

function selectHistoryBestCategory(category) {
  activeHistoryBestCategory = category;
  historicalBestMode = true;
  activeCatL1 = catL1FromFull(category);
  activeCatL2 = category;
  activeCategory = category;
  render();
  renderHistoricalBestPrices();
}

function goToBestPrice(storeId, category, productId, detail = 'all') {
  closeFilterDrawer();
  activeCatL1 = catL1FromFull(category);
  activeCatL2 = category;
  activeCategory = category;
  if (category === 'gpt_plus' && PLUS_DETAIL_OPTIONS.some(([key]) => key === detail)) {
    activePlusDetail = detail;
    plusDetailsExpanded = true;
    localStorage.setItem('activePlusDetail', detail);
  }
  // Render the focused store's nearby window completely so its product card
  // can be located even when earlier cards consume the normal page limit.
  renderLimit = Math.max(renderLimit, getFilteredProducts().length + 1);
  renderCatBar();
  switchStore(storeId);
  requestAnimationFrame(() => {
    const container = document.getElementById('storesContainer');
    const product = productId
      ? container.querySelector(`.product-card[data-product-id="${CSS.escape(productId)}"]`)
      : null;
    if (!product) return;
    const host = container.getBoundingClientRect();
    const rect = product.getBoundingClientRect();
    container.scrollTo({ top: container.scrollTop + rect.top - host.top - 60, behavior: 'smooth' });
    product.classList.add('product-target');
    setTimeout(() => product.classList.remove('product-target'), 900);
  });
}

function renderStores() {
  const container = document.getElementById('storesContainer');
  const filtered = getFilteredProducts();
  const allIds = visibleStoreSummaries().map(s => s.id);
  const ids = allIds.slice(storeWindowStart, storeWindowEnd + 1);
  if (storeOrder.length) ids.sort((a, b) => { const ai = storeOrder.indexOf(a); const bi = storeOrder.indexOf(b); if (ai === -1 && bi === -1) return 0; if (ai === -1) return 1; if (bi === -1) return -1; return ai - bi; });

  if (!stores.length && !storeSummaries.length) { container.innerHTML = '<div class="empty-state">请添加店铺开始监控</div>'; return; }
  if (!stores.length && storeSummaries.length) { container.innerHTML = '<div class="empty-state">请选择店铺查看商品</div>'; return; }
  if (!ids.length) { container.innerHTML = '<div class="empty-state">无匹配商品</div>'; return; }

  let cardCount = 0;
  let reachedLimit = false;
  const html = ids.map(id => {
    if (reachedLimit) return '';
    const s = stores.find(st => st.id === id);
    if (!s) return '';
    const storeLink = safeUrl(s.url);
    const storeName = storeLink ? `<a class="sc-name sc-store-link" href="${storeLink}" target="_blank" rel="noopener noreferrer" title="打开店铺">${escapeHtml(s.name||s.id)}</a>` : `<span class="sc-name">${escapeHtml(s.name||s.id)}</span>`;
    if (s.status === 'pending') return `<div class="store-card" data-store-id="${escapeHtml(s.id)}">${storeName}<div class="store-loading">正在获取商品数据...</div></div>`;
    if (s.status === 'error') return `<div class="store-card" data-store-id="${escapeHtml(s.id)}">${storeName}<div class="store-error">${escapeHtml(s.error||'获取失败')}</div><div class="sc-actions"><button class="hide-btn" data-action="hide-store" data-store-id="${escapeHtml(s.id)}">隐藏</button><button class="del-btn admin-only" data-action="delete-store" data-store-id="${escapeHtml(s.id)}">删除</button></div></div>`;

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
        ${storeName}
        <span class="sc-time">${formatTime(s.lastUpdated)}</span>
        <span class="sc-meta">${products.length} 个商品</span>
        <div class="sc-actions">
          <button class="ref-btn admin-only" data-action="refresh-store" data-store-id="${escapeHtml(s.id)}">更新</button>
          <button class="history-store-btn" data-action="open-history-store" data-store-id="${escapeHtml(s.id)}" title="查看该店铺历史最低价">历史最低</button>
          <button class="copy-store-btn" data-action="copy-store-link" data-store-url="${escapeHtml(s.url || '')}" title="复制店铺链接">复制链接</button>
          <button class="hide-btn" data-action="hide-store" data-store-id="${escapeHtml(s.id)}">隐藏</button>
          <button class="del-btn admin-only" data-action="delete-store" data-store-id="${escapeHtml(s.id)}">删除</button>
        </div>
      </div>
      <div class="product-grid">${gridItems.join('')}</div>
    </div>`;
  }).join('');
  const hasMore = cardCount >= renderLimit && filtered.length > cardCount;
  container.innerHTML = html + (hasMore ? '<div class="scroll-sentinel"></div>' : '');
  container.querySelectorAll('.product-card').forEach(card => {
    const mid = card.querySelector('.pc-mid');
    const bot = card.querySelector('.pc-bot');
    const trend = bot?.querySelector('.hist-btn');
    const top = card.querySelector('.pc-top');
    if (mid && bot && mid.parentElement !== bot) bot.prepend(mid);
    if (trend && top && trend.parentElement !== top) top.appendChild(trend);
  });
  container.querySelectorAll('.hist-btn').forEach(button => {
    button.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M22 12h-4l-3 9L9 3l-3 9H2"></path></svg>';
    button.setAttribute('aria-label', '查看价格走势');
    button.setAttribute('title', '查看价格走势');
  });
  observeSentinel();
}

async function copyStoreLink(url) {
  if (!url) {
    showToast('店铺链接不可用');
    return;
  }
  try {
    await navigator.clipboard.writeText(url);
  } catch (_) {
    const input = document.createElement('textarea');
    input.value = url;
    input.style.position = 'fixed';
    input.style.opacity = '0';
    document.body.appendChild(input);
    input.select();
    document.execCommand('copy');
    input.remove();
  }
  showToast('店铺链接已复制');
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
  const categoryText = escapeHtml(categoryDisplayLabel(category));
  const categoryClass = safeCssToken(category);
  const price = Number.isFinite(Number(p.price)) ? Number(p.price) : 0;
  const attributeLabels = classificationAttributeLabels(p.classification?.attributes);

  return `<div class="product-card ${inStock ? 'has-stock' : 'no-stock'}" data-price="${price}" data-product-id="${escapeHtml(p.id)}">
    <div class="pc-top">
      <div class="pc-tags">${category !== 'other' ? `<span class="tag tag-${categoryClass}" data-action="edit-label" data-product-key="${escapeHtml(p.productKey)}" data-product-name="${escapeHtml(p.name)}" data-category="${escapeHtml(category)}" data-confidence="${confidence}" title="点击修改分类">${categoryText}</span>` : `<span class="tag tag-other" data-action="edit-label" data-product-key="${escapeHtml(p.productKey)}" data-product-name="${escapeHtml(p.name)}" data-category="其他" data-confidence="0" title="点击添加分类">其他</span>`}${attributeLabels.map(label => `<span class="tag tag-attribute">${escapeHtml(label)}</span>`).join('')}</div>
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

function classificationAttributeLabels(attributes) {
  if (!attributes || typeof attributes !== 'object') return [];
  const labels = {
    unverified: '未接码', verified: '已接码', not_required: '无需接码',
    self_service: '自助开通', ready_account: '成品号', top_up: '代充',
    no_warranty: '无质保', warranty: '有质保', exclusive: '独享', shared: '共享',
    k12: 'K12', higher_education: '高校',
  };
  const ordered = ['verification', 'activation', 'warranty', 'usage', 'qualification'];
  const result = ordered.map(key => labels[attributes[key]]).filter(Boolean);
  if (attributes.warrantyDays) {
    const index = result.indexOf('有质保');
    if (index >= 0) result[index] = `质保${attributes.warrantyDays}天`;
  }
  return result.slice(0, 5);
}

function categoryKey(l1, l2) {
  if (l1 === '其他') return '其他';
  if (l1 === 'gpt' && l2.startsWith('plus_')) return l2;
  if (l1 === 'gpt' && l2 === 'k12') return 'gpt_k12';
  if (l1 === 'sms' && l2 === '接码') return 'sms';
  return `${l1}_${l2}`;
}

function editLabel(productKey, name, currentCat, confidence) {
  const l1 = catL1FromFull(currentCat);
  const l2 = catL2FromFull(currentCat);
  const l1Opts = CAT_L1.map(c => `<option value="${c}" ${c === l1 ? 'selected' : ''}>${c}</option>`).join('');
  const l2List = categoryDefinitionsForParent(l1);
  const l2Opts = l2List.map(item => {
    const full = item.id;
    return `<option value="${escapeHtml(full)}" ${full === currentCat || item.name === l2 ? 'selected' : ''}>${escapeHtml(item.name)}</option>`;
  }).join('');
  const storedClassification = productLabels[productKey]?.classification;
  const currentClassification = storedClassification?.category
    ? storedClassification
    : legacyClassification(productLabels[productKey]?.category || currentCat, name);
  const attributes = currentClassification.attributes || {};
  const attributeSelect = (id, label, options, value) => `<label class="label-attribute-field">${label}<select id="${id}">${options.map(([key, text]) => `<option value="${key}" ${key === (value || 'unknown') ? 'selected' : ''}>${text}</option>`).join('')}</select></label>`;
  const attributeFields = [
    attributeSelect('labelVerification', '接码', [['unknown','未知'],['unverified','未接码'],['verified','已接码'],['not_required','无需接码']], attributes.verification),
    attributeSelect('labelActivation', '开通', [['unknown','未知'],['self_service','自助开通'],['ready_account','成品号'],['top_up','代充'],['invite_link','邀请链接'],['redeem_code','兑换码']], attributes.activation),
    attributeSelect('labelWarranty', '质保', [['unknown','未知'],['warranty','有质保'],['no_warranty','无质保']], attributes.warranty),
    attributeSelect('labelUsage', '使用', [['unknown','未知'],['exclusive','独享'],['shared','共享']], attributes.usage),
    attributeSelect('labelQualification', '资格', [['unknown','未知'],['k12','K12'],['higher_education','高校'],['teacher','教师'],['student','学生'],['enterprise','企业']], attributes.qualification),
  ].join('');
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
    <div class="label-attribute-grid">${attributeFields}</div>
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
  const subs = categoryDefinitionsForParent(l1);
  l2sel.innerHTML = subs.map(item => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.name)}</option>`).join('');
}

const CAT_L1 = ['gpt','claude','gemini','grok','other_ai','developer_tools','sms','email','relay','digital_membership','network_cloud','recharge_life','other','ai_platform','邮箱','号码','社交账号','视频会员','音乐会员','生活券','网盘','阅读会员','QQ会员','云服务','中转额度','教程服务','IP代理','卡密兑换','虚拟卡','开发工具','电商工具','企业服务','反重力','Adobe','修图剪辑','AI平台','其他'];

const CAT_L2_MAP = {
  'other_ai': ['perplexity','poe','midjourney','suno','other'],
  'developer_tools': ['cursor','codex','kiro','copilot','other'],
  'email': ['gmail','outlook','icloud','enterprise','other'],
  'relay': ['api_relay','official_api','web_mirror','shared_gateway','other'],
  'digital_membership': ['video','music','cloud_drive','reading','software','other'],
  'network_cloud': ['proxy','vpn','cloud_server','domain','virtual_card','other'],
  'recharge_life': ['game','platform','redeem_code','ecommerce','coupon','other'],
  'other': ['tutorial','enterprise_service','review','other'],
  'gpt': ['plus','pro','team','k12','free','go','other','plus_已接码','plus_未接码','plus_质保','business','edu','max','image2','cyber','其他'],
  'claude': ['free','pro','max','team','enterprise','other','kiro','其他'],
  'gemini': ['free','ai_pro','ai_ultra','workspace','other','pro年卡','优惠链接','成品号','其他'],
  'grok': ['free','supergrok','other','super_grok','普号','其他'],
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
  'sms': ['sms','number_rental','esim','other','接码','其他'],
  '其他': ['其他'],
};

function catL1FromFull(full) {
  if (!full) return '其他';
  const configured = Array.isArray(filterConfig.categoryDefinitions) ? filterConfig.categoryDefinitions.find(item => item.id === full) : null;
  if (configured) return configured.parent;
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
    '开发工具': 'ai_platform', '卡密兑换': 'ai_platform',
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
  const configured = Array.isArray(filterConfig.categoryDefinitions) ? filterConfig.categoryDefinitions.find(item => item.id === full) : null;
  if (configured) return configured.name;
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
  const l2Opts = categoryDefinitionsForParent(l1).map(item => {
    const full = item.id;
    return `<option value="${escapeHtml(full)}" ${full === currentCat || item.name === l2 ? 'selected' : ''}>${escapeHtml(item.name)}</option>`;
  }).join('');
  const epk = escapeHtml(pk), ename = escapeHtml(name);
  const previous = escapeHtml(currentCat);
  return `<select class="cl2-l1" data-change-action="category-l1" data-product-key="${epk}" data-product-name="${ename}" data-previous-category="${previous}" style="padding:2px 4px;border:1px solid var(--border);border-radius:4px;font-size:11px;background:var(--card-bg);color:var(--text)">${l1Opts}</select>
    <select class="cl2-l2" data-change-action="save-label-settings" data-product-key="${epk}" data-product-name="${ename}" data-previous-category="${previous}" style="padding:2px 4px;border:1px solid var(--border);border-radius:4px;font-size:11px;background:var(--card-bg);color:var(--text)">${l2Opts}</select>`;
}

function onCatL1Change(l1sel, pk, name) {
  const l2sel = l1sel.nextElementSibling;
  const l1 = l1sel.value;
  const subs = categoryDefinitionsForParent(l1);
  const currentFull = l2sel.value;
  const currentL2 = currentFull.startsWith(l1 + '_') ? currentFull.slice(l1.length + 1) : '';
  l2sel.innerHTML = subs.map(item => {
    const full = item.id;
    return `<option value="${escapeHtml(full)}" ${item.name === currentL2 ? 'selected' : ''}>${escapeHtml(item.name)}</option>`;
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
    body: JSON.stringify({ category, name, previousCategory, attributes: {
      verification: document.getElementById('labelVerification')?.value || 'unknown',
      activation: document.getElementById('labelActivation')?.value || 'unknown',
      warranty: document.getElementById('labelWarranty')?.value || 'unknown',
      usage: document.getElementById('labelUsage')?.value || 'unknown',
      qualification: document.getElementById('labelQualification')?.value || 'unknown',
    } }),
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

async function waitForStoreRefresh(id, maxAttempts = 60) {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (_refreshingAll && _stopRefreshAll) throw new Error('已停止全局刷新');
    await new Promise(resolve => setTimeout(resolve, 1000));
    const summary = await (await apiFetch('/api/stores/summary')).json();
    const updated = summary.find(store => store.id === id);
    if (!updated) throw new Error('店铺不存在');
    storeSummaries = summary;
    applyStoreOrder();
    renderStoreList();
    if (updated.status === 'error') throw new Error(updated.error || '店铺刷新失败');
    if (updated.status !== 'pending') {
      await loadStoreWithProducts(id);
      const newLabels = await (await apiFetch('/api/product-labels')).json();
      for (const label of newLabels) productLabels[label.product_key] = label;
      markDirty();
      return updated;
    }
  }
  throw new Error('刷新超时，请稍后查看店铺状态');
}

async function refreshStore(id, silent) {
  if (!id || (_refreshingAll && !silent)) return;
  if (refreshingStores.has(id)) {
    if (_refreshingAll && silent) await waitForStoreRefresh(id);
    return;
  }
  refreshingStores.add(id);
  storeSummaries = storeSummaries.map(store => store.id === id
    ? { ...store, status: 'pending', error: '' }
    : store);
  renderStoreList();
  try {
    await apiFetch(`/api/stores/${id}/refresh`, { method: 'POST' });
    await waitForStoreRefresh(id);
    flashSuccess(id);
    if (!silent) render();
  } catch (error) {
    if (!silent) alert('刷新失败: ' + error.message);
    renderStoreList();
  } finally {
    refreshingStores.delete(id);
    renderStoreList();
  }
}

async function legacyRefreshStore(id, silent) {
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
let _refreshBatchId = '';
let refreshingStores = new Set();
let _storeStatusTimer = null;

function startStoreStatusPolling() {
  clearInterval(_storeStatusTimer);
  _storeStatusTimer = setInterval(async () => {
    if (document.visibilityState === 'hidden') return;
    try {
      const summary = await (await apiFetch('/api/stores/summary')).json();
      const changed = summary.length !== storeSummaries.length || summary.some(next => {
        const prev = storeSummaries.find(store => store.id === next.id);
        return !prev || prev.status !== next.status || prev.lastUpdated !== next.lastUpdated || prev.productCount !== next.productCount;
      });
      if (!changed) return;
      const refreshed = summary.some(next => {
        const prev = storeSummaries.find(store => store.id === next.id);
        return next.status === 'ok' && prev && prev.lastUpdated !== next.lastUpdated;
      });
      const refreshedIds = summary.filter(next => {
        const prev = storeSummaries.find(store => store.id === next.id);
        return next.status === 'ok' && prev && prev.lastUpdated !== next.lastUpdated;
      }).map(store => store.id);
      storeSummaries = summary;
      applyStoreOrder();
      renderStoreList();
      renderActiveStoreCard();
      if (refreshed) {
        for (const id of refreshedIds) await loadStoreWithProducts(id);
        markDirty();
        renderStores();
        renderBestPrices();
      }
    } catch (_) { /* A later poll will retry. */ }
  }, 5000);
}

async function refreshAllStores() {
  if (_refreshingAll) return;
  _refreshingAll = true;
  _stopRefreshAll = false;
  const btn = document.getElementById('refreshAllBtn');
  btn.textContent = '停止刷新';
  btn.disabled = false;
  btn.onclick = stopRefreshAll;
  // 全局刷新遵循当前店铺展示顺序，避免因刷新时间改变用户关注顺序。
  const order = [...storeSummaries].filter(store => !isStoreHidden(store.id));
  try {
    const ids = order.map(store => store.id);
    storeSummaries = storeSummaries.map(store => ids.includes(store.id)
      ? { ...store, status: 'pending', error: '' }
      : store);
    ids.forEach(id => refreshingStores.add(id));
    renderStoreList();
    const response = await apiFetch('/api/stores/refresh-all', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ storeIds: ids }),
    });
    _refreshBatchId = (await response.json()).batchId || '';
    for (const summary of order) {
      if (_stopRefreshAll) break;
      try {
        await waitForStoreRefresh(summary.id);
        flashSuccess(summary.id);
      } catch (error) {
        console.error(`店铺 ${summary.id} 刷新失败:`, error.message);
      }
    }
  } catch (error) {
    showToast('全局刷新失败: ' + error.message);
  } finally {
    refreshingStores.clear();
    finishRefreshAll();
  }
}

async function legacyRefreshAllStores() {
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
  if (_refreshBatchId) {
    apiFetch('/api/stores/refresh-all/cancel', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ batchId: _refreshBatchId }),
    }).catch(() => {});
  }
  const btn = document.getElementById('refreshAllBtn');
  btn.textContent = '正在停止...';
  btn.disabled = true;
}

function finishRefreshAll() {
  refreshingStores.clear();
  _refreshBatchId = '';
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
        cubicInterpolationMode: 'monotone',
        tension: 0.38,
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
