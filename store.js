const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const {
  normalizeRefreshConfig,
  normalizeShopUrl,
  normalizeStoreOrder,
  validateCategory,
  validateStoreId,
} = require('./validation');

const DB_PATH = process.env.DB_PATH
  ? path.resolve(process.env.DB_PATH)
  : path.join(__dirname, 'data', 'stores.db');
const JSON_PATH = path.join(__dirname, 'data', 'stores.json');

const DEFAULT_CONFIG = {
  filterPatterns: {
    plus_已接码: [
      '(gpt|chatgpt).*plus.*已接码',
      '\\bplus\\b.*已接码',
    ],
    plus_未接码: [
      '(gpt|chatgpt).*plus(?!.*已接码)',
      '\\bplus\\b(?!.*已接码)',
    ],
    plus_质保: [
      '(gpt|chatgpt).*plus.*质保\\s*\\d{1,3}\\s*天',
      '\\bplus\\b.*质保\\s*\\d{1,3}\\s*天',
      '(gpt|chatgpt).*plus.*质保一年',
    ],
    gpt_pro: [
      '(gpt|chatgpt).*pro',
      'pro\\s*20?x',
    ],
    gpt_team: [
      '(gpt|chatgpt).*team',
      '\\bk12\\b',
      'bug.?team',
      'business',
    ],
    gemini: [
      'gemini',
      'pixel.*pro',
    ],
    claude: [
      'claude',
    ],
    grok: [
      'grok',
    ],
    sms: [
      '(?<!已)(接码|短信验证|验证码|临时号码|长效.*码)',
      '实卡.*接码',
    ],
    codex: [
      '^codex',
      'codex.*(账号|free|专用)',
    ],
  },
  suggestedKeywords: ['已接码', '未接码', '质保号', 'Pro', 'Team', 'Gemini', 'Claude', 'Grok', '接码', '账号'],
};

let db = null;

function getDb() {
  if (!db) {
    const exists = fs.existsSync(DB_PATH);
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    initSchema();
    if (!exists && fs.existsSync(JSON_PATH)) {
      migrateFromJson();
    }
  }
  return db;
}

function initSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS stores (
      id TEXT PRIMARY KEY,
      url TEXT NOT NULL,
      name TEXT DEFAULT '',
      addedAt TEXT DEFAULT '',
      lastUpdated TEXT,
      status TEXT DEFAULT 'ok',
      error TEXT DEFAULT '',
      products TEXT DEFAULT '[]'
    );
    CREATE TABLE IF NOT EXISTS price_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      product_key TEXT NOT NULL,
      price REAL NOT NULL,
      stock INTEGER,
      date TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_price_history_product_key ON price_history(product_key);
    CREATE TABLE IF NOT EXISTS config (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS product_labels (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      product_key TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      category TEXT NOT NULL,
      confidence REAL DEFAULT 1.0,
      manual INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now','localtime'))
    );
    CREATE TABLE IF NOT EXISTS label_changes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      product_key TEXT NOT NULL,
      name TEXT NOT NULL,
      old_category TEXT,
      new_category TEXT NOT NULL,
      changed_at TEXT DEFAULT (datetime('now','localtime'))
    );
  `);

  try {
    db.exec('ALTER TABLE price_history ADD COLUMN stock INTEGER');
  } catch (_) {
    // Existing databases already contain the column.
  }

  try {
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_price_history_unique ON price_history(product_key, price, date)');
  } catch (err) {
    if (err.code !== 'SQLITE_CONSTRAINT_UNIQUE') throw err;
    const deduplicate = db.transaction(() => {
      db.exec(`
        DELETE FROM price_history
        WHERE id NOT IN (
          SELECT MIN(id) FROM price_history GROUP BY product_key, price, date
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_price_history_unique
        ON price_history(product_key, price, date);
      `);
    });
    deduplicate();
  }
}

function migrateFromJson() {
  try {
    const raw = fs.readFileSync(JSON_PATH, 'utf-8');
    const data = JSON.parse(raw);
    const insertStore = db.prepare('INSERT OR REPLACE INTO stores (id, url, name, addedAt, lastUpdated, status, error, products) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    const insertHistory = db.prepare('INSERT INTO price_history (product_key, price, stock, date) VALUES (?, ?, ?, ?)');
    const upsertConfig = db.prepare('INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)');
    const transaction = db.transaction(() => {
      for (const s of data.stores || []) {
        insertStore.run(s.id, s.url, s.name || '', s.addedAt || '', s.lastUpdated || null, s.status || 'ok', s.error || '', JSON.stringify(s.products || []));
      }
      for (const [pk, entries] of Object.entries(data.priceHistory || {})) {
        for (const e of entries) {
          insertHistory.run(pk, e.price, e.stock ?? null, e.date);
        }
      }
      if (data.filterConfig) {
        upsertConfig.run('filterConfig', JSON.stringify(data.filterConfig));
      }
    });
    transaction();
    console.log(`已从 stores.json 迁移数据到 SQLite: ${data.stores?.length || 0} 个店铺`);
  } catch (e) {
    console.error('迁移数据失败:', e.message);
  }
}

function serializeStore(row) {
  if (!row) return null;
  return { ...row, products: JSON.parse(row.products || '[]') };
}

function getAllStores() {
  return getDb().prepare('SELECT * FROM stores ORDER BY addedAt ASC').all().map(serializeStore);
}

function getStoreSummaries() {
  return getDb().prepare('SELECT * FROM stores ORDER BY addedAt ASC').all().map(r => {
    const products = JSON.parse(r.products || '[]');
    const { products: _, ...rest } = r;
    return { ...rest, productCount: products.length };
  });
}

function getStore(storeId) {
  return serializeStore(getDb().prepare('SELECT * FROM stores WHERE id = ?').get(storeId));
}

function addStore(url) {
  const db = getDb();
  const normalized = normalizeShopUrl(url);
  const { id } = normalized;
  if (db.prepare('SELECT id FROM stores WHERE id = ?').get(id)) return null;

  const store = { id, url: normalized.url, name: id, addedAt: new Date().toISOString(), lastUpdated: null, status: 'ok', error: '', products: [] };
  db.prepare('INSERT INTO stores (id, url, name, addedAt, lastUpdated, status, error, products) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(store.id, store.url, store.name, store.addedAt, store.lastUpdated, store.status, store.error, JSON.stringify(store.products));
  return store;
}

function removeStore(storeId) {
  const db = getDb();
  validateStoreId(storeId);
  if (!db.prepare('SELECT id FROM stores WHERE id = ?').get(storeId)) return false;
  const transaction = db.transaction(() => {
    db.prepare('DELETE FROM stores WHERE id = ?').run(storeId);
    db.prepare('DELETE FROM price_history WHERE product_key LIKE ?').run(storeId + ':%');
    db.prepare('DELETE FROM product_labels WHERE product_key LIKE ?').run(storeId + ':%');
    db.prepare('DELETE FROM label_changes WHERE product_key LIKE ?').run(storeId + ':%');
  });
  transaction();
  return true;
}

function updateStore(storeId, updates) {
  const db = getDb();
  const existing = db.prepare('SELECT * FROM stores WHERE id = ?').get(storeId);
  if (!existing) return null;

  const merged = { ...existing, ...updates };
  merged.products = updates.products ? JSON.stringify(updates.products) : existing.products;

  db.prepare('UPDATE stores SET url=?, name=?, addedAt=?, lastUpdated=?, status=?, error=?, products=? WHERE id=?').run(
    merged.url, merged.name, merged.addedAt, merged.lastUpdated, merged.status, merged.error, merged.products, storeId
  );
  return serializeStore(db.prepare('SELECT * FROM stores WHERE id = ?').get(storeId));
}

function recordPrices(storeId, products) {
  const db = getDb();
  const now = new Date().toISOString();
  const insert = db.prepare('INSERT INTO price_history (product_key, price, stock, date) VALUES (?, ?, ?, ?)');
  const prune = db.prepare('DELETE FROM price_history WHERE product_key = ? AND id NOT IN (SELECT id FROM price_history WHERE product_key = ? ORDER BY date DESC LIMIT 200)');
  const transaction = db.transaction(() => {
    for (const p of products) {
      const pk = `${storeId}:${p.id}`;
      const stock = Number.isFinite(Number(p.stock)) ? Math.trunc(Number(p.stock)) : null;
      insert.run(pk, p.price, stock, now);
      prune.run(pk, pk);
    }
  });
  transaction();
}

function getPriceHistory(productKey) {
  return getDb().prepare('SELECT price, stock, date FROM price_history WHERE product_key = ? ORDER BY date ASC').all(productKey);
}

function getFilterConfig() {
  const row = getDb().prepare('SELECT value FROM config WHERE key = ?').get('filterConfig');
  return row ? JSON.parse(row.value) : { ...DEFAULT_CONFIG };
}

function updateFilterConfig(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('筛选配置格式错误');
  getDb().prepare('INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)').run('filterConfig', JSON.stringify(config));
  return config;
}

const DEFAULT_REFRESH_CONFIG = {
  mode: 'random',
  minMinutes: 60,
  maxMinutes: 360,
  fixedMinutes: 120,
};

function getRefreshConfig() {
  const row = getDb().prepare('SELECT value FROM config WHERE key = ?').get('refreshConfig');
  if (!row) return { ...DEFAULT_REFRESH_CONFIG };
  try {
    return normalizeRefreshConfig(JSON.parse(row.value));
  } catch (_) {
    return { ...DEFAULT_REFRESH_CONFIG };
  }
}

function updateRefreshConfig(config) {
  const normalized = normalizeRefreshConfig(config);
  getDb().prepare('INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)').run('refreshConfig', JSON.stringify(normalized));
  return normalized;
}

function getProductLabel(productKey) {
  return getDb().prepare('SELECT * FROM product_labels WHERE product_key = ?').get(productKey) || null;
}

function upsertProductLabel(productKey, name, category, confidence, manual) {
  validateCategory(category);
  getDb().prepare(`
    INSERT INTO product_labels (product_key, name, category, confidence, manual)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(product_key) DO UPDATE SET name=excluded.name, category=excluded.category, confidence=excluded.confidence, manual=excluded.manual
  `).run(productKey, name, category, confidence || 1.0, manual ? 1 : 0);
}

function recordLabelChange(productKey, name, oldCategory, newCategory) {
  getDb().prepare('INSERT INTO label_changes (product_key, name, old_category, new_category) VALUES (?, ?, ?, ?)')
    .run(productKey, name, oldCategory, newCategory);
}

function setProductLabel(productKey, name, category, previousCategory = null) {
  validateCategory(category);
  if (previousCategory) validateCategory(previousCategory);
  const db = getDb();
  const existing = getProductLabel(productKey);
  const oldCategory = existing?.category || previousCategory || null;
  const changed = Boolean(oldCategory && oldCategory !== category);
  const update = db.transaction(() => {
    upsertProductLabel(productKey, name, category, 1.0, 1);
    if (changed) recordLabelChange(productKey, name, oldCategory, category);
  });
  update();
  return { label: getProductLabel(productKey), changed, oldCategory };
}

function getLabelChanges(limit = 100) {
  return getDb().prepare('SELECT * FROM label_changes ORDER BY changed_at DESC, id DESC LIMIT ?').all(limit);
}

function getLabeledData() {
  return getDb().prepare(`
    SELECT product_key, name, category, confidence, manual, created_at
    FROM product_labels
    WHERE manual=1 OR confidence>0.3
    ORDER BY manual DESC, id DESC
  `).all();
}

function exportAllData() {
  const db = getDb();
  const stores = db.prepare('SELECT * FROM stores ORDER BY addedAt ASC').all().map(serializeStore);
  const historyRows = db.prepare('SELECT product_key, price, stock, date FROM price_history ORDER BY product_key, date ASC').all();
  const priceHistory = {};
  for (const r of historyRows) {
    if (!priceHistory[r.product_key]) priceHistory[r.product_key] = [];
    priceHistory[r.product_key].push({ price: r.price, stock: r.stock, date: r.date });
  }
  const filterConfig = getFilterConfig();
  const refreshConfig = getRefreshConfig();
  const productLabels = db.prepare('SELECT product_key, name, category, confidence, manual, created_at FROM product_labels').all();
  const labelChanges = db.prepare('SELECT product_key, name, old_category, new_category, changed_at FROM label_changes').all();
  return { stores, priceHistory, filterConfig, refreshConfig, productLabels, labelChanges };
}

function normalizeProduct(product) {
  if (!product || typeof product !== 'object' || Array.isArray(product)) throw new Error('商品数据格式错误');
  const id = String(product.id || '');
  const name = String(product.name || '');
  const price = Number(product.price);
  const stock = Number(product.stock);
  if (!id || id.length > 300 || /[\u0000-\u001f]/.test(id)) throw new Error('商品ID格式错误');
  if (name.length > 1000) throw new Error('商品名称过长');
  if (!Number.isFinite(price) || price < 0 || price > 1e9) throw new Error('商品价格格式错误');
  if (!Number.isFinite(stock) || stock < -1 || stock > 1e9) throw new Error('商品库存格式错误');

  let purchaseUrl = '';
  if (product.purchaseUrl) {
    try {
      const parsed = new URL(String(product.purchaseUrl));
      if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error();
      purchaseUrl = parsed.toString();
    } catch (_) {
      throw new Error('商品购买链接格式错误');
    }
  }

  return {
    ...product,
    id,
    name,
    price,
    stock,
    purchaseUrl,
    updatedAt: product.updatedAt && !Number.isNaN(Date.parse(product.updatedAt))
      ? new Date(product.updatedAt).toISOString()
      : new Date().toISOString(),
  };
}

function normalizeStoreRecord(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('店铺数据格式错误');
  const id = validateStoreId(input.id);
  const shop = normalizeShopUrl(input.url);
  if (shop.id !== id) throw new Error('店铺ID与URL不匹配');
  if (!Array.isArray(input.products) || input.products.length > 10000) throw new Error('商品列表格式错误或数量超过限制');
  const status = ['ok', 'pending', 'error'].includes(input.status) ? input.status : 'ok';
  return {
    ...input,
    id,
    url: shop.url,
    name: String(input.name || '').slice(0, 500),
    addedAt: input.addedAt && !Number.isNaN(Date.parse(input.addedAt)) ? new Date(input.addedAt).toISOString() : new Date().toISOString(),
    lastUpdated: input.lastUpdated && !Number.isNaN(Date.parse(input.lastUpdated)) ? new Date(input.lastUpdated).toISOString() : null,
    status,
    error: String(input.error || '').slice(0, 1000),
    products: input.products.map(normalizeProduct),
  };
}

function normalizeHistory(data, allowedStoreIds, fixedStoreId = null) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('数据格式错误');
  const history = data.priceHistory ?? {};
  if (!history || typeof history !== 'object' || Array.isArray(history)) throw new Error('priceHistory 必须是对象');

  const rows = [];
  for (const [rawKey, entries] of Object.entries(history)) {
    if (typeof rawKey !== 'string' || !rawKey || rawKey.length > 500 || /[\u0000-\u001f]/.test(rawKey)) {
      throw new Error('商品历史键格式错误');
    }
    let productKey = rawKey;
    if (fixedStoreId) {
      if (!rawKey.includes(':')) productKey = `${fixedStoreId}:${rawKey}`;
      if (!productKey.startsWith(`${fixedStoreId}:`)) throw new Error('历史数据包含其他店铺记录');
    }
    const separator = productKey.indexOf(':');
    if (separator < 1) throw new Error('商品历史键缺少店铺ID');
    const ownerId = validateStoreId(productKey.slice(0, separator));
    if (allowedStoreIds && !allowedStoreIds.has(ownerId)) throw new Error(`历史数据引用了不存在的店铺: ${ownerId}`);
    if (!Array.isArray(entries) || entries.length > 200) throw new Error('单个商品历史记录超过限制');

    for (const entry of entries) {
      const price = Number(entry?.price);
      const timestamp = Date.parse(entry?.date);
      if (!Number.isFinite(price) || price < 0 || price > 1e9 || Number.isNaN(timestamp)) {
        throw new Error('价格历史记录格式错误');
      }
      const stock = entry?.stock === null || entry?.stock === undefined || entry?.stock === ''
        ? null
        : Number(entry.stock);
      if (stock !== null && (!Number.isFinite(stock) || stock < -1e9 || stock > 1e9)) {
        throw new Error('鍘嗗彶搴撳瓨璁板綍鏍煎紡閿欒');
      }
      rows.push({ productKey, price, stock: stock === null ? null : Math.trunc(stock), date: new Date(timestamp).toISOString() });
      if (rows.length > 250000) throw new Error('历史记录总数超过限制');
    }
  }
  return rows;
}

function importAllData(data) {
  const db = getDb();
  if (!data || typeof data !== 'object') throw new Error('数据格式错误');
  if (!Array.isArray(data.stores)) throw new Error('stores 必须是数组');
  if (data.stores.length > 500) throw new Error('店铺数量超过限制 (最多500个)');
  const stores = data.stores.map(normalizeStoreRecord);
  const storeIds = new Set(stores.map(s => s.id));
  if (storeIds.size !== stores.length) throw new Error('店铺ID重复');
  const historyRows = normalizeHistory(data, storeIds);
  const refreshConfig = data.refreshConfig ? normalizeRefreshConfig(data.refreshConfig) : null;
  const productLabels = data.productLabels === undefined ? null : data.productLabels;
  if (productLabels && (!Array.isArray(productLabels) || productLabels.length > 100000)) throw new Error('商品标签格式错误');
  if (productLabels) {
    for (const label of productLabels) {
      if (!label || typeof label !== 'object') throw new Error('商品标签格式错误');
      validateCategory(label.category);
      const ownerId = String(label.product_key || '').split(':')[0];
      if (!storeIds.has(ownerId)) throw new Error('商品标签引用了不存在的店铺');
    }
  }
  const transaction = db.transaction(() => {
    db.exec('DELETE FROM price_history; DELETE FROM stores; DELETE FROM config');
    const insertStore = db.prepare('INSERT INTO stores (id, url, name, addedAt, lastUpdated, status, error, products) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    for (const s of stores) {
      insertStore.run(s.id, s.url, s.name || '', s.addedAt || '', s.lastUpdated || null, s.status || 'ok', s.error || '', JSON.stringify(s.products || []));
    }
    const insertHistory = db.prepare('INSERT OR IGNORE INTO price_history (product_key, price, stock, date) VALUES (?, ?, ?, ?)');
    for (const row of historyRows) insertHistory.run(row.productKey, row.price, row.stock ?? null, row.date);
    if (data.filterConfig) {
      db.prepare('INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)').run('filterConfig', JSON.stringify(data.filterConfig));
    }
    if (refreshConfig) {
      db.prepare('INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)').run('refreshConfig', JSON.stringify(refreshConfig));
    }
    if (productLabels) {
      db.exec('DELETE FROM product_labels; DELETE FROM label_changes');
      const insertLabel = db.prepare('INSERT INTO product_labels (product_key, name, category, confidence, manual, created_at) VALUES (?, ?, ?, ?, ?, ?)');
      for (const label of productLabels) {
        insertLabel.run(label.product_key, String(label.name || '').slice(0, 1000), label.category, Number(label.confidence) || 1, label.manual ? 1 : 0, label.created_at || new Date().toISOString());
      }
      const insertChange = db.prepare('INSERT INTO label_changes (product_key, name, old_category, new_category, changed_at) VALUES (?, ?, ?, ?, ?)');
      for (const change of Array.isArray(data.labelChanges) ? data.labelChanges.slice(0, 100000) : []) {
        validateCategory(change.new_category);
        if (change.old_category) validateCategory(change.old_category);
        insertChange.run(change.product_key, String(change.name || '').slice(0, 1000), change.old_category || null, change.new_category, change.changed_at || new Date().toISOString());
      }
    }
  });
  transaction();
}

function getStoreOrder() {
  const row = getDb().prepare("SELECT value FROM config WHERE key = 'storeOrder'").get();
  return row ? JSON.parse(row.value) : [];
}

function updateStoreOrder(order) {
  const normalized = normalizeStoreOrder(order);
  const db = getDb();
  const exists = db.prepare('SELECT 1 FROM stores WHERE id = ?');
  for (const id of normalized) {
    if (!exists.get(id)) throw new Error(`店铺不存在: ${id}`);
  }
  db.prepare("INSERT OR REPLACE INTO config (key, value) VALUES ('storeOrder', ?)").run(JSON.stringify(normalized));
  return normalized;
}

function exportStore(storeId) {
  const db = getDb();
  const store = db.prepare('SELECT * FROM stores WHERE id = ?').get(storeId);
  if (!store) return null;
  const s = serializeStore(store);
  const prefix = `${storeId}:`;
  const historyRows = db.prepare('SELECT product_key, price, stock, date FROM price_history WHERE product_key LIKE ? ORDER BY date ASC').all(prefix + '%');
  const priceHistory = {};
  for (const r of historyRows) {
    if (!priceHistory[r.product_key]) priceHistory[r.product_key] = [];
    priceHistory[r.product_key].push({ price: r.price, stock: r.stock, date: r.date });
  }
  return { stores: [s], priceHistory, exportedAt: new Date().toISOString() };
}

function importSingleStore(data) {
  const db = getDb();
  if (!data || typeof data !== 'object') throw new Error('数据格式错误');
  if (!Array.isArray(data.stores) || data.stores.length !== 1) throw new Error('单店铺导入必须包含一个店铺');
  const s = normalizeStoreRecord(data.stores[0]);
  const historyRows = normalizeHistory(data, new Set([s.id]), s.id);
  const transaction = db.transaction(() => {
    const existing = db.prepare('SELECT id FROM stores WHERE id = ?').get(s.id);
    if (existing) {
      db.prepare('UPDATE stores SET url=?, name=?, lastUpdated=?, status=?, error=?, products=? WHERE id=?')
        .run(s.url, s.name, s.lastUpdated, s.status, s.error, JSON.stringify(s.products), s.id);
      db.prepare('DELETE FROM price_history WHERE product_key LIKE ?').run(s.id + ':%');
    } else {
      db.prepare('INSERT INTO stores (id, url, name, addedAt, lastUpdated, status, error, products) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(s.id, s.url, s.name, s.addedAt, s.lastUpdated, s.status, s.error, JSON.stringify(s.products));
    }
    const insertHistory = db.prepare('INSERT OR IGNORE INTO price_history (product_key, price, stock, date) VALUES (?, ?, ?, ?)');
    for (const row of historyRows) insertHistory.run(row.productKey, row.price, row.stock ?? null, row.date);
  });
  transaction();
  return true;
}

function exportStoreHistory(storeId) {
  const db = getDb();
  const prefix = `${storeId}:`;
  const historyRows = db.prepare('SELECT product_key, price, stock, date FROM price_history WHERE product_key LIKE ? ORDER BY date ASC').all(prefix + '%');
  const priceHistory = {};
  for (const r of historyRows) {
    if (!priceHistory[r.product_key]) priceHistory[r.product_key] = [];
    priceHistory[r.product_key].push({ price: r.price, stock: r.stock, date: r.date });
  }
  return { storeId, exportedAt: new Date().toISOString(), priceHistory };
}

function exportAllHistory() {
  const db = getDb();
  const historyRows = db.prepare('SELECT product_key, price, stock, date FROM price_history ORDER BY product_key, date ASC').all();
  const priceHistory = {};
  for (const r of historyRows) {
    if (!priceHistory[r.product_key]) priceHistory[r.product_key] = [];
    priceHistory[r.product_key].push({ price: r.price, stock: r.stock, date: r.date });
  }
  return { exportedAt: new Date().toISOString(), priceHistory };
}

function importStoreHistory(storeId, data) {
  validateStoreId(storeId);
  const db = getDb();
  const store = db.prepare('SELECT id FROM stores WHERE id = ?').get(storeId);
  if (!store) throw new Error('店铺不存在');
  const rows = normalizeHistory(data, new Set([storeId]), storeId);
  const insert = db.prepare('INSERT OR IGNORE INTO price_history (product_key, price, stock, date) VALUES (?, ?, ?, ?)');
  const prune = db.prepare('DELETE FROM price_history WHERE product_key = ? AND id NOT IN (SELECT id FROM price_history WHERE product_key = ? ORDER BY date DESC LIMIT 200)');
  const transaction = db.transaction(() => {
    for (const row of rows) insert.run(row.productKey, row.price, row.stock ?? null, row.date);
    for (const productKey of new Set(rows.map(row => row.productKey))) prune.run(productKey, productKey);
  });
  transaction();
  return true;
}

function importAllHistory(data) {
  const db = getDb();
  const storeIds = new Set(db.prepare('SELECT id FROM stores').all().map(row => row.id));
  const rows = normalizeHistory(data, storeIds);
  const insert = db.prepare('INSERT OR IGNORE INTO price_history (product_key, price, stock, date) VALUES (?, ?, ?, ?)');
  const prune = db.prepare('DELETE FROM price_history WHERE product_key = ? AND id NOT IN (SELECT id FROM price_history WHERE product_key = ? ORDER BY date DESC LIMIT 200)');
  const transaction = db.transaction(() => {
    for (const row of rows) insert.run(row.productKey, row.price, row.stock ?? null, row.date);
    for (const productKey of new Set(rows.map(row => row.productKey))) prune.run(productKey, productKey);
  });
  transaction();
  return true;
}

module.exports = {
  getAllStores, getStoreSummaries, getStore, addStore, removeStore, updateStore,
  recordPrices, getPriceHistory,
  getFilterConfig, updateFilterConfig,
  getRefreshConfig, updateRefreshConfig,
  exportAllData, importAllData, exportStore, importSingleStore,
  getProductLabel, upsertProductLabel, setProductLabel, getLabeledData, recordLabelChange, getLabelChanges,
  getStoreOrder, updateStoreOrder,
  exportStoreHistory, exportAllHistory, importStoreHistory, importAllHistory,
};
