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
  assert.equal(inspectProductSubject('Claude GPT API 中转额度').product, 'other-ai');
  assert.equal(inspectProductSubject('Outlook 邮箱，可注册 ChatGPT').product, 'email');
});

test('pre-rules keep GPT products that mention account attributes', () => {
  assert.equal(inspectProductSubject('GPT Plus 成品号，无接码').eligible, true);
  assert.equal(inspectProductSubject('ChatGPT Pro 20X 官方代充').eligible, true);
});

test('strong tier precedence keeps K12 separate from Team', () => {
  assert.equal(preClassifyProduct('GPT K12 Team 教育套餐').strongTier, 'k12');
  assert.equal(preClassifyProduct('ChatGPT Business 工作区邀请').strongTier, 'team');
  assert.equal(preClassifyProduct('GPT Pro 20X 成品号').strongTier, 'pro');
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
