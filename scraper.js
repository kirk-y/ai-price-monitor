const axios = require('axios');
const crypto = require('crypto');
const { classifyProduct: classifyStructuredProduct } = require('./classification');
const {
  classifyHybridProduct,
  guardClassificationSubject,
  isKnownGptClassification,
  preClassifyProduct,
} = require('./hybrid-classification');
const { RULE_VERSION } = require('./classification');

const BASE = process.env.SHOP_API_BASE || 'https://pay.ldxp.cn';
const GOODS_TYPES = ['card', 'article', 'resource', 'equity'];
const FOCUS_KEYWORDS = ['plus', 'k12'];
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
      if (err.code === 'REQUEST_BUDGET_EXHAUSTED') throw err;
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

function headers(cookies, context = {}) {
  return {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'Content-Type': 'application/json',
    'Cookie': cookies || '',
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.6',
    'Referer': context.referer || BASE,
    'visitorid': crypto.randomBytes(12).toString('hex'),
  };
}

function upstreamError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function proxyConfigFromOptions(options = {}) {
  const raw = String(options.proxyUrl || process.env.SHOP_API_PROXY_URL || '').trim();
  if (!raw) return null;
  const url = new URL(raw);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('SHOP_API_PROXY_URL 仅支持 HTTP(S) 代理');
  return {
    protocol: url.protocol.slice(0, -1),
    host: url.hostname,
    port: Number(url.port || (url.protocol === 'https:' ? 443 : 80)),
    ...(url.username ? { auth: { username: decodeURIComponent(url.username), password: decodeURIComponent(url.password) } } : {}),
  };
}

function createShopRequestContext(token, signal, beforeAttempt, options = {}) {
  const proxy = proxyConfigFromOptions(options);
  const mode = String(options.proxyMode || process.env.SHOP_API_PROXY_MODE || 'on_challenge').toLowerCase();
  return {
    token,
    signal,
    beforeAttempt,
    referer: `${BASE}/shop/${token}`,
    proxy,
    useProxy: mode === 'always' && Boolean(proxy),
    allowProxyFallback: mode !== 'never' && mode !== 'direct' && Boolean(proxy),
  };
}

function validateJsonResponse(response) {
  const contentType = String(response.headers?.['content-type'] || '');
  if (typeof response.data === 'string' || contentType.includes('text/html')) {
    throw upstreamError('UPSTREAM_CHALLENGE', '目标站返回了 JavaScript 验证页，刷新已暂停');
  }
  return response.data;
}

