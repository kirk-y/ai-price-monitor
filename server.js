const express = require('express');
const path = require('path');
const { scrapeShop, classifyProducts } = require('./scraper');
const store = require('./store');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

process.on('unhandledRejection', (err) => {
  console.error('未处理的Promise拒绝:', err.message);
});
process.on('uncaughtException', (err) => {
  console.error('未捕获的异常:', err.message);
});

app.get('/api/stores/export', (req, res) => {
  const data = store.exportAllData();
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', `attachment; filename="ldxp-stores-${new Date().toISOString().slice(0,10)}.json"`);
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

app.get('/api/stores', (req, res) => {
  res.json(store.getAllStores());
});

app.get('/api/stores/summary', (req, res) => {
  res.json(store.getStoreSummaries());
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

  scrapeAndUpdate(existing.id, url);
});

app.delete('/api/stores/:id', (req, res) => {
  res.json({ success: store.removeStore(req.params.id) });
});

app.post('/api/stores/:id/refresh', async (req, res) => {
  const s = store.getStore(req.params.id);
  if (!s) return res.status(404).json({ error: '店铺不存在' });

  store.updateStore(s.id, { status: 'pending' });
  res.json({ status: 'pending' });

  scrapeAndUpdate(s.id, s.url);
});

app.get('/api/products/:storeId/:productId/history', (req, res) => {
  res.json(store.getPriceHistory(`${req.params.storeId}:${req.params.productId}`));
});

app.get('/api/product-labels', (req, res) => {
  res.json(store.getLabeledData());
});

app.put('/api/product-labels/:productKey', (req, res) => {
  const { category } = req.body;
  if (!category) return res.status(400).json({ error: '缺少category' });
  store.upsertProductLabel(req.params.productKey, req.body.name || '', category, 1.0, 1);
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
  res.json(store.updateRefreshConfig(req.body));
});

app.get('/api/store-order', (req, res) => {
  res.json(store.getStoreOrder());
});

app.put('/api/store-order', (req, res) => {
  res.json(store.updateStoreOrder(req.body));
});

async function scrapeAndUpdate(storeId, url) {
  try {
    const result = await scrapeShop(url);
    store.updateStore(storeId, {
      name: result.shopName,
      status: 'ok',
      lastUpdated: new Date().toISOString(),
      products: result.products,
    });
    store.recordPrices(storeId, result.products);
    await classifyProducts(result.products, storeId);
  } catch (err) {
    store.updateStore(storeId, { status: 'error', error: err.message });
  }
}

const server = app.listen(PORT, () => {
  console.log(`链动小铺价格监控服务已启动: http://localhost:${PORT}`);
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

function startAutoRefresh() {
  nextRefreshAt = null;
  const all = store.getAllStores();
  const ok = all.filter(s => s.status === 'ok');
  if (ok.length === 0) {
    scheduleNextRefresh(60 * 1000);
    return;
  }

  const pick = ok[Math.floor(Math.random() * ok.length)];
  scrapeAndUpdate(pick.id, pick.url);

  const cfg = store.getRefreshConfig();
  let delay;
  if (cfg.mode === 'fixed') {
    delay = cfg.fixedMinutes * 60 * 1000;
  } else {
    delay = randomBetween(cfg.minMinutes || 60, cfg.maxMinutes || 360);
  }
  scheduleNextRefresh(delay);
}
