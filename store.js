const Database = require('better-sqlite3');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const { DEFAULT_CLASSIFICATION_CONFIG, RULE_VERSION, migrateClassificationConfig, validateClassificationConfig } = require('./classification');
const {
  normalizeRefreshConfig,
  normalizeRefreshProxyConfig,
  normalizeShopUrl,
  normalizeStoreOrder,
  validateCategory,
  validateStoreId,
} = require('./validation');

const DB_PATH = process.env.DB_PATH
  ? path.resolve(process.env.DB_PATH)
  : path.join(__dirname, 'data', 'stores.db');
const JSON_PATH = path.join(__dirname, 'data', 'stores.json');
const MAX_HISTORY_IMPORT_ROWS = Number(process.env.MAX_HISTORY_IMPORT_ROWS || 1000000);
if (!Number.isSafeInteger(MAX_HISTORY_IMPORT_ROWS) || MAX_HISTORY_IMPORT_ROWS < 1) {
  throw new Error('MAX_HISTORY_IMPORT_ROWS must be a positive integer');
}

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
    db.pragma('foreign_keys = ON');
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
      products TEXT DEFAULT '[]',
      refresh_meta TEXT DEFAULT '{}'
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
    CREATE TABLE IF NOT EXISTS classification_feedback (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      product_key TEXT NOT NULL,
      name TEXT NOT NULL,
      dimension TEXT NOT NULL,
      old_value TEXT,
      new_value TEXT NOT NULL,
      classification_version INTEGER DEFAULT 3,
      created_at TEXT DEFAULT (datetime('now','localtime'))
    );
    CREATE INDEX IF NOT EXISTS idx_classification_feedback_product
    ON classification_feedback(product_key, created_at DESC);
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE COLLATE NOCASE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('admin', 'operator', 'viewer')),
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_login_at TEXT
    );
    CREATE TABLE IF NOT EXISTS auth_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_auth_sessions_token ON auth_sessions(token_hash);
    CREATE TABLE IF NOT EXISTS audit_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      username TEXT,
      action TEXT NOT NULL,
      target TEXT,
      detail TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS user_preferences (
      user_id INTEGER PRIMARY KEY,
      value TEXT NOT NULL DEFAULT '{}',
      updated_at TEXT NOT NULL,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );
  `);

  for (const statement of [
    "ALTER TABLE product_labels ADD COLUMN classification_json TEXT DEFAULT '{}'",
    "ALTER TABLE product_labels ADD COLUMN classification_version INTEGER DEFAULT 1",
    "ALTER TABLE product_labels ADD COLUMN classification_source TEXT DEFAULT 'legacy'",
    "ALTER TABLE stores ADD COLUMN refresh_meta TEXT DEFAULT '{}'",
  ]) {
    try { db.exec(statement); } catch (_) { /* Existing databases already contain the column. */ }
  }

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
  const { refresh_meta: refreshMetaJson, ...plain } = row;
  let refreshMeta = {};
  try { refreshMeta = JSON.parse(refreshMetaJson || '{}'); } catch (_) { refreshMeta = {}; }
  return { ...plain, products: JSON.parse(row.products || '[]'), refreshMeta };
}

function getAllStores() {
  return getDb().prepare('SELECT * FROM stores ORDER BY addedAt ASC').all().map(serializeStore);
}

function getStoresByIds(storeIds) {
  const ids = [...new Set((storeIds || []).map(String))].slice(0, 20);
  if (!ids.length) return [];
  const placeholders = ids.map(() => '?').join(',');
  const rows = getDb().prepare(`SELECT * FROM stores WHERE id IN (${placeholders})`).all(...ids);
  const byId = new Map(rows.map(row => [row.id, serializeStore(row)]));
  return ids.map(id => byId.get(id)).filter(Boolean);
}

function getStoreSummaries() {
  return getDb().prepare('SELECT * FROM stores ORDER BY addedAt ASC').all().map(r => {
    const products = JSON.parse(r.products || '[]');
    let refreshMeta = {};
    try { refreshMeta = JSON.parse(r.refresh_meta || '{}'); } catch (_) { refreshMeta = {}; }
    const { products: _, refresh_meta: __, ...rest } = r;
    return {
      ...rest,
      productCount: products.length,
      refreshState: refreshMeta.refreshState || 'idle',
      refreshError: refreshMeta.refreshError || '',
      lastAttemptAt: refreshMeta.lastAttemptAt || null,
      lastSuccessAt: refreshMeta.lastSuccessAt || r.lastUpdated || null,
      collectorRoute: refreshMeta.collectorRoute || '',
    };
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

function importStoreList(list) {
  if (!Array.isArray(list) || list.length > 500) throw new Error('store list must contain at most 500 items');
  const normalized = [];
  const seen = new Set();
  let skipped = 0;
  for (const item of list) {
    try {
      const shop = normalizeShopUrl(typeof item === 'string' ? item : item?.url);
      if (seen.has(shop.id)) { skipped++; continue; }
      seen.add(shop.id);
      normalized.push({ ...shop, name: String(item?.name || shop.id).slice(0, 500) });
    } catch (_) {
      skipped++;
    }
  }
  const db = getDb();
  const insert = db.prepare('INSERT OR IGNORE INTO stores (id, url, name, addedAt, lastUpdated, status, error, products) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  const addedIds = [];
  const now = new Date().toISOString();
  const transaction = db.transaction(() => {
    for (const shop of normalized) {
      const result = insert.run(shop.id, shop.url, shop.name, now, null, 'pending', '', '[]');
      if (result.changes) addedIds.push(shop.id);
      else skipped++;
    }
  });
  transaction();
  return { addedIds, skipped };
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
    db.prepare('DELETE FROM classification_feedback WHERE product_key LIKE ?').run(storeId + ':%');
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
  merged.refresh_meta = updates.refreshMeta ? JSON.stringify(updates.refreshMeta) : existing.refresh_meta;

  db.prepare('UPDATE stores SET url=?, name=?, addedAt=?, lastUpdated=?, status=?, error=?, products=?, refresh_meta=? WHERE id=?').run(
    merged.url, merged.name, merged.addedAt, merged.lastUpdated, merged.status, merged.error, merged.products, merged.refresh_meta, storeId
  );
  return serializeStore(db.prepare('SELECT * FROM stores WHERE id = ?').get(storeId));
}

function recordPrices(storeId, products) {
  const db = getDb();
  const now = new Date().toISOString();
  // Refresh results can contain the same product more than once; history writes are idempotent.
  const insert = db.prepare('INSERT OR IGNORE INTO price_history (product_key, price, stock, date) VALUES (?, ?, ?, ?)');
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

function getPriceHistoryForProducts(productKeys, since = 0) {
  const keys = [...new Set((productKeys || []).filter(Boolean).map(String))];
  if (!keys.length) return [];
  const placeholders = keys.map(() => '?').join(',');
  const params = [...keys];
  let query = `SELECT product_key, price, stock, date FROM price_history WHERE product_key IN (${placeholders})`;
  if (Number.isFinite(Number(since)) && Number(since) > 0) {
    query += ' AND date >= ?';
    params.push(new Date(Number(since)).toISOString());
  }
  return getDb().prepare(`${query} ORDER BY date ASC`).all(...params);
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

function getClassificationConfig() {
  const row = getDb().prepare('SELECT value FROM config WHERE key = ?').get('classificationConfig');
  if (!row) return validateClassificationConfig(DEFAULT_CLASSIFICATION_CONFIG);
  try {
    const raw = JSON.parse(row.value);
    const normalized = migrateClassificationConfig(raw);
    if (Number(raw?.version) !== normalized.version || JSON.stringify(raw) !== JSON.stringify(normalized)) {
      getDb().prepare('INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)')
        .run('classificationConfig', JSON.stringify(normalized));
    }
    return normalized;
  } catch (_) {
    return validateClassificationConfig(DEFAULT_CLASSIFICATION_CONFIG);
  }
}

function updateClassificationConfig(config) {
  const normalized = Number(config?.version) < RULE_VERSION
    ? migrateClassificationConfig(config)
    : validateClassificationConfig(config);
  getDb().prepare('INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)')
    .run('classificationConfig', JSON.stringify(normalized));
  return normalized;
}

const DEFAULT_REFRESH_CONFIG = {
  collectorMode: 'auto',
  plusCycleMinutes: 60,
  typeProbeHours: 24,
  catalogRefreshHours: 24,
  requestDelayMinSeconds: 20,
  requestDelayMaxSeconds: 60,
  riskThreshold: 3,
  riskCooldownMinutes: 15,
  hourlyRequestLimit: 60,
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

function getRefreshProxyConfig() {
  const row = getDb().prepare('SELECT value FROM config WHERE key = ?').get('refreshProxyConfig');
  if (!row) return { enabled: false, proxyUrl: '' };
  try { return normalizeRefreshProxyConfig(JSON.parse(row.value)); }
  catch (_) { return { enabled: false, proxyUrl: '' }; }
}

function updateRefreshProxyConfig(config) {
  const current = getRefreshProxyConfig();
  const normalized = normalizeRefreshProxyConfig(config, current.proxyUrl);
  getDb().prepare('INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)')
    .run('refreshProxyConfig', JSON.stringify(normalized));
  return normalized;
}

function getRefreshRuntimeState() {
  const row = getDb().prepare('SELECT value FROM config WHERE key = ?').get('refreshRuntimeState');
  const fallback = { circuitState: 'closed', blockedUntil: 0, lastErrorCode: '', lastError: '', lastErrorAt: null, preferredRoute: '', routeVerifiedAt: null, requestTimestamps: [] };
  if (!row) return fallback;
  try {
    const value = JSON.parse(row.value);
    return {
      circuitState: value.circuitState === 'open' ? 'open' : 'closed',
      blockedUntil: Math.max(0, Number(value.blockedUntil) || 0),
      lastErrorCode: String(value.lastErrorCode || '').slice(0, 100),
      lastError: String(value.lastError || '').slice(0, 1000),
      lastErrorAt: value.lastErrorAt && !Number.isNaN(Date.parse(value.lastErrorAt)) ? new Date(value.lastErrorAt).toISOString() : null,
      preferredRoute: ['direct', 'browser'].includes(value.preferredRoute) ? value.preferredRoute : '',
      routeVerifiedAt: value.routeVerifiedAt && !Number.isNaN(Date.parse(value.routeVerifiedAt)) ? new Date(value.routeVerifiedAt).toISOString() : null,
      requestTimestamps: Array.isArray(value.requestTimestamps)
        ? value.requestTimestamps.map(Number).filter(Number.isFinite).slice(-1000)
        : [],
    };
  } catch (_) {
    return fallback;
  }
}

function updateRefreshRuntimeState(patch) {
  const next = { ...getRefreshRuntimeState(), ...patch };
  getDb().prepare('INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)')
    .run('refreshRuntimeState', JSON.stringify(next));
  return getRefreshRuntimeState();
}

function updateStoreRefreshMeta(storeId, patch) {
  const current = getStore(storeId);
  if (!current) return null;
  const refreshMeta = { ...(current.refreshMeta || {}), ...patch };
  getDb().prepare('UPDATE stores SET refresh_meta = ? WHERE id = ?').run(JSON.stringify(refreshMeta), storeId);
  return refreshMeta;
}

function getProductLabel(productKey) {
  return serializeProductLabel(getDb().prepare('SELECT * FROM product_labels WHERE product_key = ?').get(productKey));
}

function serializeProductLabel(row) {
  if (!row) return null;
  let classification = null;
  try { classification = JSON.parse(row.classification_json || 'null'); } catch (_) { classification = null; }
  const { classification_json: _, ...label } = row;
  return { ...label, classification };
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
    SELECT product_key, name, category, confidence, manual, created_at,
           classification_json, classification_version, classification_source
    FROM product_labels
    WHERE manual=1 OR confidence>0.3
    ORDER BY manual DESC, id DESC
  `).all().map(serializeProductLabel);
}

