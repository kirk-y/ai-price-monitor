const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { scrapeFocusProducts, scrapeCatalogProducts, classifyProducts } = require('./scraper');
const { clearCollectorData, collectShop: collectShopWithBrowser, closeCollector } = require('./browser-collector');
const { buildFeedbackSuggestions, classifyProduct, validateClassificationConfig } = require('./classification');
const {
  automaticFocusRefreshType,
  buildPlusPriorityScores,
  estimatedRefreshRequests,
  focusRefreshIntervalMinutes,
  pickDueCatalogStore,
} = require('./refresh-priority');
const {
  classifyHybridProduct,
  guardClassificationSubject,
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
app.set('trust proxy', process.env.TRUST_PROXY || 'loopback');

const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
const USER_TOKEN = process.env.USER_TOKEN || '';
const JSON_BODY_LIMIT = process.env.JSON_BODY_LIMIT || '100mb';
const MAX_IMPORT_FILE_BYTES = Number(process.env.MAX_IMPORT_FILE_BYTES || 150 * 1024 * 1024);
const IMPORT_CHUNK_BYTES = 512 * 1024;
const IMPORT_UPLOAD_TTL_MS = 30 * 60 * 1000;
const VISITOR_REFRESH_COOLDOWN_MS = Number(process.env.VISITOR_REFRESH_COOLDOWN_MS || 60 * 1000);
const REFRESH_LOG_PATH = process.env.REFRESH_LOG_PATH
  ? path.resolve(process.env.REFRESH_LOG_PATH)
  : path.join(__dirname, 'data', 'refresh-events.jsonl');
const recentRefreshEvents = [];

function recordRefreshEvent(event, details = {}) {
  const entry = { time: new Date().toISOString(), event, ...details };
  recentRefreshEvents.push(entry);
  if (recentRefreshEvents.length > 100) recentRefreshEvents.shift();
  try {
    fs.mkdirSync(path.dirname(REFRESH_LOG_PATH), { recursive: true });
    if (fs.existsSync(REFRESH_LOG_PATH) && fs.statSync(REFRESH_LOG_PATH).size > 2 * 1024 * 1024) {
      fs.renameSync(REFRESH_LOG_PATH, `${REFRESH_LOG_PATH}.old`);
    }
    fs.appendFileSync(REFRESH_LOG_PATH, JSON.stringify(entry) + os.EOL, 'utf8');
  } catch (error) {
    console.error('写入刷新日志失败:', error.message);
  }
}

try {
  if (fs.existsSync(REFRESH_LOG_PATH)) {
    const lines = fs.readFileSync(REFRESH_LOG_PATH, 'utf8').trim().split(/\r?\n/).slice(-100);
    for (const line of lines) {
      try { recentRefreshEvents.push(JSON.parse(line)); } catch (_) { /* Ignore a partial final line. */ }
    }
  }
} catch (error) {
  console.error('读取刷新日志失败:', error.message);
}

if (!Number.isSafeInteger(MAX_IMPORT_FILE_BYTES) || MAX_IMPORT_FILE_BYTES < IMPORT_CHUNK_BYTES) {
  throw new Error('MAX_IMPORT_FILE_BYTES must be at least 524288');
}
if (!Number.isSafeInteger(VISITOR_REFRESH_COOLDOWN_MS) || VISITOR_REFRESH_COOLDOWN_MS < 10000) {
  throw new Error('VISITOR_REFRESH_COOLDOWN_MS must be at least 10000');
}

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
  skip: req => req.method === 'GET' && ['/bootstrap', '/stores/summary', '/stores-batch'].includes(req.path),
  message: { error: '请求过于频繁，请稍后再试' },
});

const strictLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  message: { error: '操作过于频繁，请稍后再试' },
});

app.use('/api/', apiLimiter);
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders(res, filePath) {
    const name = path.basename(filePath).toLowerCase();
    if (name === 'index.html' || name === 'app.js' || name === 'style.css') {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
    }
  },
}));
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
      const chunkPart = req.path.startsWith('/stores/import/chunk/') && !req.path.endsWith('/finish');
      if (res.statusCode < 400 && !chunkPart) store.recordAudit(req.user, `${req.method} ${req.route?.path || req.path}`, req.originalUrl);
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

const visitorRefreshLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 12,
  skip: req => req.role === 'admin' || req.role === 'operator',
  message: { error: '单店铺更新操作过于频繁，请稍后再试' },
});

