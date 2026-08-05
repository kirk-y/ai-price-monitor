'use strict';

const { predictGptTier } = require('./ml-classifier');
const { RULE_VERSION } = require('./classification');

function normalizeHybridText(value) {
  return String(value || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s\-_+|/\\()[\]{}]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function detectStrongTier(value) {
  const text = normalizeHybridText(value);
  if (/\bk12\b|(?:chat\s*gpt|gpt)\s*edu|教育(?:版|套餐)/i.test(text)) {
    return { tier: 'k12', reason: '明确包含 K12/教育套餐特征' };
  }
  const teamNegated = /(?:team|business).{0,8}(?:不能|不可|不支持|无法|勿拍)|(?:不能|不可|不支持|无法).{0,8}(?:team|business)/i.test(text);
  if (!teamNegated && /\b(?:team|business)\b|团队版|团队套餐|工作区邀请/i.test(text)) {
    return { tier: 'team', reason: '明确包含 Team/Business 特征' };
  }
  if (/(?:chat\s*gpt|gpt)\s*go\b|\bgo\s*(?:会员|套餐|月卡)/i.test(text)) {
    return { tier: 'go', reason: '明确包含 GPT Go 特征' };
  }
  if (/(?:chat\s*gpt|gpt)\s*pro\b|\bpro\s*(?:5x|20x|账号|会员|月卡|代充|成品)/i.test(text)) {
    return { tier: 'pro', reason: '明确包含 GPT Pro 特征' };
  }
  const paidTierText = text.replace(/(?:非|不是|并非|不含|not)\s*(?:plus|pro|team|business|k12)\b/gi, ' ');
  const paidTier = /\b(?:plus|pro|team|business|k12)\b|gptplus/i.test(paidTierText);
  if (!paidTier && /(?:chat\s*gpt|gpt)\s*free\b|free\s*(?:号|账号)|普通号|普号|白号/i.test(text)) {
    return { tier: 'free', reason: '明确包含 GPT Free/普通账号特征' };
  }
  if (/(?:chat\s*gpt|gpt)\s*plus\b|\bplus\s*(?:chat\s*gpt|gpt)\b|gptplus/i.test(paidTierText)) {
    return { tier: 'plus', reason: '明确包含 GPT Plus 特征' };
  }
  if (hasImplicitGptPlusContext(text)) {
    return { tier: 'plus', reason: 'Plus 标题包含接码状态、成品号或账号交付特征' };
  }
  return null;
}

function hasImplicitGptPlusContext(value) {
  const text = normalizeHybridText(value);
  const accountSignal = '(?:已接码|未接码|不接码|无需接码|成品号?|账号|账户|自助开通|自助充值|周额度|额度|\\brt\\b|refresh\\s*token|uip|oa渠道|质保首登|反代)';
  return new RegExp(`\\bplus\\b.*${accountSignal}|${accountSignal}.*\\bplus\\b`, 'i').test(text);
}

function inspectProductSubject(value) {
  const text = normalizeHybridText(value);
  const implicitGptPlus = hasImplicitGptPlusContext(text);
  const explicitGptTier = /(?:chat\s*gpt|gpt)\s*(?:plus|pro|team|business|k12|edu|free|go)\b|gptplus/i.test(text) || implicitGptPlus;
  const gptBrand = /chat\s*gpt|open\s*ai|\bgpt\b|gpt(?=plus|pro|team|k12|free)/i.test(text) || implicitGptPlus;
  const accountContext = explicitGptTier || /账号|成品|代充|充值|会员|订阅|套餐|独享|共享/i.test(text);

  if (/(?:教程|教学|课程|指南|脚本)/i.test(text)
    && !/(?:成品号|账号|账户|会员|订阅|购买|代充|自助开通|售卖)/i.test(text)) {
    return { eligible: false, product: 'tutorial', definitive: true, reason: '商品主体是教程或教学内容' };
  }
  if (/(?:接码专用|专用接码|接码服务|接码成功率|一次码|临时码)/i.test(text)) {
    return { eligible: false, product: 'sms', definitive: true, reason: '商品主体是接码服务' };
  }
  if (/(?:虚拟卡|\bvisa\b.{0,12}(?:0\s*刀|卡)|\bmastercard\b.{0,8}卡)/i.test(text)
    && !/非虚拟卡/i.test(text) && !explicitGptTier) {
    return { eligible: false, product: 'network-cloud', category: 'network_cloud_virtual_card', definitive: true, reason: '商品主体是虚拟卡' };
  }
  if (/(?:api\s*中转|中转\s*api|中转站|镜像站|网页镜像)/i.test(text)) {
    return { eligible: false, product: 'relay', definitive: true, reason: '商品主体是中转或镜像服务' };
  }

  if (/(?:claude(?=pro|max|code|\b)|gemini(?=pro|ultra|\b)|(?:super\s*)?grok)/i.test(text) && !explicitGptTier) {
    const brand = /claude(?=pro|max|code|\b)/i.test(text) ? 'claude' : /gemini(?=pro|ultra|\b)/i.test(text) ? 'gemini' : 'grok';
    return { eligible: false, product: 'other-ai', brand, definitive: true, reason: '商品主体是其他 AI 产品' };
  }
  if (/接码|短信验证|验证码|号码租用|实卡\s*api|接码\s*api/i.test(text) && !accountContext) {
    return { eligible: false, product: 'sms', reason: '商品主体是接码或号码服务' };
  }
  if (/api\s*中转|中转\s*api|中转额度|中转站|镜像站|网页镜像|共享网关|反代/i.test(text) && !explicitGptTier) {
    return { eligible: false, product: 'relay', reason: '商品主体是中转或镜像服务' };
  }
  if (gptBrand && /(?:提链|提取链接|长链提取|扫码对接|代付代扫|支付二维码|重置额度|额度重置|恢复额度|刷新额度)/i.test(text)
    && !/(?:成品号|账号|账户|账密|会员|订阅|代充|充值到|自助开通)/i.test(text)) {
    return { eligible: false, product: 'gpt-service', definitive: true, reason: '商品主体是 GPT 周边服务' };
  }
  if (/邮箱|outlook|hotmail|gmail|icloud/i.test(text) && !accountContext && !explicitGptTier) {
    return { eligible: false, product: 'email', reason: '商品主体是邮箱服务' };
  }
  if (!gptBrand && !explicitGptTier) {
    return { eligible: false, product: null, reason: '缺少明确的 GPT 主体特征' };
  }
  return { eligible: true, product: 'gpt', reason: '确认商品主体为 GPT' };
}

function hasKnownGptAccountContext(value) {
  const text = normalizeHybridText(value);
  return /(?:chat\s*gpt|gpt)\s*(?:plus|pro|team|business|k12|edu|free|go)\b|gptplus/i.test(text)
    || hasImplicitGptPlusContext(text)
    || /\b(?:plus|k12|team|business|free)\b|普号|普通号|白号/i.test(text);
}

function guardClassificationSubject(baseResult, subject) {
  if (!subject?.product || subject.eligible) return baseResult;
  const brand = subject.product === 'other-ai' ? subject.brand : null;
  const product = brand || (subject.product === 'other-ai' ? 'other_ai' : subject.product === 'tutorial' ? 'other' : subject.product.replace(/-/g, '_'));
  if (subject.product === 'other-ai') {
    if (String(baseResult?.category || '').startsWith('relay')) return baseResult;
    if (['claude', 'gemini', 'grok', 'other_ai'].includes(baseResult?.product)) return baseResult;
  }
  if (!['sms', 'email', 'relay', 'gpt-service', 'other-ai', 'tutorial', 'network-cloud'].includes(subject.product)) return baseResult;
  const current = baseResult?.dimensions?.product || {};
  const category = subject.category || (subject.product === 'tutorial'
    ? 'other_tutorial'
    : subject.product === 'gpt-service'
    ? (String(baseResult?.category || '').startsWith('gpt_service') ? baseResult.category : 'gpt_service')
    : ['sms', 'email', 'relay'].includes(subject.product) && String(baseResult?.category || '').startsWith(`${product}_`)
      ? baseResult.category
      : product);
  return {
    ...baseResult,
    product,
    tier: 'other',
    category,
    dimensions: {
      ...(baseResult?.dimensions || {}),
      product: { ...current, value: product, label: product, confidence: Math.max(0.7, Number(current.confidence) || 0), ambiguous: false },
    },
    needsReview: false,
  };
}

function preClassifyProduct(name) {
  const subject = inspectProductSubject(name);
  if (!subject.eligible) return { ...subject, strongTier: null };
  const strong = detectStrongTier(name);
  return { ...subject, strongTier: strong?.tier || null, strongReason: strong?.reason || null };
}

function isKnownGptClassification(labelOrCategory) {
  if (!labelOrCategory) return false;
  if (typeof labelOrCategory === 'string') {
    return /^(?:gpt(?:_|$)|plus_|gptk12$)/i.test(labelOrCategory);
  }
  return isKnownGptClassification(labelOrCategory.category)
    || labelOrCategory.classification?.product === 'gpt';
}

function validateModelPrediction(name, prediction, options = {}) {
  const pre = options.knownProduct
    ? { eligible: true, product: 'gpt', reason: '已有分类上下文确认商品主体为 GPT', ...(() => {
      const strong = detectStrongTier(name);
      return { strongTier: strong?.tier || null, strongReason: strong?.reason || null };
    })() }
    : preClassifyProduct(name);
  if (!pre.eligible) {
    return {
      accepted: false,
      tier: null,
      source: 'pre-rule-rejected',
      needsReview: false,
      reason: pre.reason,
    };
  }

  const modelTier = String(prediction?.tier || 'other');
  const confidence = Number(prediction?.confidence || 0);
  if (pre.strongTier && pre.strongTier !== modelTier) {
    return {
      accepted: true,
      tier: pre.strongTier,
      source: 'post-rule-corrected',
      needsReview: false,
      reason: `${pre.strongReason}，覆盖模型结果 ${modelTier}`,
    };
  }

  const text = normalizeHybridText(name);
  if (modelTier === 'other' && /(?:chat\s*gpt|gpt)\s*plus\b|gptplus|\bplus\s*(?:账号|会员|成品|代充)/i.test(text)) {
    return {
      accepted: true,
      tier: 'plus',
      source: 'post-rule-corrected',
      needsReview: false,
      reason: '明确包含 GPT Plus 特征，修正模型的其他分类',
    };
  }

  return {
    accepted: true,
    tier: modelTier,
    source: confidence < 0.65 ? 'model-low-confidence' : 'model',
    needsReview: confidence < 0.65,
    reason: confidence < 0.65 ? '模型置信度较低，需要复核' : '模型结果通过规则校验',
  };
}

function classifyHybridProduct(name, baseResult, options = {}) {
  const knownProduct = options.knownProduct === true;
  const pre = preClassifyProduct(name);
  const conflictingSubject = new Set(['other-ai', 'sms', 'relay', 'email', 'gpt-service', 'tutorial', 'network-cloud']).has(pre.product);
  const trustedKnownProduct = knownProduct && (
    !conflictingSubject
    || (!pre.definitive && !['other-ai', 'tutorial'].includes(pre.product) && hasKnownGptAccountContext(name))
  );
  if (!trustedKnownProduct && !pre.eligible) {
    return {
      ...guardClassificationSubject(baseResult, pre),
      hybrid: { accepted: false, source: 'pre-rule-rejected', reason: pre.reason },
    };
  }

  const prediction = predictGptTier(name, { ...options, knownProduct: trustedKnownProduct });
  const decision = validateModelPrediction(name, prediction, { knownProduct: trustedKnownProduct });
  if (!decision.accepted) return { ...guardClassificationSubject(baseResult, pre), hybrid: decision };
  const category = decision.tier === 'other' ? 'gpt_other' : `gpt_${decision.tier}`;
  const tierDimension = {
    value: decision.tier,
    label: decision.tier,
    score: prediction.margin,
    confidence: prediction.confidence,
    ambiguous: decision.needsReview,
    evidence: [],
    alternatives: prediction.alternatives.map(item => ({ value: item.label, score: item.score })),
  };
  const existingProductDimension = baseResult?.dimensions?.product || {};
  const productDimension = {
    ...existingProductDimension,
    value: 'gpt',
    label: 'GPT',
    score: existingProductDimension.value === 'gpt' ? existingProductDimension.score : prediction.margin,
    confidence: trustedKnownProduct ? Math.max(0.95, Number(existingProductDimension.confidence) || 0) : prediction.confidence,
    ambiguous: false,
    evidence: knownProduct ? ['existing-gpt-label'] : existingProductDimension.evidence || [],
    alternatives: existingProductDimension.alternatives || [],
  };
  return {
    ...baseResult,
    version: RULE_VERSION,
    category,
    product: 'gpt',
    tier: decision.tier,
    dimensions: { ...(baseResult?.dimensions || {}), product: productDimension, tier: tierDimension },
    needsReview: Boolean(baseResult?.dimensions?.product?.ambiguous || decision.needsReview),
    hybrid: {
      ...decision,
      modelTier: prediction.tier,
      confidence: prediction.confidence,
      margin: prediction.margin,
    },
  };
}

module.exports = {
  classifyHybridProduct,
  detectStrongTier,
  guardClassificationSubject,
  hasKnownGptAccountContext,
  inspectProductSubject,
  isKnownGptClassification,
  normalizeHybridText,
  preClassifyProduct,
  validateModelPrediction,
};
