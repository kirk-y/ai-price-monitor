'use strict';

const RULE_VERSION = 2;

function normalizeText(value) {
  return String(value || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s\-_+|/\\()[\]{}]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeTerms(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(normalizeText).filter(Boolean))].slice(0, 100);
}

function normalizeRule(rule) {
  if (!rule || typeof rule !== 'object' || Array.isArray(rule)) throw new Error('分类规则格式错误');
  const id = String(rule.id || '').trim();
  const dimension = String(rule.dimension || '').trim();
  if (!/^[a-z][a-z0-9_-]{0,79}$/.test(id) || !/^[a-z][a-z0-9_-]{0,39}$/.test(dimension)) {
    throw new Error('分类规则ID格式错误');
  }
  return {
    id,
    dimension,
    label: String(rule.label || id).slice(0, 80),
    parent: rule.parent ? String(rule.parent).slice(0, 80) : null,
    priority: Math.max(-1000, Math.min(1000, Number(rule.priority) || 0)),
    enabled: rule.enabled !== false,
    all: normalizeTerms(rule.all),
    any: normalizeTerms(rule.any),
    exclude: normalizeTerms(rule.exclude),
    negative: normalizeTerms(rule.negative),
    products: Array.isArray(rule.products)
      ? [...new Set(rule.products.map(value => String(value || '').trim()).filter(value => /^[a-z][a-z0-9_-]{0,79}$/.test(value)))]
      : [],
  };
}

function termMatches(text, term) {
  return text.includes(term);
}

function evaluateRule(text, inputRule) {
  const rule = normalizeRule(inputRule);
  if (!rule.enabled) return { ...rule, matched: false, score: -Infinity, reason: 'disabled' };

  const excluded = rule.exclude.filter(term => termMatches(text, term));
  if (excluded.length) {
    return { ...rule, matched: false, score: -Infinity, excluded, hits: [], reason: 'excluded' };
  }

  const allHits = rule.all.filter(term => termMatches(text, term));
  if (allHits.length !== rule.all.length) {
    return { ...rule, matched: false, score: -Infinity, hits: allHits, reason: 'missing-required' };
  }

  const anyHits = rule.any.filter(term => termMatches(text, term));
  if (!rule.all.length && rule.any.length && !anyHits.length) {
    return { ...rule, matched: false, score: -Infinity, hits: [], reason: 'no-positive-hit' };
  }
  if (!rule.all.length && !rule.any.length) {
    return { ...rule, matched: false, score: -Infinity, hits: [], reason: 'no-positive-rule' };
  }

  const negativeHits = rule.negative.filter(term => termMatches(text, term));
  const specificity = [...allHits, ...anyHits].reduce((sum, term) => sum + Math.min(term.length, 24), 0);
  const score = rule.priority + allHits.length * 60 + anyHits.length * 20 + specificity - negativeHits.length * 10;
  return {
    ...rule,
    matched: true,
    score,
    hits: [...allHits, ...anyHits],
    negativeHits,
    reason: 'matched',
  };
}

function classifyDimension(text, rules, dimension, product = null) {
  const candidates = rules
    .filter(rule => rule.dimension === dimension && (!rule.products?.length || rule.products.includes(product)))
    .map(rule => evaluateRule(text, rule))
    .filter(result => result.matched)
    .sort((a, b) => b.score - a.score || b.priority - a.priority || a.id.localeCompare(b.id));
  const best = candidates[0] || null;
  const runnerUp = candidates[1] || null;
  return {
    value: best?.id || null,
    label: best?.label || null,
    score: best?.score || 0,
    confidence: best ? Math.max(0.05, Math.min(0.99, runnerUp ? 0.5 + Math.min(0.49, (best.score - runnerUp.score) / 100) : 0.9)) : 0,
    ambiguous: Boolean(best && runnerUp && best.score - runnerUp.score < 15),
    evidence: best?.hits || [],
    alternatives: candidates.slice(1, 4).map(item => ({ value: item.id, label: item.label, score: item.score })),
  };
}

function extractWarrantyDays(text) {
  const match = text.match(/(?:质保|售后|保修)\s*(\d{1,3})\s*(?:天|日)/i);
  if (match) return Math.min(365, Number(match[1]));
  if (/(?:质保|售后|保修)\s*(?:一年|1年)/i.test(text)) return 365;
  return null;
}

