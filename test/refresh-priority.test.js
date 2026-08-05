const test = require('node:test');
const assert = require('node:assert/strict');
const {
  automaticFocusRefreshType,
  buildPlusPriorityScores,
  estimatedRefreshRequests,
  focusRefreshIntervalMinutes,
  pickDueCatalogStore,
} = require('../refresh-priority');

test('plus priority favors repeated in-stock low prices over one stale low price', () => {
  const snapshots = [
    { id: 'stable-low', current: [{ key: 'stable-low:p', price: 10, stock: 2 }], keys: ['stable-low:p'] },
    { id: 'stale-low', current: [{ key: 'stale-low:p', price: 8, stock: 0 }], keys: ['stale-low:p'] },
    { id: 'normal', current: [{ key: 'normal:p', price: 20, stock: 3 }], keys: ['normal:p'] },
  ];
  const history = [
    ...Array.from({ length: 6 }, (_, index) => ({ product_key: 'stable-low:p', price: 10 + index % 2, stock: 1, date: `2026-07-2${index + 1}T00:00:00.000Z` })),
    { product_key: 'stale-low:p', price: 8, stock: 0, date: '2026-07-30T00:00:00.000Z' },
    ...Array.from({ length: 6 }, (_, index) => ({ product_key: 'normal:p', price: 20 + index, stock: 2, date: `2026-07-2${index + 1}T00:00:00.000Z` })),
  ];
  const scores = buildPlusPriorityScores(snapshots, history, 1);
  assert.equal(scores.get('stable-low').tier, 'A');
  assert.equal(scores.get('stable-low').rank, 1);
  assert.ok(scores.get('stable-low').score > scores.get('normal').score);
  assert.equal(scores.get('stale-low').observations, 0);
});

test('stores without valid Plus evidence stay in the exploration tier', () => {
  const scores = buildPlusPriorityScores([
    { id: 'known', current: [{ price: 10, stock: 1 }], keys: ['known:p'] },
    { id: 'empty', current: [], keys: [] },
  ], [
    { product_key: 'known:p', price: 10, stock: 1, date: '2026-07-30T00:00:00.000Z' },
  ], 1);
  assert.equal(scores.get('known').tier, 'A');
  assert.equal(scores.get('empty').tier, 'C');
  assert.equal(scores.get('empty').observations, 0);
});

test('catalog refreshes are overdue per store but spread across the configured cycle', () => {
  const now = Date.parse('2026-08-01T12:00:00.000Z');
  const stores = [
    { id: 'oldest', refreshMeta: { lastCatalogAttemptAt: '2026-07-30T12:00:00.000Z' } },
    { id: 'recent', refreshMeta: { lastCatalogAttemptAt: '2026-08-01T11:30:00.000Z' } },
  ];
  assert.equal(pickDueCatalogStore(stores, 24, now), null);
  stores[1].refreshMeta.lastCatalogAttemptAt = '2026-07-31T23:00:00.000Z';
  assert.equal(pickDueCatalogStore(stores, 24, now)?.id, 'oldest');
});

test('known product types use focused refresh without repeating type probes', () => {
  assert.equal(automaticFocusRefreshType({ refreshMeta: { focusGoodsTypes: ['card'] } }), 'plus');
  assert.equal(automaticFocusRefreshType({ refreshMeta: {} }), 'probe');
});

test('focus tiers stay bounded and full scans reserve enough request budget', () => {
  assert.equal(focusRefreshIntervalMinutes({ status: 'ok' }, { tier: 'A' }, 60), 60);
  assert.equal(focusRefreshIntervalMinutes({ status: 'ok' }, { tier: 'B' }, 60), 120);
  assert.equal(focusRefreshIntervalMinutes({ status: 'ok' }, { tier: 'C' }, 60), 180);
  assert.equal(focusRefreshIntervalMinutes({ status: 'error' }, { tier: 'A' }, 60), 120);
  assert.equal(estimatedRefreshRequests({ products: Array(914) }, 'full'), 16);
});
