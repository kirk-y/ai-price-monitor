function percentile(values, ratio) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return Infinity;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * ratio)));
  return sorted[index];
}

function clamp(value) {
  return Math.max(0, Math.min(1, value));
}

function buildPlusPriorityScores(snapshots, historyRows, topCount = 10) {
  const historyByKey = new Map();
  for (const row of historyRows || []) {
    if (!historyByKey.has(row.product_key)) historyByKey.set(row.product_key, []);
    historyByKey.get(row.product_key).push(row);
  }

  const rows = snapshots.map((snapshot, index) => {
    const current = (snapshot.current || []).filter(item => Number(item.price) > 0);
    const currentInStock = current.filter(item => Number(item.stock) > 0);
    const history = (snapshot.keys || []).flatMap(key => historyByKey.get(key) || [])
      .filter(item => Number(item.price) > 0);
    const validHistory = history.filter(item => Number(item.stock) > 0);
    const prices = validHistory.map(item => Number(item.price));
    const currentPrices = currentInStock.map(item => Number(item.price));
    const currentMin = currentPrices.length ? Math.min(...currentPrices) : Infinity;
    const historyP25 = percentile(prices, 0.25);
    const representative = Math.min(currentMin, historyP25);
    const observations = validHistory.length + currentPrices.length;
    return {
      id: snapshot.id,
      index,
      currentMin,
      representative,
      currentPrices,
      validHistory,
      history,
      observations,
    };
  });

  const marketPrices = rows.map(row => row.representative).filter(Number.isFinite);
  const cutoff = percentile(marketPrices, 0.35);
  for (const row of rows) {
    const allValidPrices = [...row.validHistory.map(item => Number(item.price)), ...row.currentPrices];
    const lowCount = allValidPrices.filter(price => price <= cutoff).length;
    const historyConfidence = Math.min(1, row.validHistory.length / 6);
    const currentSignal = row.currentMin <= cutoff ? 0.6 : row.currentMin < Infinity ? 0.1 : 0;
    const frequency = historyConfidence * (lowCount / Math.max(1, allValidPrices.length))
      + (1 - historyConfidence) * currentSignal;
    const availability = row.history.length ? row.validHistory.length / row.history.length : row.currentPrices.length ? 1 : 0;
    const priceScore = Number.isFinite(row.representative) && Number.isFinite(cutoff) && cutoff > 0
      ? clamp(1 - row.representative / (cutoff * 1.25))
      : 0;
    row.score = Number((frequency * 0.55 + priceScore * 0.3 + availability * 0.15).toFixed(4));
  }

  const ranked = [...rows].sort((a, b) => b.score - a.score || a.index - b.index);
  const result = new Map();
  let evidenceRank = 0;
  ranked.forEach((row, rank) => {
    const hasEvidence = row.observations > 0;
    if (hasEvidence) evidenceRank++;
    result.set(row.id, {
      score: row.score,
      rank: rank + 1,
      tier: !hasEvidence ? 'C' : evidenceRank <= topCount ? 'A' : evidenceRank <= topCount * 2 ? 'B' : 'C',
      currentMin: Number.isFinite(row.currentMin) ? row.currentMin : null,
      observations: row.observations,
    });
  });
  return result;
}

function pickDueCatalogStore(stores, intervalHours, now = Date.now()) {
  const candidates = (stores || []).map((store, index) => {
    const attemptedAt = Date.parse(store.refreshMeta?.lastCatalogAttemptAt || store.refreshMeta?.lastCatalogRefreshAt || 0) || 0;
    return { store, index, attemptedAt };
  });
  if (!candidates.length) return null;
  const intervalMs = Math.max(1, Number(intervalHours) || 24) * 60 * 60 * 1000;
  const latestAttempt = Math.max(...candidates.map(item => item.attemptedAt));
  if (latestAttempt && now - latestAttempt < intervalMs / candidates.length) return null;
  const due = candidates.filter(item => !item.attemptedAt || now - item.attemptedAt >= intervalMs);
  due.sort((a, b) => a.attemptedAt - b.attemptedAt || a.index - b.index);
  return due[0]?.store || null;
}

function focusRefreshIntervalMinutes(item, priority, cycleMinutes) {
  const base = Math.max(5, Number(cycleMinutes) || 60);
  if (item.status === 'error') return Math.max(120, base * 2);
  const tier = priority?.tier;
  if (tier === 'A') return base;
  if (tier === 'B') return Math.max(120, base * 2);
  return Math.max(180, base * 3);
}

function automaticFocusRefreshType(item) {
  const knownTypes = item.refreshMeta?.focusGoodsTypes || item.refreshMeta?.plusGoodsTypes || [];
  return knownTypes.length ? 'plus' : 'probe';
}

function estimatedRefreshRequests(item, refreshType) {
  if (refreshType === 'full') return 6 + Math.ceil((item.products?.length || 0) / 100);
  const types = refreshType === 'probe'
    ? 4
    : Math.max(1, (item.refreshMeta?.focusGoodsTypes || item.refreshMeta?.plusGoodsTypes || []).length);
  return 1 + types * 2;
}

module.exports = {
  automaticFocusRefreshType,
  buildPlusPriorityScores,
  estimatedRefreshRequests,
  focusRefreshIntervalMinutes,
  pickDueCatalogStore,
  percentile,
};