function classifyProduct(name, config = DEFAULT_CLASSIFICATION_CONFIG) {
  const text = normalizeText(name);
  const rules = (config.rules || []).map(normalizeRule);
  const dimensions = [...new Set(rules.map(rule => rule.dimension))];
  const productResult = classifyDimension(text, rules, 'product');
  const product = productResult.value || 'other';
  const results = { product: productResult };
  for (const dimension of dimensions) {
    if (dimension !== 'product') results[dimension] = classifyDimension(text, rules, dimension, product);
  }
  const tier = results.tier?.value || 'other';
  const subtype = results.subtype?.value || null;
  const category = tier !== 'other' && results.tier?.value
    ? `${product}_${tier}`
    : subtype ? `${product}_${subtype}` : product;
  const attributes = {};
  for (const dimension of dimensions) {
    if (dimension === 'product' || dimension === 'tier' || dimension === 'subtype') continue;
    if (results[dimension]?.value) attributes[dimension] = results[dimension].value;
  }
  const warrantyDays = extractWarrantyDays(text);
  if (warrantyDays) attributes.warrantyDays = warrantyDays;
  return {
    version: RULE_VERSION,
    name: String(name || ''),
    normalizedName: text,
    category,
    product,
    tier,
    attributes,
    dimensions: results,
    needsReview: !results.product?.value || Object.values(results).some(result => result.ambiguous),
  };
}

