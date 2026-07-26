'use strict';

const { predictGptTier } = require('./ml-classifier');

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
  if (/\b(?:team|business)\b|团队版|团队套餐|工作区邀请/i.test(text)) {
    return { tier: 'team', reason: '明确包含 Team/Business 特征' };
  }
  if (/(?:chat\s*gpt|gpt)\s*go\b|\bgo\s*(?:会员|套餐|月卡)/i.test(text)) {
    return { tier: 'go', reason: '明确包含 GPT Go 特征' };
  }
  if (/(?:chat\s*gpt|gpt)\s*pro\b|\bpro\s*(?:20x|账号|会员|月卡|代充|成品)/i.test(text)) {
    return { tier: 'pro', reason: '明确包含 GPT Pro 特征' };
  }
  const paidTier = /\b(?:plus|pro|team|business|k12)\b|gptplus/i.test(text);
  if (!paidTier && /(?:chat\s*gpt|gpt)\s*free\b|free\s*(?:号|账号)|普通号|普号|白号/i.test(text)) {
    return { tier: 'free', reason: '明确包含 GPT Free/普通账号特征' };
  }
  return null;
}

function inspectProductSubject(value) {
  const text = normalizeHybridText(value);
  const explicitGptTier = /(?:chat\s*gpt|gpt)\s*(?:plus|pro|team|business|k12|edu|free|go)\b|gptplus/i.test(text);
  const gptBrand = /chat\s*gpt|open\s*ai|\bgpt\b|gpt(?=plus|pro|team|k12|free)/i.test(text);
  const accountContext = explicitGptTier || /账号|成品|代充|充值|会员|订阅|套餐|独享|共享/i.test(text);

  if (/\b(?:claude|gemini|grok)\b/i.test(text) && !explicitGptTier) {
    return { eligible: false, product: 'other-ai', reason: '商品主体是其他 AI 产品' };
  }
  if (/接码|短信验证|验证码|号码租用|实卡\s*api|接码\s*api/i.test(text) && !accountContext) {
    return { eligible: false, product: 'sms', reason: '商品主体是接码或号码服务' };
  }
  if (/api\s*中转|中转\s*api|中转额度|中转站|镜像站|网页镜像|共享网关|反代/i.test(text) && !explicitGptTier) {
    return { eligible: false, product: 'relay', reason: '商品主体是中转或镜像服务' };
  }
  if (/邮箱|outlook|hotmail|gmail|icloud/i.test(text) && !accountContext && !explicitGptTier) {
    return { eligible: false, product: 'email', reason: '商品主体是邮箱服务' };
  }
  if (!gptBrand && !explicitGptTier) {
    return { eligible: false, product: null, reason: '缺少明确的 GPT 主体特征' };
  }
  return { eligible: true, product: 'gpt', reason: '确认商品主体为 GPT' };
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
  if (!knownProduct && !pre.eligible) {
    return {
      ...baseResult,
      hybrid: { accepted: false, source: 'pre-rule-rejected', reason: pre.reason },
    };
  }

  const prediction = predictGptTier(name, options);
  const decision = validateModelPrediction(name, prediction, { knownProduct });
  if (!decision.accepted) return { ...baseResult, hybrid: decision };
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
  return {
    ...baseResult,
    version: 2,
    category,
    product: 'gpt',
    tier: decision.tier,
    dimensions: { ...(baseResult?.dimensions || {}), tier: tierDimension },
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
  inspectProductSubject,
  isKnownGptClassification,
  normalizeHybridText,
  preClassifyProduct,
  validateModelPrediction,
};
