const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const playwright = require('playwright-core');

function fakeContext(page) {
  const context = new EventEmitter();
  let connected = true;
  context.browser = () => ({ isConnected: () => connected });
  context.pages = () => [page];
  context.newPage = async () => page;
  context.close = async () => {
    if (!connected) return;
    connected = false;
    context.emit('close');
  };
  return context;
}

function fakePage({ failOnce = false, failureMessage = '' } = {}) {
  let failed = false;
  const calls = { goto: [], api: [] };
  return {
    calls,
    isClosed: () => false,
    setDefaultTimeout() {},
    setDefaultNavigationTimeout() {},
    route: async () => {},
    unroute: async () => {},
    goto: async url => {
      calls.goto.push(url);
      return { status: () => 200 };
    },
    waitForTimeout: async () => {},
    waitForFunction: async () => {},
    evaluate: async (_fn, args) => {
      if (!args) return 'shop';
      if (failureMessage && !failed) {
        failed = true;
        return { networkError: failureMessage };
      }
      if (failOnce && !failed) {
        failed = true;
        throw new Error('browserContext.newPage: Target page, context or browser has been closed');
      }
      calls.api.push(args);
      const suffix = args.payload.keywords === 'k12' ? 'k12' : 'plus';
      const item = { goods_key: `${args.payload.token}-${suffix}`, name: suffix === 'k12' ? 'GPT K12' : 'GPT Plus', price: 10, extend: { stock_count: 1 } };
      return { status: 200, contentType: 'application/json', body: JSON.stringify({ code: 1, data: { list: [item], total: 1 } }) };
    },
  };
}

async function withFakeBrowser(pages, run) {
  const originalLaunch = playwright.chromium.launchPersistentContext;
  const originalExecutable = process.env.SHOP_BROWSER_EXECUTABLE;
  const originalProfile = process.env.SHOP_BROWSER_PROFILE_PATH;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-collector-test-'));
  let launches = 0;
  process.env.SHOP_BROWSER_EXECUTABLE = __filename;
  process.env.SHOP_BROWSER_PROFILE_PATH = tempDir;
  playwright.chromium.launchPersistentContext = async () => fakeContext(pages[launches++]);
  delete require.cache[require.resolve('../browser-collector')];
  const collector = require('../browser-collector');
  try {
    await run(collector, () => launches);
  } finally {
    await collector.closeCollector();
    playwright.chromium.launchPersistentContext = originalLaunch;
    if (originalExecutable === undefined) delete process.env.SHOP_BROWSER_EXECUTABLE;
    else process.env.SHOP_BROWSER_EXECUTABLE = originalExecutable;
    if (originalProfile === undefined) delete process.env.SHOP_BROWSER_PROFILE_PATH;
    else process.env.SHOP_BROWSER_PROFILE_PATH = originalProfile;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

test('browser collector reuses one session across stores', async () => {
  const page = fakePage();
  await withFakeBrowser([page], async (collector, launches) => {
    let requests = 0;
    const options = { preferredTypes: ['card'], beforeAttempt: () => { requests++; } };
    const first = await collector.collectShop('https://pay.ldxp.cn/shop/alpha', options);
    const second = await collector.collectShop('https://pay.ldxp.cn/shop/beta', options);

    assert.equal(launches(), 1);
    assert.equal(page.calls.goto.length, 1);
    assert.deepEqual(page.calls.api.map(call => call.payload.token), ['alpha', 'alpha', 'beta', 'beta']);
    assert.deepEqual(page.calls.api.map(call => call.payload.keywords), ['plus', 'k12', 'plus', 'k12']);
    assert.deepEqual(first.products.map(product => product.id), ['alpha-plus', 'alpha-k12']);
    assert.deepEqual(second.products.map(product => product.id), ['beta-plus', 'beta-k12']);
    assert.equal(requests, 5);
  });
});

test('browser collector rebuilds a closed session once', async () => {
  const failedPage = fakePage({ failOnce: true });
  const recoveredPage = fakePage();
  await withFakeBrowser([failedPage, recoveredPage], async (collector, launches) => {
    const result = await collector.collectShop('https://pay.ldxp.cn/shop/alpha', { preferredTypes: ['card'] });
    assert.equal(launches(), 2);
    assert.equal(result.products[0].id, 'alpha-plus');
    assert.equal(recoveredPage.calls.goto.length, 1);
  });
});

test('a second closed session becomes a provider failure', async () => {
  await withFakeBrowser([fakePage({ failOnce: true }), fakePage({ failOnce: true })], async (collector, launches) => {
    await assert.rejects(
      collector.collectShop('https://pay.ldxp.cn/shop/alpha', { preferredTypes: ['card'] }),
      error => error.code === 'UPSTREAM_UNAVAILABLE',
    );
    assert.equal(launches(), 2);
  });
});

test('browser fetch failure rebuilds the session once', async () => {
  const recoveredPage = fakePage();
  await withFakeBrowser([
    fakePage({ failureMessage: 'page.evaluate: TypeError: Failed to fetch' }),
    recoveredPage,
  ], async (collector, launches) => {
    const result = await collector.collectShop('https://pay.ldxp.cn/shop/alpha', { preferredTypes: ['card'] });
    assert.equal(launches(), 2);
    assert.equal(result.products[0].id, 'alpha-plus');
  });
});

test('repeated browser fetch failure stops the provider', async () => {
  const failed = () => fakePage({ failureMessage: 'page.evaluate: TypeError: Failed to fetch' });
  await withFakeBrowser([failed(), failed()], async (collector, launches) => {
    await assert.rejects(
      collector.collectShop('https://pay.ldxp.cn/shop/alpha', { preferredTypes: ['card'] }),
      error => error.code === 'UPSTREAM_UNAVAILABLE',
    );
    assert.equal(launches(), 2);
  });
});
