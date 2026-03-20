// engine/beast/queries.js — Beast's five query types
//
// Four are pure computation on Redis time-series data.
// The fifth (market summary) uses Venice via Bankr.

const { redis } = require('../bids');
const bankr = require('../bankr');

// ── QUERY 1: PRICE HISTORY ─────────────────────────────
// "What has the clearing price for <provider> been over
//  the last <n> epochs / <minutes> minutes?"

async function queryPriceHistory({ providerId, n, windowMinutes }) {
  const key = `beast:prices:${providerId}`;
  const exists = await redis.exists(key);
  if (!exists) return { error: `No data for provider: ${providerId}` };

  let raw;
  if (windowMinutes) {
    const since = Date.now() - windowMinutes * 60 * 1000;
    raw = await redis.zrangebyscore(key, since, '+inf');
  } else {
    const count = Math.min(parseInt(n) || 20, 500);
    raw = await redis.zrevrange(key, 0, count - 1);
    raw.reverse();
  }

  const points = raw.map(r => JSON.parse(r));
  if (points.length === 0) return { error: 'No data in requested range' };

  const prices = points.map(p => p.clearingPrice);
  const mean   = prices.reduce((a, b) => a + b, 0) / prices.length;
  const sorted = [...prices].sort((a, b) => a - b);

  return {
    providerId,
    dataPoints: points.length,
    series: points.map(p => ({ ts: p.ts, price: p.clearingPrice, epochId: p.epochId })),
    stats: {
      mean:   parseFloat(mean.toFixed(6)),
      median: sorted[Math.floor(sorted.length / 2)],
      min:    sorted[0],
      max:    sorted[sorted.length - 1],
      first:  prices[0],
      last:   prices[prices.length - 1],
      trend:  prices[prices.length - 1] > prices[0] ? 'rising'
            : prices[prices.length - 1] < prices[0] ? 'falling'
            : 'flat',
    },
  };
}

// ── QUERY 2: PROVIDER COMPARISON ──────────────────────
// "Compare clearing prices across all providers (or a subset)
//  over the last <n> epochs."

async function queryProviderComparison({ providerIds, n }) {
  const ids = providerIds?.length
    ? providerIds
    : await redis.smembers('beast:providers');

  const count   = Math.min(parseInt(n) || 50, 200);
  const results = {};

  for (const id of ids) {
    const raw = await redis.zrevrange(`beast:prices:${id}`, 0, count - 1);
    if (raw.length === 0) continue;
    const prices   = raw.map(r => JSON.parse(r).clearingPrice);
    const mean     = prices.reduce((a, b) => a + b, 0) / prices.length;
    const statsRaw = await redis.get(`beast:stats:${id}`);
    const stats    = statsRaw ? JSON.parse(statsRaw) : {};

    results[id] = {
      epochsSampled: prices.length,
      mean:          parseFloat(mean.toFixed(6)),
      stddev:        parseFloat((stats.stddev || 0).toFixed(6)),
      min:           stats.min,
      max:           stats.max,
      lastPrice:     prices[0],
      volatility:    stats.stddev && mean > 0
                       ? parseFloat((stats.stddev / mean).toFixed(4))
                       : 0,
    };
  }

  const ranked = Object.entries(results)
    .sort(([, a], [, b]) => b.mean - a.mean)
    .map(([id, data], i) => ({ rank: i + 1, providerId: id, ...data }));

  return { providers: ranked, epochsPerProvider: count };
}

// ── QUERY 3: DEMAND SIGNALS ────────────────────────────
// "Is demand rising or falling on <provider>?
//  How does current price compare to the recent average?"

async function queryDemandSignals({ providerId, windowEpochs }) {
  const n   = Math.min(parseInt(windowEpochs) || 30, 200);
  const key = `beast:prices:${providerId}`;
  const raw = await redis.zrevrange(key, 0, n - 1);
  if (raw.length < 3) return { error: 'Insufficient data for signal analysis' };

  const points = raw.map(r => JSON.parse(r)).reverse();
  const prices = points.map(p => p.clearingPrice);

  const half       = Math.floor(prices.length / 2);
  const early      = prices.slice(0, half);
  const recent     = prices.slice(half);
  const earlyMean  = early.reduce((a, b) => a + b, 0) / early.length;
  const recentMean = recent.reduce((a, b) => a + b, 0) / recent.length;

  // Momentum: slope of last 5 prices via linear regression
  const last5 = prices.slice(-5);
  const xMean = 2;
  const yMean = last5.reduce((a, b) => a + b, 0) / last5.length;
  const num   = last5.reduce((acc, y, i) => acc + (i - xMean) * (y - yMean), 0);
  const den   = last5.reduce((acc, _, i) => acc + (i - xMean) ** 2, 0);
  const slope = den !== 0 ? num / den : 0;

  const signal = recentMean > earlyMean * 1.05 ? 'rising'
               : recentMean < earlyMean * 0.95 ? 'falling'
               : 'stable';

  const statsRaw = await redis.get(`beast:stats:${providerId}`);
  const stats    = statsRaw ? JSON.parse(statsRaw) : {};

  return {
    providerId,
    signal,
    momentum:        slope > 0 ? 'accelerating' : slope < 0 ? 'decelerating' : 'flat',
    slopePerEpoch:   parseFloat(slope.toFixed(8)),
    recentMean:      parseFloat(recentMean.toFixed(6)),
    historicalMean:  parseFloat((stats.mean || earlyMean).toFixed(6)),
    currentVsAverage: parseFloat(((prices[prices.length - 1] / (stats.mean || 1) - 1) * 100).toFixed(2)) + '%',
    epochsAnalyzed:  prices.length,
    recommendation:  slope > 0
      ? 'Demand rising — bid sooner rather than later'
      : slope < 0
      ? 'Demand falling — consider waiting for lower clearing price'
      : 'Demand stable — current price likely to hold',
  };
}

