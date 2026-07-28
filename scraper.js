const axios = require('axios');
const { classifyProduct: classifyStructuredProduct } = require('./classification');
const {
  classifyHybridProduct,
  isKnownGptClassification,
  preClassifyProduct,
} = require('./hybrid-classification');

const BASE = 'https://pay.ldxp.cn';
const GOODS_TYPES = ['card', 'article', 'resource', 'equity'];
const REQ_TIMEOUT = 10000;
const MAX_PAGES = 30;
const PAGE_DELAY_MIN = Number(process.env.SCRAPER_PAGE_DELAY_MIN || 200);
const PAGE_DELAY_MAX = Number(process.env.SCRAPER_PAGE_DELAY_MAX || 600);
const TYPE_DELAY_MIN = Number(process.env.SCRAPER_TYPE_DELAY_MIN || 500);
const TYPE_DELAY_MAX = Number(process.env.SCRAPER_TYPE_DELAY_MAX || 1500);
const SHOP_TIMEOUT = Number(process.env.SCRAPER_SHOP_TIMEOUT || 180000);

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
      if (config.beforeAttempt) await config.beforeAttempt();
      return await axios.request(config);
    } catch (err) {
      if (config.signal?.aborted) throw err;
      const status = err.response?.status;
      const retryable = (!config.noRetryRisk && status === 429) || status === 502 || status === 503 || status === 504 || !status;
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

async function getCookies(token, signal) {
  const res = await requestWithBackoff({ method: 'get', url: `${BASE}/shop/${token}`,
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
    timeout: REQ_TIMEOUT,
    signal,
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

function riskError(message) {
  const error = new Error(message);
  error.code = 'UPSTREAM_RISK_CONTROL';
  return error;
}

function validateGoodsResponse(response) {
  const contentType = String(response.headers?.['content-type'] || '');
  if (typeof response.data === 'string' || contentType.includes('text/html')) {
    throw riskError('目标站返回了风控验证页，刷新已暂停');
  }
  if (!response.data || response.data.code !== 1 || !Array.isArray(response.data.data?.list)) {
    const message = String(response.data?.msg || '商品接口返回异常');
    if (response.status === 403 || response.status === 429) throw riskError(message);
    throw new Error(message);
  }
  return response.data.data;
}

function normalizeRemoteProduct(item) {
  return {
    id: item.goods_key || String(item.id || `g_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`),
    name: item.name || '',
    price: typeof item.price === 'number' ? item.price : parseFloat(item.price) || 0,
    stock: item.extend?.stock_count !== undefined ? item.extend.stock_count : -1,
    purchaseUrl: normalizeHttpUrl(item.link),
    updatedAt: new Date().toISOString(),
  };
}

async function fetchTargetProducts(token, goodsType, { keywords, signal, beforeAttempt } = {}) {
  const products = [];
  const pageSize = 100;
  let current = 1;
  let total = Infinity;
  while (current <= MAX_PAGES && products.length < total) {
    const data = { token, goods_type: goodsType, current, pageSize };
    if (keywords) data.keywords = keywords;
    let response;
    try {
      response = await requestWithBackoff({
        method: 'post', url: `${BASE}/shopApi/Shop/goodsList`, data,
        headers: headers(''), timeout: REQ_TIMEOUT, signal, noRetryRisk: true, beforeAttempt,
      });
    } catch (error) {
      if ([403, 429].includes(error.response?.status)) throw riskError(`目标站限制请求 (${error.response.status})`);
      throw error;
    }
    const payload = validateGoodsResponse(response);
    total = Number.isFinite(Number(payload.total)) ? Number(payload.total) : products.length + payload.list.length;
    products.push(...payload.list.map(normalizeRemoteProduct));
    if (!payload.list.length || payload.list.length < pageSize) break;
    current++;
    await sleep(randomDelay(PAGE_DELAY_MIN, PAGE_DELAY_MAX));
  }
  return products;
}

async function scrapePlusProducts(url, preferredTypes = [], beforeAttempt) {
  const token = extractToken(url);
  if (!token) throw new Error(`无法从 URL 提取店铺标识: ${url}`);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SHOP_TIMEOUT);
  try {
    const candidates = [...new Set((preferredTypes.length ? preferredTypes : GOODS_TYPES).filter(type => GOODS_TYPES.includes(type)))];
    const products = [];
    const activeTypes = [];
    for (const type of candidates) {
      const found = await fetchTargetProducts(token, type, { keywords: 'plus', signal: controller.signal, beforeAttempt });
      if (found.length) activeTypes.push(type);
      products.push(...found);
      if (preferredTypes.length) continue;
      await sleep(randomDelay(TYPE_DELAY_MIN, TYPE_DELAY_MAX));
    }
    return {
      products: [...new Map(products.map(product => [product.id, product])).values()],
      goodsTypes: activeTypes.length ? activeTypes : ['card'],
      probed: !preferredTypes.length,
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function scrapeCatalogProducts(url, beforeAttempt) {
  const token = extractToken(url);
  if (!token) throw new Error(`无法从 URL 提取店铺标识: ${url}`);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SHOP_TIMEOUT);
  try {
    const products = [];
    for (const type of GOODS_TYPES) {
      products.push(...await fetchTargetProducts(token, type, { signal: controller.signal, beforeAttempt }));
      await sleep(randomDelay(TYPE_DELAY_MIN, TYPE_DELAY_MAX));
    }
    return { products: [...new Map(products.map(product => [product.id, product])).values()] };
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchProducts(token, goodsType, cookies, signal) {
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
      signal,
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
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SHOP_TIMEOUT);
  try {
  const token = extractToken(url);
  if (!token) throw new Error(`无法从URL提取店铺标识: ${url}`);

  const cookies = await getCookies(token, controller.signal);

  const infoRes = await requestWithBackoff({
    method: 'post',
    url: `${BASE}/shopApi/Shop/info`,
    data: { token },
    headers: headers(cookies),
    timeout: REQ_TIMEOUT,
    signal: controller.signal,
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
  const failedTypes = [];
  for (const gt of goodsTypeSort) {
    try {
      const products = await fetchProducts(token, gt, cookies, controller.signal);
      allProducts.push(...products);
    } catch (err) {
      failedTypes.push(`${gt}: ${err.message}`);
    }
    await sleep(randomDelay(TYPE_DELAY_MIN, TYPE_DELAY_MAX));
  }

  if (failedTypes.length) throw new Error(`商品类型抓取失败: ${failedTypes.join('; ')}`);

  // Some stores expose the same goods key in more than one type/page.
  // Keep one record per key so cards and history remain consistent.
  const uniqueProducts = [...new Map(allProducts.map(product => [product.id, product])).values()];
  return { shopName, products: uniqueProducts };
  } finally {
    clearTimeout(timeout);
  }
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
  const classificationConfig = store.getClassificationConfig();
  for (const p of products) {
    const pk = `${storeId}:${p.id}`;
    const existing = store.getProductLabel(pk);
    if (existing?.manual) continue;
    const knownGpt = isKnownGptClassification(existing);
    const currentHybrid = String(existing?.classification_source || '').startsWith('hybrid-v1-');
    // Upgrade legacy GPT labels once. Afterwards, unchanged products do not need inference.
    if (existing && existing.name === p.name && (!knownGpt || currentHybrid)) continue;

    const baseResult = classifyStructuredProduct(p.name, classificationConfig);
    const pre = preClassifyProduct(p.name);
    if (knownGpt || pre.eligible) {
      const hybridResult = classifyHybridProduct(p.name, baseResult, { knownProduct: knownGpt });
      if (hybridResult.hybrid?.accepted) {
        store.saveClassificationResult(pk, p.name, hybridResult, `hybrid-v1-${hybridResult.hybrid.source}`);
        continue;
      }
    }

    const result = classifyProduct(p.name, filterPatterns);
    if (result && result.category) {
      store.upsertProductLabel(pk, p.name, result.category, result.confidence, 0);
    }
  }
}

module.exports = { scrapeShop, scrapePlusProducts, scrapeCatalogProducts, fetchTargetProducts, classifyProducts, classifyProduct, normalizeHttpUrl };
