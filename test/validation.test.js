const test = require('node:test');
const assert = require('node:assert/strict');
const {
  isLoopbackHost,
  normalizeRefreshConfig,
  normalizeRefreshProxyConfig,
  normalizeShopUrl,
  normalizeStoreOrder,
  validateCategory,
} = require('../validation');

test('normalizeShopUrl accepts and canonicalizes supported shop URLs', () => {
  assert.deepEqual(normalizeShopUrl('http://pay.ldxp.cn/shop/plus123/'), {
    id: 'plus123',
    url: 'https://pay.ldxp.cn/shop/plus123',
  });
});

test('normalizeShopUrl rejects other hosts and ambiguous URLs', () => {
  assert.throws(() => normalizeShopUrl('https://example.com/shop/plus123'), /仅支持/);
  assert.throws(() => normalizeShopUrl('https://pay.ldxp.cn/shop/plus123?next=x'), /查询参数/);
  assert.throws(() => normalizeShopUrl('https://pay.ldxp.cn/other/plus123'), /必须为/);
});

test('refresh config prevents zero-delay and inverted schedules', () => {
  assert.throws(() => normalizeRefreshConfig({ mode: 'fixed', fixedMinutes: 0 }), /1 到 1440/);
  assert.throws(() => normalizeRefreshConfig({ mode: 'random', minMinutes: 20, maxMinutes: 10 }), /不能大于/);
  const fixed = normalizeRefreshConfig({ mode: 'fixed', fixedMinutes: 30 });
  assert.equal(fixed.fixedMinutes, 30);
  assert.equal(fixed.plusCycleMinutes, 60);
  assert.equal(fixed.catalogRefreshHours, 24);
  assert.equal(fixed.collectorMode, 'auto');
  assert.equal(fixed.requestDelayMinSeconds, 20);
  const disabled = normalizeRefreshConfig({ mode: 'disabled' });
  assert.equal(disabled.mode, 'disabled');
  assert.equal(disabled.hourlyRequestLimit, 60);
  assert.equal(disabled.riskThreshold, 3);
  assert.equal(disabled.riskCooldownMinutes, 15);
  assert.throws(() => normalizeRefreshConfig({ mode: 'fixed', requestDelayMinSeconds: 80, requestDelayMaxSeconds: 20 }), /cannot exceed/);
});

test('refresh proxy config defaults to direct and validates explicit proxy use', () => {
  assert.deepEqual(normalizeRefreshProxyConfig({ enabled: false }), { enabled: false, proxyUrl: '' });
  assert.throws(() => normalizeRefreshProxyConfig({ enabled: true }), /启用代理前/);
  assert.throws(() => normalizeRefreshProxyConfig({ enabled: true, proxyUrl: 'socks5://127.0.0.1:1080' }), /HTTP\(S\)/);
  assert.deepEqual(
    normalizeRefreshProxyConfig({ enabled: true, proxyUrl: '' }, 'http://user:secret@127.0.0.1:18080'),
    { enabled: true, proxyUrl: 'http://user:secret@127.0.0.1:18080/' },
  );
  assert.deepEqual(
    normalizeRefreshProxyConfig({ enabled: false, clear: true }, 'http://127.0.0.1:18080'),
    { enabled: false, proxyUrl: '' },
  );
});

test('category and store order validation reject injection-shaped input', () => {
  assert.equal(validateCategory('gpt_plus_未接码'), 'gpt_plus_未接码');
  assert.throws(() => validateCategory('x"><img_onerror>'), /格式错误/);
  assert.throws(() => normalizeStoreOrder(['safe', 'safe']), /重复/);
  assert.throws(() => normalizeStoreOrder(['safe', 'bad\"id']), /店铺ID/);
});

test('loopback detection does not treat wildcard listeners as local', () => {
  assert.equal(isLoopbackHost('127.0.0.1'), true);
  assert.equal(isLoopbackHost('::1'), true);
  assert.equal(isLoopbackHost('0.0.0.0'), false);
});
