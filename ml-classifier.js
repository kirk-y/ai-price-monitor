'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const DEFAULT_MODEL_PATH = path.join(__dirname, 'models', 'gpt-tier-svm.json.gz');
let cachedModel = null;

function loadModel(modelPath = DEFAULT_MODEL_PATH) {
  if (cachedModel && modelPath === DEFAULT_MODEL_PATH) return cachedModel;
  const parsed = JSON.parse(zlib.gunzipSync(fs.readFileSync(modelPath)).toString('utf8'));
  if (parsed.format !== 'char-tfidf-linear-svm-v1' || !Array.isArray(parsed.features)) {
    throw new Error('GPT 分类模型格式错误');
  }
  parsed.featureIndex = new Map(parsed.features.map((feature, index) => [feature, index]));
  if (modelPath === DEFAULT_MODEL_PATH) cachedModel = parsed;
  return parsed;
}

function sklearnCharText(value) {
  return String(value || '').toLowerCase().replace(/\s\s+/gu, ' ');
}

function vectorize(value, model) {
  const chars = Array.from(sklearnCharText(value));
  const counts = new Map();
  const [minimum, maximum] = model.ngramRange;
  for (let size = minimum; size <= maximum; size++) {
    for (let start = 0; start <= chars.length - size; start++) {
      const index = model.featureIndex.get(chars.slice(start, start + size).join(''));
      if (index !== undefined) counts.set(index, (counts.get(index) || 0) + 1);
    }
  }

  const values = new Map();
  let squaredNorm = 0;
  for (const [index, count] of counts) {
    const value = (1 + Math.log(count)) * model.idf[index];
    values.set(index, value);
    squaredNorm += value * value;
  }
  const norm = Math.sqrt(squaredNorm) || 1;
  for (const [index, value] of values) values.set(index, value / norm);
  return values;
}

function predictGptTier(name, options = {}) {
  const model = loadModel(options.modelPath || DEFAULT_MODEL_PATH);
  const vector = vectorize(name, model);
  const scores = model.classes.map((label, classIndex) => {
    let score = model.intercept[classIndex];
    const coefficients = model.coef[classIndex];
    for (const [featureIndex, value] of vector) score += coefficients[featureIndex] * value;
    return { label, score };
  }).sort((a, b) => b.score - a.score);
  const margin = scores[0].score - (scores[1]?.score || 0);
  return {
    tier: scores[0].label,
    confidence: 1 / (1 + Math.exp(-margin)),
    margin,
    alternatives: scores.slice(1, 4),
  };
}

module.exports = { loadModel, predictGptTier, sklearnCharText, vectorize };
