'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { predictGptTier } = require('../ml-classifier');

test('Node classifier reproduces expected GPT tier predictions', () => {
  const cases = [
    ['GPT Plus 未接码质保30天', 'plus'],
    ['ChatGPT Team 团队版', 'team'],
    ['GPT K12 EDU 成品号', 'k12'],
    ['GPT Pro 20X 官方充值', 'pro'],
    ['GPT Free 普号', 'free'],
  ];
  for (const [name, expected] of cases) {
    const result = predictGptTier(name);
    assert.equal(result.tier, expected);
    assert.ok(result.confidence >= 0.5 && result.confidence <= 1);
  }
});