const DEFAULT_CLASSIFICATION_CONFIG = {
  version: RULE_VERSION,
  taxonomy: [
    { id: 'gpt', label: 'GPT', children: ['free', 'plus', 'pro', 'business', 'edu', 'go', 'other'] },
    { id: 'claude', label: 'Claude', children: ['free', 'pro', 'max', 'team', 'enterprise', 'other'] },
    { id: 'gemini', label: 'Gemini', children: ['free', 'ai_pro', 'ai_ultra', 'workspace', 'other'] },
    { id: 'grok', label: 'Grok', children: ['free', 'supergrok', 'other'] },
    { id: 'other_ai', label: '其他 AI', children: ['perplexity', 'poe', 'midjourney', 'suno', 'other'] },
    { id: 'developer_tools', label: 'AI 开发工具', children: ['cursor', 'codex', 'kiro', 'copilot', 'other'] },
    { id: 'sms', label: '接码', children: ['sms', 'number_rental', 'esim', 'other'] },
    { id: 'email', label: '邮箱', children: ['gmail', 'outlook', 'icloud', 'enterprise', 'other'] },
    { id: 'relay', label: '中转/镜像', children: ['api_relay', 'official_api', 'web_mirror', 'shared_gateway', 'other'] },
    { id: 'digital_membership', label: '数字会员', children: ['video', 'music', 'cloud_drive', 'reading', 'software', 'other'] },
    { id: 'network_cloud', label: '网络与云服务', children: ['proxy', 'vpn', 'cloud_server', 'domain', 'virtual_card', 'other'] },
    { id: 'recharge_life', label: '充值与生活', children: ['game', 'platform', 'redeem_code', 'ecommerce', 'coupon', 'other'] },
    { id: 'other', label: '其他', children: ['tutorial', 'enterprise_service', 'review', 'other'] },
  ],
  rules: [
    { id: 'gpt', dimension: 'product', label: 'GPT', priority: 80, any: ['chatgpt', 'gpt', 'plus', 'team', 'k12'], exclude: ['claude', 'gemini', 'grok'] },
    { id: 'claude', dimension: 'product', label: 'Claude', priority: 80, any: ['claude', '克劳德'], exclude: ['chatgpt'] },
    { id: 'gemini', dimension: 'product', label: 'Gemini', priority: 80, any: ['gemini', '谷歌ai'], exclude: ['chatgpt'] },
    { id: 'grok', dimension: 'product', label: 'Grok', priority: 80, any: ['grok', 'supergrok'], exclude: ['chatgpt'] },
    { id: 'developer_tools', dimension: 'product', label: 'AI 开发工具', priority: 50, any: ['cursor', 'codex', 'kiro', 'copilot'] },
    { id: 'other_ai', dimension: 'product', label: '其他 AI', priority: 35, any: ['perplexity', 'poe', 'midjourney', 'suno'] },
    { id: 'email', dimension: 'product', label: '邮箱', priority: 60, any: ['gmail', 'outlook', 'hotmail', 'icloud邮箱', '企业邮箱'] },
    { id: 'sms', dimension: 'product', label: '接码', priority: 120, any: ['接码', '短信验证', '验证码', '号码租用', 'esim'], exclude: ['已接码', '未接码', '没接码', '没有接码', '无需接码', '接码版本', '登录codex要接码', '登录codex需要接码'] },
    { id: 'relay', dimension: 'product', label: '中转/镜像', priority: 120, any: ['api中转', '中转api', '中转 api', '中转额度', '中转站', '中转券', '中转邀请', '镜像站', '共享网关', 'codex反代'] },
    { id: 'digital_membership', dimension: 'product', label: '数字会员', priority: 25, any: ['视频会员', '音乐会员', '网盘会员', '阅读会员', 'adobe', 'firefly', '剪映会员', '醒图会员'] },
    { id: 'network_cloud', dimension: 'product', label: '网络与云服务', priority: 25, any: ['住宅ip', '机房ip', 'vpn', '云服务器', '虚拟卡'] },
    { id: 'recharge_life', dimension: 'product', label: '充值与生活', priority: 20, any: ['充值卡', '兑换码', '生活券', '优惠券'] },
    { id: 'plus', dimension: 'tier', label: 'Plus', products: ['gpt'], priority: 30, any: ['plus'], exclude: ['pro', 'business', 'team', 'free', '普通号', '普号', '白号'] },
    { id: 'pro', dimension: 'tier', label: 'Pro', products: ['gpt', 'claude'], priority: 35, any: ['pro', 'pro账号'], exclude: ['claude max', 'supergrok'] },
    { id: 'business', dimension: 'tier', label: 'Business/Team', products: ['gpt'], priority: 45, any: ['business', 'team', '团队版'] },
    { id: 'go', dimension: 'tier', label: 'Go', products: ['gpt'], priority: 55, any: ['gpt go', 'go会员'] },
    { id: 'free', dimension: 'tier', label: 'Free', products: ['gpt', 'claude', 'gemini', 'grok'], priority: 50, any: ['free', '普通号', '普号', '白号'], exclude: ['plus', 'pro'] },
    { id: 'max', dimension: 'tier', label: 'Max', products: ['claude'], priority: 40, any: ['max'] },
    { id: 'ai_pro', dimension: 'tier', label: 'Google AI Pro', products: ['gemini'], priority: 40, any: ['ai pro', 'gemini pro', 'pro年卡'] },
    { id: 'ai_ultra', dimension: 'tier', label: 'Google AI Ultra', products: ['gemini'], priority: 50, any: ['ai ultra', 'gemini ultra'] },
    { id: 'supergrok', dimension: 'tier', label: 'SuperGrok', products: ['grok'], priority: 50, any: ['supergrok', 'super grok'] },
    { id: 'cursor', dimension: 'subtype', label: 'Cursor', products: ['developer_tools'], priority: 50, any: ['cursor'] },
    { id: 'codex', dimension: 'subtype', label: 'Codex', products: ['developer_tools'], priority: 50, any: ['codex'] },
    { id: 'kiro', dimension: 'subtype', label: 'Kiro', products: ['developer_tools'], priority: 50, any: ['kiro'] },
    { id: 'gmail', dimension: 'subtype', label: 'Gmail', products: ['email'], priority: 50, any: ['gmail'] },
    { id: 'outlook', dimension: 'subtype', label: 'Outlook', products: ['email'], priority: 50, any: ['outlook', 'hotmail'] },
    { id: 'api_relay', dimension: 'subtype', label: 'API中转', products: ['relay'], priority: 50, any: ['api中转', '中转额度'] },
    { id: 'web_mirror', dimension: 'subtype', label: '网页镜像', products: ['relay'], priority: 50, any: ['镜像站', '网页镜像'] },
    { id: 'unverified', dimension: 'verification', label: '未接码', priority: 90, any: ['未接码', '不接码', '没接码', '没有接码'], exclude: ['已接码', '无需接码'] },
    { id: 'verified', dimension: 'verification', label: '已接码', priority: 80, any: ['已接码'], exclude: ['未接码', '无需接码'] },
    { id: 'not_required', dimension: 'verification', label: '无需接码', priority: 100, any: ['无需接码', '免接码'] },
    { id: 'self_service', dimension: 'activation', label: '自助开通', priority: 60, any: ['自助开通', '自助充值', '自动开通', '秒开'] },
    { id: 'ready_account', dimension: 'activation', label: '成品号', priority: 50, any: ['成品号', '现号', '直接登录'] },
    { id: 'top_up', dimension: 'activation', label: '代充', priority: 50, any: ['代充', '充值'], exclude: ['自助充值'] },
    { id: 'no_warranty', dimension: 'warranty', label: '无质保', priority: 100, any: ['无质保', '不质保', '不包售后', '售出不退'] },
    { id: 'warranty', dimension: 'warranty', label: '有质保', priority: 50, any: ['质保', '售后', '保修'], exclude: ['无质保', '不质保', '不包售后', '售出不退'] },
    { id: 'exclusive', dimension: 'usage', label: '独享', priority: 50, any: ['独享', '独立号', '单人'] },
    { id: 'shared', dimension: 'usage', label: '共享', priority: 50, any: ['共享', '拼车', '合租'] },
    { id: 'k12', dimension: 'qualification', label: 'K12', priority: 50, any: ['k12'] },
    { id: 'higher_education', dimension: 'qualification', label: '高校', priority: 50, any: ['高校', '大学', 'edu'] },
  ],
};

