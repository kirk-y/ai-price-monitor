const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DB_PATH = path.join(__dirname, 'data', 'stores.db');
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

function normalizeImportedStore(s, index) {
  if (!s || typeof s !== 'object' || Array.isArray(s)) {
    throw new Error(`店铺数据格式错误: 第 ${index + 1} 项不是对象`);
  }
  if (!s.id || typeof s.id !== 'string') {
    throw new Error(`店铺数据格式错误: 第 ${index + 1} 项缺少 id`);
  }
  if (!s.url || typeof s.url !== 'string' || !s.url.startsWith('http')) {
    throw new Error(`店铺数据格式错误: ${s.id} 缺少有效 url`);
  }
  if (s.products !== undefined && !Array.isArray(s.products)) {
    throw new Error(`店铺数据格式错误: ${s.id} 的 products 必须是数组`);
  }
  return {
    id: s.id,
    url: s.url,
    name: s.name || '',
    addedAt: s.addedAt || '',
    lastUpdated: s.lastUpdated || null,
    status: s.status || 'ok',
    error: s.error || '',
    products: s.products || [],
  };
}

function extractStoreId(url) {
  const m = String(url || '').match(/\/shop\/([^/?#]+)/);
  if (m) return decodeURIComponent(m[1]);
  return String(url || '').replace(/\/+$/, '').split('/').pop() || `shop_${Date.now()}`;
}

function normalizeImportedHistory(priceHistory) {
  if (priceHistory === undefined || priceHistory === null) return [];
  if (typeof priceHistory !== 'object' || Array.isArray(priceHistory)) {
    throw new Error('数据格式错误: priceHistory 必须是对象');
  }
  const rows = [];
  for (const [productKey, entries] of Object.entries(priceHistory)) {
    if (!Array.isArray(entries)) {
      throw new Error(`价格历史格式错误: ${productKey} 必须是数组`);
    }
    for (const e of entries) {
      if (!e || typeof e !== 'object') {
        throw new Error(`价格历史格式错误: ${productKey} 中存在无效记录`);
      }
      const price = Number(e.price);
      if (!Number.isFinite(price) || !e.date) {
        throw new Error(`价格历史格式错误: ${productKey} 中存在无效价格或日期`);
      }
      rows.push({ productKey, price, date: String(e.date) });
    }
  }
  return rows;
}

function normalizeImportedLabels(productLabels) {
  if (productLabels === undefined || productLabels === null) return [];
  if (!Array.isArray(productLabels)) {
    throw new Error('数据格式错误: productLabels 必须是数组');
  }
  return productLabels.map((l, index) => {
    if (!l || typeof l !== 'object') {
      throw new Error(`分类标签格式错误: 第 ${index + 1} 项不是对象`);
    }
    const productKey = l.product_key || l.productKey;
    if (!productKey || !l.category) {
      throw new Error(`分类标签格式错误: 第 ${index + 1} 项缺少 product_key 或 category`);
    }
    const confidence = Number(l.confidence);
    return {
      productKey: String(productKey),
      name: l.name || '',
      category: String(l.category),
      confidence: Number.isFinite(confidence) ? confidence : 1.0,
      manual: l.manual ? 1 : 0,
      createdAt: l.created_at || l.createdAt || null,
    };
  });
}

function normalizeFullImportData(data) {
  if (Array.isArray(data)) {
    throw new Error('数据格式错误: 这是店铺列表文件，请在“店铺导出”中使用“导入店铺列表”');
  }
  if (!data || typeof data !== 'object') {
    throw new Error('数据格式错误: 请导入完整 JSON 备份文件');
  }
  if (!Array.isArray(data.stores)) {
    throw new Error('数据格式错误: 缺少 stores 数组');
  }
  return {
    stores: data.stores.map(normalizeImportedStore),
    historyRows: normalizeImportedHistory(data.priceHistory),
    productLabels: normalizeImportedLabels(data.productLabels || data.product_labels),
    filterConfig: data.filterConfig,
    refreshConfig: data.refreshConfig,
    storeOrder: Array.isArray(data.storeOrder) ? data.storeOrder.map(String) : null,
  };
}

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
}

function migrateFromJson() {
  try {
    const raw = fs.readFileSync(JSON_PATH, 'utf-8');
    const data = JSON.parse(raw);
    const insertStore = db.prepare('INSERT OR REPLACE INTO stores (id, url, name, addedAt, lastUpdated, status, error, products) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    const insertHistory = db.prepare('INSERT INTO price_history (product_key, price, date) VALUES (?, ?, ?)');
    const upsertConfig = db.prepare('INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)');
    const transaction = db.transaction(() => {
      for (const s of data.stores || []) {
        insertStore.run(s.id, s.url, s.name || '', s.addedAt || '', s.lastUpdated || null, s.status || 'ok', s.error || '', JSON.stringify(s.products || []));
      }
      for (const [pk, entries] of Object.entries(data.priceHistory || {})) {
        for (const e of entries) {
          insertHistory.run(pk, e.price, e.date);
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

function productKeyPrefix(storeId) {
  return `${storeId}:`;
}

function deleteRowsByProductKeyPrefix(db, table, storeId) {
  const prefix = productKeyPrefix(storeId);
  db.prepare(`DELETE FROM ${table} WHERE substr(product_key, 1, ?) = ?`).run(prefix.length, prefix);
}

function selectRowsByProductKeyPrefix(db, table, columns, storeId, orderBy) {
  const prefix = productKeyPrefix(storeId);
  return db.prepare(`SELECT ${columns} FROM ${table} WHERE substr(product_key, 1, ?) = ? ${orderBy}`).all(prefix.length, prefix);
}

function addStore(url) {
  const db = getDb();
  const id = extractStoreId(url);
  if (db.prepare('SELECT id FROM stores WHERE id = ?').get(id)) return null;

  const store = { id, url, name: id, addedAt: new Date().toISOString(), lastUpdated: null, status: 'ok', error: '', products: [] };
  db.prepare('INSERT INTO stores (id, url, name, addedAt, lastUpdated, status, error, products) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(store.id, store.url, store.name, store.addedAt, store.lastUpdated, store.status, store.error, JSON.stringify(store.products));
  return store;
}

function removeStore(storeId) {
  const db = getDb();
  if (!db.prepare('SELECT id FROM stores WHERE id = ?').get(storeId)) return false;
  const transaction = db.transaction(() => {
    db.prepare('DELETE FROM stores WHERE id = ?').run(storeId);
    deleteRowsByProductKeyPrefix(db, 'price_history', storeId);
    deleteRowsByProductKeyPrefix(db, 'product_labels', storeId);
  });
  transaction();
  return true;
}

function updateStore(storeId, updates) {
  const db = getDb();
  const existing = db.prepare('SELECT * FROM stores WHERE id = ?').get(storeId);
  if (!existing) return null;

  const merged = { ...existing, ...updates };
  merged.products = Object.prototype.hasOwnProperty.call(updates, 'products')
    ? JSON.stringify(updates.products || [])
    : existing.products;

  db.prepare('UPDATE stores SET url=?, name=?, addedAt=?, lastUpdated=?, status=?, error=?, products=? WHERE id=?').run(
    merged.url, merged.name, merged.addedAt, merged.lastUpdated, merged.status, merged.error, merged.products, storeId
  );
  return serializeStore(db.prepare('SELECT * FROM stores WHERE id = ?').get(storeId));
}

function recordPrices(storeId, products) {
  const db = getDb();
  const now = new Date().toISOString();
  const insert = db.prepare('INSERT INTO price_history (product_key, price, date) VALUES (?, ?, ?)');
  const prune = db.prepare('DELETE FROM price_history WHERE product_key = ? AND id NOT IN (SELECT id FROM price_history WHERE product_key = ? ORDER BY date DESC LIMIT 200)');
  const transaction = db.transaction(() => {
    for (const p of products) {
      const pk = `${storeId}:${p.id}`;
      insert.run(pk, p.price, now);
      prune.run(pk, pk);
    }
  });
  transaction();
}

function getPriceHistory(productKey) {
  return getDb().prepare('SELECT price, date FROM price_history WHERE product_key = ? ORDER BY date ASC').all(productKey);
}

function getFilterConfig() {
  const row = getDb().prepare('SELECT value FROM config WHERE key = ?').get('filterConfig');
  return row ? JSON.parse(row.value) : { ...DEFAULT_CONFIG };
}

function updateFilterConfig(config) {
  getDb().prepare('INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)').run('filterConfig', JSON.stringify(config));
  return config;
}

const DEFAULT_REFRESH_CONFIG = {
  mode: 'random',
  minMinutes: 60,
  maxMinutes: 360,
  fixedMinutes: 120,
};

function normalizeRefreshConfig(config) {
  const minMinutes = Math.max(1, parseInt(config?.minMinutes, 10) || DEFAULT_REFRESH_CONFIG.minMinutes);
  const maxMinutesRaw = Math.max(1, parseInt(config?.maxMinutes, 10) || DEFAULT_REFRESH_CONFIG.maxMinutes);
  const maxMinutes = Math.max(minMinutes, maxMinutesRaw);
  const fixedMinutes = Math.max(1, parseInt(config?.fixedMinutes, 10) || DEFAULT_REFRESH_CONFIG.fixedMinutes);
  return {
    mode: config?.mode === 'fixed' ? 'fixed' : 'random',
    minMinutes,
    maxMinutes,
    fixedMinutes,
  };
}

function getRefreshConfig() {
  const row = getDb().prepare('SELECT value FROM config WHERE key = ?').get('refreshConfig');
  return row ? normalizeRefreshConfig(JSON.parse(row.value)) : { ...DEFAULT_REFRESH_CONFIG };
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
  getDb().prepare(`
    INSERT INTO product_labels (product_key, name, category, confidence, manual)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(product_key) DO UPDATE SET category=excluded.category, confidence=excluded.confidence, manual=excluded.manual
  `).run(productKey, name, category, confidence || 1.0, manual ? 1 : 0);
}

function recordLabelChange(productKey, name, oldCategory, newCategory) {
  getDb().prepare('INSERT INTO label_changes (product_key, name, old_category, new_category) VALUES (?, ?, ?, ?)')
    .run(productKey, name, oldCategory, newCategory);
}

function getLabelChanges(limit = 100) {
  return getDb().prepare('SELECT * FROM label_changes ORDER BY changed_at DESC LIMIT ?').all(limit);
}

function getLabeledData() {
  return getDb().prepare('SELECT product_key, name, category, confidence, manual, created_at FROM product_labels WHERE manual=1 OR confidence>0.3 ORDER BY manual DESC').all();
}

function exportAllData() {
  const db = getDb();
  const stores = db.prepare('SELECT * FROM stores ORDER BY addedAt ASC').all().map(serializeStore);
  const historyRows = db.prepare('SELECT product_key, price, date FROM price_history ORDER BY product_key, date ASC').all();
  const priceHistory = {};
  for (const r of historyRows) {
    if (!priceHistory[r.product_key]) priceHistory[r.product_key] = [];
    priceHistory[r.product_key].push({ price: r.price, date: r.date });
  }
  const filterConfig = getFilterConfig();
  const refreshConfig = getRefreshConfig();
  const storeOrder = getStoreOrder();
  const productLabels = db.prepare('SELECT product_key, name, category, confidence, manual, created_at FROM product_labels ORDER BY product_key ASC').all();
  return { stores, priceHistory, productLabels, filterConfig, refreshConfig, storeOrder };
}

function importAllData(data) {
  const normalized = normalizeFullImportData(data);
  const db = getDb();
  const transaction = db.transaction(() => {
    db.exec('DELETE FROM product_labels; DELETE FROM price_history; DELETE FROM stores; DELETE FROM config');
    const insertStore = db.prepare('INSERT INTO stores (id, url, name, addedAt, lastUpdated, status, error, products) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    for (const s of normalized.stores) {
      insertStore.run(s.id, s.url, s.name, s.addedAt, s.lastUpdated, s.status, s.error, JSON.stringify(s.products));
    }
    const insertHistory = db.prepare('INSERT INTO price_history (product_key, price, date) VALUES (?, ?, ?)');
    for (const e of normalized.historyRows) {
      insertHistory.run(e.productKey, e.price, e.date);
    }
    const insertLabel = db.prepare(`
      INSERT OR REPLACE INTO product_labels (product_key, name, category, confidence, manual, created_at)
      VALUES (?, ?, ?, ?, ?, COALESCE(?, datetime('now','localtime')))
    `);
    for (const l of normalized.productLabels) {
      insertLabel.run(l.productKey, l.name, l.category, l.confidence, l.manual, l.createdAt);
    }
    if (normalized.filterConfig) {
      db.prepare('INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)').run('filterConfig', JSON.stringify(normalized.filterConfig));
    }
    if (normalized.refreshConfig) {
      db.prepare('INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)').run('refreshConfig', JSON.stringify(normalizeRefreshConfig(normalized.refreshConfig)));
    }
    if (normalized.storeOrder) {
      db.prepare("INSERT OR REPLACE INTO config (key, value) VALUES ('storeOrder', ?)").run(JSON.stringify(normalized.storeOrder));
    }
  });
  transaction();
}

function getStoreOrder() {
  const row = getDb().prepare("SELECT value FROM config WHERE key = 'storeOrder'").get();
  return row ? JSON.parse(row.value) : [];
}

function updateStoreOrder(order) {
  const normalized = Array.isArray(order) ? order.map(String) : [];
  getDb().prepare("INSERT OR REPLACE INTO config (key, value) VALUES ('storeOrder', ?)").run(JSON.stringify(normalized));
  return normalized;
}

function exportStore(storeId) {
  const db = getDb();
  const store = db.prepare('SELECT * FROM stores WHERE id = ?').get(storeId);
  if (!store) return null;
  const s = serializeStore(store);
  const historyRows = selectRowsByProductKeyPrefix(db, 'price_history', 'product_key, price, date', storeId, 'ORDER BY date ASC');
  const priceHistory = {};
  for (const r of historyRows) {
    if (!priceHistory[r.product_key]) priceHistory[r.product_key] = [];
    priceHistory[r.product_key].push({ price: r.price, date: r.date });
  }
  const productLabels = selectRowsByProductKeyPrefix(db, 'product_labels', 'product_key, name, category, confidence, manual, created_at', storeId, 'ORDER BY product_key ASC');
  return { stores: [s], priceHistory, productLabels, exportedAt: new Date().toISOString() };
}

function importSingleStore(data) {
  const db = getDb();
  const s = normalizeImportedStore(data.stores?.[0], 0);
  const historyRows = normalizeImportedHistory(data.priceHistory).filter(e => e.productKey.startsWith(s.id + ':'));
  const productLabels = normalizeImportedLabels(data.productLabels || data.product_labels).filter(l => l.productKey.startsWith(s.id + ':'));
  if (!s) return false;
  const transaction = db.transaction(() => {
    const existing = db.prepare('SELECT id FROM stores WHERE id = ?').get(s.id);
    if (existing) {
      db.prepare('UPDATE stores SET url=?, name=?, lastUpdated=?, status=?, error=?, products=? WHERE id=?')
        .run(s.url, s.name, s.lastUpdated, s.status, s.error, JSON.stringify(s.products), s.id);
      deleteRowsByProductKeyPrefix(db, 'price_history', s.id);
      deleteRowsByProductKeyPrefix(db, 'product_labels', s.id);
    } else {
      db.prepare('INSERT INTO stores (id, url, name, addedAt, lastUpdated, status, error, products) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(s.id, s.url, s.name, s.addedAt || new Date().toISOString(), s.lastUpdated, s.status, s.error, JSON.stringify(s.products));
    }
    const insertHistory = db.prepare('INSERT INTO price_history (product_key, price, date) VALUES (?, ?, ?)');
    for (const e of historyRows) {
      insertHistory.run(e.productKey, e.price, e.date);
    }
    const insertLabel = db.prepare(`
      INSERT OR REPLACE INTO product_labels (product_key, name, category, confidence, manual, created_at)
      VALUES (?, ?, ?, ?, ?, COALESCE(?, datetime('now','localtime')))
    `);
    for (const l of productLabels) {
      insertLabel.run(l.productKey, l.name, l.category, l.confidence, l.manual, l.createdAt);
    }
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
  getProductLabel, upsertProductLabel, getLabeledData, recordLabelChange, getLabelChanges,
  getStoreOrder, updateStoreOrder,
};
