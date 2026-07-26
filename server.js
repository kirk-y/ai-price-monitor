const express = require('express');
const path = require('path');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { scrapeShop, classifyProducts } = require('./scraper');
const { buildFeedbackSuggestions, classifyProduct, validateClassificationConfig } = require('./classification');
const {
  classifyHybridProduct,
  isKnownGptClassification,
  preClassifyProduct,
} = require('./hybrid-classification');
const store = require('./store');
const {
  isLoopbackHost,
  normalizeShopUrl,
  validateCategory,
} = require('./validation');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '127.0.0.1';

const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
const USER_TOKEN = process.env.USER_TOKEN || '';
const JSON_BODY_LIMIT = process.env.JSON_BODY_LIMIT || '100mb';

if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
  throw new Error('PORT 必须是 1 到 65535 之间的整数');
}
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      baseUri: ["'none'"],
      connectSrc: ["'self'"],
      imgSrc: ["'self'", 'data:', 'https:'],
      objectSrc: ["'none'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      upgradeInsecureRequests: null,
    },
  },
  crossOriginEmbedderPolicy: false,
}));

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 1000,
  message: { error: '请求过于频繁，请稍后再试' },
});

const strictLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  message: { error: '操作过于频繁，请稍后再试' },
});

app.use('/api/', apiLimiter);
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json({ limit: JSON_BODY_LIMIT }));

function requestToken(req) {
  const authorization = String(req.headers.authorization || '');
  return String(req.headers['x-auth-token'] || (authorization.startsWith('Bearer ') ? authorization.slice(7) : ''));
}

function isLocalRequest(req) {
  const address = String(req.socket?.remoteAddress || '').replace(/^::ffff:/, '');
  return address === '127.0.0.1' || address === '::1';
}

function requireAuth(req, res, next) {
  const token = requestToken(req);
  const user = store.resolveAuthSession(token);
  if (user) { req.user = user; req.role = user.role; req.authToken = token; return next(); }
  if (ADMIN_TOKEN && token === ADMIN_TOKEN) { req.user = { id: null, username: 'legacy-admin', role: 'admin' }; req.role = 'admin'; return next(); }
  if (USER_TOKEN && token === USER_TOKEN) { req.user = { id: null, username: 'legacy-viewer', role: 'viewer' }; req.role = 'viewer'; return next(); }
  req.user = { id: null, username: '', role: 'viewer', guest: true };
  req.role = 'viewer';
  next();
}

function requireAdmin(req, res, next) {
  if (req.role === 'admin') return next();
  res.status(403).json({ error: '权限不足，需要管理员权限' });
}

function requireOperator(req, res, next) {
  if (req.role === 'admin' || req.role === 'operator') return next();
  res.status(403).json({ error: '权限不足，需要操作员权限' });
}

app.get('/api/auth/status', (req, res) => {
  res.json({ setupRequired: store.getUserCount() === 0 });
});