function validateClassificationConfig(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('分类配置格式错误');
  if (!Array.isArray(config.rules) || config.rules.length > 2000) throw new Error('分类规则格式错误');
  const rules = config.rules.map(normalizeRule);
  const ids = new Set();
  for (const rule of rules) {
    const key = `${rule.dimension}:${rule.id}`;
    if (ids.has(key)) throw new Error(`分类规则重复: ${key}`);
    ids.add(key);
  }
  const taxonomy = Array.isArray(config.taxonomy) ? config.taxonomy.slice(0, 100).map(item => ({
    id: String(item?.id || '').slice(0, 80),
    label: String(item?.label || '').slice(0, 80),
    children: Array.isArray(item?.children) ? item.children.map(value => String(value).slice(0, 80)).slice(0, 100) : [],
  })) : [];
  return { version: RULE_VERSION, taxonomy, rules };
}

function feedbackTokens(name) {
  const normalized = normalizeText(name);
  const tokens = normalized.match(/[a-z][a-z0-9+.]{1,30}|[\u4e00-\u9fff]{2,8}/g) || [];
  const ignored = new Set(['账号', '商品', '自动', '购买', '专用', '全新', '稳定']);
  return [...new Set(tokens.filter(token => !ignored.has(token)))];
}

function buildFeedbackSuggestions(feedback, minimumSupport = 2) {
  const groups = new Map();
  for (const item of Array.isArray(feedback) ? feedback : []) {
    const dimension = String(item?.dimension || '');
    const newValue = String(item?.new_value || item?.newValue || '');
    if (!dimension || !newValue || newValue === 'unknown') continue;
    const key = `${dimension}:${newValue}`;
    if (!groups.has(key)) groups.set(key, { dimension, value: newValue, rows: [], counts: new Map(), oldValues: new Map() });
    const group = groups.get(key);
    group.rows.push(item);
    for (const token of feedbackTokens(item.name)) group.counts.set(token, (group.counts.get(token) || 0) + 1);
    const oldValue = String(item.old_value || item.oldValue || '');
    if (oldValue && oldValue !== 'unknown') group.oldValues.set(oldValue, (group.oldValues.get(oldValue) || 0) + 1);
  }
  const suggestions = [];
  for (const group of groups.values()) {
    if (group.rows.length < minimumSupport) continue;
    for (const [term, support] of group.counts) {
      const ratio = support / group.rows.length;
      if (support < minimumSupport || ratio < 0.6) continue;
      suggestions.push({
        type: 'include', dimension: group.dimension, value: group.value, term,
        support, total: group.rows.length, confidence: Number(ratio.toFixed(2)),
      });
      for (const [oldValue, oldSupport] of group.oldValues) {
        if (oldSupport >= minimumSupport) suggestions.push({
          type: 'exclude', dimension: group.dimension, value: oldValue, term,
          support: Math.min(support, oldSupport), total: group.rows.length, confidence: Number(ratio.toFixed(2)),
        });
      }
    }
  }
  return suggestions.sort((a, b) => b.support - a.support || b.confidence - a.confidence).slice(0, 100);
}

module.exports = {
  DEFAULT_CLASSIFICATION_CONFIG,
  RULE_VERSION,
  classifyProduct,
  buildFeedbackSuggestions,
  evaluateRule,
  normalizeText,
  validateClassificationConfig,
};
