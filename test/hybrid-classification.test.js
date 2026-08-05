'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  classifyHybridProduct,
  inspectProductSubject,
  isKnownGptClassification,
  preClassifyProduct,
  validateModelPrediction,
} = require('../hybrid-classification');

test('pre-rules reject non-product GPT mentions', () => {
  assert.equal(inspectProductSubject('Codex 接码，一次码，支持 GPT').product, 'sms');
  assert.equal(inspectProductSubject('Claude GPT API 中转额度').product, 'relay');
  assert.equal(inspectProductSubject('Outlook 邮箱，可注册 ChatGPT').product, 'email');
});

test('pre-rules keep GPT products that mention account attributes', () => {
  assert.equal(inspectProductSubject('GPT Plus 成品号，无接码').eligible, true);
  assert.equal(inspectProductSubject('ChatGPT Pro 20X 官方代充').eligible, true);
  assert.equal(inspectProductSubject('Plus 已接码 仅反代').eligible, true);
  assert.equal(inspectProductSubject('Plus 周额度 outlook邮箱').eligible, true);
  assert.equal(inspectProductSubject('GPT Plus 越南visa实卡开通').eligible, true);
});

test('strong tier precedence keeps K12 separate from Team', () => {
  assert.equal(preClassifyProduct('GPT K12 Team 教育套餐').strongTier, 'k12');
  assert.equal(preClassifyProduct('ChatGPT Business 工作区邀请').strongTier, 'team');
  assert.equal(preClassifyProduct('GPT Pro 20X 成品号').strongTier, 'pro');
  assert.equal(preClassifyProduct('GPT Plus 卡充 Pro 5X').strongTier, 'pro');
  assert.equal(preClassifyProduct('GPT Plus充值，已有team不能冲').strongTier, 'plus');
  assert.equal(preClassifyProduct('纯plus-gpt套餐').strongTier, 'plus');
  assert.equal(preClassifyProduct('GPT Free 成品号，非plus').strongTier, 'free');
});

test('post-rules correct contradictory model predictions', () => {
  const corrected = validateModelPrediction('GPT K12 Team 教育套餐', { tier: 'team', confidence: 0.9 });
  assert.equal(corrected.tier, 'k12');
  assert.equal(corrected.source, 'post-rule-corrected');
});

test('post-rules mark uncertain predictions for review', () => {
  const result = validateModelPrediction('GPT 老号长期稳定', { tier: 'plus', confidence: 0.58 });
  assert.equal(result.tier, 'plus');
  assert.equal(result.needsReview, true);
  assert.equal(result.source, 'model-low-confidence');
});

test('known GPT context allows ambiguous marketplace titles into tier validation', () => {
  const result = validateModelPrediction('韩国渠道成品号，质保首登', { tier: 'plus', confidence: 0.82 }, { knownProduct: true });
  assert.equal(result.accepted, true);
  assert.equal(result.tier, 'plus');
});

test('pre-rules reject GPT peripheral services as account products', () => {
  const result = inspectProductSubject('ChatGPT 提链 支付链接提取');
  assert.equal(result.eligible, false);
  assert.equal(result.product, 'gpt-service');
});

test('explicit SMS services override referenced GPT tiers', () => {
  const base = { version: 3, category: 'gpt_plus', product: 'gpt', tier: 'plus', dimensions: { product: { value: 'gpt', confidence: 0.9 } }, attributes: {} };
  const result = classifyHybridProduct('GPT Plus/Free 接码专用，质保接码成功', base, { knownProduct: true });
  assert.equal(result.category, 'sms');
  assert.equal(result.product, 'sms');
});

test('GPT peripheral services override stale GPT labels', () => {
  const base = { version: 3, category: 'gpt_service_link', product: 'gpt_service', tier: 'other', dimensions: { product: { value: 'gpt_service', confidence: 0.9 } }, attributes: {} };
  const result = classifyHybridProduct('ChatGPT 提链 支付链接提取', base, { knownProduct: true });
  assert.equal(result.category, 'gpt_service_link');
  assert.equal(result.product, 'gpt_service');
});