app.post('/api/auth/bootstrap', requireStrictLimit, (req, res) => {
  try {
    if (!isLocalRequest(req)) return res.status(403).json({ error: '首次管理员只能在服务所在电脑上创建' });
    if (store.getUserCount() > 0) return res.status(409).json({ error: '管理员已经初始化' });
    const user = store.createUser(req.body?.username, req.body?.password, 'admin');
    const session = store.createAuthSession(user.id);
    store.recordAudit(user, 'auth.bootstrap', String(user.id));
    res.status(201).json({ token: session.token, expiresAt: session.expiresAt, user });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.post('/api/auth/login', requireStrictLimit, (req, res) => {
  const user = store.authenticateUser(req.body?.username, req.body?.password);
  if (!user) return res.status(401).json({ error: '用户名或密码错误' });
  const session = store.createAuthSession(user.id);
  store.recordAudit(user, 'auth.login', String(user.id));
  res.json({ token: session.token, expiresAt: session.expiresAt, user });
});

app.use('/api/', requireAuth);

app.use('/api/', (req, res, next) => {
  if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    res.on('finish', () => {
      if (res.statusCode < 400) store.recordAudit(req.user, `${req.method} ${req.route?.path || req.path}`, req.originalUrl);
    });
  }
  next();
});

app.get('/api/auth/role', (req, res) => {
  res.json({ role: req.role, user: req.user });
});

app.get('/api/auth/me', (req, res) => res.json({ user: req.user }));
app.post('/api/auth/logout', (req, res) => {
  if (req.authToken) store.deleteAuthSession(req.authToken);
  res.json({ success: true });
});

app.get('/api/users', requireAdmin, (req, res) => res.json(store.listUsers()));
app.post('/api/users', requireAdmin, requireStrictLimit, (req, res) => {
  try { res.status(201).json(store.createUser(req.body?.username, req.body?.password, req.body?.role)); }
  catch (err) { res.status(400).json({ error: err.message }); }
});
app.put('/api/users/:id', requireAdmin, requireStrictLimit, (req, res) => {
  try { res.json(store.updateUser(req.params.id, req.body || {}, req.user.id)); }
  catch (err) { res.status(400).json({ error: err.message }); }
});
app.delete('/api/users/:id', requireAdmin, requireStrictLimit, (req, res) => {
  try { res.json({ success: store.deleteUser(req.params.id, req.user.id) }); }
  catch (err) { res.status(400).json({ error: err.message }); }
});
app.get('/api/audit-logs', requireAdmin, (req, res) => res.json(store.getAuditLogs(req.query.limit)));
app.get('/api/preferences', (req, res) => res.json(req.user.id ? store.getUserPreferences(req.user.id) : {}));
app.put('/api/preferences', (req, res) => {
  if (!req.user.id) return res.status(403).json({ error: '访客偏好仅保存在当前浏览器' });
  try { res.json(store.updateUserPreferences(req.user.id, req.body)); }
  catch (err) { res.status(400).json({ error: err.message }); }
});

app.post('/api/system/clear-data', requireAdmin, requireStrictLimit, (req, res) => {
  if (req.body?.confirmation !== '清除所有数据') {
    return res.status(400).json({ error: '请输入“清除所有数据”以确认操作' });
  }
  invalidateRefreshQueue();
  const deleted = store.clearSystemData();
  autoRefreshAttempts.clear();
  nextRefreshAt = null;
  res.json({ success: true, deleted });
});

function requireStrictLimit(req, res, next) {
  strictLimiter(req, res, next);
}

function safeDownloadName(value, fallback = 'export') {
  const name = String(value || fallback).replace(/[^\p{L}\p{N}._-]+/gu, '_').slice(0, 100);
  return name || fallback;
}

app.use((err, req, res, next) => {
  if (err?.type === 'entity.too.large') {
    return res.status(413).json({ error: `导入文件过大，当前上限为 ${JSON_BODY_LIMIT}` });
  }
  return next(err);
});

process.on('unhandledRejection', (err) => {
  console.error('未处理的Promise拒绝:', err.message);
});
process.on('uncaughtException', (err) => {
  console.error('未捕获的异常:', err.message);
});

app.get('/api/stores/export', requireAdmin, (req, res) => {
  const data = store.exportAllData();
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', `attachment; filename="ai-price-monitor-${new Date().toISOString().slice(0,10)}.json"`);
  res.json(data);
});

app.post('/api/stores/import', requireAdmin, requireStrictLimit, (req, res) => {
  try {
    store.importAllData(req.body);
    res.json({ success: true });
  } catch (e) {
    res.status(400).json({ error: '导入失败: ' + e.message });
  }
});

app.post('/api/stores/import-single', requireAdmin, requireStrictLimit, (req, res) => {
  try {
    if (!req.body.stores?.length) return res.status(400).json({ error: '数据格式错误，缺少店铺信息' });
    store.importSingleStore(req.body);
    res.json({ success: true, storeId: req.body.stores[0].id });
  } catch (e) {
    res.status(400).json({ error: '导入失败: ' + e.message });
  }
});

app.get('/api/stores', (req, res) => {
  res.json(store.getAllStores());
});

app.get('/api/stores/export-list', (req, res) => {
  const all = store.getAllStores();
  const list = all.map(s => ({ id: s.id, url: s.url, name: s.name || '', addedAt: s.addedAt }));
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', `attachment; filename="stores-list-${new Date().toISOString().slice(0,10)}.json"`);
  res.json(list);
});

app.get('/api/stores/summary', (req, res) => {
  res.json(store.getStoreSummaries());
});

app.post('/api/stores/refresh-all', requireOperator, requireStrictLimit, (req, res) => {
  const requested = Array.isArray(req.body?.storeIds) ? req.body.storeIds : [];
  const byId = new Map(store.getAllStores().map(item => [item.id, item]));
  const storesToRefresh = requested
    .filter(id => typeof id === 'string' && byId.has(id))
    .map(id => byId.get(id));
  if (!storesToRefresh.length) return res.status(400).json({ error: '没有可刷新的店铺' });

  const batchId = `refresh_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  for (const item of storesToRefresh) store.updateStore(item.id, { status: 'pending', error: '' });
  res.json({ status: 'pending', batchId, storeIds: storesToRefresh.map(item => item.id) });

  (async () => {
    for (const item of storesToRefresh) {
      enqueueStoreRefresh(item.id, item.url, 'global', batchId);
    }
  })().catch(error => console.error('全局刷新任务失败:', error.message));
});

app.post('/api/stores/refresh-all/cancel', requireOperator, requireStrictLimit, (req, res) => {
  const batchId = String(req.body?.batchId || '');
  if (!batchId) return res.status(400).json({ error: '缺少刷新批次标识' });
  cancelledRefreshBatches.add(batchId);
  res.json({ success: true, batchId });
});

app.get('/api/stores/:id/export', (req, res) => {
  const data = store.exportStore(req.params.id);
  if (!data) return res.status(404).json({ error: '店铺不存在' });
  const name = safeDownloadName(data.stores[0]?.name || req.params.id, req.params.id);
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', `attachment; filename="${name}-${new Date().toISOString().slice(0,10)}.json"`);
  res.json(data);
});

app.get('/api/stores/:id', (req, res) => {
  const s = store.getStore(req.params.id);
  if (!s) return res.status(404).json({ error: '店铺不存在' });
  res.json(s);
});

app.post('/api/stores', requireOperator, requireStrictLimit, async (req, res) => {
  let shop;
  try {
    shop = normalizeShopUrl(req.body?.url);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  const existing = store.addStore(shop.url);
  if (!existing) {
    return res.status(409).json({ error: '该店铺已存在' });
  }

  store.updateStore(existing.id, { status: 'pending' });
  res.json(store.getStore(existing.id));

  enqueueStoreRefresh(existing.id, shop.url, 'initial');
});

app.post('/api/stores/import-list', requireOperator, requireStrictLimit, (req, res) => {
  try {
    const result = store.importStoreList(req.body?.stores ?? req.body);
    for (const id of result.addedIds) {
      const imported = store.getStore(id);
      if (imported) enqueueStoreRefresh(id, imported.url, 'initial');
    }
    res.json({ success: true, ...result });
  } catch (e) {
    res.status(400).json({ error: '批量导入失败: ' + e.message });
  }
});

app.delete('/api/stores/:id', requireOperator, requireStrictLimit, (req, res) => {
  res.json({ success: store.removeStore(req.params.id) });
});

app.post('/api/stores/:id/refresh', requireOperator, requireStrictLimit, async (req, res) => {
  const s = store.getStore(req.params.id);
  if (!s) return res.status(404).json({ error: '店铺不存在' });

  store.updateStore(s.id, { status: 'pending', error: '' });
  res.json({ status: 'pending' });

  enqueueStoreRefresh(s.id, s.url, 'manual');
});

app.get('/api/products/:storeId/:productId/history', (req, res) => {
  res.json(store.getPriceHistory(`${req.params.storeId}:${req.params.productId}`));
});

app.get('/api/stores/:id/history/export', (req, res) => {
  const data = store.exportStoreHistory(req.params.id);
  if (!data.priceHistory || !Object.keys(data.priceHistory).length) return res.status(404).json({ error: '该店铺暂无历史数据' });
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', `attachment; filename="history-${req.params.id}-${new Date().toISOString().slice(0,10)}.json"`);
  res.json(data);
});

app.post('/api/stores/:id/history/import', requireAdmin, requireStrictLimit, (req, res) => {
  try {
    store.importStoreHistory(req.params.id, req.body);
    res.json({ success: true });
  } catch (e) {
    res.status(400).json({ error: '导入失败: ' + e.message });
  }
});

app.get('/api/history/export', (req, res) => {
  const data = store.exportAllHistory();
  if (!data.priceHistory || !Object.keys(data.priceHistory).length) return res.status(404).json({ error: '暂无历史数据' });
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', `attachment; filename="all-history-${new Date().toISOString().slice(0,10)}.json"`);
  res.json(data);
});

app.post('/api/history/import', requireAdmin, requireStrictLimit, (req, res) => {
  try {
    store.importAllHistory(req.body);
    res.json({ success: true });
  } catch (e) {
    res.status(400).json({ error: '导入失败: ' + e.message });
  }
});

app.get('/api/product-labels', (req, res) => {
  res.json(store.getAllProductLabels());
});

app.get('/api/label-changes', (req, res) => {
  res.json(store.getLabelChanges());
});

app.put('/api/product-labels/:productKey', requireOperator, (req, res) => {
  try {
    const category = validateCategory(req.body?.category);
    const previousCategory = req.body?.previousCategory
      ? validateCategory(req.body.previousCategory)
      : null;
    let result = store.setProductLabel(
      req.params.productKey,
      String(req.body?.name || '').slice(0, 1000),
      category,
      previousCategory,
    );
    if (req.body?.attributes && typeof req.body.attributes === 'object') {
      const attributeResult = store.setProductClassificationAttributes(
        req.params.productKey,
        String(req.body?.name || '').slice(0, 1000),
        req.body.attributes,
      );
      result = { ...result, label: attributeResult.label, attributeChanges: attributeResult.changes };
    }
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/ai-classify', requireOperator, async (req, res) => {
  try {
    const url = String(req.body?.url || '').trim();
    const key = String(req.body?.key || '').trim();
    const model = String(req.body?.model || 'gpt-4o-mini').trim();
    const products = Array.isArray(req.body?.products) ? req.body.products.slice(0, 500) : [];
    const categories = Array.isArray(req.body?.categories) ? req.body.categories : [];
    if (!/^https?:\/\//i.test(url) || !key || !products.length || !categories.length) {
      return res.status(400).json({ error: '大模型配置或商品数据不完整' });
    }
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model,
        temperature: 0,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: `你是商品分类助手。只能从给定分类中选择，必须返回 JSON：{"items":[{"productKey":"...","category":"..."}]}。不得新增分类。分类集合：${categories.join(', ')}` },
          { role: 'user', content: JSON.stringify(products.map(product => ({ productKey: product.productKey, name: product.name, currentCategory: product.category }))) },
        ],
      }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) return res.status(502).json({ error: payload.error?.message || '大模型请求失败' });
    const content = payload.choices?.[0]?.message?.content;
    const parsed = typeof content === 'string' ? JSON.parse(content.replace(/^```json\s*|\s*```$/g, '')) : content;
    const items = Array.isArray(parsed?.items) ? parsed.items.filter(item => item && typeof item.productKey === 'string' && categories.includes(item.category)) : [];
    res.json({ items });
  } catch (error) {
    res.status(502).json({ error: error.message || '大模型分类失败' });
  }
});

app.get('/api/filter-config', (req, res) => {
  const config = store.getFilterConfig();
  if (req.role === 'viewer' && config.aiClassify) {
    res.json({ ...config, aiClassify: { ...config.aiClassify, key: '' } });
    return;
  }
  res.json(config);
});

app.put('/api/filter-config', requireOperator, (req, res) => {
  try {
    res.json(store.updateFilterConfig(req.body));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/classification/config', (req, res) => {
  res.json(store.getClassificationConfig());
});

app.put('/api/classification/config', requireOperator, (req, res) => {
  try {
    res.json(store.updateClassificationConfig(req.body));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

function classificationCandidates(requestedProducts) {
  if (Array.isArray(requestedProducts)) {
    return requestedProducts.slice(0, 5000).map(item => ({
      productKey: String(item?.productKey || '').slice(0, 500),
      name: String(item?.name || '').slice(0, 1000),
      currentCategory: item?.currentCategory ? String(item.currentCategory).slice(0, 80) : null,
    })).filter(item => item.productKey && item.name);
  }
  const labels = new Map(store.getLabeledData().map(label => [label.product_key, label]));
  const products = [];
  for (const shop of store.getAllStores()) {
    for (const product of shop.products || []) {
      const productKey = `${shop.id}:${product.id}`;
      products.push({ productKey, name: product.name, currentCategory: labels.get(productKey)?.category || null });
      if (products.length >= 5000) return products;
    }
  }
  return products;
}

function classifyCandidate(product, config) {
  const baseResult = classifyProduct(product.name, config);
  const knownProduct = isKnownGptClassification(product.currentCategory);
  const pre = preClassifyProduct(product.name);
  if (!knownProduct && !pre.eligible) return baseResult;
  return classifyHybridProduct(product.name, baseResult, { knownProduct });
}

app.post('/api/classification/preview', requireOperator, requireStrictLimit, (req, res) => {
  try {
    const config = req.body?.config
      ? validateClassificationConfig(req.body.config)
      : store.getClassificationConfig();
    const candidates = classificationCandidates(req.body?.products);
    const items = candidates.map(product => ({
      ...product,
      result: classifyCandidate(product, config),
    }));
    const summary = items.reduce((acc, item) => {
      acc.total++;
      if (item.result.needsReview) acc.needsReview++;
      if (item.currentCategory && item.currentCategory === item.result.category) acc.unchanged++;
      else if (item.currentCategory) acc.changed++;
      else acc.unclassified++;
      return acc;
    }, { total: 0, unchanged: 0, changed: 0, unclassified: 0, needsReview: 0 });
    res.json({ summary, items });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/classification/apply', requireOperator, requireStrictLimit, (req, res) => {
  try {
    const config = store.getClassificationConfig();
    const candidates = classificationCandidates(req.body?.products);
    let saved = 0;
    let skipped = 0;
    let needsReview = 0;
    for (const product of candidates) {
      const result = classifyCandidate(product, config);
      if (result.needsReview && req.body?.includeNeedsReview !== true) {
        needsReview++;
        continue;
      }
      const source = result.hybrid?.accepted ? `hybrid-v1-${result.hybrid.source}` : 'rules-v2';
      const outcome = store.saveClassificationResult(product.productKey, product.name, result, source);
      if (outcome.skipped) skipped++; else saved++;
    }
    res.json({ success: true, total: candidates.length, saved, skippedManual: skipped, needsReview });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/classification/feedback', (req, res) => {
  res.json(store.getClassificationFeedback(req.query.limit));
});

app.get('/api/classification/suggestions', (req, res) => {
  const feedback = store.getClassificationFeedback(1000);
  res.json({ suggestions: buildFeedbackSuggestions(feedback) });
});

app.post('/api/classification/feedback', requireOperator, requireStrictLimit, (req, res) => {
  try {
    store.recordClassificationFeedback(
      String(req.body?.productKey || '').slice(0, 500),
      String(req.body?.name || '').slice(0, 1000),
      String(req.body?.dimension || ''),
      req.body?.oldValue ? String(req.body.oldValue).slice(0, 80) : null,
      String(req.body?.newValue || ''),
    );
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/refresh-config', (req, res) => {
  const cfg = store.getRefreshConfig();
  cfg.nextRefreshAt = nextRefreshAt;
  res.json(cfg);
});

app.put('/api/refresh-config', requireAdmin, (req, res) => {
  try {
    res.json(store.updateRefreshConfig(req.body));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/store-order', (req, res) => {
  res.json(store.getStoreOrder());
});

app.put('/api/store-order', requireOperator, (req, res) => {
  try {
    res.json(store.updateStoreOrder(req.body));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

const activeRefreshes = new Map();
const refreshQueue = [];
const queuedRefreshes = new Map();
const cancelledRefreshBatches = new Set();
let refreshQueueRunning = false;
let refreshSequence = 0;
let lastRefreshFinishedAt = 0;
let dataGeneration = 0;

function invalidateRefreshQueue() {
  dataGeneration++;
  while (refreshQueue.length) refreshQueue.shift().resolve();
  queuedRefreshes.clear();
  cancelledRefreshBatches.clear();
  lastRefreshFinishedAt = 0;
}

function queueDelay(min, max) {
  const lo = Number(process.env.REFRESH_STORE_DELAY_MIN || min);
  const hi = Number(process.env.REFRESH_STORE_DELAY_MAX || max);
  return Math.floor(Math.random() * Math.max(1, hi - lo + 1) + lo);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function enqueueStoreRefresh(storeId, url, reason = 'manual', batchId = '') {
  if (activeRefreshes.has(storeId)) return activeRefreshes.get(storeId);
  if (queuedRefreshes.has(storeId)) return queuedRefreshes.get(storeId);

  const priority = reason === 'manual' ? 0 : reason === 'global' ? 10 : 20;
  const task = new Promise((resolve) => {
    refreshQueue.push({ storeId, url, reason, batchId, priority, sequence: refreshSequence++, generation: dataGeneration, resolve });
    refreshQueue.sort((a, b) => a.priority - b.priority || a.sequence - b.sequence);
  });
  queuedRefreshes.set(storeId, task);
  processRefreshQueue();
  return task;
}

async function processRefreshQueue() {
  if (refreshQueueRunning) return;
  refreshQueueRunning = true;
  try {
    while (refreshQueue.length) {
      const job = refreshQueue.shift();
      queuedRefreshes.delete(job.storeId);
      if (job.generation !== dataGeneration) {
        job.resolve();
        continue;
      }
      if (job.batchId && cancelledRefreshBatches.has(job.batchId)) {
        store.updateStore(job.storeId, {
          status: 'error',
          error: '全局刷新已取消，可重新尝试',
        });
        job.resolve();
        continue;
      }
      const sinceLast = Date.now() - lastRefreshFinishedAt;
      const minimumGap = queueDelay(2000, 6000);
      if (lastRefreshFinishedAt && sinceLast < minimumGap) await sleep(minimumGap - sinceLast);
      store.updateStore(job.storeId, { status: 'pending', error: '' });
      await scrapeAndUpdate(job.storeId, job.url, job.generation);
      lastRefreshFinishedAt = Date.now();
      job.resolve();
    }
  } finally {
    refreshQueueRunning = false;
    if (refreshQueue.length) processRefreshQueue();
  }
}

function scrapeAndUpdate(storeId, url, generation = dataGeneration) {
  if (activeRefreshes.has(storeId)) return activeRefreshes.get(storeId);
  const task = (async () => {
    try {
      const result = await scrapeShop(url);
      if (generation !== dataGeneration || !store.getStore(storeId)) return;
      store.updateStore(storeId, {
        name: result.shopName,
        status: 'ok',
        error: '',
        lastUpdated: new Date().toISOString(),
        products: result.products,
      });
      store.recordPrices(storeId, result.products);
      try {
        await classifyProducts(result.products, storeId);
      } catch (err) {
        console.error(`店铺 ${storeId} 分类失败:`, err.message);
      }
    } catch (err) {
      if (generation === dataGeneration && store.getStore(storeId)) {
        store.updateStore(storeId, { status: 'error', error: err.message });
      }
    }
  })();
  activeRefreshes.set(storeId, task);
  task.finally(() => activeRefreshes.delete(storeId));
  return task;
}

function recoverInterruptedRefreshes() {
  for (const item of store.getAllStores()) {
    if (item.status !== 'pending') continue;
    store.updateStore(item.id, {
      status: 'error',
      error: '上次刷新未完成，已恢复，可重新尝试',
    });
  }
}

const server = app.listen(PORT, HOST, () => {
  console.log(`AI价格监控服务已启动: http://${HOST}:${PORT}`);
  recoverInterruptedRefreshes();
  startAutoRefresh();
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`端口 ${PORT} 已被占用，请关闭其他服务或使用其他端口`);
    process.exit(1);
  }
});