const AUTH_ROLES = new Set(['admin', 'operator', 'viewer']);

function validateUsername(username) {
  const value = String(username || '').trim();
  if (!/^[\p{L}\p{N}_.-]{3,32}$/u.test(value)) throw new Error('用户名需为 3-32 位字母、数字、中文、点、横线或下划线');
  return value;
}

function validatePassword(password) {
  const value = String(password || '');
  if (value.length < 8 || value.length > 128) throw new Error('密码长度需为 8-128 位');
  return value;
}

function validateRole(role) {
  const value = String(role || '');
  if (!AUTH_ROLES.has(value)) throw new Error('无效的用户角色');
  return value;
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(validatePassword(password), salt, 64);
  return `scrypt:${salt.toString('hex')}:${hash.toString('hex')}`;
}

function verifyPassword(password, stored) {
  try {
    const [algorithm, saltHex, hashHex] = String(stored || '').split(':');
    if (algorithm !== 'scrypt' || !saltHex || !hashHex) return false;
    const expected = Buffer.from(hashHex, 'hex');
    const actual = crypto.scryptSync(String(password || ''), Buffer.from(saltHex, 'hex'), expected.length);
    return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
  } catch (_) { return false; }
}

function publicUser(row) {
  if (!row) return null;
  return { id: row.id, username: row.username, role: row.role, enabled: Boolean(row.enabled), createdAt: row.created_at, updatedAt: row.updated_at, lastLoginAt: row.last_login_at };
}