app.post('/api/system/clear-data', requireAdmin, requireStrictLimit, async (req, res) => {
  if (req.body?.confirmation !== '清除所有数据') {
    return res.status(400).json({ error: '请输入“清除所有数据”以确认操作' });
  }
  invalidateRefreshQueue();
  try { await clearCollectorData(); }
  catch (error) { return res.status(500).json({ error: `清除浏览器会话失败: ${error.message}` }); }
  const deleted = store.clearSystemData();
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

const importUploads = new Map();

function removeImportUpload(uploadId) {
  const upload = importUploads.get(uploadId);
  if (!upload) return;
  importUploads.delete(uploadId);
  try { fs.unlinkSync(upload.path); } catch (err) { if (err.code !== 'ENOENT') console.error('清理导入临时文件失败:', err.message); }
}

function cleanupExpiredImportUploads() {
  const cutoff = Date.now() - IMPORT_UPLOAD_TTL_MS;
  for (const [uploadId, upload] of importUploads) {
    if (upload.createdAt < cutoff) removeImportUpload(uploadId);
  }
}

function ownedImportUpload(req, res) {
  const uploadId = String(req.params.uploadId || '');
  const upload = importUploads.get(uploadId);
  const owner = req.user.id ? `user:${req.user.id}` : `legacy:${req.user.username}`;
  if (!upload || upload.owner !== owner) {
    res.status(404).json({ error: '导入任务不存在或已过期' });
    return null;
  }
  return upload;
}

app.post('/api/stores/import/chunk/start', requireAdmin, requireStrictLimit, (req, res) => {
  cleanupExpiredImportUploads();
  const size = Number(req.body?.size);
  if (!Number.isSafeInteger(size) || size < 2 || size > MAX_IMPORT_FILE_BYTES) {
    return res.status(400).json({ error: `导入文件大小无效（最大 ${Math.floor(MAX_IMPORT_FILE_BYTES / 1024 / 1024)} MB）` });
  }
  const uploadId = crypto.randomBytes(18).toString('hex');
  const filePath = path.join(os.tmpdir(), `ai-price-monitor-import-${uploadId}.json`);
  fs.writeFileSync(filePath, '');
  importUploads.set(uploadId, {
    path: filePath,
    size,
    received: 0,
    nextIndex: 0,
    createdAt: Date.now(),
    owner: req.user.id ? `user:${req.user.id}` : `legacy:${req.user.username}`,
  });
  res.json({ uploadId, chunkSize: IMPORT_CHUNK_BYTES });
});

app.post('/api/stores/import/chunk/:uploadId/part/:index', requireAdmin,
  express.raw({ type: 'application/octet-stream', limit: IMPORT_CHUNK_BYTES + 1024 }), (req, res) => {
    const upload = ownedImportUpload(req, res);
    if (!upload) return;
    const index = Number(req.params.index);
    const chunk = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    if (!Number.isSafeInteger(index) || index !== upload.nextIndex) {
      return res.status(409).json({ error: `分片顺序错误，期望 ${upload.nextIndex}` });
    }
    if (!chunk.length || chunk.length > IMPORT_CHUNK_BYTES || upload.received + chunk.length > upload.size) {
      removeImportUpload(req.params.uploadId);
      return res.status(400).json({ error: '导入分片大小无效' });
    }
    fs.appendFileSync(upload.path, chunk);
    upload.received += chunk.length;
    upload.nextIndex++;
    res.json({ received: upload.received });
  });

app.post('/api/stores/import/chunk/:uploadId/finish', requireAdmin, requireStrictLimit, (req, res) => {
  const upload = ownedImportUpload(req, res);
  if (!upload) return;
  if (upload.received !== upload.size) {
    return res.status(409).json({ error: `文件尚未上传完成（${upload.received}/${upload.size} 字节）` });
  }
  try {
    const data = JSON.parse(fs.readFileSync(upload.path, 'utf8'));
    store.importAllData(data);
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: '导入失败: ' + err.message });
  } finally {
    removeImportUpload(req.params.uploadId);
  }
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

function compactProductLabels(labels) {
  return labels.map(label => ({
    product_key: label.product_key,
    category: label.category,
    confidence: label.confidence,
    manual: label.manual,
    classification: label.classification ? {
      category: label.classification.category,
      attributes: label.classification.attributes || {},
    } : null,
  }));
}

function buildInitialStorePreviews(storeIds, productLimit = 8) {
  const fullStores = store.getStoresByIds(storeIds);
  const labels = compactProductLabels(store.getProductLabelsForStores(storeIds));
  const labelsByKey = new Map(labels.map(label => [label.product_key, label]));
  const selectedKeys = new Set();
  const stores = fullStores.map(item => {
    const products = (item.products || []).map(product => {
      const productKey = `${item.id}:${product.id}`;
      return { product, productKey, label: labelsByKey.get(productKey) };
    }).filter(entry => {
      const category = entry.label?.classification?.category || entry.label?.category || '';
      return category === 'gpt_plus'
        && !entry.product.refreshUnavailable
        && !(Number(entry.product.plusMissingCount) > 0)
        && entry.product.stock > 0
        && entry.product.price > 0;
    }).sort((a, b) => a.product.price - b.product.price).slice(0, productLimit);
    for (const entry of products) selectedKeys.add(entry.productKey);
    return { ...item, products: products.map(entry => entry.product), partial: true };
  });
  return {
    stores,
    productLabels: labels.filter(label => selectedKeys.has(label.product_key)),
  };
}

app.get('/api/bootstrap', (req, res) => {
  const summaries = store.getStoreSummaries();
  const preferences = req.user.id ? store.getUserPreferences(req.user.id) : {};
  const sharedOrder = store.getStoreOrder();
  const preferredOrder = Array.isArray(preferences.storeOrder) ? preferences.storeOrder : sharedOrder;
  const byId = new Map(summaries.map(item => [item.id, item]));
  const orderedIds = [...new Set([...preferredOrder, ...summaries.map(item => item.id)])].filter(id => byId.has(id));
  const hidden = new Set(Array.isArray(preferences.hiddenStoreIds) ? preferences.hiddenStoreIds : []);
  const initialStoreIds = orderedIds.filter(id => !hidden.has(id)).slice(0, 5);
  const filterConfig = store.getFilterConfig();
  const safeFilterConfig = req.role === 'viewer' && filterConfig.aiClassify
    ? { ...filterConfig, aiClassify: { ...filterConfig.aiClassify, key: '' } }
    : filterConfig;
  const initialCatalog = buildInitialStorePreviews(initialStoreIds);
  res.json({
    filterConfig: safeFilterConfig,
    preferences,
    classificationConfig: store.getClassificationConfig(),
    refreshConfig: { ...store.getRefreshConfig(), nextRefreshAt },
    refreshProvider: refreshProviderStatus(),
    summaries,
    storeOrder: sharedOrder,
    stores: initialCatalog.stores,
    productLabels: initialCatalog.productLabels,
  });
});

app.get('/api/stores-batch', (req, res) => {
  const ids = String(req.query.ids || '').split(',').filter(Boolean).slice(0, 20);
  const knownIds = new Set(store.getStoreSummaries().map(item => item.id));
  if (ids.some(id => !knownIds.has(id))) return res.status(400).json({ error: '店铺参数无效' });
  res.json({
    stores: store.getStoresByIds(ids),
    productLabels: compactProductLabels(store.getProductLabelsForStores(ids)),
  });
});

app.post('/api/stores/refresh-all', requireOperator, requireStrictLimit, (req, res) => {
  const availability = refreshProviderStatus();
  if (!availability.acceptingJobs) {
    res.setHeader('Retry-After', String(Math.max(1, Math.ceil((availability.blockedUntil - Date.now()) / 1000))));
    return res.status(503).json({ error: availability.message, provider: availability });
  }
  if (activeRefreshBatches.size) {
    return res.status(409).json({ error: '已有全局刷新批次正在排队，请等待完成或先停止当前批次' });
  }
  const requested = Array.isArray(req.body?.storeIds) ? req.body.storeIds : [];
  const byId = new Map(store.getAllStores().map(item => [item.id, item]));
  const storesToRefresh = requested
    .filter(id => typeof id === 'string' && byId.has(id))
    .map(id => byId.get(id));
  if (!storesToRefresh.length) return res.status(400).json({ error: '没有可刷新的店铺' });

  const refreshType = ['plus', 'probe', 'full'].includes(req.body?.refreshType) ? req.body.refreshType : 'plus';
  if (refreshType !== 'plus' && req.role !== 'admin') return res.status(403).json({ error: '仅管理员可执行探测或完整扫描' });
  const batchId = `refresh_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  activeRefreshBatches.add(batchId);
  res.json({ status: 'pending', batchId, refreshType, storeIds: storesToRefresh.map(item => item.id) });
  recordRefreshEvent('batch.queued', { batchId, refreshType, stores: storesToRefresh.length, actor: req.user?.username || req.role || 'unknown' });

  (async () => {
    for (const item of storesToRefresh) {
      enqueueStoreRefresh(item.id, item.url, 'global', batchId, refreshType);
    }
    if (!refreshQueue.some(item => item.batchId === batchId)) activeRefreshBatches.delete(batchId);
  })().catch(error => console.error('全局刷新任务失败:', error.message));
});

app.post('/api/stores/refresh-all/cancel', requireOperator, requireStrictLimit, (req, res) => {
  const batchId = String(req.body?.batchId || '');
  if (!batchId) return res.status(400).json({ error: '缺少刷新批次标识' });
  cancelledRefreshBatches.add(batchId);
  activeRefreshBatches.delete(batchId);
  let cancelled = 0;
  for (let index = refreshQueue.length - 1; index >= 0; index--) {
    const job = refreshQueue[index];
    if (job.batchId !== batchId) continue;
    refreshQueue.splice(index, 1);
    queuedRefreshes.delete(job.storeId);
    store.updateStoreRefreshMeta(job.storeId, { refreshState: 'cancelled', refreshError: '任务已取消' });
    job.resolve();
    cancelled++;
  }
  res.json({ success: true, batchId, cancelled });
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

const visitorStoreRefreshes = new Map();

app.post('/api/stores/:id/refresh', visitorRefreshLimiter, async (req, res) => {
  const s = store.getStore(req.params.id);
  if (!s) return res.status(404).json({ error: '店铺不存在' });

  const availability = refreshProviderStatus();
  if (!availability.acceptingJobs) {
    res.setHeader('Retry-After', String(Math.max(1, Math.ceil((availability.blockedUntil - Date.now()) / 1000))));
    return res.status(503).json({ error: availability.message, provider: availability });
  }

  const privileged = req.role === 'admin' || req.role === 'operator';
  if (!privileged) {
    const now = Date.now();
    const lastAccepted = visitorStoreRefreshes.get(s.id) || 0;
    const lastUpdated = s.lastUpdated ? Date.parse(s.lastUpdated) : 0;
    const reference = Math.max(lastAccepted, Number.isFinite(lastUpdated) ? lastUpdated : 0);
    const remainingMs = VISITOR_REFRESH_COOLDOWN_MS - (now - reference);
    if (remainingMs > 0 && s.status !== 'pending') {
      const retryAfter = Math.max(1, Math.ceil(remainingMs / 1000));
      res.setHeader('Retry-After', String(retryAfter));
      return res.status(429).json({ error: `该店铺刚更新过，请 ${retryAfter} 秒后再试`, retryAfter });
    }
    if (s.status !== 'pending') visitorStoreRefreshes.set(s.id, now);
  }

  const reused = activeRefreshes.has(s.id) || queuedRefreshes.has(s.id);
  enqueueStoreRefresh(s.id, s.url, privileged ? 'manual' : 'visitor', '', 'plus');
  res.json({ status: 'queued', reused });
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
  if (!knownProduct && !pre.eligible) return guardClassificationSubject(baseResult, pre);
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
      const source = result.hybrid?.accepted ? `hybrid-v2-${result.hybrid.source}` : 'rules-v3';
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

app.get('/api/refresh-status', (req, res) => {
  pruneRecentRequests();
  const cfg = store.getRefreshConfig();
  const provider = refreshProviderStatus();
  res.json({
    queueLength: refreshQueue.length,
    active: [...activeRefreshes.keys()],
    activeBatchCount: activeRefreshBatches.size,
    nextRefreshAt,
    riskCooldownUntil: provider.blockedUntil,
    riskFailures,
    hourlyRequests: recentRequests.length,
    hourlyRequestLimit: cfg.hourlyRequestLimit,
    mode: cfg.mode,
    provider,
    recentEvents: recentRefreshEvents.slice(-20).reverse(),
  });
});

app.post('/api/refresh-budget/reset', requireAdmin, requireStrictLimit, (req, res) => {
  const cleared = recentRequests.length;
  recentRequests.splice(0, recentRequests.length);
  store.updateRefreshRuntimeState({ requestTimestamps: [] });
  recordRefreshEvent('budget.reset', {
    cleared,
    actor: req.user?.username || 'admin',
  });
  store.recordAudit(req.user, 'refresh.budget.reset', 'refresh-budget', JSON.stringify({ cleared }));
  res.json({ success: true, cleared, hourlyRequests: 0 });
});

app.put('/api/refresh-config', requireAdmin, (req, res) => {
  try {
    const config = store.updateRefreshConfig(req.body);
    resetAutoRefreshSchedule(config);
    res.json({ ...config, nextRefreshAt });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/refresh-proxy-config', requireAdmin, (req, res) => {
  const config = store.getRefreshProxyConfig();
  res.json({ enabled: config.enabled, configured: Boolean(config.proxyUrl) });
});

app.put('/api/refresh-proxy-config', requireAdmin, (req, res) => {
  try {
    const config = store.updateRefreshProxyConfig(req.body);
    res.json({ enabled: config.enabled, configured: Boolean(config.proxyUrl) });
  } catch (error) {
    res.status(400).json({ error: error.message });
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
const activeRefreshBatches = new Set();
let refreshQueueRunning = false;
let refreshSequence = 0;
let lastRefreshFinishedAt = 0;
let wakeQueueWait = null;
let dataGeneration = 0;
let riskFailures = 0;
const recentRequests = store.getRefreshRuntimeState().requestTimestamps.filter(timestamp => timestamp > Date.now() - 3600000);

function pruneRecentRequests() {
  const cutoff = Date.now() - 3600000;
  let changed = false;
  while (recentRequests.length && recentRequests[0] <= cutoff) {
    recentRequests.shift();
    changed = true;
  }
  if (changed) store.updateRefreshRuntimeState({ requestTimestamps: recentRequests });
}

function refreshProviderStatus() {
  const runtime = store.getRefreshRuntimeState();
  const blocked = runtime.circuitState === 'open' && runtime.blockedUntil > Date.now();
  return {
    state: blocked ? 'blocked' : runtime.circuitState === 'open' ? 'probe-ready' : 'healthy',
    acceptingJobs: !blocked,
    blockedUntil: blocked ? runtime.blockedUntil : 0,
    lastErrorCode: runtime.lastErrorCode,
    lastError: runtime.lastError,
    lastErrorAt: runtime.lastErrorAt,
    preferredRoute: runtime.preferredRoute,
    routeVerifiedAt: runtime.routeVerifiedAt,
    message: blocked
      ? `采集通道已熔断，请在 ${new Date(runtime.blockedUntil).toLocaleTimeString()} 后重试`
      : runtime.circuitState === 'open' ? '采集通道等待一次恢复探测' : '采集通道正常',
  };
}

function openRefreshCircuit(error) {
  const cfg = store.getRefreshConfig();
  riskFailures = Math.max(riskFailures, cfg.riskThreshold);
  const blockedUntil = Date.now() + cfg.riskCooldownMinutes * 60000;
  store.updateRefreshRuntimeState({
    circuitState: 'open',
    blockedUntil,
    lastErrorCode: error.code || 'UPSTREAM_UNAVAILABLE',
    lastError: error.message,
    lastErrorAt: new Date().toISOString(),
  });
}

function closeRefreshCircuit(preferredRoute = '') {
  riskFailures = 0;
  store.updateRefreshRuntimeState({
    circuitState: 'closed',
    blockedUntil: 0,
    ...(preferredRoute ? { preferredRoute, routeVerifiedAt: new Date().toISOString() } : {}),
  });
}

function invalidateRefreshQueue() {
  dataGeneration++;
  while (refreshQueue.length) refreshQueue.shift().resolve();
  queuedRefreshes.clear();
  cancelledRefreshBatches.clear();
  activeRefreshBatches.clear();
  wakeQueueWait?.();
  lastRefreshFinishedAt = 0;
  riskFailures = 0;
}

function queueDelay(min, max) {
  const lo = Number(process.env.REFRESH_STORE_DELAY_MIN || min);
  const hi = Number(process.env.REFRESH_STORE_DELAY_MAX || max);
  return Math.floor(Math.random() * Math.max(1, hi - lo + 1) + lo);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function waitForQueueDelay(ms) {
  if (ms <= 0) return Promise.resolve();
  return new Promise(resolve => {
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (wakeQueueWait === finish) wakeQueueWait = null;
      resolve();
    };
    const timer = setTimeout(finish, ms);
    wakeQueueWait = finish;
  });
}

function refreshJobDelay(job, config) {
  return queueDelay(config.requestDelayMinSeconds * 1000, config.requestDelayMaxSeconds * 1000);
}

function consumeRequestBudget() {
  pruneRecentRequests();
  if (recentRequests.length >= store.getRefreshConfig().hourlyRequestLimit) {
    const error = new Error('已达到每小时请求预算，请稍后重试');
    error.code = 'REQUEST_BUDGET_EXHAUSTED';
    throw error;
  }
  recentRequests.push(Date.now());
  store.updateRefreshRuntimeState({ requestTimestamps: recentRequests });
}

function refreshBudgetWaitMs(requiredRequests, config = store.getRefreshConfig()) {
  pruneRecentRequests();
  const required = Math.max(1, requiredRequests);
  if (required > config.hourlyRequestLimit) return -1;
  const overflow = recentRequests.length + required - config.hourlyRequestLimit;
  if (overflow <= 0) return 0;
  return Math.max(1000, recentRequests[Math.min(overflow - 1, recentRequests.length - 1)] + 3600000 - Date.now());
}

function enqueueStoreRefresh(storeId, url, reason = 'manual', batchId = '', refreshType = 'plus') {
  if (activeRefreshes.has(storeId)) return activeRefreshes.get(storeId);
  if (queuedRefreshes.has(storeId)) {
    if (reason === 'manual' || reason === 'visitor') {
      const queued = refreshQueue.find(job => job.storeId === storeId);
      const promotedPriority = reason === 'manual' ? 0 : 5;
      if (queued && queued.priority > promotedPriority) {
        queued.sourceBatchId = queued.sourceBatchId || queued.batchId || '';
        queued.priority = promotedPriority;
        queued.reason = reason;
        queued.batchId = '';
        queued.refreshType = 'plus';
        queued.sequence = refreshSequence++;
        refreshQueue.sort((a, b) => a.priority - b.priority || a.sequence - b.sequence);
        wakeQueueWait?.();
      }
    }
    return queuedRefreshes.get(storeId);
  }

  const priority = reason === 'manual' ? 0 : reason === 'visitor' ? 5 : reason === 'global' ? 10 : 20;
  const task = new Promise((resolve) => {
    refreshQueue.push({ storeId, url, reason, batchId, sourceBatchId: '', refreshType, priority, sequence: refreshSequence++, generation: dataGeneration, queuedAt: Date.now(), resolve });
    refreshQueue.sort((a, b) => a.priority - b.priority || a.sequence - b.sequence);
  });
  queuedRefreshes.set(storeId, task);
  store.updateStoreRefreshMeta(storeId, {
    refreshState: 'queued',
    refreshError: '',
    queuedAt: new Date().toISOString(),
  });
  if (reason === 'manual' || reason === 'visitor') wakeQueueWait?.();
  processRefreshQueue();
  return task;
}

function cancelQueuedRefreshesAfterChallenge(batchId) {
  let cancelled = 0;
  if (batchId) {
    cancelledRefreshBatches.add(batchId);
    activeRefreshBatches.delete(batchId);
  }
  for (let index = refreshQueue.length - 1; index >= 0; index--) {
    const queued = refreshQueue[index];
    if (queued.reason !== 'auto' && (!batchId || queued.batchId !== batchId)) continue;
    refreshQueue.splice(index, 1);
    queuedRefreshes.delete(queued.storeId);
    store.updateStoreRefreshMeta(queued.storeId, {
      refreshState: 'cancelled',
      refreshError: '采集通道不可用，本次任务未执行',
    });
    queued.resolve();
    cancelled++;
  }
  recordRefreshEvent('queue.cancelled-by-challenge', { batchId, cancelled });
}

function finishRefreshBatchIfDrained(job) {
  const batchId = job.batchId || job.sourceBatchId;
  if (batchId && !refreshQueue.some(item => item.batchId === batchId || item.sourceBatchId === batchId)) {
    activeRefreshBatches.delete(batchId);
  }
}

async function processRefreshQueue() {
  if (refreshQueueRunning) return;
  refreshQueueRunning = true;
  try {
    while (refreshQueue.length) {
      const job = refreshQueue.shift();
      if (job.generation !== dataGeneration) {
        queuedRefreshes.delete(job.storeId);
        job.resolve();
        continue;
      }
      if (job.batchId && cancelledRefreshBatches.has(job.batchId)) {
        queuedRefreshes.delete(job.storeId);
        store.updateStoreRefreshMeta(job.storeId, { refreshState: 'cancelled', refreshError: '任务已取消' });
        recordRefreshEvent('store.cancelled', { storeId: job.storeId, refreshType: job.refreshType, batchId: job.batchId });
        job.resolve();
        continue;
      }
      const config = store.getRefreshConfig();
      const availability = refreshProviderStatus();
      if (!availability.acceptingJobs) {
        queuedRefreshes.delete(job.storeId);
        store.updateStoreRefreshMeta(job.storeId, { refreshState: 'cancelled', refreshError: availability.message });
        recordRefreshEvent('store.skipped', { storeId: job.storeId, refreshType: job.refreshType, reason: availability.message });
        job.resolve();
        cancelQueuedRefreshesAfterChallenge(job.batchId);
        continue;
      }
      pruneRecentRequests();
      if (recentRequests.length >= config.hourlyRequestLimit) {
        queuedRefreshes.delete(job.storeId);
        const error = '已达到每小时请求预算，请稍后重试';
        store.updateStoreRefreshMeta(job.storeId, { refreshState: 'cancelled', refreshError: error });
        recordRefreshEvent('store.skipped', { storeId: job.storeId, refreshType: job.refreshType, reason: error });
        job.resolve();
        finishRefreshBatchIfDrained(job);
        continue;
      }
      const sinceLast = Date.now() - lastRefreshFinishedAt;
      const minimumGap = job.reason === 'manual' || job.reason === 'visitor' ? 0 : refreshJobDelay(job, config);
      if (lastRefreshFinishedAt && sinceLast < minimumGap) {
        await waitForQueueDelay(minimumGap - sinceLast);
        if (job.priority > 0 && refreshQueue.some(item => item.priority < job.priority)) {
          refreshQueue.push(job);
          refreshQueue.sort((a, b) => a.priority - b.priority || a.sequence - b.sequence);
          continue;
        }
      }
      queuedRefreshes.delete(job.storeId);
      store.updateStoreRefreshMeta(job.storeId, {
        refreshState: 'refreshing',
        refreshError: '',
        lastAttemptAt: new Date().toISOString(),
        ...(job.refreshType === 'full' ? { lastCatalogAttemptAt: new Date().toISOString() } : {}),
      });
      recordRefreshEvent('store.started', {
        storeId: job.storeId,
        refreshType: job.refreshType,
        reason: job.reason,
        queueWaitMs: Date.now() - job.queuedAt,
      });
      const result = await scrapeAndUpdate(job.storeId, job.url, job.generation, job.refreshType);
      lastRefreshFinishedAt = Date.now();
      job.resolve();
      if (['UPSTREAM_CHALLENGE', 'UPSTREAM_UNAVAILABLE', 'BROWSER_UNAVAILABLE'].includes(result?.code)) {
        cancelQueuedRefreshesAfterChallenge(job.batchId || job.sourceBatchId);
      } else {
        finishRefreshBatchIfDrained(job);
      }
    }
  } finally {
    refreshQueueRunning = false;
    if (refreshQueue.length) processRefreshQueue();
  }
}

async function collectStoreProducts(current, url, refreshType, preferredTypes, requestOptions) {
  const config = store.getRefreshConfig();
  const runtime = store.getRefreshRuntimeState();
  const browserPreferred = config.collectorMode === 'browser'
    || (config.collectorMode === 'auto' && (
      current?.refreshMeta?.collectorRoute === 'browser' || runtime.preferredRoute === 'browser'
    ));
  const directCollect = () => refreshType === 'full'
    ? scrapeCatalogProducts(url, consumeRequestBudget, requestOptions)
    : scrapeFocusProducts(url, preferredTypes, consumeRequestBudget, requestOptions);
  const browserCollect = () => collectShopWithBrowser(url, {
    refreshType,
    preferredTypes,
    proxyUrl: requestOptions.proxyUrl,
    beforeAttempt: consumeRequestBudget,
    includeInfo: refreshType === 'full' || current?.status === 'pending',
  });

  if (config.collectorMode === 'browser') return browserCollect();
  if (browserPreferred) {
    try { return await browserCollect(); }
    catch (error) {
      if (error.code !== 'BROWSER_UNAVAILABLE') throw error;
      return directCollect();
    }
  }
  try {
    return await directCollect();
  } catch (directError) {
    if (config.collectorMode !== 'auto' || directError.code !== 'UPSTREAM_CHALLENGE') throw directError;
    try {
      return await browserCollect();
    } catch (browserError) {
      if (browserError.code === 'UPSTREAM_CHALLENGE' || browserError.code === 'UPSTREAM_RATE_LIMIT') throw browserError;
      const error = new Error(`直连触发验证，浏览器采集也不可用: ${browserError.message}`);
      error.code = 'UPSTREAM_UNAVAILABLE';
      throw error;
    }
  }
}

function scrapeAndUpdate(storeId, url, generation = dataGeneration, refreshType = 'plus') {
  if (activeRefreshes.has(storeId)) return activeRefreshes.get(storeId);
  const task = (async () => {
    const scrapeStartedAt = Date.now();
    try {
      const current = store.getStore(storeId);
      const proxyConfig = store.getRefreshProxyConfig();
      const requestOptions = {
        proxyMode: proxyConfig.enabled ? 'on_challenge' : 'never',
        proxyUrl: proxyConfig.enabled ? proxyConfig.proxyUrl : '',
      };
      const preferredTypes = refreshType === 'probe'
        ? []
        : ((current?.refreshMeta?.focusGoodsTypes || current?.refreshMeta?.plusGoodsTypes || []).length
          ? (current.refreshMeta.focusGoodsTypes || current.refreshMeta.plusGoodsTypes)
          : ['card']);
      const result = await collectStoreProducts(current, url, refreshType, preferredTypes, requestOptions);
      if (generation !== dataGeneration || !store.getStore(storeId)) return;
      if (refreshType === 'full') {
        const refreshedAt = new Date().toISOString();
        store.updateStore(storeId, {
          status: 'pending', error: '', lastUpdated: refreshedAt, products: result.products,
          refreshMeta: { ...(current?.refreshMeta || {}), lastCatalogRefreshAt: refreshedAt, lastTypeProbeAt: refreshedAt },
        });
      } else {
        store.mergeFocusedProducts(storeId, result.products, {
          focusGoodsTypes: result.goodsTypes,
          plusGoodsTypes: result.goodsTypes,
          lastTypeProbeAt: result.probed ? new Date().toISOString() : current?.refreshMeta?.lastTypeProbeAt,
          plusStatus: 'ok', plusError: '', collectorRoute: result.requestRoute,
        });
      }
      store.recordPrices(storeId, result.products);
      try {
        await classifyProducts(result.products, storeId);
      } catch (err) {
        console.error(`店铺 ${storeId} 分类失败:`, err.message);
      }
      if (generation === dataGeneration && store.getStore(storeId)) {
        const successAt = new Date().toISOString();
        store.updateStore(storeId, { status: 'ok', error: '', ...(result.shopName ? { name: result.shopName } : {}) });
        store.updateStoreRefreshMeta(storeId, {
          refreshState: 'succeeded',
          refreshError: '',
          lastSuccessAt: successAt,
          collectorRoute: result.requestRoute,
        });
      }
      recordRefreshEvent('store.succeeded', { storeId, refreshType, products: result.products.length, requestRoute: result.requestRoute, durationMs: Date.now() - scrapeStartedAt, requestsThisHour: recentRequests.length });
      closeRefreshCircuit(result.requestRoute);
      return { ok: true };
    } catch (err) {
      if (['UPSTREAM_CHALLENGE', 'UPSTREAM_UNAVAILABLE', 'BROWSER_UNAVAILABLE'].includes(err.code)) {
        openRefreshCircuit(err);
      } else if (err.code === 'UPSTREAM_RATE_LIMIT') {
        riskFailures++;
        const cfg = store.getRefreshConfig();
        if (riskFailures >= cfg.riskThreshold) openRefreshCircuit(err);
      } else riskFailures = 0;
      if (generation === dataGeneration && store.getStore(storeId)) {
        store.updateStore(storeId, { status: 'error', error: err.message });
        store.updateStoreRefreshMeta(storeId, {
          refreshState: 'failed',
          refreshError: err.message,
        });
      }
      recordRefreshEvent('store.failed', { storeId, refreshType, code: err.code || '', error: err.message, durationMs: Date.now() - scrapeStartedAt });
      return { ok: false, code: err.code || '', error: err.message };
    }
  })();
  activeRefreshes.set(storeId, task);
  task.finally(() => activeRefreshes.delete(storeId));
  return task;
}

function recoverInterruptedRefreshes() {
  for (const item of store.getAllStores()) {
    if (item.status === 'error' && /page\.evaluate:[\s\S]*Failed to fetch/i.test(item.error || item.refreshMeta?.refreshError || '')) {
      store.updateStore(item.id, { status: 'ok', error: '' });
      store.updateStoreRefreshMeta(item.id, {
        refreshState: 'idle',
        refreshError: '',
        lastAttemptAt: null,
      });
      continue;
    }
    if (item.refreshMeta?.refreshState !== 'queued' && item.refreshMeta?.refreshState !== 'refreshing') continue;
    store.updateStoreRefreshMeta(item.id, {
      refreshState: 'cancelled',
      refreshError: '服务重启，上次刷新任务已取消',
    });
  }
}

const server = app.listen(PORT, HOST, () => {
  console.log(`AI价格监控服务已启动: http://${HOST}:${PORT}`);
  recoverInterruptedRefreshes();
  resetAutoRefreshSchedule(store.getRefreshConfig(), { immediate: process.env.AUTO_REFRESH_IMMEDIATE === 'true' });
});

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  clearTimeout(autoRefreshTimer);
  invalidateRefreshQueue();
  await closeCollector().catch(() => {});
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000).unref();
}

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`端口 ${PORT} 已被占用，请关闭其他服务或使用其他端口`);
    process.exit(1);
  }
});

