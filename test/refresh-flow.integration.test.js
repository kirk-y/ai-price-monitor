const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn, spawnSync } = require('node:child_process');

const projectRoot = path.resolve(__dirname, '..');

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(error => error ? reject(error) : resolve(port));
    });
  });
}

function runStoreScript(dbPath, source) {
  const result = spawnSync(process.execPath, ['-e', source], {
    cwd: projectRoot,
    env: { ...process.env, DB_PATH: dbPath },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

async function startApp({ port, upstreamPort, dbPath, immediateAuto = false }) {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: projectRoot,
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      DB_PATH: dbPath,
      REFRESH_LOG_PATH: path.join(path.dirname(dbPath), 'refresh-events.jsonl'),
      ADMIN_TOKEN: 'refresh-test-admin',
      SHOP_API_BASE: `http://127.0.0.1:${upstreamPort}`,
      REFRESH_STORE_DELAY_MIN: '0',
      REFRESH_STORE_DELAY_MAX: '0',
      AUTO_REFRESH_IMMEDIATE: immediateAuto ? 'true' : 'false',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`app exited early: ${output}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/refresh-status`);
      if (response.ok) return child;
    } catch (_) { /* Wait for the listener. */ }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  child.kill();
  throw new Error(`app did not start: ${output}`);
}

async function stopApp(child) {
  if (!child || child.exitCode !== null) return;
  child.kill();
  await new Promise(resolve => child.once('exit', resolve));
}

async function api(port, pathname, options = {}) {
  return fetch(`http://127.0.0.1:${port}${pathname}`, {
    ...options,
    headers: {
      Authorization: 'Bearer refresh-test-admin',
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(options.headers || {}),
    },
  });
}

async function waitFor(port, predicate, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const summaries = await (await api(port, '/api/stores/summary')).json();
    if (predicate(summaries)) return summaries;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('timed out waiting for refresh state');
}

test('refresh flow preserves data, opens a durable circuit, and recovers with one probe', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-price-monitor-refresh-flow-'));
  const dbPath = path.join(tempDir, 'stores.db');
  const appPort = await freePort();
  const upstreamPort = await freePort();
  let mode = 'success';
  let delayMs = 0;
  const calls = [];
  const upstream = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
    calls.push({ path: req.url, token: body.token });
    if (delayMs) await new Promise(resolve => setTimeout(resolve, delayMs));
    if (req.url === '/shopApi/Shop/info') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ code: 1, data: { nickname: `Shop ${body.token}` } }));
      return;
    }
    if (mode === 'challenge') {
      res.setHeader('Content-Type', 'text/html');
      res.end('<html><title>JavaScript verification</title></html>');
      return;
    }
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ code: 1, data: { total: 1, list: [{ goods_key: `${body.token}-plus`, name: 'GPT Plus 未接码', price: body.token === 'alpha' ? 10 : 20, extend: { stock_count: 3 }, link: `https://pay.ldxp.cn/item/${body.token}-plus` }] } }));
  });
  await new Promise(resolve => upstream.listen(upstreamPort, '127.0.0.1', resolve));

  runStoreScript(dbPath, `
    const store = require('./store');
    store.addStore('https://pay.ldxp.cn/shop/alpha');
    store.addStore('https://pay.ldxp.cn/shop/beta');
    store.updateRefreshConfig({ ...store.getRefreshConfig(), mode: 'disabled', collectorMode: 'direct' });
  `);

  let app;
  try {
    app = await startApp({ port: appPort, upstreamPort, dbPath });
    delayMs = 300;
    const first = await api(appPort, '/api/stores/refresh-all', {
      method: 'POST',
      body: JSON.stringify({ storeIds: ['alpha', 'beta'], refreshType: 'plus' }),
    });
    assert.equal(first.status, 200);
    const duplicate = await api(appPort, '/api/stores/refresh-all', {
      method: 'POST',
      body: JSON.stringify({ storeIds: ['alpha', 'beta'], refreshType: 'plus' }),
    });
    assert.equal(duplicate.status, 409);
    let summaries = await waitFor(appPort, rows => rows.every(row => row.refreshState === 'succeeded'));
    assert.deepEqual(summaries.map(row => row.productCount), [1, 1]);
    assert.deepEqual(calls.filter(call => call.path === '/shopApi/Shop/info').map(call => call.token), ['alpha', 'beta']);
    const completedStatus = await (await api(appPort, '/api/refresh-status')).json();
    assert.equal(completedStatus.activeBatchCount, 0);

    delayMs = 0;
    mode = 'challenge';
    const challenged = await api(appPort, '/api/stores/refresh-all', {
      method: 'POST',
      body: JSON.stringify({ storeIds: ['alpha', 'beta'], refreshType: 'plus' }),
    });
    assert.equal(challenged.status, 200);
    summaries = await waitFor(appPort, rows => rows.some(row => row.refreshState === 'failed'));
    const alpha = summaries.find(row => row.id === 'alpha');
    const beta = summaries.find(row => row.id === 'beta');
    assert.equal(alpha.productCount, 1);
    assert.equal(alpha.refreshState, 'failed');
    assert.equal(beta.productCount, 1);
    assert.equal(beta.refreshState, 'cancelled');

    const blocked = await api(appPort, '/api/stores/refresh-all', {
      method: 'POST',
      body: JSON.stringify({ storeIds: ['alpha'], refreshType: 'plus' }),
    });
    assert.equal(blocked.status, 503);
    const reset = await api(appPort, '/api/refresh-budget/reset', { method: 'POST' });
    assert.equal(reset.status, 200);
    const stillBlocked = await api(appPort, '/api/stores/alpha/refresh', { method: 'POST' });
    assert.equal(stillBlocked.status, 503);

    await stopApp(app);
    app = null;
    app = await startApp({ port: appPort, upstreamPort, dbPath });
    const persisted = await (await api(appPort, '/api/refresh-status')).json();
    assert.equal(persisted.provider.state, 'blocked');

    runStoreScript(dbPath, `require('./store').updateRefreshRuntimeState({ blockedUntil: Date.now() - 1 });`);
    mode = 'success';
    const probe = await api(appPort, '/api/stores/alpha/refresh', { method: 'POST' });
    assert.equal(probe.status, 200);
    summaries = await waitFor(appPort, rows => rows.find(row => row.id === 'alpha')?.refreshState === 'succeeded');
    assert.equal(summaries.find(row => row.id === 'alpha').productCount, 1);
    const recovered = await (await api(appPort, '/api/refresh-status')).json();
    assert.equal(recovered.provider.state, 'healthy');

    await stopApp(app);
    app = null;
    runStoreScript(dbPath, `
      const store = require('./store');
      store.updateRefreshConfig({ ...store.getRefreshConfig(), mode: 'fixed', fixedMinutes: 1, collectorMode: 'direct' });
      for (const item of store.getAllStores()) {
        store.updateStore(item.id, { status: 'ok', error: '', lastUpdated: '2020-01-01T00:00:00.000Z' });
        store.updateStoreRefreshMeta(item.id, { refreshState: 'idle', refreshError: '', lastAttemptAt: null, lastSuccessAt: '2020-01-01T00:00:00.000Z' });
      }
    `);
    const autoStartedAt = Date.now();
    app = await startApp({ port: appPort, upstreamPort, dbPath, immediateAuto: true });
    summaries = await waitFor(appPort, rows => rows.some(row => Date.parse(row.lastSuccessAt || 0) >= autoStartedAt));
    assert.equal(summaries.filter(row => Date.parse(row.lastSuccessAt || 0) >= autoStartedAt).length, 1);
    assert.equal(summaries.filter(row => row.refreshState === 'idle').length, 1);
    const autoStatus = await (await api(appPort, '/api/refresh-status')).json();
    assert.equal(autoStatus.recentEvents.some(event => event.event === 'store.started' && event.reason === 'auto'), true);
  } finally {
    await stopApp(app);
    await new Promise(resolve => upstream.close(resolve));
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
