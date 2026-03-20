// engine/beast/index.js — Beast: market intelligence agent
//
// Beast ingests clearing data from every epoch across every provider
// on Belle Epoch and sells queries against that dataset via its own CCA.
// Query types: price history, provider comparison, demand signals,
// optimal bid timing, market summary.

const { redis } = require('../bids');
const { startProviderLoop } = require('../providerLoop');
const { ingestEpoch } = require('./ingest');
const { registerBeast, BEAST_ID } = require('./identity');

async function startBeast() {
  console.log('[beast] starting...');

  // Register Beast as a provider on Belle Epoch
  await registerBeast();

  // Backfill from existing epoch events in Redis
  await backfillHistory();

  // Start Beast's own CCA provider loop
  const beast = await getBeastProvider();
  if (beast) {
    startProviderLoop(beast).catch(err =>
      console.error('[beast] provider loop error:', err.message)
    );
  } else {
    console.error('[beast] could not load provider record — loop not started');
  }

  console.log('[beast] live');
}

async function getBeastProvider() {
  const raw = await redis.get(`provider:${BEAST_ID}`);
  return raw ? JSON.parse(raw) : null;
}

async function backfillHistory() {
  console.log('[beast] backfilling price history from Redis...');
  const events = await redis.lrange('feed:events', 0, -1);
  let count = 0;
  for (const raw of events) {
    try {
      const event = JSON.parse(raw);
      await ingestEpoch(event);
      count++;
    } catch (e) { /* skip malformed */ }
  }
  console.log(`[beast] backfilled ${count} epochs`);
}

module.exports = { startBeast };