function getUserCount() {
  return getDb().prepare('SELECT COUNT(*) count FROM users').get().count;
}

function listUsers() {
  return getDb().prepare('SELECT * FROM users ORDER BY username COLLATE NOCASE').all().map(publicUser);
}

function createUser(username, password, role = 'viewer') {
  const now = new Date().toISOString();
  const info = getDb().prepare(`INSERT INTO users (username, password_hash, role, enabled, created_at, updated_at)
    VALUES (?, ?, ?, 1, ?, ?)`).run(validateUsername(username), hashPassword(password), validateRole(role), now, now);
  return publicUser(getDb().prepare('SELECT * FROM users WHERE id=?').get(info.lastInsertRowid));
}

function authenticateUser(username, password) {
  const row = getDb().prepare('SELECT * FROM users WHERE username=? COLLATE NOCASE').get(String(username || '').trim());
  if (!row || !row.enabled || !verifyPassword(password, row.password_hash)) return null;
  const now = new Date().toISOString();
  getDb().prepare('UPDATE users SET last_login_at=?, updated_at=? WHERE id=?').run(now, now, row.id);
  return publicUser({ ...row, last_login_at: now, updated_at: now });
}

function createAuthSession(userId, maxAgeMs = 7 * 24 * 60 * 60 * 1000) {
  const token = crypto.randomBytes(32).toString('base64url');
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  const now = new Date();
  const expiresAt = new Date(now.getTime() + maxAgeMs).toISOString();
  const db = getDb();
  db.prepare('DELETE FROM auth_sessions WHERE expires_at<=?').run(now.toISOString());
  db.prepare('INSERT INTO auth_sessions (user_id, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?)')
    .run(userId, tokenHash, expiresAt, now.toISOString());
  return { token, expiresAt };
}

