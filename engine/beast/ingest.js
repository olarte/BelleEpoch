// engine/beast/ingest.js — Beast's core data pipeline
//
// Every time an EpochCleared event fires anywhere on the network,
// ingestEpoch() is called. Beast accumulates price history, running
// statistics, and provider metadata for market intelligence queries.

const { redis } = require('../bids');

// Redis key schema:
//   beast:prices:<providerId>   sorted set, score=timestamp, value=JSON
//   beast:providers              set of all seen provider IDs
//   beast:stats:<providerId>    hash of running statistics
//   beast:epochs:count           total epochs ingested
//   beast:last:update            ISO timestamp of last ingest

async function ingestEpoch(event) {
  const {
    epochId,
    provider,
    providerEns,
    clearingPrice,
    slotsFilled,
    totalBids,
    chain,
    timestamp,
    resourceId,
  } = event;

  if (!provider || clearingPrice == null) return;

  const ts = typeof timestamp === 'number'
    ? timestamp
    : (timestamp ? new Date(timestamp).getTime() : Date.now());

  const dataPoint = JSON.stringify({
    epochId,
    clearingPrice: parseFloat(clearingPrice),
    slotsFilled:   parseInt(slotsFilled) || 0,
    totalBids:     parseInt(totalBids)   || 0,
    chain:         chain || 'base',
    resourceId:    resourceId || 'unknown',
    ts,
  });

  // Store in sorted set: score = timestamp for time-range queries
  await redis.zadd(`beast:prices:${provider}`, ts, dataPoint);

  // Track all seen providers
  await redis.sadd('beast:providers', provider);
  if (providerEns && providerEns !== provider) {
    await redis.sadd('beast:providers', providerEns);
  }

  // Update running stats for this provider
  await updateProviderStats(provider, parseFloat(clearingPrice));

  // Global counters
  await redis.incr('beast:epochs:count');
  await redis.set('beast:last:update', new Date().toISOString());
}

async function updateProviderStats(providerId, price) {
  const key = `beast:stats:${providerId}`;
  const raw = await redis.get(key);
  const stats = raw ? JSON.parse(raw) : {
    count: 0, sum: 0, sumSq: 0,
    min: Infinity, max: -Infinity,
    lastPrice: null, prevPrice: null,
  };

  stats.prevPrice  = stats.lastPrice;
  stats.lastPrice  = price;
  stats.count     += 1;
  stats.sum       += price;
  stats.sumSq     += price * price;
  stats.min        = Math.min(stats.min, price);
  stats.max        = Math.max(stats.max, price);

  // Running mean and variance (Welford's online algorithm)
  const mean = stats.sum / stats.count;
  const variance = stats.count > 1
    ? (stats.sumSq - stats.count * mean * mean) / (stats.count - 1)
    : 0;
  stats.mean     = mean;
  stats.stddev   = Math.sqrt(Math.max(0, variance));
  stats.updated  = new Date().toISOString();

  await redis.set(key, JSON.stringify(stats));
}

module.exports = { ingestEpoch };
