const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { chromium } = require('playwright-core');

const BASE = 'https://pay.ldxp.cn';
const GOODS_TYPES = ['card', 'article', 'resource', 'equity'];
const FOCUS_KEYWORDS = ['plus', 'k12'];
const PAGE_SIZE = 100;
const MAX_PAGES = 30;
const TIMEOUT = Number(process.env.SHOP_BROWSER_TIMEOUT || 30000);
const API_TIMEOUT = Math.max(1000, Number(process.env.SHOP_BROWSER_API_TIMEOUT) || 10000);

let activeCollector = null;

function upstreamError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function profileRoot() {
  return process.env.SHOP_BROWSER_PROFILE_PATH
    ? path.resolve(process.env.SHOP_BROWSER_PROFILE_PATH)
    : path.join(__dirname, 'data', 'browser-profile');
}

function findBrowserExecutable() {
  const candidates = [
    process.env.SHOP_BROWSER_EXECUTABLE,
    process.platform === 'win32' ? path.join(process.env.PROGRAMFILES || '', 'Google', 'Chrome', 'Application', 'chrome.exe') : '',
    process.platform === 'win32' ? path.join(process.env['PROGRAMFILES(X86)'] || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe') : '',
    process.platform === 'win32' ? path.join(process.env.PROGRAMFILES || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe') : '',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ].filter(Boolean);
  return candidates.find(candidate => fs.existsSync(candidate)) || '';
}

function normalizeProxy(proxyUrl) {
  if (!proxyUrl) return null;
  const parsed = new URL(proxyUrl);
  return {
    server: `${parsed.protocol}//${parsed.hostname}${parsed.port ? `:${parsed.port}` : ''}`,
    ...(parsed.username ? {
      username: decodeURIComponent(parsed.username),
      password: decodeURIComponent(parsed.password),
    } : {}),
  };
}

function isUsable(collector) {
  if (!collector?.context || !collector.page || collector.page.isClosed()) return false;
  const browser = collector.context.browser();
  return !browser || browser.isConnected();
}

async function discardCollector(collector = activeCollector) {
  if (activeCollector === collector) activeCollector = null;
  await collector?.context?.close().catch(() => {});
}

async function closeCollector() {
  await discardCollector();
}

async function getCollector(proxyUrl = '') {
  const executablePath = findBrowserExecutable();
  if (!executablePath) throw upstreamError('BROWSER_UNAVAILABLE', '未找到 Chrome 或 Edge，浏览器采集不可用');
  const key = `${executablePath}|${proxyUrl}`;
  if (activeCollector?.key === key && isUsable(activeCollector)) return activeCollector;
  await discardCollector();

  fs.mkdirSync(profileRoot(), { recursive: true });
  const profilePath = path.join(profileRoot(), crypto.createHash('sha256').update(key).digest('hex').slice(0, 12));
  const headless = process.env.SHOP_BROWSER_HEADLESS === 'true';
  try {
    const context = await chromium.launchPersistentContext(profilePath, {
      executablePath,
      headless,
      viewport: { width: 1365, height: 900 },
      locale: 'zh-CN',
      args: !headless && process.platform === 'win32'
        ? ['--start-minimized', '--window-position=-32000,-32000', '--disable-background-timer-throttling']
        : [],
      ...(proxyUrl ? { proxy: normalizeProxy(proxyUrl) } : {}),
    });
    const page = context.pages()[0] || await context.newPage();
    page.setDefaultTimeout(TIMEOUT);
    page.setDefaultNavigationTimeout(TIMEOUT);
    const collector = { key, context, page, ready: false };
    context.once('close', () => {
      if (activeCollector === collector) activeCollector = null;
    });
    activeCollector = collector;
    return collector;
  } catch (error) {
    throw upstreamError('BROWSER_UNAVAILABLE', `无法启动浏览器采集: ${error.message}`);
  }
}

async function clearCollectorData() {
  await closeCollector();
  if (process.env.SHOP_BROWSER_PROFILE_PATH) return false;
  fs.rmSync(profileRoot(), { recursive: true, force: true });
  return true;
}

async function establishSession(collector, token, beforeAttempt) {
  if (collector.ready) return;
  if (beforeAttempt) await beforeAttempt();
  const blockShopApi = route => route.abort();
  await collector.page.route('**/shopApi/**', blockShopApi);
  try {
    const response = await collector.page.goto(`${BASE}/shop/${encodeURIComponent(token)}`, { waitUntil: 'domcontentloaded' });
    if (response?.status() === 403) throw upstreamError('UPSTREAM_CHALLENGE', '目标站拒绝浏览器会话访问 (403)');
    if (response?.status() === 429) throw upstreamError('UPSTREAM_RATE_LIMIT', '目标站限制请求 (429)');
    await collector.page.waitForTimeout(800);
    const challenge = await collector.page.evaluate(() => `${document.title}\n${document.body?.innerText || ''}`);
    if (/验证|checking|just a moment|verify you are human/i.test(challenge)) {
      throw upstreamError('UPSTREAM_CHALLENGE', '目标站要求完成 JavaScript 验证');
    }
    collector.ready = true;
  } finally {
    await collector.page.unroute('**/shopApi/**', blockShopApi).catch(() => {});
  }
}

async function pageApi(page, token, endpoint, payload, beforeAttempt) {
  if (beforeAttempt) await beforeAttempt();
  const result = await page.evaluate(async ({ token, endpoint, payload, timeout }) => {
    history.replaceState(null, '', `/shop/${encodeURIComponent(token)}`);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json', visitorid: crypto.randomUUID().replaceAll('-', '') },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      return {
        status: response.status,
        contentType: response.headers.get('content-type') || '',
        body: await response.text(),
      };
    } catch (error) {
      return { networkError: String(error?.message || error) };
    } finally {
      clearTimeout(timer);
    }
  }, { token, endpoint, payload, timeout: API_TIMEOUT });
  if (result.networkError) {
    throw upstreamError('BROWSER_FETCH_FAILED', `浏览器接口请求失败: ${result.networkError}`);
  }
  if (result.status === 403) throw upstreamError('UPSTREAM_CHALLENGE', '目标站拒绝浏览器会话访问 (403)');
  if (result.status === 429) throw upstreamError('UPSTREAM_RATE_LIMIT', '目标站限制请求 (429)');
  if (result.contentType.includes('text/html') || /^\s*</.test(result.body)) {
    throw upstreamError('UPSTREAM_CHALLENGE', '浏览器会话仍被 JavaScript 验证拦截');
  }
  try {
    return JSON.parse(result.body);
  } catch (_) {
    throw new Error('商品接口未返回有效 JSON');
  }
}

function normalizeProduct(item) {
  let purchaseUrl = '';
  try {
    const parsed = new URL(String(item.link || ''), BASE);
    if (['http:', 'https:'].includes(parsed.protocol)) purchaseUrl = parsed.toString();
  } catch (_) { /* Invalid remote link. */ }
  return {
    id: item.goods_key || String(item.id || ''),
    name: item.name || '',
    price: typeof item.price === 'number' ? item.price : parseFloat(item.price) || 0,
    stock: item.extend?.stock_count !== undefined ? item.extend.stock_count : -1,
    purchaseUrl,
    updatedAt: new Date().toISOString(),
  };
}

async function fetchProducts(page, token, goodsType, keywords, beforeAttempt) {
  const products = [];
  for (let current = 1; current <= MAX_PAGES; current++) {
    const response = await pageApi(page, token, '/shopApi/Shop/goodsList', {
      token,
      category_id: 0,
      goods_type: goodsType,
      current,
      pageSize: PAGE_SIZE,
      ...(keywords ? { keywords } : {}),
    }, beforeAttempt);
    if (response?.code !== 1 || !Array.isArray(response.data?.list)) {
      throw new Error(String(response?.msg || '商品接口返回异常'));
    }
    products.push(...response.data.list.map(normalizeProduct).filter(product => product.id));
    if (response.data.list.length < PAGE_SIZE || products.length >= Number(response.data.total)) break;
  }
  return products;
}

function isClosedBrowserError(error) {
  return /target page|context or browser has been closed|browser has been closed|page has been closed/i.test(error?.message || '');
}

function isRecoverableBrowserError(error) {
  return error?.code === 'BROWSER_FETCH_FAILED' || isClosedBrowserError(error);
}

async function collectOnce(url, options) {
  const token = String(url).match(/\/shop\/([^/?#]+)/)?.[1];
  if (!token) throw new Error(`无法从 URL 提取店铺标识: ${url}`);
  const collector = await getCollector(options.proxyUrl);
  await establishSession(collector, token, options.beforeAttempt);

  let shopName = '';
  if (options.includeInfo) {
    const info = await pageApi(collector.page, token, '/shopApi/Shop/info', { token, category_key: '' }, options.beforeAttempt);
    if (info?.code !== 1 || !info.data) throw new Error(String(info?.msg || '店铺信息接口返回异常'));
    shopName = info.data.nickname || token;
  }
  const candidates = options.refreshType === 'full'
    ? GOODS_TYPES
    : [...new Set((options.preferredTypes.length ? options.preferredTypes : GOODS_TYPES).filter(type => GOODS_TYPES.includes(type)))];
  const products = [];
  const activeTypes = [];
  for (const type of candidates) {
    const keywordsList = options.refreshType === 'full' ? [''] : FOCUS_KEYWORDS;
    for (const keywords of keywordsList) {
      const found = await fetchProducts(collector.page, token, type, keywords, options.beforeAttempt);
      if (found.length && !activeTypes.includes(type)) activeTypes.push(type);
      products.push(...found);
    }
  }
  return {
    shopName,
    products: [...new Map(products.map(product => [product.id, product])).values()],
    goodsTypes: activeTypes.length ? activeTypes : ['card'],
    probed: options.refreshType === 'probe' && !options.preferredTypes.length,
    requestRoute: 'browser',
  };
}

async function collectShop(url, { refreshType = 'plus', preferredTypes = [], proxyUrl = '', beforeAttempt, includeInfo = false } = {}) {
  const options = { refreshType, preferredTypes, proxyUrl, beforeAttempt, includeInfo };
  try {
    return await collectOnce(url, options);
  } catch (error) {
    const collector = activeCollector;
    if (error.code === 'UPSTREAM_CHALLENGE') await discardCollector(collector);
    if (!isRecoverableBrowserError(error)) throw error;
    await discardCollector(collector);
    try {
      return await collectOnce(url, options);
    } catch (retryError) {
      if (isRecoverableBrowserError(retryError)) {
        await discardCollector();
        throw upstreamError('UPSTREAM_UNAVAILABLE', `浏览器采集通道不可用: ${retryError.message}`);
      }
      throw retryError;
    }
  }
}

module.exports = { clearCollectorData, closeCollector, collectShop, findBrowserExecutable };
