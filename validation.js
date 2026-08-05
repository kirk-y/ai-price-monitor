const SHOP_HOST = 'pay.ldxp.cn';
const STORE_ID_RE = /^[A-Za-z0-9_-]{1,100}$/;
const CATEGORY_RE = /^[\p{L}\p{N}_-]{1,80}$/u;

function normalizeShopUrl(value) {
  if (typeof value !== 'string' || !value.trim()) throw new Error('店铺URL格式错误');

  let parsed;
  try {
    parsed = new URL(value.trim());
  } catch (_) {
    throw new Error('店铺URL格式错误');
  }

  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.hostname.toLowerCase() !== SHOP_HOST) {
    throw new Error(`仅支持 ${SHOP_HOST} 店铺地址`);
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error('店铺URL不能包含认证信息、查询参数或片段');
  }

  const match = parsed.pathname.match(/^\/shop\/([A-Za-z0-9_-]{1,100})\/?$/);
  if (!match) throw new Error('店铺URL必须为 /shop/店铺ID 格式');

  return { id: match[1], url: `https://${SHOP_HOST}/shop/${match[1]}` };
}

function validateStoreId(value) {
  if (typeof value !== 'string' || !STORE_ID_RE.test(value)) {
    throw new Error('店铺ID仅允许字母、数字、下划线和连字符');
  }
  return value;
}

function validateCategory(value) {
  if (typeof value !== 'string' || !CATEGORY_RE.test(value)) {
    throw new Error('分类名称格式错误');
  }
  return value;
}

function normalizeRefreshConfig(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('刷新配置格式错误');
  const mode = ['fixed', 'random', 'disabled'].includes(value.mode) ? value.mode : null;
  if (!mode) throw new Error('刷新模式必须为 fixed、random 或 disabled');

  const toMinutes = (input, field) => {
    const n = Number(input);
    if (!Number.isInteger(n) || n < 1 || n > 1440) {
      throw new Error(`${field} 必须是 1 到 1440 之间的整数`);
    }
    return n;
  };

  const toRangeInt = (input, fallback, min, max, field) => {
    const n = Number(input ?? fallback);
    if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${field} must be between ${min} and ${max}`);
    return n;
  };

  const normalized = {
    mode,
    collectorMode: ['auto', 'direct', 'browser'].includes(value.collectorMode) ? value.collectorMode : 'auto',
    plusCycleMinutes: toRangeInt(value.plusCycleMinutes, 60, 5, 1440, 'Plus cycle'),
    typeProbeHours: toRangeInt(value.typeProbeHours, 24, 1, 720, 'Type probe interval'),
    catalogRefreshHours: toRangeInt(value.catalogRefreshHours, 24, 1, 720, 'Catalog refresh interval'),
    requestDelayMinSeconds: toRangeInt(value.requestDelayMinSeconds, 20, 1, 600, 'Minimum request delay'),
    requestDelayMaxSeconds: toRangeInt(value.requestDelayMaxSeconds, 60, 1, 900, 'Maximum request delay'),
    riskThreshold: toRangeInt(value.riskThreshold, 3, 1, 10, 'Risk threshold'),
    riskCooldownMinutes: toRangeInt(value.riskCooldownMinutes, 15, 5, 1440, 'Risk cooldown'),
    hourlyRequestLimit: toRangeInt(value.hourlyRequestLimit, 60, 1, 1000, 'Hourly request limit'),
    minMinutes: toMinutes(value.minMinutes ?? 60, '最小刷新间隔'),
    maxMinutes: toMinutes(value.maxMinutes ?? 360, '最大刷新间隔'),
    fixedMinutes: toMinutes(value.fixedMinutes ?? 120, '固定刷新间隔'),
  };
  if (normalized.minMinutes > normalized.maxMinutes) {
    throw new Error('最小刷新间隔不能大于最大刷新间隔');
  }
  if (normalized.requestDelayMinSeconds > normalized.requestDelayMaxSeconds) throw new Error('Minimum request delay cannot exceed maximum request delay');
  return normalized;
}

function normalizeRefreshProxyConfig(value, currentUrl = '') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('代理配置格式错误');
  const enabled = value.enabled === true;
  const supplied = String(value.proxyUrl || '').trim();
  let proxyUrl = value.clear === true ? '' : (supplied || String(currentUrl || '').trim());
  if (proxyUrl) {
    if (proxyUrl.length > 2048 || /[\u0000-\u001f]/.test(proxyUrl)) throw new Error('代理地址格式错误');
    let parsed;
    try { parsed = new URL(proxyUrl); } catch (_) { throw new Error('代理地址格式错误'); }
    if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname || parsed.search || parsed.hash) {
      throw new Error('代理地址必须是有效的 HTTP(S) 地址');
    }
    proxyUrl = parsed.toString();
  }
  if (enabled && !proxyUrl) throw new Error('启用代理前请填写代理地址');
  return { enabled, proxyUrl };
}

function normalizeStoreOrder(value) {
  if (!Array.isArray(value) || value.length > 500) throw new Error('店铺排序格式错误');
  const order = value.map(validateStoreId);
  if (new Set(order).size !== order.length) throw new Error('店铺排序中存在重复ID');
  return order;
}

function isLoopbackHost(host) {
  const normalized = String(host || '').trim().toLowerCase().replace(/^\[|\]$/g, '');
  return normalized === '127.0.0.1' || normalized === 'localhost' || normalized === '::1';
}

module.exports = {
  normalizeRefreshConfig,
  normalizeRefreshProxyConfig,
  normalizeShopUrl,
  normalizeStoreOrder,
  validateCategory,
  validateStoreId,
  isLoopbackHost,
};
