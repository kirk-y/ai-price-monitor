const test = require('node:test');
const assert = require('node:assert/strict');
const axios = require('axios');
const { scrapePlusProducts } = require('../scraper');

test('focused refresh queries Plus and K12 with browser-compatible headers', async () => {
  const originalRequest = axios.request;
  const calls = [];
  axios.request = async config => {
    calls.push(config);
    if (config.url.endsWith('/info')) {
      return { status: 200, headers: { 'content-type': 'application/json' }, data: { code: 1, data: { nickname: 'test' } } };
    }
    const keyword = config.data.keywords;
    const item = { goods_key: keyword, name: keyword === 'k12' ? 'GPT K12' : 'GPT Plus', price: 10, extend: { stock_count: 1 } };
    return { status: 200, headers: { 'content-type': 'application/json' }, data: { code: 1, data: { list: [item], total: 1 } } };
  };
  try {
    const result = await scrapePlusProducts('https://pay.ldxp.cn/shop/demo', ['card'], () => {});
    assert.deepEqual(result.products.map(product => product.id), ['plus', 'k12']);
    assert.deepEqual(calls.map(call => new URL(call.url).pathname), [
      '/shopApi/Shop/info',
      '/shopApi/Shop/goodsList',
      '/shopApi/Shop/goodsList',
    ]);
    assert.notEqual(calls[0].headers.visitorid, calls[1].headers.visitorid);
    assert.match(calls[0].headers.visitorid, /^[a-f0-9]{24}$/);
    assert.equal(calls[0].headers.Referer, 'https://pay.ldxp.cn/shop/demo');
    assert.match(calls[0].headers['Accept-Language'], /^zh-CN/);
    assert.deepEqual(calls.slice(1).map(call => call.data.keywords), ['plus', 'k12']);
  } finally {
    axios.request = originalRequest;
  }
});

test('HTML challenge stops a shop refresh immediately', async () => {
  const originalRequest = axios.request;
  let attempts = 0;
  axios.request = async () => {
    attempts++;
    return { status: 200, headers: { 'content-type': 'text/html' }, data: '<html><script>challenge</script></html>' };
  };
  try {
    await assert.rejects(
      scrapePlusProducts('https://pay.ldxp.cn/shop/demo', ['card'], () => {}),
      error => error.code === 'UPSTREAM_CHALLENGE',
    );
    assert.equal(attempts, 1);
  } finally {
    axios.request = originalRequest;
  }
});

test('HTTP 403 opens the challenge path without retrying', async () => {
  const originalRequest = axios.request;
  let attempts = 0;
  axios.request = async () => {
    attempts++;
    const error = new Error('forbidden');
    error.response = { status: 403 };
    throw error;
  };
  try {
    await assert.rejects(
      scrapePlusProducts('https://pay.ldxp.cn/shop/demo', ['card'], () => {}, { proxyMode: 'never' }),
      error => error.code === 'UPSTREAM_CHALLENGE',
    );
    assert.equal(attempts, 1);
  } finally {
    axios.request = originalRequest;
  }
});

test('configured proxy is tried once after a direct HTML challenge', async () => {
  const originalRequest = axios.request;
  const originalProxyUrl = process.env.SHOP_API_PROXY_URL;
  const originalProxyMode = process.env.SHOP_API_PROXY_MODE;
  const calls = [];
  process.env.SHOP_API_PROXY_URL = 'http://user:pass@127.0.0.1:18080';
  process.env.SHOP_API_PROXY_MODE = 'on_challenge';
  axios.request = async config => {
    calls.push(config);
    if (calls.length === 1) {
      return { status: 200, headers: { 'content-type': 'text/html' }, data: '<html><script>challenge</script></html>' };
    }
    if (config.url.endsWith('/info')) {
      return { status: 200, headers: { 'content-type': 'application/json' }, data: { code: 1, data: { nickname: 'test' } } };
    }
    return { status: 200, headers: { 'content-type': 'application/json' }, data: { code: 1, data: { list: [], total: 0 } } };
  };
  try {
    await scrapePlusProducts('https://pay.ldxp.cn/shop/demo', ['card'], () => {});
    assert.equal(calls[0].proxy, undefined);
    assert.equal(calls[1].proxy.host, '127.0.0.1');
    assert.equal(calls[2].proxy.host, '127.0.0.1');
  } finally {
    axios.request = originalRequest;
    if (originalProxyUrl === undefined) delete process.env.SHOP_API_PROXY_URL;
    else process.env.SHOP_API_PROXY_URL = originalProxyUrl;
    if (originalProxyMode === undefined) delete process.env.SHOP_API_PROXY_MODE;
    else process.env.SHOP_API_PROXY_MODE = originalProxyMode;
  }
});
