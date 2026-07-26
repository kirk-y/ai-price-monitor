const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

test('history imports are idempotent and unsafe backup IDs are rejected', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-price-monitor-'));
  const dbPath = path.join(tempDir, 'test.db');
  const script = `
    const assert = require('node:assert/strict');
    const store = require('./store');
    store.addStore('https://pay.ldxp.cn/shop/test_store');
    const payload = { priceHistory: { 'test_store:item1': [{ price: 9.9, date: '2026-07-23T00:00:00.000Z' }] } };
    store.importAllHistory(payload);
    store.importAllHistory(payload);
    assert.equal(store.getPriceHistory('test_store:item1').length, 1);
    assert.throws(() => store.importAllData({ stores: [{ id: 'bad\\"id', url: 'https://pay.ldxp.cn/shop/test_store', products: [] }] }));
  `;

  const result = spawnSync(process.execPath, ['-e', script], {
    cwd: path.resolve(__dirname, '..'),
    env: { ...process.env, DB_PATH: dbPath },
    encoding: 'utf8',
  });
  try {
    assert.equal(result.status, 0, result.stderr || result.stdout);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('schema migration removes legacy duplicate history before adding the unique index', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-price-monitor-migration-'));
  const dbPath = path.join(tempDir, 'legacy.db');
  const script = `
    const assert = require('node:assert/strict');
    const Database = require('better-sqlite3');
    let db = new Database(process.env.DB_PATH);
    db.exec('CREATE TABLE price_history (id INTEGER PRIMARY KEY AUTOINCREMENT, product_key TEXT NOT NULL, price REAL NOT NULL, date TEXT NOT NULL)');
    const insert = db.prepare('INSERT INTO price_history (product_key, price, date) VALUES (?, ?, ?)');
    insert.run('legacy:item', 10, '2026-07-23T00:00:00.000Z');
    insert.run('legacy:item', 10, '2026-07-23T00:00:00.000Z');
    db.close();
    const store = require('./store');
    store.getAllStores();
    db = new Database(process.env.DB_PATH, { readonly: true });
    assert.equal(db.prepare('SELECT COUNT(*) count FROM price_history').get().count, 1);
    assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_price_history_unique'").get());
    db.close();
  `;
  const result = spawnSync(process.execPath, ['-e', script], {
    cwd: path.resolve(__dirname, '..'),
    env: { ...process.env, DB_PATH: dbPath },
    encoding: 'utf8',
  });
  try {
    assert.equal(result.status, 0, result.stderr || result.stdout);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('manual category updates keep labels and change records associated', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-price-monitor-labels-'));
  const dbPath = path.join(tempDir, 'labels.db');
  const script = `
    const assert = require('node:assert/strict');
    const store = require('./store');

    let result = store.setProductLabel('shop:item1', 'Item one', 'claude_pro', 'plus_未接码');
    assert.equal(result.changed, true);
    assert.equal(result.label.category, 'claude_pro');
    assert.equal(store.getLabelChanges()[0].old_category, 'plus_未接码');
    assert.equal(store.getLabelChanges()[0].new_category, 'claude_pro');

    result = store.setProductLabel('shop:item1', 'Renamed item', 'gemini_pro年卡', 'claude_pro');
    assert.equal(result.changed, true);
    assert.equal(result.label.name, 'Renamed item');
    assert.equal(result.label.category, 'gemini_pro年卡');
    assert.equal(store.getLabelChanges()[0].product_key, 'shop:item1');
    assert.equal(store.getLabelChanges()[0].old_category, 'claude_pro');
    assert.equal(store.getLabelChanges()[0].new_category, 'gemini_pro年卡');
  `;

  const result = spawnSync(process.execPath, ['-e', script], {
    cwd: path.resolve(__dirname, '..'),
    env: { ...process.env, DB_PATH: dbPath },
    encoding: 'utf8',
  });
  try {
    assert.equal(result.status, 0, result.stderr || result.stdout);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('all product labels include low-confidence classifications used by the UI', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-price-monitor-all-labels-'));
  const dbPath = path.join(tempDir, 'labels.db');
  const script = `
    const assert = require('node:assert/strict');
    const store = require('./store');
    store.saveClassificationResult('shop:uncertain', 'Ambiguous GPT item', {
      version: 2,
      category: 'gpt_plus',
      dimensions: { product: { value: 'gpt', confidence: 0.2 } },
      attributes: {},
      needsReview: true,
    });
    assert.equal(store.getLabeledData().length, 0);
    const labels = store.getAllProductLabels();
    assert.equal(labels.length, 1);
    assert.equal(labels[0].category, 'gpt_plus');
    assert.equal(labels[0].classification.needsReview, true);
  `;

  const result = spawnSync(process.execPath, ['-e', script], {
    cwd: path.resolve(__dirname, '..'),
    env: { ...process.env, DB_PATH: dbPath },
    encoding: 'utf8',
  });
  try {
    assert.equal(result.status, 0, result.stderr || result.stdout);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('user accounts hash passwords and revoke sessions on security changes', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-price-monitor-auth-'));
  const dbPath = path.join(tempDir, 'auth.db');
  const script = `
    const assert = require('node:assert/strict');
    const Database = require('better-sqlite3');
    const store = require('./store');
    const admin = store.createUser('admin_user', 'strong-password-1', 'admin');
    const viewer = store.createUser('viewer_user', 'strong-password-2', 'viewer');
    assert.equal(store.authenticateUser('admin_user', 'wrong-password'), null);
    assert.equal(store.authenticateUser('admin_user', 'strong-password-1').role, 'admin');
    const db = new Database(process.env.DB_PATH, { readonly: true });
    assert.equal(db.prepare('SELECT password_hash FROM users WHERE id=?').get(admin.id).password_hash.includes('strong-password-1'), false);
    db.close();
    const session = store.createAuthSession(viewer.id);
    assert.equal(store.resolveAuthSession(session.token).username, 'viewer_user');
    store.updateUser(viewer.id, { password: 'changed-password-3' }, admin.id);
    assert.equal(store.resolveAuthSession(session.token), null);
    assert.equal(store.authenticateUser('viewer_user', 'strong-password-2'), null);
    assert.equal(store.authenticateUser('viewer_user', 'changed-password-3').role, 'viewer');
    assert.throws(() => store.updateUser(admin.id, { enabled: false }, admin.id));
    assert.throws(() => store.deleteUser(admin.id, admin.id));
  `;
  const result = spawnSync(process.execPath, ['-e', script], {
    cwd: path.resolve(__dirname, '..'), env: { ...process.env, DB_PATH: dbPath }, encoding: 'utf8',
  });
  try { assert.equal(result.status, 0, result.stderr || result.stdout); }
  finally { fs.rmSync(tempDir, { recursive: true, force: true }); }
});

test('structured classifications and per-dimension feedback survive backups', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-price-monitor-classification-'));
  const dbPath = path.join(tempDir, 'classification.db');
  const script = `
    const assert = require('node:assert/strict');
    const store = require('./store');
    const { classifyProduct } = require('./classification');
    const shop = store.addStore('https://pay.ldxp.cn/shop/rules');
    store.updateStore(shop.id, { products: [{ id: 'p1', name: 'GPT Plus 未接码 自助开通 质保30天', price: 10, stock: 1 }] });
    const classified = classifyProduct('GPT Plus 未接码 自助开通 质保30天');
    store.saveClassificationResult('rules:p1', classified.name, classified);
    let label = store.getProductLabel('rules:p1');
    assert.equal(label.category, 'gpt_plus');
    assert.equal(label.classification.attributes.verification, 'unverified');
    store.setProductLabel('rules:p1', classified.name, 'gpt_plus', 'gpt_plus');
    store.setProductClassificationAttributes('rules:p1', classified.name, { verification: 'verified', warranty: 'warranty' });
    label = store.getProductLabel('rules:p1');
    assert.equal(label.classification.attributes.verification, 'verified');
    assert.equal(store.getClassificationFeedback()[0].new_value, 'verified');
    const backup = store.exportAllData();
    assert.equal(backup.classificationConfig.version, 2);
    assert.equal(backup.classificationFeedback.length, 1);
    store.importAllData(backup);
    assert.equal(store.getProductLabel('rules:p1').classification.attributes.verification, 'verified');
    assert.equal(store.getClassificationFeedback()[0].dimension, 'verification');
    const single = store.exportStore('rules');
    store.importSingleStore(single);
    assert.equal(store.getProductLabel('rules:p1').classification.attributes.warranty, 'warranty');
    assert.equal(store.getClassificationFeedback().length, 1);
  `;
  const result = spawnSync(process.execPath, ['-e', script], {
    cwd: path.resolve(__dirname, '..'),
    env: { ...process.env, DB_PATH: dbPath },
    encoding: 'utf8',
  });
  try {
    assert.equal(result.status, 0, result.stderr || result.stdout);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('full and single store backups preserve labels, history, and store order', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-price-monitor-backup-'));
  const dbPath = path.join(tempDir, 'backup.db');
  const script = `
    const assert = require('node:assert/strict');
    const store = require('./store');
    const s1 = store.addStore('https://pay.ldxp.cn/shop/alpha');
    const s2 = store.addStore('https://pay.ldxp.cn/shop/beta');
    store.updateStore(s1.id, { products: [{ id: 'p1', name: 'Alpha', price: 12, stock: 3, purchaseUrl: 'https://pay.ldxp.cn/shop/alpha' }] });
    store.updateStore(s2.id, { products: [{ id: 'p2', name: 'Beta', price: 22, stock: 2, purchaseUrl: 'https://pay.ldxp.cn/shop/beta' }] });
    store.setProductLabel('alpha:p1', 'Alpha', 'plus_未接码');
    store.setProductLabel('alpha:p1', 'Alpha', 'claude_pro', 'plus_未接码');
    store.setProductLabel('beta:p2', 'Beta', 'gpt_team');
    store.importAllHistory({ priceHistory: {
      'alpha:p1': [{ price: 12, stock: 3, date: '2026-07-23T00:00:00.000Z' }],
      'beta:p2': [{ price: 22, stock: 2, date: '2026-07-23T00:00:00.000Z' }]
    }});
    store.updateStoreOrder(['beta', 'alpha']);
    const backup = store.exportAllData();
    assert.deepEqual(backup.storeOrder, ['beta', 'alpha']);
    assert.equal(backup.productLabels.length, 2);
    assert.equal(backup.labelChanges.length, 1);

    store.removeStore('alpha');
    store.importAllData(backup);
    assert.equal(store.getAllStores().length, 2);
    assert.equal(store.getPriceHistory('alpha:p1').length, 1);
    assert.equal(store.getProductLabel('alpha:p1').category, 'claude_pro');
    assert.equal(store.getLabelChanges()[0].old_category, 'plus_未接码');
    assert.deepEqual(store.getStoreOrder(), ['beta', 'alpha']);

    const single = store.exportStore('alpha');
    store.setProductLabel('beta:p2', 'Beta', 'claude_pro', 'gpt_team');
    store.importSingleStore(single);
    assert.equal(store.getProductLabel('alpha:p1').category, 'claude_pro');
    assert.equal(store.getProductLabel('beta:p2').category, 'claude_pro');
    assert.equal(store.getPriceHistory('alpha:p1').length, 1);

    const before = store.getAllStores().map(item => item.id).sort();
    assert.throws(() => store.importAllData({ ...backup, storeOrder: ['missing'] }));
    assert.deepEqual(store.getAllStores().map(item => item.id).sort(), before);
  `;
  const result = spawnSync(process.execPath, ['-e', script], {
    cwd: path.resolve(__dirname, '..'),
    env: { ...process.env, DB_PATH: dbPath },
    encoding: 'utf8',
  });
  try {
    assert.equal(result.status, 0, result.stderr || result.stdout);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('store list import is transactional and deduplicates entries', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-price-monitor-store-list-'));
  const dbPath = path.join(tempDir, 'stores.db');
  const script = `
    const assert = require('node:assert/strict');
    const store = require('./store');
    const result = store.importStoreList([
      { url: 'https://pay.ldxp.cn/shop/one', name: 'One' },
      { url: 'https://pay.ldxp.cn/shop/one', name: 'Duplicate' },
      { url: 'https://pay.ldxp.cn/shop/two' },
      { url: 'https://example.com/shop/invalid' }
    ]);
    assert.deepEqual(result.addedIds.sort(), ['one', 'two']);
    assert.equal(result.skipped, 2);
    assert.equal(store.getStore('one').status, 'pending');
    assert.equal(store.getStore('one').name, 'One');
    assert.equal(store.getAllStores().length, 2);
  `;
  const result = spawnSync(process.execPath, ['-e', script], {
    cwd: path.resolve(__dirname, '..'),
    env: { ...process.env, DB_PATH: dbPath },
    encoding: 'utf8',
  });
  try {
    assert.equal(result.status, 0, result.stderr || result.stdout);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
