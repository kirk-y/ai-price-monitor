const axios = require('axios');

const BASE = 'https://pay.ldxp.cn';
const GOODS_TYPES = ['card', 'article', 'resource', 'equity'];
const REQ_TIMEOUT = 10000;
const MAX_PAGES = 30;
const PAGE_DELAY_MIN = Number(process.env.SCRAPER_PAGE_DELAY_MIN || 200);
const PAGE_DELAY_MAX = Number(process.env.SCRAPER_PAGE_DELAY_MAX || 600);
const TYPE_DELAY_MIN = Number(process.env.SCRAPER_TYPE_DELAY_MIN || 500);
const TYPE_DELAY_MAX = Number(process.env.SCRAPER_TYPE_DELAY_MAX || 1500);

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
function randomDelay(min, max) {
  const lo = Math.max(0, Number(min) || 0);
  const hi = Math.max(lo, Number(max) || lo);
  return Math.floor(Math.random() * (hi - lo + 1)) + lo;
}

async function requestWithBackoff(config) {
  let attempt = 0;
  while (true) {
    try {
      return await axios.request(config);
    } catch (err) {
      const status = err.response?.status;
      const retryable = status === 429 || status === 502 || status === 503 || status === 504 || !status;
      if (!retryable || attempt >= 2) throw err;
      await sleep((2 ** attempt) * 1000 + randomDelay(200, 800));
      attempt++;
    }
  }
}

function extractToken(url) {
  const m = url.match(/\/shop\/([^/?#]+)/);
  return m ? m[1] : null;
}

async function getCookies(token) {
  const res = await requestWithBackoff({ method: 'get', url: `${BASE}/shop/${token}`,
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
    timeout: REQ_TIMEOUT,
  });
  return (res.headers['set-cookie'] || []).map(c => c.split(';')[0]).join('; ');
}

function headers(cookies) {
  return {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'Content-Type': 'application/json',
    'Cookie': cookies || '',
    'Accept': 'application/json, text/plain, */*',
  };
}

async function fetchProducts(token, goodsType, cookies) {
  const products = [];
  let current = 1;
  const pageSize = 100;

  while (current <= MAX_PAGES) {
    const res = await requestWithBackoff({
      method: 'post',
      url: `${BASE}/shopApi/Shop/goodsList`,
      data: { token, goods_type: goodsType, current, pageSize },
      headers: headers(cookies),
      timeout: REQ_TIMEOUT,
    });

    const data = res.data;
    if (!data || data.code !== 1 || !data.data?.list) break;

    const list = data.data.list;
    if (list.length === 0) break;

    for (const item of list) {
      products.push({
        id: item.goods_key || String(item.id || `g_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`),
        name: item.name || '',
        price: typeof item.price === 'number' ? item.price : parseFloat(item.price) || 0,
        stock: item.extend?.stock_count !== undefined ? item.extend.stock_count : -1,
        purchaseUrl: normalizeHttpUrl(item.link),
        updatedAt: new Date().toISOString(),
      });
    }

    if (list.length < pageSize) break;
    current++;
    await sleep(randomDelay(PAGE_DELAY_MIN, PAGE_DELAY_MAX));
  }

  return products;
}

async function scrapeShop(url) {
  const token = extractToken(url);
  if (!token) throw new Error(`无法从URL提取店铺标识: ${url}`);

  const cookies = await getCookies(token);

  const infoRes = await requestWithBackoff({
    method: 'post',
    url: `${BASE}/shopApi/Shop/info`,
    data: { token },
    headers: headers(cookies),
    timeout: REQ_TIMEOUT,
  });

  if (!infoRes.data || infoRes.data.code !== 1) {
    throw new Error(`店铺不存在或无法访问: ${infoRes.data?.msg || '未知错误'}`);
  }

  const shopInfo = infoRes.data.data;
  const shopName = shopInfo.nickname || shopInfo.link?.split('/').pop() || token;
  const goodsTypeSort = Array.isArray(shopInfo.goods_type_sort)
    ? shopInfo.goods_type_sort.filter(type => GOODS_TYPES.includes(type))
    : GOODS_TYPES;

  const allProducts = [];
  for (const gt of goodsTypeSort) {
    try {
      const products = await fetchProducts(token, gt, cookies);
      allProducts.push(...products);
    } catch (_) { }
    await sleep(randomDelay(TYPE_DELAY_MIN, TYPE_DELAY_MAX));
  }

  return { shopName, products: allProducts };
}

function normalizeHttpUrl(value) {
  if (!value) return '';
  try {
    const parsed = new URL(String(value));
    return ['http:', 'https:'].includes(parsed.protocol) ? parsed.toString() : '';
  } catch (_) {
    return '';
  }
}

function classifyProduct(name, filterPatterns) {
  for (const [category, patterns] of Object.entries(filterPatterns || {})) {
    if (!Array.isArray(patterns)) continue;
    for (const pattern of patterns) {
      try {
        if (new RegExp(pattern, 'i').test(name)) return { category, confidence: 0.55 };
      } catch (_) { }
    }
  }
  return null;
}

async function classifyProducts(products, storeId) {
  const store = require('./store');
  const filterPatterns = store.getFilterConfig().filterPatterns || {};
  for (const p of products) {
    const pk = `${storeId}:${p.id}`;
    const existing = store.getProductLabel(pk);
    if (existing) continue;
    const result = classifyProduct(p.name, filterPatterns);
    if (result && result.category) {
      store.upsertProductLabel(pk, p.name, result.category, result.confidence, 0);
    }
  }
}

module.exports = { scrapeShop, classifyProducts, classifyProduct, normalizeHttpUrl };
