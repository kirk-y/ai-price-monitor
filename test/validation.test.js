const test = require('node:test');
const assert = require('node:assert/strict');
const {
  isLoopbackHost,
  normalizeRefreshConfig,
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
  assert.deepEqual(normalizeRefreshConfig({ mode: 'fixed', fixedMinutes: 30 }), {
    mode: 'fixed', minMinutes: 60, maxMinutes: 360, fixedMinutes: 30,
  });
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
