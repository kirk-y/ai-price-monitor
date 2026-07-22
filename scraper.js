const axios = require('axios');
const { spawn } = require('child_process');
const path = require('path');

const BASE = 'https://pay.ldxp.cn';
const GOODS_TYPES = ['card', 'article', 'resource', 'equity'];
const REQ_TIMEOUT = 10000;
const CLASSIFIER_SCRIPT = path.join(__dirname, 'python', 'classifier.py');

function extractToken(url) {
  const m = url.match(/\/shop\/([^/?#]+)/);
  return m ? m[1] : null;
}

async function getCookies(token) {
  const res = await axios.get(`${BASE}/shop/${token}`, {
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

  while (true) {
    const res = await axios.post(`${BASE}/shopApi/Shop/goodsList`, {
      token, goods_type: goodsType, current, pageSize,
    }, { headers: headers(cookies), timeout: REQ_TIMEOUT });

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
    headers: headers(cookies), timeout: REQ_TIMEOUT,
  });

  if (!infoRes.data || infoRes.data.code !== 1) {
    throw new Error(`店铺不存在或无法访问: ${infoRes.data?.msg || '未知错误'}`);
  }

  const shopInfo = infoRes.data.data;
  const shopName = shopInfo.nickname || shopInfo.link?.split('/').pop() || token;
  const goodsTypeSort = shopInfo.goods_type_sort || GOODS_TYPES;

  const allProducts = [];
  for (const gt of goodsTypeSort) {
    try {
      const products = await fetchProducts(token, gt, cookies);
      allProducts.push(...products);
    } catch (_) { }
  }

  return { shopName, products: allProducts };
}

function classifyProduct(name) {
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
