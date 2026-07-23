const test = require('node:test');
const assert = require('node:assert/strict');
const { classifyProduct, normalizeHttpUrl } = require('../scraper');

test('local classifier uses configured patterns without Python', () => {
  const result = classifyProduct('ChatGPT Plus 未接码账号', {
    gpt_plus: ['chatgpt.*plus'],
  });
  assert.deepEqual(result, { category: 'gpt_plus', confidence: 0.55 });
  assert.equal(classifyProduct('unmatched', { gpt: ['chatgpt'] }), null);
});

test('external links are limited to normalized HTTP URLs', () => {
  assert.equal(normalizeHttpUrl('javascript:alert(1)'), '');
  assert.equal(normalizeHttpUrl('not a url'), '');
  assert.equal(normalizeHttpUrl('https://example.com/a b'), 'https://example.com/a%20b');
});