let nextRefreshAt = null;
let autoRefreshTimer = null;
let autoRefreshScheduleVersion = 0;

function cancelQueuedAutoRefreshes() {
  for (let index = refreshQueue.length - 1; index >= 0; index--) {
    const job = refreshQueue[index];
    if (job.reason !== 'auto') continue;
    refreshQueue.splice(index, 1);
    queuedRefreshes.delete(job.storeId);
    job.resolve();
  }
}

function autoRefreshSlotDelay(config, storeCount) {
  const cycleMs = Math.max(5, Number(config.plusCycleMinutes) || 60) * 60000;
  const slotMs = Math.max(30000, cycleMs / Math.max(1, storeCount));
  return Math.round(slotMs * (0.85 + Math.random() * 0.3));
}

function resetAutoRefreshSchedule(config, { immediate = false } = {}) {
  autoRefreshScheduleVersion++;
  clearTimeout(autoRefreshTimer);
  autoRefreshTimer = null;
  nextRefreshAt = null;
  if (config.mode === 'disabled') {
    cancelQueuedAutoRefreshes();
    console.log('自动刷新已停止');
    return;
  }
  if (immediate) startAutoRefresh(autoRefreshScheduleVersion);
  else scheduleNextRefresh(autoRefreshSlotDelay(config, store.getStoreSummaries().length), autoRefreshScheduleVersion);
}