test('pre-rules separate tutorials from account products', () => {
  const result = inspectProductSubject('未接码 Plus gpt号接码教程');
  assert.equal(result.eligible, false);
  assert.equal(result.product, 'tutorial');
});

test('subject guard prevents reference text from changing the sold product', () => {
  const base = { version: 3, category: 'gpt', product: 'gpt', tier: 'other', dimensions: { product: { value: 'gpt', confidence: 0.9 } }, attributes: {} };
  const result = classifyHybridProduct('Outlook邮箱 可注册 ChatGPT', base, { knownProduct: true });
  assert.equal(result.category, 'email');
  assert.equal(result.product, 'email');
  assert.equal(result.hybrid.accepted, false);
});

test('other AI brands remain the product when delivery attributes are present', () => {
  const base = { version: 3, category: 'sms', product: 'sms', tier: 'other', dimensions: { product: { value: 'sms', confidence: 0.9 } }, attributes: {} };
  const result = classifyHybridProduct('Claude Code 普号 带快速接码', base, { knownProduct: false });
  assert.equal(result.category, 'claude');
  assert.equal(result.product, 'claude');
});

test('concatenated AI brands override stale GPT labels', () => {
  const grokBase = { version: 3, category: 'grok_supergrok', product: 'grok', tier: 'supergrok', dimensions: { product: { value: 'grok', confidence: 0.9 } }, attributes: {} };
  const claudeBase = { version: 3, category: 'claude_pro', product: 'claude', tier: 'pro', dimensions: { product: { value: 'claude', confidence: 0.9 } }, attributes: {} };
  assert.equal(classifyHybridProduct('SuperGrok Heavy 年卡', grokBase, { knownProduct: true }).category, 'grok_supergrok');
  assert.equal(classifyHybridProduct('ClaudePro 七天成品号', claudeBase, { knownProduct: true }).category, 'claude_pro');
});

test('reference use does not turn virtual cards into GPT products', () => {
  const base = { version: 3, category: 'gpt_other', product: 'gpt', tier: 'other', dimensions: { product: { value: 'gpt', confidence: 0.9 } }, attributes: {} };
  const result = classifyHybridProduct('VISA 0刀虚拟卡（gpt需要手法）', base, { knownProduct: true });
  assert.equal(result.category, 'network_cloud_virtual_card');
  assert.equal(result.product, 'network_cloud');
});

test('explicit mirror products are classified as relay services', () => {
  const base = { version: 3, category: 'gpt_plus', product: 'gpt', tier: 'plus', dimensions: { product: { value: 'gpt', confidence: 0.9 } }, attributes: {} };
  const result = classifyHybridProduct('GPT PLUS 镜像站周卡', base, { knownProduct: true });
  assert.equal(result.category, 'relay');
  assert.equal(result.product, 'relay');
});

test('known GPT K12 context is not replaced by relay wording', () => {
  const base = { version: 3, category: 'relay', product: 'relay', tier: 'other', dimensions: { product: { value: 'relay', confidence: 0.9 } }, attributes: {} };
  const result = classifyHybridProduct('K12 Team 反代专用', base, { knownProduct: true });
  assert.equal(result.category, 'gpt_k12');
  assert.equal(result.product, 'gpt');
});

test('hybrid classification supplies confidence for known GPT context', () => {
  const base = { version: 2, dimensions: { product: { value: null, confidence: 0 } }, attributes: {} };
  const result = classifyHybridProduct('韩国渠道成品号，质保首登', base, { knownProduct: true });
  assert.equal(result.dimensions.product.value, 'gpt');
  assert.ok(result.dimensions.product.confidence > 0.3);
});

test('recognizes canonical and legacy GPT labels without matching other products', () => {
  assert.equal(isKnownGptClassification('gpt_plus'), true);
  assert.equal(isKnownGptClassification('plus_未接码'), true);
  assert.equal(isKnownGptClassification('gptk12'), true);
  assert.equal(isKnownGptClassification('sms'), false);
  assert.equal(isKnownGptClassification({ category: 'other', classification: { product: 'gpt' } }), true);
});
