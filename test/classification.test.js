'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  classifyProduct,
  buildFeedbackSuggestions,
  evaluateRule,
  normalizeText,
  validateClassificationConfig,
} = require('../classification');

test('normalizes full-width characters and separators', () => {
  assert.equal(normalizeText('ＧＰＴ-Plus_未接码'), 'gpt plus 未接码');
});

test('exclude terms override positive terms', () => {
  const result = evaluateRule('gpt plus 无质保', {
    id: 'warranty', dimension: 'warranty', any: ['质保'], exclude: ['无质保'],
  });
  assert.equal(result.matched, false);
  assert.equal(result.reason, 'excluded');
});

test('classifies GPT dimensions independently', () => {
  const result = classifyProduct('ChatGPT Plus 未接码 自助开通 独享 质保30天');
  assert.equal(result.category, 'gpt_plus');
  assert.deepEqual(result.attributes, {
    verification: 'unverified',
    activation: 'self_service',
    warranty: 'warranty',
    warrantyDays: 30,
    usage: 'exclusive',
  });
});

test('negated warranty and no-verification phrases win', () => {
  const result = classifyProduct('GPT Plus 无需接码 自助开通 无质保');
  assert.equal(result.attributes.verification, 'not_required');
  assert.equal(result.attributes.warranty, 'no_warranty');
});

test('does not confuse Kiro with Claude', () => {
  const result = classifyProduct('Kiro Pro 开发工具账号');
  assert.equal(result.product, 'developer_tools');
  assert.equal(result.category, 'developer_tools_kiro');
});

test('rejects duplicate rules in one dimension', () => {
  assert.throws(() => validateClassificationConfig({ rules: [
    { id: 'plus', dimension: 'tier', any: ['plus'] },
    { id: 'plus', dimension: 'tier', any: ['plus会员'] },
  ] }), /规则重复/);
});

test('feedback suggestions require repeated evidence', () => {
  const suggestions = buildFeedbackSuggestions([
    { dimension: 'verification', old_value: 'verified', new_value: 'unverified', name: 'Plus 未接码 独享' },
    { dimension: 'verification', old_value: 'verified', new_value: 'unverified', name: 'GPT Plus 未接码' },
    { dimension: 'verification', old_value: 'verified', new_value: 'unverified', name: 'Claude Pro' },
  ]);
  assert.ok(suggestions.some(item => item.type === 'include' && item.term === 'plus'));
  assert.ok(suggestions.some(item => item.type === 'exclude' && item.value === 'verified'));
});
