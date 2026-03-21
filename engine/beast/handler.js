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
    const totalQueries = await redis.get('beast:queries:count');

    // On-chain proof context
    const beastRaw = await redis.get('provider:beast.epoch.base.eth');
    const beast = beastRaw ? JSON.parse(beastRaw) : {};
    const epochsIngested = await redis.get('beast:epochs:count');

    return res.status(200).json({
      type,
      result,
      provider: 'beast.epoch.base.eth',
      timestamp: new Date().toISOString(),
      onChainProof: {
        provider: 'beast.epoch.base.eth',
        dataSource: 'https://basescan.org/address/0x254fdF5a9031d63A599ddef7b4d986d7C03B4760',
        event: 'EpochCleared',
        chain: 'base',
        epochsIngested: parseInt(epochsIngested) || 0,
        queriesServed: parseInt(totalQueries) || 0,
        model: result.model || 'gemini-3-flash',
        retained: false,
        proofHash: result.proofHash || null,
        registeredAt: beast.registeredAt || null,
      },
    });
  } catch (err) {
    console.error('[beast] query error:', err.message);
    return res.status(500).json({ error: 'Query failed', reason: err.message });
  }
}

module.exports = { beastHandler, QUERY_TYPES };