let nextRefreshAt = null;
const autoRefreshAttempts = new Map();

function randomBetween(min, max) {
  return Math.floor(Math.random() * (max - min + 1) + min) * 60 * 1000;
}

function scheduleNextRefresh(delay) {
  nextRefreshAt = Date.now() + delay;
  console.log(`下次自动刷新: ${Math.round(delay/60000)} 分钟后`);
  setTimeout(startAutoRefresh, delay);
}

async function startAutoRefresh() {
  nextRefreshAt = null;
  const all = store.getAllStores();
  const cfg = store.getRefreshConfig();
  const thresholdMinutes = cfg.mode === 'fixed'
    ? cfg.fixedMinutes
    : Math.max(1, cfg.minMinutes || 60);
  const thresholdMs = thresholdMinutes * 60 * 1000;
  const now = Date.now();
  const due = all.filter(item => {
    if (!item.url || item.status === 'pending' || queuedRefreshes.has(item.id) || activeRefreshes.has(item.id)) return false;
    const lastAttempt = autoRefreshAttempts.get(item.id) || 0;
    if (lastAttempt && now - lastAttempt < thresholdMs) return false;
    const lastUpdated = item.lastUpdated ? Date.parse(item.lastUpdated) : 0;
    return !lastUpdated || now - lastUpdated >= thresholdMs;
  });

  for (const item of due) autoRefreshAttempts.set(item.id, now);
  // 自动刷新批次仍使用统一队列，逐店执行；手动任务可优先插入。
  await Promise.all(due.map(item => enqueueStoreRefresh(item.id, item.url, 'auto')));

  let delay;
  if (cfg.mode === 'fixed') {
    delay = cfg.fixedMinutes * 60 * 1000;
  } else {
    delay = randomBetween(cfg.minMinutes || 60, cfg.maxMinutes || 360);
  }
  scheduleNextRefresh(delay);
}