function scheduleNextRefresh(delay, version = autoRefreshScheduleVersion) {
  clearTimeout(autoRefreshTimer);
  nextRefreshAt = Date.now() + delay;
  console.log(`下次自动刷新: ${Math.round(delay/60000)} 分钟后`);
  autoRefreshTimer = setTimeout(() => startAutoRefresh(version), delay);
}

function isGptPlusProduct(item, product, labels) {
  const label = labels.get(`${item.id}:${product.id}`);
  const category = label?.classification?.category || label?.category || '';
  if (label?.manual) return /^(?:gpt_plus|plus_)/i.test(category);
  if (/^(?:gpt_plus|plus_)/i.test(category)) return true;
  const name = String(product.name || '');
  return /(?:chat\s*gpt|gpt)\s*plus\b|gptplus/i.test(name)
    && !/\b(?:pro|team|business|k12|free)\b/i.test(name);
}

function isGptK12Product(item, product, labels) {
  const label = labels.get(`${item.id}:${product.id}`);
  const category = label?.classification?.category || label?.category || '';
  if (/^(?:gpt_k12|gptk12)$/i.test(category)) return true;
  return /(?:chat\s*gpt|gpt).*?(?:k12|edu)|\bk12\b/i.test(String(product.name || ''));
}

function buildFocusPriority(all) {
  const labels = new Map(store.getAllProductLabels().map(label => [label.product_key, label]));
  const snapshotsFor = predicate => all.map(item => {
    const current = (item.products || [])
      .filter(product => predicate(item, product, labels) && Number(product.price) > 0)
      .sort((a, b) => Number(a.price) - Number(b.price))
      .slice(0, 5)
      .map(product => ({ key: `${item.id}:${product.id}`, price: Number(product.price), stock: Number(product.stock) }));
    return { id: item.id, current, keys: current.map(product => product.key) };
  });
  const plusSnapshots = snapshotsFor(isGptPlusProduct);
  const k12Snapshots = snapshotsFor(isGptK12Product);
  const keys = [...new Set([...plusSnapshots, ...k12Snapshots].flatMap(item => item.keys))];
  const history = store.getPriceHistoryForProducts(keys, Date.now() - 7 * 24 * 60 * 60 * 1000);
  const plusPriority = buildPlusPriorityScores(plusSnapshots, history, 10);
  const k12Priority = buildPlusPriorityScores(k12Snapshots, history, 10);
  const tierRank = { A: 0, B: 1, C: 2 };
  return new Map(all.map(item => {
    const plus = plusPriority.get(item.id);
    const k12 = k12Priority.get(item.id);
    const tier = tierRank[plus.tier] <= tierRank[k12.tier] ? plus.tier : k12.tier;
    return [item.id, { tier, score: Math.max(plus.score, k12.score), plus, k12 }];
  }));
}

