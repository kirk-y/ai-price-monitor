const express = require('express');
const path = require('path');
const { scrapeShop, classifyProducts } = require('./scraper');
const store = require('./store');

const app = express();
const PORT = process.env.PORT || 3000;
const SCRAPE_QUEUE_DELAY_MS = Math.max(0, parseInt(process.env.SCRAPE_QUEUE_DELAY_MS, 10) || 2000);
const SCRAPE_MAX_RETRIES = Math.max(0, parseInt(process.env.SCRAPE_MAX_RETRIES, 10) || 2);

app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/favicon.ico', (req, res) => res.status(204).end());

function encodeRFC5987Value(value) {
  return encodeURIComponent(value).replace(/['()*]/g, ch =>
    '%' + ch.charCodeAt(0).toString(16).toUpperCase()
  );
}

function safeFilenamePart(value, fallback) {
  const cleaned = String(value || fallback)
    .replace(/[\r\n\\/:"*?<>|]+/g, '_')
    .trim();
  return cleaned || fallback;
}

function setJsonDownloadHeaders(res, filenameBase) {
  const filename = `${safeFilenamePart(filenameBase, 'export')}-${new Date().toISOString().slice(0, 10)}.json`;
  const asciiFallback = filename
    .replace(/[^\x20-\x7E]+/g, '_')
    .replace(/["\\;]/g, '_');
  res.setHeader('Content-Type', 'application/json');
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encodeRFC5987Value(filename)}`
  );
}

process.on('unhandledRejection', (err) => {
  console.error('未处理的Promise拒绝:', err.message);
});
process.on('uncaughtException', (err) => {
  console.error('未捕获的异常:', err.message);
});

app.get('/api/stores/export', (req, res) => {
  const data = store.exportAllData();
  setJsonDownloadHeaders(res, 'ai-price-monitor');
  res.json(data);
});

app.post('/api/stores/import', (req, res) => {
  try {
    store.importAllData(req.body);
    res.json({ success: true });
  } catch (e) {
    res.status(400).json({ error: '导入失败: ' + e.message });
  }
});

app.post('/api/stores/import-single', (req, res) => {
  try {
    if (!req.body.stores?.length) return res.status(400).json({ error: '数据格式错误，缺少店铺信息' });
    store.importSingleStore(req.body);
    res.json({ success: true, storeId: req.body.stores[0].id });
  } catch (e) {
    res.status(400).json({ error: '导入失败: ' + e.message });
  }
});

app.post('/api/stores/import-list', (req, res) => {
  try {
    const list = Array.isArray(req.body) ? req.body : req.body?.stores;
    if (!Array.isArray(list)) {
      return res.status(400).json({ error: '数据格式错误，应为店铺数组' });
    }

    let added = 0;
    let skipped = 0;
    let failed = 0;
    const stores = [];
    for (const item of list) {
      const url = typeof item === 'string' ? item : item?.url;
      if (!url || typeof url !== 'string' || !url.startsWith('http')) {
        failed++;
        continue;
      }
      const created = store.addStore(url);
      if (!created) {
        skipped++;
        continue;
      }
      const updates = { status: 'pending', error: '' };
      if (typeof item?.name === 'string' && item.name.trim()) updates.name = item.name.trim();
      const pendingStore = store.updateStore(created.id, updates) || created;
      enqueueScrape(pendingStore.id, pendingStore.url, 'import-list');
      stores.push({ id: pendingStore.id, url: pendingStore.url, name: pendingStore.name });
      added++;
    }

    res.json({ success: true, added, skipped, failed, queued: added, stores });
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
  setJsonDownloadHeaders(res, 'stores-list');
  res.json(list);
});

app.get('/api/stores/summary', (req, res) => {
  res.json(store.getStoreSummaries());
});

app.get('/api/stores/:id/export', (req, res) => {
  const data = store.exportStore(req.params.id);
  if (!data) return res.status(404).json({ error: '店铺不存在' });
  const name = data.stores[0]?.name || req.params.id;
  setJsonDownloadHeaders(res, name);
  res.json(data);
});

app.get('/api/stores/:id', (req, res) => {
  const s = store.getStore(req.params.id);
  if (!s) return res.status(404).json({ error: '店铺不存在' });
  res.json(s);
});

app.post('/api/stores', async (req, res) => {
  const { url } = req.body;
  if (!url || !url.startsWith('http')) {
    return res.status(400).json({ error: '请提供有效的URL' });
  }

  const existing = store.addStore(url);
  if (!existing) {
    return res.status(409).json({ error: '该店铺已存在' });
  }

  store.updateStore(existing.id, { status: 'pending' });
  res.json(store.getStore(existing.id));

  enqueueScrape(existing.id, url, 'add-store');
});

app.delete('/api/stores/:id', (req, res) => {
  res.json({ success: store.removeStore(req.params.id) });
});

app.post('/api/stores/:id/refresh', async (req, res) => {
  const s = store.getStore(req.params.id);
  if (!s) return res.status(404).json({ error: '店铺不存在' });

  store.updateStore(s.id, { status: 'pending' });
  const queue = enqueueScrape(s.id, s.url, 'manual-refresh');
  res.json({ status: 'pending', queued: queue.queued, position: queue.position });
});

app.get('/api/products/:storeId/:productId/history', (req, res) => {
  res.json(store.getPriceHistory(`${req.params.storeId}:${req.params.productId}`));
});

app.get('/api/product-labels', (req, res) => {
  res.json(store.getLabeledData());
});

app.get('/api/label-changes', (req, res) => {
  res.json(store.getLabelChanges());
});

app.put('/api/product-labels/:productKey', (req, res) => {
  const { category } = req.body;
  if (!category) return res.status(400).json({ error: '缺少category' });
  const old = store.getProductLabel(req.params.productKey);
  store.upsertProductLabel(req.params.productKey, req.body.name || '', category, 1.0, 1);
  if (old && old.category !== category) {
    store.recordLabelChange(req.params.productKey, req.body.name || '', old.category, category);
  }
  res.json({ success: true });
});

app.get('/api/filter-config', (req, res) => {
  res.json(store.getFilterConfig());
});

app.put('/api/filter-config', (req, res) => {
  res.json(store.updateFilterConfig(req.body));
});

app.get('/api/refresh-config', (req, res) => {
  const cfg = store.getRefreshConfig();
  cfg.nextRefreshAt = nextRefreshAt;
  res.json(cfg);
});

app.put('/api/refresh-config', (req, res) => {
  const cfg = store.updateRefreshConfig(req.body);
  rescheduleAutoRefresh(cfg);
  cfg.nextRefreshAt = nextRefreshAt;
  res.json(cfg);
});

app.get('/api/refresh-queue', (req, res) => {
  res.json(getRefreshQueueStatus());
});

app.get('/api/store-order', (req, res) => {
  res.json(store.getStoreOrder());
});

app.put('/api/store-order', (req, res) => {
  res.json(store.updateStoreOrder(req.body));
});

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const RETRYABLE_STATUSES = new Set([408, 409, 425, 429, 500, 502, 503, 504, 520, 521, 522, 523, 524]);
const RETRYABLE_CODES = new Set(['ECONNABORTED', 'ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN']);

function isRetryableScrapeError(err) {
  const status = err.response?.status;
  return RETRYABLE_STATUSES.has(status) || RETRYABLE_CODES.has(err.code);
}

async function scrapeShopWithRetry(url) {
  let lastErr = null;
  for (let attempt = 0; attempt <= SCRAPE_MAX_RETRIES; attempt++) {
    try {
      return await scrapeShop(url);
    } catch (err) {
      lastErr = err;
      if (attempt >= SCRAPE_MAX_RETRIES || !isRetryableScrapeError(err)) break;
      const delay = Math.min(30000, 3000 * Math.pow(2, attempt));
      console.warn(`抓取失败，${Math.round(delay / 1000)} 秒后重试: ${err.message}`);
      await wait(delay);
    }
  }
  throw lastErr;
}

async function scrapeAndUpdate(storeId, url) {
  try {
    const result = await scrapeShopWithRetry(url);
    store.updateStore(storeId, {
      name: result.shopName,
      status: 'ok',
      error: result.partialFailures?.length ? `部分商品类型获取失败: ${result.partialFailures.join('; ')}` : '',
      lastUpdated: new Date().toISOString(),
      products: result.products,
    });
    store.recordPrices(storeId, result.products);
    await classifyProducts(result.products, storeId);
  } catch (err) {
    store.updateStore(storeId, { status: 'error', error: err.message });
  }
}

const scrapeQueue = [];
const queuedScrapes = new Map();
let scrapeRunning = false;
let activeScrapeTask = null;
let lastScrapeFinishedAt = 0;
const scrapeStats = {
  completed: 0,
  failed: 0,
  lastFinishedAt: null,
};

function enqueueScrape(storeId, url, reason = 'manual') {
  const existing = queuedScrapes.get(storeId);
  if (existing) {
    existing.url = url;
    existing.reason = reason;
    return { queued: false, position: scrapeQueue.indexOf(existing) + 1 };
  }

  const task = { storeId, url, reason, queuedAt: Date.now() };
  scrapeQueue.push(task);
  queuedScrapes.set(storeId, task);
  drainScrapeQueue();
  return { queued: true, position: scrapeQueue.length };
}

async function drainScrapeQueue() {
  if (scrapeRunning) return;
  scrapeRunning = true;
  try {
    while (scrapeQueue.length) {
      const task = scrapeQueue.shift();
      activeScrapeTask = task;
      const current = store.getStore(task.storeId);
      if (!current) {
        queuedScrapes.delete(task.storeId);
        activeScrapeTask = null;
        continue;
      }

      const gap = Date.now() - lastScrapeFinishedAt;
      if (lastScrapeFinishedAt && gap < SCRAPE_QUEUE_DELAY_MS) {
        await wait(SCRAPE_QUEUE_DELAY_MS - gap);
      }

      await scrapeAndUpdate(task.storeId, task.url);
      const updated = store.getStore(task.storeId);
      if (updated?.status === 'ok') scrapeStats.completed++;
      else if (updated?.status === 'error') scrapeStats.failed++;
      lastScrapeFinishedAt = Date.now();
      scrapeStats.lastFinishedAt = new Date().toISOString();
      queuedScrapes.delete(task.storeId);
      activeScrapeTask = null;
    }
  } finally {
    activeScrapeTask = null;
    scrapeRunning = false;
    if (scrapeQueue.length) drainScrapeQueue();
  }
}

function publicQueueTask(task, index) {
  if (!task) return null;
  const s = store.getStore(task.storeId);
  return {
    id: task.storeId,
    name: s?.name || task.storeId,
    reason: task.reason,
    queuedAt: task.queuedAt,
    position: index,
  };
}

function getRefreshQueueStatus() {
  const pendingStores = store.getStoreSummaries().filter(s => s.status === 'pending');
  return {
    running: scrapeRunning,
    active: publicQueueTask(activeScrapeTask, 0),
    queued: scrapeQueue.map((task, index) => publicQueueTask(task, index + 1)),
    pendingStores: pendingStores.map(s => ({ id: s.id, name: s.name || s.id, productCount: s.productCount || 0 })),
    queuedCount: scrapeQueue.length,
    pendingCount: pendingStores.length,
    delayMs: SCRAPE_QUEUE_DELAY_MS,
    maxRetries: SCRAPE_MAX_RETRIES,
    stats: scrapeStats,
  };
}

const server = app.listen(PORT, () => {
  console.log(`AI价格监控服务已启动: http://localhost:${PORT}`);
  startAutoRefresh();
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`端口 ${PORT} 已被占用，请关闭其他服务或使用其他端口`);
    process.exit(1);
  }
});

let nextRefreshAt = null;
let refreshTimer = null;

function randomBetween(min, max) {
  return Math.floor(Math.random() * (max - min + 1) + min) * 60 * 1000;
}

function getRefreshDelay(cfg = store.getRefreshConfig()) {
  if (cfg.mode === 'fixed') return cfg.fixedMinutes * 60 * 1000;
  return randomBetween(cfg.minMinutes || 60, cfg.maxMinutes || 360);
}

function scheduleNextRefresh(delay) {
  const safeDelay = Math.max(1000, Number(delay) || 60 * 1000);
  if (refreshTimer) clearTimeout(refreshTimer);
  nextRefreshAt = Date.now() + safeDelay;
  console.log(`下次自动刷新: ${Math.round(safeDelay/60000)} 分钟后`);
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    startAutoRefresh();
  }, safeDelay);
}

function rescheduleAutoRefresh(cfg = store.getRefreshConfig()) {
  scheduleNextRefresh(getRefreshDelay(cfg));
}

function startAutoRefresh() {
  nextRefreshAt = null;
  const all = store.getAllStores();
  if (scrapeRunning || scrapeQueue.length) {
    scheduleNextRefresh(60 * 1000);
    return;
  }

  const candidates = all.filter(s => s.status !== 'pending' && !queuedScrapes.has(s.id));
  if (candidates.length === 0) {
    scheduleNextRefresh(60 * 1000);
    return;
  }

  const pick = candidates[Math.floor(Math.random() * candidates.length)];
  store.updateStore(pick.id, { status: 'pending', error: '' });
  enqueueScrape(pick.id, pick.url, 'auto-refresh');
  scheduleNextRefresh(getRefreshDelay());
}
