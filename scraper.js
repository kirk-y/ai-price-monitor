const axios = require('axios');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const BASE = 'https://pay.ldxp.cn';
const GOODS_TYPES = ['card', 'article', 'resource', 'equity'];
const REQ_TIMEOUT = 10000;
const CLASSIFIER_SCRIPT = path.join(__dirname, 'python', 'classifier.py');
let classifierAvailable = null;

function extractToken(url) {
  const m = url.match(/\/shop\/([^/?#]+)/);
  return m ? m[1] : null;
}

async function getCookies(token) {
  try {
    const res = await axios.get(`${BASE}/shop/${encodeURIComponent(token)}`, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
      timeout: REQ_TIMEOUT,
    });
    return (res.headers['set-cookie'] || []).map(c => c.split(';')[0]).join('; ');
  } catch (err) {
    console.warn(`获取店铺页面 Cookie 失败，继续尝试 API: ${token} - ${err.message}`);
    return '';
  }
}

function headers(cookies, token) {
  const h = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'Content-Type': 'application/json',
    'Accept': 'application/json, text/plain, */*',
    'Origin': BASE,
    'Referer': `${BASE}/shop/${encodeURIComponent(token || '')}`,
  };
  if (cookies) h.Cookie = cookies;
  return h;
}

async function fetchProducts(token, goodsType, cookies) {
  const products = [];
  let current = 1;
  const pageSize = 100;

  while (true) {
    const res = await axios.post(`${BASE}/shopApi/Shop/goodsList`, {
      token, goods_type: goodsType, current, pageSize,
    }, { headers: headers(cookies, token), timeout: REQ_TIMEOUT });

    const data = res.data;
    if (!data) throw new Error(`${goodsType} 商品列表响应为空`);
    if (data.code !== 1) throw new Error(`${goodsType} 商品列表错误: ${data.msg || '未知错误'}`);
    if (!Array.isArray(data.data?.list)) throw new Error(`${goodsType} 商品列表格式异常`);

    const list = data.data.list;
    if (list.length === 0) break;

    for (const item of list) {
      products.push({
        id: item.goods_key || String(item.id || `g_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`),
        name: item.name || '',
        price: typeof item.price === 'number' ? item.price : parseFloat(item.price) || 0,
        stock: item.extend?.stock_count !== undefined ? item.extend.stock_count : -1,
        purchaseUrl: item.link || '',
        updatedAt: new Date().toISOString(),
      });
    }

    if (list.length < pageSize) break;
    current++;
  }

  return products;
}

async function scrapeShop(url) {
  const token = extractToken(url);
  if (!token) throw new Error(`无法从URL提取店铺标识: ${url}`);

  const cookies = await getCookies(token);

  const infoRes = await axios.post(`${BASE}/shopApi/Shop/info`, { token }, {
    headers: headers(cookies, token), timeout: REQ_TIMEOUT,
  });

  if (!infoRes.data || infoRes.data.code !== 1) {
    throw new Error(`店铺不存在或无法访问: ${infoRes.data?.msg || '未知错误'}`);
  }

  const shopInfo = infoRes.data.data;
  const shopName = shopInfo.nickname || shopInfo.link?.split('/').pop() || token;
  const goodsTypeSort = Array.isArray(shopInfo.goods_type_sort) && shopInfo.goods_type_sort.length
    ? shopInfo.goods_type_sort
    : GOODS_TYPES;

  const allProducts = [];
  const failures = [];
  let fetchedTypes = 0;
  for (const gt of goodsTypeSort) {
    try {
      const products = await fetchProducts(token, gt, cookies);
      allProducts.push(...products);
      fetchedTypes++;
    } catch (err) {
      failures.push(`${gt}: ${err.message}`);
    }
  }

  if (fetchedTypes === 0 && failures.length) {
    throw new Error(`无法获取商品列表: ${failures.join('; ')}`);
  }

  return { shopName, products: allProducts, partialFailures: failures };
}

function hasClassifier() {
  if (classifierAvailable === null) {
    classifierAvailable = fs.existsSync(CLASSIFIER_SCRIPT);
    if (!classifierAvailable) {
      console.warn(`分类器不存在，已跳过AI分类: ${CLASSIFIER_SCRIPT}`);
    }
  }
  return classifierAvailable;
}

function classifyProduct(name) {
  if (!hasClassifier()) return Promise.resolve(null);
  return new Promise((resolve) => {
    const proc = spawn('python', [CLASSIFIER_SCRIPT, 'predict', name], {
      cwd: path.join(__dirname, 'python'),
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
    });
    let stdout = '';
    let stderr = '';
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', d => stdout += d);
    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', d => stderr += d);
    proc.on('close', (code) => {
      if (code !== 0) return resolve(null);
      try { resolve(JSON.parse(stdout)); }
      catch { resolve(null); }
    });
    proc.on('error', () => resolve(null));
  });
}

async function classifyProducts(products, storeId) {
  if (!hasClassifier()) return;
  const store = require('./store');
  for (const p of products) {
    const pk = `${storeId}:${p.id}`;
    const existing = store.getProductLabel(pk);
    if (existing) continue;
    const result = await classifyProduct(p.name);
    if (result && result.category) {
      store.upsertProductLabel(pk, p.name, result.category, result.confidence, 0);
    }
  }
}

module.exports = { scrapeShop, classifyProducts };