function startAutoRefresh(version = autoRefreshScheduleVersion) {
  if (version !== autoRefreshScheduleVersion) return;
  nextRefreshAt = null;
  const all = store.getAllStores();
  const cfg = store.getRefreshConfig();
  if (cfg.mode === 'disabled') return;
  const availability = refreshProviderStatus();
  if (!availability.acceptingJobs) {
    const waitMs = Math.max(autoRefreshSlotDelay(cfg, all.length), availability.blockedUntil - Date.now());
    recordRefreshEvent('auto.skipped', { reason: availability.message, waitMs });
    scheduleNextRefresh(waitMs, version);
    return;
  }
  const priority = buildFocusPriority(all);
  const now = Date.now();
  const eligible = all.filter(item => item.url && item.status !== 'pending' && !queuedRefreshes.has(item.id) && !activeRefreshes.has(item.id));
  const due = eligible.map((item, index) => {
    const thresholdMs = focusRefreshIntervalMinutes(item, priority.get(item.id), cfg.plusCycleMinutes) * 60 * 1000;
    const lastAttempt = Date.parse(item.refreshMeta?.lastAttemptAt || item.lastUpdated || 0) || 0;
    const age = lastAttempt ? now - lastAttempt : Infinity;
    return age >= thresholdMs ? { item, index, urgency: age / thresholdMs } : false;
  }).filter(Boolean).sort((a, b) => (b.urgency - a.urgency) || (a.index - b.index));

  // 每个时间槽最多加入一家店铺，避免服务重启或到点后形成请求峰值。
  if (!refreshQueue.length && !activeRefreshes.size) {
    const urgentPlus = due.find(candidate => priority.get(candidate.item.id)?.tier === 'A' && candidate.urgency >= 1.25);
    const catalogStore = pickDueCatalogStore(eligible.filter(item => item.status === 'ok'), cfg.catalogRefreshHours, now);
    const selected = urgentPlus?.item || due[0]?.item || catalogStore;
    if (selected) {
      const refreshType = selected === catalogStore ? 'full' : automaticFocusRefreshType(selected);
      const budgetWaitMs = refreshBudgetWaitMs(estimatedRefreshRequests(selected, refreshType), cfg);
      if (budgetWaitMs !== 0) {
        const waitMs = budgetWaitMs < 0 ? autoRefreshSlotDelay(cfg, all.length) : budgetWaitMs;
        const reason = budgetWaitMs < 0 ? '小时请求上限低于单次任务所需预算' : '小时请求预算不足';
        recordRefreshEvent('auto.skipped', { reason, waitMs });
        scheduleNextRefresh(Math.max(autoRefreshSlotDelay(cfg, all.length), waitMs), version);
        return;
      }
      enqueueStoreRefresh(selected.id, selected.url, 'auto', '', refreshType);
    }
  }

  if (version !== autoRefreshScheduleVersion) return;
  const latestConfig = store.getRefreshConfig();
  if (latestConfig.mode === 'disabled') return;
  scheduleNextRefresh(autoRefreshSlotDelay(latestConfig, all.length), version);
}