async function requestShopApi(context, path, data) {
  const request = async () => {
    try {
      const response = await requestWithBackoff({
        method: 'post', url: `${BASE}${path}`, data,
        headers: headers('', context), timeout: REQ_TIMEOUT, signal: context.signal,
        noRetryRisk: true, beforeAttempt: context.beforeAttempt,
        ...(context.useProxy ? { proxy: context.proxy } : {}),
      });
      return validateJsonResponse(response);
    } catch (error) {
      if (error.response?.status === 403) throw upstreamError('UPSTREAM_CHALLENGE', '目标站拒绝服务端访问 (403)');
      if (error.response?.status === 429) throw upstreamError('UPSTREAM_RATE_LIMIT', '目标站限制请求 (429)');
      throw error;
    }
  };

  try {
    return await request();
  } catch (error) {
    if (error.code !== 'UPSTREAM_CHALLENGE' || context.useProxy || !context.allowProxyFallback) throw error;
    context.useProxy = true;
    return request();
  }
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

async function fetchTargetProducts(context, goodsType, { keywords } = {}) {
  const products = [];
  const pageSize = 100;
  let current = 1;
  let total = Infinity;
  while (current <= MAX_PAGES && products.length < total) {
    const data = { token: context.token, category_id: 0, goods_type: goodsType, current, pageSize };
    if (keywords) data.keywords = keywords;
    const response = await requestShopApi(context, '/shopApi/Shop/goodsList', data);
    if (!response || response.code !== 1 || !Array.isArray(response.data?.list)) {
      throw new Error(String(response?.msg || '商品接口返回异常'));
    }
    const payload = response.data;
    total = Number.isFinite(Number(payload.total)) ? Number(payload.total) : products.length + payload.list.length;
    products.push(...payload.list.map(normalizeRemoteProduct));
    if (!payload.list.length || payload.list.length < pageSize) break;
    current++;
    await sleep(randomDelay(PAGE_DELAY_MIN, PAGE_DELAY_MAX));
  }
  return products;
}

async function scrapeFocusProducts(url, preferredTypes = [], beforeAttempt, options = {}) {
  const token = extractToken(url);
  if (!token) throw new Error(`无法从 URL 提取店铺标识: ${url}`);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SHOP_TIMEOUT);
  try {
    const context = createShopRequestContext(token, controller.signal, beforeAttempt, options);
    const info = await requestShopApi(context, '/shopApi/Shop/info', { token, category_key: '' });
    if (!info || info.code !== 1 || !info.data) throw new Error(String(info?.msg || '店铺信息接口返回异常'));
    const candidates = [...new Set((preferredTypes.length ? preferredTypes : GOODS_TYPES).filter(type => GOODS_TYPES.includes(type)))];
    const products = [];
    const activeTypes = [];
    for (const type of candidates) {
      for (const keywords of FOCUS_KEYWORDS) {
        const found = await fetchTargetProducts(context, type, { keywords });
        if (found.length && !activeTypes.includes(type)) activeTypes.push(type);
        products.push(...found);
      }
      if (preferredTypes.length) continue;
      await sleep(randomDelay(TYPE_DELAY_MIN, TYPE_DELAY_MAX));
    }
    return {
      products: [...new Map(products.map(product => [product.id, product])).values()],
      goodsTypes: activeTypes.length ? activeTypes : ['card'],
      probed: !preferredTypes.length,
      requestRoute: context.useProxy ? 'proxy' : 'direct',
    };
  } finally {
    clearTimeout(timeout);
  }
}

const scrapePlusProducts = scrapeFocusProducts;

async function scrapeCatalogProducts(url, beforeAttempt, options = {}) {
  const token = extractToken(url);
  if (!token) throw new Error(`无法从 URL 提取店铺标识: ${url}`);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SHOP_TIMEOUT);
  try {
    const context = createShopRequestContext(token, controller.signal, beforeAttempt, options);
    const info = await requestShopApi(context, '/shopApi/Shop/info', { token, category_key: '' });
    if (!info || info.code !== 1 || !info.data) throw new Error(String(info?.msg || '店铺信息接口返回异常'));
    const products = [];
    for (const type of GOODS_TYPES) {
      products.push(...await fetchTargetProducts(context, type));
      await sleep(randomDelay(TYPE_DELAY_MIN, TYPE_DELAY_MAX));
    }
    return {
      products: [...new Map(products.map(product => [product.id, product])).values()],
      requestRoute: context.useProxy ? 'proxy' : 'direct',
    };
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
    const currentHybrid = String(existing?.classification_source || '').startsWith('hybrid-v2-');
    const currentVersion = Number(existing?.classification_version) || 0;
    // Upgrade legacy GPT labels once. Afterwards, unchanged products do not need inference.
    if (existing && existing.name === p.name && currentVersion >= RULE_VERSION && (!knownGpt || currentHybrid)) continue;

    const baseResult = classifyStructuredProduct(p.name, classificationConfig);
    const pre = preClassifyProduct(p.name);
    if (!pre.eligible && pre.product) {
      const guarded = guardClassificationSubject(baseResult, pre);
      store.saveClassificationResult(pk, p.name, guarded, 'rules-v3-subject-guard');
      continue;
    }
    if (knownGpt || pre.eligible) {
      const hybridResult = classifyHybridProduct(p.name, baseResult, { knownProduct: knownGpt });
      if (hybridResult.hybrid?.accepted) {
        store.saveClassificationResult(pk, p.name, hybridResult, `hybrid-v2-${hybridResult.hybrid.source}`);
        continue;
      }
    }

    const result = classifyProduct(p.name, filterPatterns);
    if (result && result.category) {
      store.upsertProductLabel(pk, p.name, result.category, result.confidence, 0);
    }
  }
}

module.exports = { scrapeShop, scrapeFocusProducts, scrapePlusProducts, scrapeCatalogProducts, fetchTargetProducts, classifyProducts, classifyProduct, normalizeHttpUrl };