function resolveAuthSession(token) {
  if (!token) return null;
  const tokenHash = crypto.createHash('sha256').update(String(token)).digest('hex');
  const row = getDb().prepare(`SELECT s.id session_id, s.expires_at, u.* FROM auth_sessions s
    JOIN users u ON u.id=s.user_id WHERE s.token_hash=?`).get(tokenHash);
  if (!row || !row.enabled || Date.parse(row.expires_at) <= Date.now()) {
    if (row) getDb().prepare('DELETE FROM auth_sessions WHERE id=?').run(row.session_id);
    return null;
  }
  return { ...publicUser(row), sessionId: row.session_id, expiresAt: row.expires_at };
}

function deleteAuthSession(token) {
  if (!token) return false;
  const tokenHash = crypto.createHash('sha256').update(String(token)).digest('hex');
  return getDb().prepare('DELETE FROM auth_sessions WHERE token_hash=?').run(tokenHash).changes > 0;
}

function updateUser(userId, changes, actorId) {
  const id = Number(userId);
  const current = getDb().prepare('SELECT * FROM users WHERE id=?').get(id);
  if (!current) throw new Error('用户不存在');
  const role = changes.role === undefined ? current.role : validateRole(changes.role);
  const enabled = changes.enabled === undefined ? current.enabled : (changes.enabled ? 1 : 0);
  if (id === Number(actorId) && (!enabled || role !== 'admin')) throw new Error('不能取消自己的管理员权限');
  if (current.role === 'admin' && current.enabled && (!enabled || role !== 'admin')) {
    const admins = getDb().prepare("SELECT COUNT(*) count FROM users WHERE role='admin' AND enabled=1").get().count;
    if (admins <= 1) throw new Error('至少需要保留一个启用的管理员');
  }
  const passwordHash = changes.password ? hashPassword(changes.password) : current.password_hash;
  const now = new Date().toISOString();
  const db = getDb();
  db.prepare('UPDATE users SET role=?, enabled=?, password_hash=?, updated_at=? WHERE id=?').run(role, enabled, passwordHash, now, id);
  if (!enabled || changes.password) db.prepare('DELETE FROM auth_sessions WHERE user_id=?').run(id);
  return publicUser(db.prepare('SELECT * FROM users WHERE id=?').get(id));
}

function deleteUser(userId, actorId) {
  const id = Number(userId);
  if (id === Number(actorId)) throw new Error('不能删除当前登录用户');
  const row = getDb().prepare('SELECT * FROM users WHERE id=?').get(id);
  if (!row) return false;
  if (row.role === 'admin' && row.enabled) {
    const admins = getDb().prepare("SELECT COUNT(*) count FROM users WHERE role='admin' AND enabled=1").get().count;
    if (admins <= 1) throw new Error('至少需要保留一个启用的管理员');
  }
  return getDb().prepare('DELETE FROM users WHERE id=?').run(id).changes > 0;
}

