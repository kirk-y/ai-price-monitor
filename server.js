const express = require('express');
const path = require('path');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { scrapeShop, classifyProducts } = require('./scraper');
const store = require('./store');
const {
  isLoopbackHost,
  normalizeShopUrl,
  validateCategory,
} = require('./validation');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '127.0.0.1';

const AUTH_TOKEN = process.env.AUTH_TOKEN || '';

if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
  throw new Error('PORT 必须是 1 到 65535 之间的整数');
}
if (!AUTH_TOKEN && !isLoopbackHost(HOST)) {
  throw new Error('监听非本机地址时必须设置 AUTH_TOKEN');
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

function requireAuth(req, res, next) {
  if (!AUTH_TOKEN) return next();
  const token = req.headers['x-auth-token'];
  if (token === AUTH_TOKEN) return next();
  res.status(401).json({ error: '未授权，请提供有效的访问令牌' });
}

app.use('/api/', requireAuth);

function requireStrictLimit(req, res, next) {
  strictLimiter(req, res, next);
}

function safeDownloadName(value, fallback = 'export') {
  const name = String(value || fallback).replace(/[^\p{L}\p{N}._-]+/gu, '_').slice(0, 100);
  return name || fallback;
}

app.use(express.json({ limit: '10mb' }));

process.on('unhandledRejection', (err) => {
  console.error('未处理的Promise拒绝:', err.message);
});
process.on('uncaughtException', (err) => {
  console.error('未捕获的异常:', err.message);
});

app.get('/api/stores/export', (req, res) => {
  const data = store.exportAllData();
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', `attachment; filename="ai-price-monitor-${new Date().toISOString().slice(0,10)}.json"`);
  res.json(data);
});

app.post('/api/stores/import', requireStrictLimit, (req, res) => {
  try {
    store.importAllData(req.body);
    res.json({ success: true });
  } catch (e) {
    res.status(400).json({ error: '导入失败: ' + e.message });
  }
});

app.post('/api/stores/import-single', requireStrictLimit, (req, res) => {
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

app.post('/api/stores', requireStrictLimit, async (req, res) => {
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

  scrapeAndUpdate(existing.id, shop.url);
});

app.delete('/api/stores/:id', requireStrictLimit, (req, res) => {
  res.json({ success: store.removeStore(req.params.id) });
});

app.post('/api/stores/:id/refresh', requireStrictLimit, async (req, res) => {
  const s = store.getStore(req.params.id);
  if (!s) return res.status(404).json({ error: '店铺不存在' });

  store.updateStore(s.id, { status: 'pending' });
  res.json({ status: 'pending' });

  scrapeAndUpdate(s.id, s.url);
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

app.post('/api/stores/:id/history/import', requireStrictLimit, (req, res) => {
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

app.post('/api/history/import', requireStrictLimit, (req, res) => {
  try {
    store.importAllHistory(req.body);
    res.json({ success: true });
  } catch (e) {
    res.status(400).json({ error: '导入失败: ' + e.message });
  }
});

app.get('/api/product-labels', (req, res) => {
  res.json(store.getLabeledData());
});

app.get('/api/label-changes', (req, res) => {
  res.json(store.getLabelChanges());
});

app.put('/api/product-labels/:productKey', (req, res) => {
  try {
    const category = validateCategory(req.body?.category);
    const previousCategory = req.body?.previousCategory
      ? validateCategory(req.body.previousCategory)
      : null;
    const result = store.setProductLabel(
      req.params.productKey,
      String(req.body?.name || '').slice(0, 1000),
      category,
      previousCategory,
    );
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/ai-classify', async (req, res) => {
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
  res.json(store.getFilterConfig());
});

app.put('/api/filter-config', (req, res) => {
  try {
    res.json(store.updateFilterConfig(req.body));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/refresh-config', (req, res) => {
  const cfg = store.getRefreshConfig();
  cfg.nextRefreshAt = nextRefreshAt;
  res.json(cfg);
});

app.put('/api/refresh-config', (req, res) => {
  try {
    res.json(store.updateRefreshConfig(req.body));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/store-order', (req, res) => {
  res.json(store.getStoreOrder());
});

app.put('/api/store-order', (req, res) => {
  try {
    res.json(store.updateStoreOrder(req.body));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

const activeRefreshes = new Map();

function scrapeAndUpdate(storeId, url) {
  if (activeRefreshes.has(storeId)) return activeRefreshes.get(storeId);
  const task = (async () => {
    try {
      const result = await scrapeShop(url);
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
      store.updateStore(storeId, { status: 'error', error: err.message });
    }
  })();
  activeRefreshes.set(storeId, task);
  task.finally(() => activeRefreshes.delete(storeId));
  return task;
}

const server = app.listen(PORT, HOST, () => {
  console.log(`AI价格监控服务已启动: http://${HOST}:${PORT}`);
  startAutoRefresh();
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`端口 ${PORT} 已被占用，请关闭其他服务或使用其他端口`);
    process.exit(1);
  }
});

let nextRefreshAt = null;

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
  const ok = all.filter(s => s.status === 'ok');
  if (ok.length === 0) {
    scheduleNextRefresh(60 * 1000);
    return;
  }

  const pick = ok[Math.floor(Math.random() * ok.length)];
  await scrapeAndUpdate(pick.id, pick.url);

  const cfg = store.getRefreshConfig();
  let delay;
  if (cfg.mode === 'fixed') {
    delay = cfg.fixedMinutes * 60 * 1000;
  } else {
    delay = randomBetween(cfg.minMinutes || 60, cfg.maxMinutes || 360);
  }
  scheduleNextRefresh(delay);
}
