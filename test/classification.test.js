'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  DEFAULT_CLASSIFICATION_CONFIG,
  classifyProduct,
  buildFeedbackSuggestions,
  evaluateRule,
  migrateClassificationConfig,
  normalizeText,
  RULE_VERSION,
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

test('K12 wins over Team wording in marketplace titles', () => {
  const result = classifyProduct('GPT K12 Team 子号成品');
  assert.equal(result.category, 'gpt_k12');
  assert.equal(result.attributes.qualification, 'k12');
});

test('does not classify a plus-only title as GPT without an explicit subject', () => {
  assert.equal(classifyProduct('Plus 会员 年卡').product, 'other');
});

test('recognizes omitted GPT brand only with Plus account evidence', () => {
  const result = classifyProduct('Plus 已接码 成品号 带RT');
  assert.equal(result.category, 'gpt_plus');
  assert.equal(result.attributes.verification, 'verified');
});

test('separates GPT peripheral services from Plus accounts', () => {
  const result = classifyProduct('ChatGPT 提链 支付链接提取');
  assert.equal(result.category, 'gpt_service_link');
});

test('rejects duplicate rules in one dimension', () => {
  assert.throws(() => validateClassificationConfig({ rules: [
    { id: 'plus', dimension: 'tier', any: ['plus'] },
    { id: 'plus', dimension: 'tier', any: ['plus会员'] },
  ] }), /规则重复/);
});

test('migrates legacy configs without restoring deleted old rules', () => {
  const legacy = JSON.parse(JSON.stringify(DEFAULT_CLASSIFICATION_CONFIG));
  legacy.version = 2;
  legacy.taxonomy = legacy.taxonomy.filter(item => item.id !== 'gpt_service');
  legacy.rules = legacy.rules.filter(rule => !['product:gpt_service', 'subtype:link', 'subtype:scan', 'subtype:reset'].includes(`${rule.dimension}:${rule.id}`));
  legacy.rules = legacy.rules.filter(rule => rule.id !== 'plus');
  legacy.rules.push({ id: 'custom', dimension: 'product', label: '自定义', priority: 1, any: ['custom'] });
  const migrated = migrateClassificationConfig(legacy);
  assert.equal(migrated.version, RULE_VERSION);
  assert.equal(migrated.rules.some(rule => rule.id === 'gpt_service' && rule.dimension === 'product'), true);
  assert.equal(migrated.rules.some(rule => rule.id === 'plus' && rule.dimension === 'tier'), false);
  assert.equal(migrated.rules.some(rule => rule.id === 'custom' && rule.dimension === 'product'), true);
  assert.deepEqual(migrateClassificationConfig(migrated), migrated);
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