function recordAudit(user, action, target = '', detail = '') {
  getDb().prepare('INSERT INTO audit_logs (user_id, username, action, target, detail, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(user?.id || null, user?.username || '', String(action).slice(0, 100), String(target).slice(0, 500), String(detail).slice(0, 2000), new Date().toISOString());
}

function getAuditLogs(limit = 200) {
  return getDb().prepare('SELECT * FROM audit_logs ORDER BY id DESC LIMIT ?').all(Math.min(500, Math.max(1, Number(limit) || 200)));
}

function getUserPreferences(userId) {
  const row = getDb().prepare('SELECT value FROM user_preferences WHERE user_id=?').get(Number(userId));
  try { return JSON.parse(row?.value || '{}'); } catch (_) { return {}; }
}

function updateUserPreferences(userId, value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('用户偏好格式错误');
  const json = JSON.stringify(value);
  if (json.length > 100000) throw new Error('用户偏好数据过大');
  getDb().prepare(`INSERT INTO user_preferences (user_id, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`)
    .run(Number(userId), json, new Date().toISOString());
  return value;
}

function getAllProductLabels() {
  return getDb().prepare(`
    SELECT product_key, name, category, confidence, manual, created_at,
           classification_json, classification_version, classification_source
    FROM product_labels
    ORDER BY manual DESC, id DESC
  `).all().map(serializeProductLabel);
}

function saveClassificationResult(productKey, name, result, source = 'rules-v3') {
  if (!result || typeof result !== 'object' || result.version !== RULE_VERSION) throw new Error('分类结果格式错误');
  validateCategory(result.category);
  const existing = getProductLabel(productKey);
  if (existing?.manual) return { label: existing, skipped: true };
  getDb().prepare(`
    INSERT INTO product_labels
      (product_key, name, category, confidence, manual, classification_json, classification_version, classification_source)
    VALUES (?, ?, ?, ?, 0, ?, ?, ?)
    ON CONFLICT(product_key) DO UPDATE SET
      name=excluded.name, category=excluded.category, confidence=excluded.confidence,
      classification_json=excluded.classification_json,
      classification_version=excluded.classification_version,
      classification_source=excluded.classification_source
  `).run(
    productKey,
    String(name || '').slice(0, 1000),
    result.category,
    Number(result.dimensions?.product?.confidence || 0),
    JSON.stringify(result),
    result.version,
    String(source || 'rules-v3').slice(0, 40),
  );
  return { label: getProductLabel(productKey), skipped: false };
}

function recordClassificationFeedback(productKey, name, dimension, oldValue, newValue) {
  if (!/^[a-z][a-z0-9_-]{0,39}$/.test(String(dimension || ''))) throw new Error('反馈维度格式错误');
  if (!/^[a-z][a-z0-9_-]{0,79}$/.test(String(newValue || ''))) throw new Error('反馈值格式错误');
  getDb().prepare(`
    INSERT INTO classification_feedback (product_key, name, dimension, old_value, new_value, classification_version)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(productKey, String(name || '').slice(0, 1000), dimension, oldValue || null, newValue, RULE_VERSION);
}

const CLASSIFICATION_ATTRIBUTE_VALUES = {
  verification: new Set(['unverified', 'verified', 'not_required', 'unknown']),
  activation: new Set(['self_service', 'ready_account', 'top_up', 'invite_link', 'redeem_code', 'unknown']),
  warranty: new Set(['no_warranty', 'warranty', 'unknown']),
  usage: new Set(['exclusive', 'shared', 'unknown']),
  qualification: new Set(['k12', 'higher_education', 'teacher', 'student', 'enterprise', 'unknown']),
};

function setProductClassificationAttributes(productKey, name, attributes) {
  if (!attributes || typeof attributes !== 'object' || Array.isArray(attributes)) throw new Error('分类属性格式错误');
  const db = getDb();
  const existing = getProductLabel(productKey);
  if (!existing) throw new Error('商品标签不存在');
  const previous = existing.classification && typeof existing.classification === 'object' ? existing.classification : {};
  const previousAttributes = previous.attributes && typeof previous.attributes === 'object' ? previous.attributes : {};
  const normalized = { ...previousAttributes };
  const changes = [];
  for (const [dimension, allowed] of Object.entries(CLASSIFICATION_ATTRIBUTE_VALUES)) {
    if (!(dimension in attributes)) continue;
    const value = String(attributes[dimension] || 'unknown');
    if (!allowed.has(value)) throw new Error(`分类属性值错误: ${dimension}`);
    if (value === 'unknown') delete normalized[dimension]; else normalized[dimension] = value;
    const oldValue = previousAttributes[dimension] || 'unknown';
    if (oldValue !== value) changes.push({ dimension, oldValue, newValue: value });
  }
  const classification = {
    ...previous,
    version: RULE_VERSION,
    category: existing.category,
    attributes: normalized,
  };
  const transaction = db.transaction(() => {
    db.prepare(`UPDATE product_labels SET classification_json=?, classification_version=?,
      classification_source='manual', manual=1 WHERE product_key=?`)
      .run(JSON.stringify(classification), RULE_VERSION, productKey);
    for (const change of changes) {
      recordClassificationFeedback(productKey, name, change.dimension, change.oldValue, change.newValue);
    }
  });
  transaction();
  return { label: getProductLabel(productKey), changes };
}

function getClassificationFeedback(limit = 200) {
  return getDb().prepare('SELECT * FROM classification_feedback ORDER BY created_at DESC, id DESC LIMIT ?')
    .all(Math.max(1, Math.min(1000, Number(limit) || 200)));
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
  const classificationConfig = getClassificationConfig();
  const refreshConfig = getRefreshConfig();
  const productLabels = db.prepare(`SELECT product_key, name, category, confidence, manual, created_at,
    classification_json, classification_version, classification_source FROM product_labels`).all();
  const labelChanges = db.prepare('SELECT product_key, name, old_category, new_category, changed_at FROM label_changes').all();
  const classificationFeedback = db.prepare(`SELECT product_key, name, dimension, old_value, new_value,
    classification_version, created_at FROM classification_feedback`).all();
  return { stores, priceHistory, filterConfig, classificationConfig, refreshConfig, storeOrder: getStoreOrder(), productLabels, labelChanges, classificationFeedback };
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
  const rawMeta = input.refreshMeta && typeof input.refreshMeta === 'object' && !Array.isArray(input.refreshMeta) ? input.refreshMeta : {};
  const refreshMeta = {
    plusGoodsTypes: Array.isArray(rawMeta.plusGoodsTypes) ? rawMeta.plusGoodsTypes.filter(type => ['card', 'article', 'resource', 'equity'].includes(type)).slice(0, 4) : [],
    focusGoodsTypes: Array.isArray(rawMeta.focusGoodsTypes) ? rawMeta.focusGoodsTypes.filter(type => ['card', 'article', 'resource', 'equity'].includes(type)).slice(0, 4) : [],
    plusLastUpdated: rawMeta.plusLastUpdated && !Number.isNaN(Date.parse(rawMeta.plusLastUpdated)) ? new Date(rawMeta.plusLastUpdated).toISOString() : null,
    lastTypeProbeAt: rawMeta.lastTypeProbeAt && !Number.isNaN(Date.parse(rawMeta.lastTypeProbeAt)) ? new Date(rawMeta.lastTypeProbeAt).toISOString() : null,
    lastCatalogAttemptAt: rawMeta.lastCatalogAttemptAt && !Number.isNaN(Date.parse(rawMeta.lastCatalogAttemptAt)) ? new Date(rawMeta.lastCatalogAttemptAt).toISOString() : null,
    lastCatalogRefreshAt: rawMeta.lastCatalogRefreshAt && !Number.isNaN(Date.parse(rawMeta.lastCatalogRefreshAt)) ? new Date(rawMeta.lastCatalogRefreshAt).toISOString() : null,
  };
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
    refreshMeta,
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
      if (rows.length > MAX_HISTORY_IMPORT_ROWS) throw new Error(`历史记录总数超过限制（最多 ${MAX_HISTORY_IMPORT_ROWS} 条）`);
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
  const classificationConfig = data.classificationConfig
    ? migrateClassificationConfig(data.classificationConfig)
    : null;
  const productLabels = data.productLabels === undefined ? [] : data.productLabels;
  if (!Array.isArray(productLabels) || productLabels.length > 100000) throw new Error('商品标签格式错误');
  if (productLabels) {
    for (const label of productLabels) {
      if (!label || typeof label !== 'object') throw new Error('商品标签格式错误');
      validateCategory(label.category);
      const ownerId = String(label.product_key || '').split(':')[0];
      if (!storeIds.has(ownerId)) throw new Error('商品标签引用了不存在的店铺');
    }
  }
  const storeOrder = data.storeOrder === undefined ? [] : normalizeStoreOrder(data.storeOrder);
  if (storeOrder.some(id => !storeIds.has(id))) throw new Error('storeOrder references an unknown store');
  const labelChanges = Array.isArray(data.labelChanges) ? data.labelChanges : [];
  if (labelChanges.length > 100000) throw new Error('鍒嗙被鍙樻洿璁板綍瓒呰繃闄愬埗');
  for (const change of labelChanges) {
    if (!change || typeof change !== 'object') throw new Error('鍒嗙被鍙樻洿璁板綍鏍煎紡閿欒');
    const ownerId = String(change.product_key || '').split(':')[0];
    if (!storeIds.has(ownerId)) throw new Error('label change references an unknown store');
    validateCategory(change.new_category);
    if (change.old_category) validateCategory(change.old_category);
  }
  const classificationFeedback = Array.isArray(data.classificationFeedback) ? data.classificationFeedback : [];
  if (classificationFeedback.length > 100000) throw new Error('分类反馈记录超过限制');
  for (const feedback of classificationFeedback) {
    if (!feedback || typeof feedback !== 'object') throw new Error('分类反馈记录格式错误');
    const ownerId = String(feedback.product_key || '').split(':')[0];
    if (!storeIds.has(ownerId)) throw new Error('分类反馈引用了不存在的店铺');
    if (!/^[a-z][a-z0-9_-]{0,39}$/.test(String(feedback.dimension || ''))) throw new Error('分类反馈维度格式错误');
    if (!/^[a-z][a-z0-9_-]{0,79}$/.test(String(feedback.new_value || ''))) throw new Error('分类反馈值格式错误');
  }
  const transaction = db.transaction(() => {
    db.exec('DELETE FROM price_history; DELETE FROM stores; DELETE FROM config');
    const insertStore = db.prepare('INSERT INTO stores (id, url, name, addedAt, lastUpdated, status, error, products, refresh_meta) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
    for (const s of stores) {
      insertStore.run(s.id, s.url, s.name || '', s.addedAt || '', s.lastUpdated || null, s.status || 'ok', s.error || '', JSON.stringify(s.products || []), JSON.stringify(s.refreshMeta || {}));
    }
    if (storeOrder.length) {
      db.prepare("INSERT OR REPLACE INTO config (key, value) VALUES ('storeOrder', ?)").run(JSON.stringify(storeOrder));
    }
    const insertHistory = db.prepare('INSERT OR IGNORE INTO price_history (product_key, price, stock, date) VALUES (?, ?, ?, ?)');
    for (const row of historyRows) insertHistory.run(row.productKey, row.price, row.stock ?? null, row.date);
    if (data.filterConfig) {
      db.prepare('INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)').run('filterConfig', JSON.stringify(data.filterConfig));
    }
    if (refreshConfig) {
      db.prepare('INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)').run('refreshConfig', JSON.stringify(refreshConfig));
    }
    if (classificationConfig) {
      db.prepare('INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)').run('classificationConfig', JSON.stringify(classificationConfig));
    }
    if (productLabels) {
      db.exec('DELETE FROM product_labels; DELETE FROM label_changes; DELETE FROM classification_feedback');
      const insertLabel = db.prepare(`INSERT INTO product_labels
        (product_key, name, category, confidence, manual, created_at, classification_json, classification_version, classification_source)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      for (const label of productLabels) {
        insertLabel.run(label.product_key, String(label.name || '').slice(0, 1000), label.category, Number(label.confidence) || 1, label.manual ? 1 : 0, label.created_at || new Date().toISOString(), label.classification_json || JSON.stringify(label.classification || {}), Number(label.classification_version) || 1, String(label.classification_source || 'import').slice(0, 40));
      }
      const insertChange = db.prepare('INSERT INTO label_changes (product_key, name, old_category, new_category, changed_at) VALUES (?, ?, ?, ?, ?)');
      for (const change of labelChanges) {
        insertChange.run(change.product_key, String(change.name || '').slice(0, 1000), change.old_category || null, change.new_category, change.changed_at || new Date().toISOString());
      }
      const insertFeedback = db.prepare(`INSERT INTO classification_feedback
        (product_key, name, dimension, old_value, new_value, classification_version, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`);
      for (const feedback of classificationFeedback) {
        insertFeedback.run(feedback.product_key, String(feedback.name || '').slice(0, 1000), feedback.dimension, feedback.old_value || null, feedback.new_value, Number(feedback.classification_version) || RULE_VERSION, feedback.created_at || new Date().toISOString());
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
  const productLabels = db.prepare(`SELECT product_key, name, category, confidence, manual, created_at,
    classification_json, classification_version, classification_source FROM product_labels WHERE product_key LIKE ?`).all(prefix + '%');
  const labelChanges = db.prepare('SELECT product_key, name, old_category, new_category, changed_at FROM label_changes WHERE product_key LIKE ?').all(prefix + '%');
  const classificationFeedback = db.prepare(`SELECT product_key, name, dimension, old_value, new_value,
    classification_version, created_at FROM classification_feedback WHERE product_key LIKE ?`).all(prefix + '%');
  return { stores: [s], priceHistory, productLabels, labelChanges, classificationFeedback, exportedAt: new Date().toISOString() };
}

function importSingleStore(data) {
  const db = getDb();
  if (!data || typeof data !== 'object') throw new Error('数据格式错误');
  if (!Array.isArray(data.stores) || data.stores.length !== 1) throw new Error('单店铺导入必须包含一个店铺');
  const s = normalizeStoreRecord(data.stores[0]);
  const historyRows = normalizeHistory(data, new Set([s.id]), s.id);
  const productLabels = data.productLabels === undefined ? [] : data.productLabels;
  if (!Array.isArray(productLabels) || productLabels.length > 100000) throw new Error('鍟嗗搧鏍囩鏍煎紡閿欒');
  for (const label of productLabels) {
    if (!label || typeof label !== 'object' || !String(label.product_key || '').startsWith(`${s.id}:`)) throw new Error('label references another store');
    validateCategory(label.category);
  }
  const labelChanges = Array.isArray(data.labelChanges) ? data.labelChanges : [];
  if (labelChanges.length > 100000) throw new Error('鍒嗙被鍙樻洿璁板綍瓒呰繃闄愬埗');
  for (const change of labelChanges) {
    if (!change || typeof change !== 'object' || !String(change.product_key || '').startsWith(`${s.id}:`)) throw new Error('label change references another store');
    validateCategory(change.new_category);
    if (change.old_category) validateCategory(change.old_category);
  }
  const classificationFeedback = Array.isArray(data.classificationFeedback) ? data.classificationFeedback : [];
  if (classificationFeedback.length > 100000) throw new Error('分类反馈记录超过限制');
  for (const feedback of classificationFeedback) {
    if (!feedback || typeof feedback !== 'object' || !String(feedback.product_key || '').startsWith(`${s.id}:`)) throw new Error('分类反馈引用了其他店铺');
    if (!/^[a-z][a-z0-9_-]{0,39}$/.test(String(feedback.dimension || ''))) throw new Error('分类反馈维度格式错误');
    if (!/^[a-z][a-z0-9_-]{0,79}$/.test(String(feedback.new_value || ''))) throw new Error('分类反馈值格式错误');
  }
  const transaction = db.transaction(() => {
    const existing = db.prepare('SELECT id FROM stores WHERE id = ?').get(s.id);
    if (existing) {
      db.prepare('UPDATE stores SET url=?, name=?, lastUpdated=?, status=?, error=?, products=?, refresh_meta=? WHERE id=?')
        .run(s.url, s.name, s.lastUpdated, s.status, s.error, JSON.stringify(s.products), JSON.stringify(s.refreshMeta || {}), s.id);
      db.prepare('DELETE FROM price_history WHERE product_key LIKE ?').run(s.id + ':%');
    } else {
      db.prepare('INSERT INTO stores (id, url, name, addedAt, lastUpdated, status, error, products, refresh_meta) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(s.id, s.url, s.name, s.addedAt, s.lastUpdated, s.status, s.error, JSON.stringify(s.products), JSON.stringify(s.refreshMeta || {}));
    }
    const insertHistory = db.prepare('INSERT OR IGNORE INTO price_history (product_key, price, stock, date) VALUES (?, ?, ?, ?)');
    for (const row of historyRows) insertHistory.run(row.productKey, row.price, row.stock ?? null, row.date);
    const productKeys = new Set(s.products.map(product => `${s.id}:${product.id}`));
    const deleteLabels = db.prepare('DELETE FROM product_labels WHERE product_key = ?');
    const deleteChanges = db.prepare('DELETE FROM label_changes WHERE product_key = ?');
    const deleteFeedback = db.prepare('DELETE FROM classification_feedback WHERE product_key = ?');
    for (const productKey of productKeys) {
      deleteLabels.run(productKey);
      deleteChanges.run(productKey);
      deleteFeedback.run(productKey);
    }
    const insertLabel = db.prepare(`INSERT INTO product_labels
      (product_key, name, category, confidence, manual, created_at, classification_json, classification_version, classification_source)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const label of productLabels) {
      insertLabel.run(label.product_key, String(label.name || '').slice(0, 1000), label.category, Number(label.confidence) || 1, label.manual ? 1 : 0, label.created_at || new Date().toISOString(), label.classification_json || JSON.stringify(label.classification || {}), Number(label.classification_version) || 1, String(label.classification_source || 'import').slice(0, 40));
    }
    const insertChange = db.prepare('INSERT INTO label_changes (product_key, name, old_category, new_category, changed_at) VALUES (?, ?, ?, ?, ?)');
    for (const change of labelChanges) {
      insertChange.run(change.product_key, String(change.name || '').slice(0, 1000), change.old_category || null, change.new_category, change.changed_at || new Date().toISOString());
    }
    const insertFeedback = db.prepare(`INSERT INTO classification_feedback
      (product_key, name, dimension, old_value, new_value, classification_version, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`);
    for (const feedback of classificationFeedback) {
        insertFeedback.run(feedback.product_key, String(feedback.name || '').slice(0, 1000), feedback.dimension, feedback.old_value || null, feedback.new_value, Number(feedback.classification_version) || RULE_VERSION, feedback.created_at || new Date().toISOString());
    }
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

function mergeFocusedProducts(storeId, fetchedProducts, metaUpdates = {}) {
  const current = getStore(storeId);
  if (!current) return null;
  const fetchedById = new Map(fetchedProducts.map(product => [String(product.id), product]));
  const isFocused = product => /plus|k12/i.test(String(product.name || ''));
  const products = current.products.map(product => {
    const fresh = fetchedById.get(String(product.id));
    if (fresh) {
      fetchedById.delete(String(product.id));
      return { ...product, ...fresh, plusMissingCount: 0, refreshUnavailable: false };
    }
    if (!isFocused(product)) return product;
    const plusMissingCount = Math.min(2, Number(product.plusMissingCount || 0) + 1);
    return plusMissingCount >= 2
      ? { ...product, plusMissingCount, stock: 0, refreshUnavailable: true }
      : { ...product, plusMissingCount, refreshUnavailable: true };
  });
  for (const product of fetchedById.values()) products.push({ ...product, plusMissingCount: 0, refreshUnavailable: false });
  const now = new Date().toISOString();
  const refreshMeta = { ...(current.refreshMeta || {}), ...metaUpdates, plusLastUpdated: now };
  return updateStore(storeId, { products, refreshMeta, lastUpdated: now, status: 'pending', error: '' });
}

const mergePlusProducts = mergeFocusedProducts;

function getProductLabelsForStores(storeIds) {
  const ids = [...new Set((storeIds || []).map(String))].slice(0, 20);
  if (!ids.length) return [];
  const conditions = ids.map(() => '(product_key >= ? AND product_key < ?)').join(' OR ');
  return getDb().prepare(`
    SELECT product_key, name, category, confidence, manual, created_at,
           classification_json, classification_version, classification_source
    FROM product_labels
    WHERE ${conditions}
    ORDER BY manual DESC, id DESC
  `).all(...ids.flatMap(id => [`${id}:`, `${id};`])).map(serializeProductLabel);
}

function clearSystemData() {
  const db = getDb();
  const tables = [
    'stores',
    'price_history',
    'config',
    'product_labels',
    'label_changes',
    'classification_feedback',
    'user_preferences',
    'audit_logs',
  ];
  const counts = Object.fromEntries(tables.map(table => [
    table,
    db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count,
  ]));
  const transaction = db.transaction(() => {
    db.exec(`
      DELETE FROM price_history;
      DELETE FROM product_labels;
      DELETE FROM label_changes;
      DELETE FROM classification_feedback;
      DELETE FROM stores;
      DELETE FROM config;
      DELETE FROM user_preferences;
      DELETE FROM audit_logs;
    `);
    db.prepare(`DELETE FROM sqlite_sequence WHERE name IN (${tables.map(() => '?').join(',')})`).run(...tables);
  });
  transaction();
  return counts;
}

module.exports = {
  getAllStores, getStoresByIds, getStoreSummaries, getStore, addStore, importStoreList, removeStore, updateStore, mergeFocusedProducts, mergePlusProducts,
  recordPrices, getPriceHistory, getPriceHistoryForProducts,
  getFilterConfig, updateFilterConfig,
  getClassificationConfig, updateClassificationConfig,
  getRefreshConfig, updateRefreshConfig, getRefreshProxyConfig, updateRefreshProxyConfig,
  getRefreshRuntimeState, updateRefreshRuntimeState, updateStoreRefreshMeta,
  exportAllData, importAllData, exportStore, importSingleStore,
  getProductLabel, upsertProductLabel, setProductLabel, getLabeledData, getAllProductLabels, getProductLabelsForStores, recordLabelChange, getLabelChanges,
  saveClassificationResult, recordClassificationFeedback, getClassificationFeedback,
  setProductClassificationAttributes,
  getStoreOrder, updateStoreOrder,
  exportStoreHistory, exportAllHistory, importStoreHistory, importAllHistory,
  getUserCount, listUsers, createUser, authenticateUser, createAuthSession, resolveAuthSession, deleteAuthSession,
  updateUser, deleteUser, recordAudit, getAuditLogs, getUserPreferences, updateUserPreferences,
  clearSystemData,
};