// ── QUERY 4: OPTIMAL BID TIMING ───────────────────────
// "When in the day does <provider> typically clear lowest?"

async function queryOptimalBidTiming({ providerId, timezoneOffset }) {
  const key = `beast:prices:${providerId}`;
  const raw = await redis.zrevrange(key, 0, 1999);
  if (raw.length < 24) return { error: 'Need at least 24 data points for timing analysis' };

  const points   = raw.map(r => JSON.parse(r));
  const tzOffset = parseInt(timezoneOffset) || 0;

  const hourlyBuckets = {};
  for (let h = 0; h < 24; h++) hourlyBuckets[h] = [];

  for (const p of points) {
    const hour         = new Date(p.ts).getUTCHours();
    const adjustedHour = (hour + tzOffset + 24) % 24;
    hourlyBuckets[adjustedHour].push(p.clearingPrice);
  }

  const hourlyStats = Object.entries(hourlyBuckets)
    .filter(([, prices]) => prices.length > 0)
    .map(([hour, prices]) => {
      const mean = prices.reduce((a, b) => a + b, 0) / prices.length;
      return { hour: parseInt(hour), mean: parseFloat(mean.toFixed(6)), samples: prices.length };
    })
    .sort((a, b) => a.mean - b.mean);

  const cheapestHours = hourlyStats.slice(0, 3);
  const mostExpensive = hourlyStats.slice(-3).reverse();

  return {
    providerId,
    cheapestWindows: cheapestHours.map(h => ({
      hourUTC:   (h.hour - tzOffset + 24) % 24,
      hourLocal: h.hour,
      meanPrice: h.mean,
      samples:   h.samples,
    })),
    mostExpensiveWindows: mostExpensive.map(h => ({
      hourUTC:   (h.hour - tzOffset + 24) % 24,
      hourLocal: h.hour,
      meanPrice: h.mean,
      samples:   h.samples,
    })),
    bestTimeToday: `Hour ${cheapestHours[0].hour} local (${cheapestHours[0].samples} observations, avg ${cheapestHours[0].mean} USDC)`,
    dataPoints: points.length,
  };
}

// ── QUERY 5: MARKET SUMMARY ────────────────────────────
// Narrative summary via Venice/Bankr — only query needing LLM.

async function queryMarketSummary() {
  const providers = await redis.smembers('beast:providers');
  if (providers.length === 0) return { error: 'No provider data yet' };

  const snapshot = [];
  for (const id of providers.slice(0, 10)) {
    const statsRaw = await redis.get(`beast:stats:${id}`);
    if (!statsRaw) continue;
    const stats  = JSON.parse(statsRaw);
    const recent = await redis.zrevrange(`beast:prices:${id}`, 0, 4);
    const lastFive = recent.map(r => JSON.parse(r).clearingPrice);
    snapshot.push({
      provider:  id,
      meanPrice: stats.mean?.toFixed(5),
      stddev:    stats.stddev?.toFixed(5),
      lastFive,
      trend: lastFive.length >= 2
        ? lastFive[0] > lastFive[lastFive.length - 1] ? 'rising' : 'falling'
        : 'insufficient data',
    });
  }

  const prompt = `You are Beast, a market intelligence agent on Belle Epoch.
You have the following clearing price data from the last few epochs across providers.
Write a concise 3-5 sentence market summary for an autonomous agent deciding where
to allocate compute budget. Be specific about prices and trends. Do not recommend
bid amounts — that is Belle's domain. Focus on timing, volatility, and provider
selection.

Market data:
${JSON.stringify(snapshot, null, 2)}

Respond with a plain text summary only. No markdown. No headers.`;

  const response = await bankr.chatCompletion(
    process.env.VENICE_MODEL || 'llama-3.3-70b',
    [{ role: 'user', content: prompt }],
    { temperature: 0.4, max_tokens: 512 }
  );

  const summary   = response?.choices?.[0]?.message?.content || 'Summary unavailable';
  const proofHash = response?.veniceProof || null;

  return {
    summary,
    proofHash,
    retained: false,
    providersAnalyzed: snapshot.length,
    generatedAt: new Date().toISOString(),
  };
}

module.exports = {
  queryPriceHistory,
  queryProviderComparison,
  queryDemandSignals,
  queryOptimalBidTiming,
  queryMarketSummary,
};
