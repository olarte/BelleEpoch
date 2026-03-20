// engine/beast/handler.js — Express handler routing queries to Beast functions

const {
  queryPriceHistory,
  queryProviderComparison,
  queryDemandSignals,
  queryOptimalBidTiming,
  queryMarketSummary,
} = require('./queries');

const QUERY_TYPES = {
  'price-history':       queryPriceHistory,
  'provider-comparison': queryProviderComparison,
  'demand-signals':      queryDemandSignals,
  'optimal-bid-timing':  queryOptimalBidTiming,
  'market-summary':      queryMarketSummary,
};

async function beastHandler(req, res) {
  const { type, ...params } = req.body;

  if (!type) {
    return res.status(400).json({
      error: 'Missing query type',
      availableTypes: Object.keys(QUERY_TYPES),
    });
  }

  const fn = QUERY_TYPES[type];
  if (!fn) {
    return res.status(400).json({
      error: `Unknown query type: ${type}`,
      availableTypes: Object.keys(QUERY_TYPES),
    });
  }

  try {
    const result = await fn(params);

    // Track query counts for agent_log.json metrics
    const { redis } = require('../bids');
    await redis.incr('beast:queries:count');
    await redis.incr(`beast:queries:${type}:count`);

    return res.status(200).json({
      type,
      result,
      provider: 'beast.epoch.base.eth',
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    console.error('[beast] query error:', err.message);
    return res.status(500).json({ error: 'Query failed', reason: err.message });
  }
}

module.exports = { beastHandler, QUERY_TYPES };
