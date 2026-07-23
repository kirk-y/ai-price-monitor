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
