// engine/providerLoop.js — Per-provider epoch loops
//
// Replaces the global setInterval. Each provider gets its own loop that
// can be started / stopped independently. Belle delegates to the existing
// engine.runEpoch(); other providers run a lighter per-provider clearing.
// On-chain calls fire ONLY when there are real winners — idle epochs cost
// zero gas.

const engine = require('./clearing');
const { redis } = require('./bids');
const { ingestEpoch: beastIngest } = require('./beast/ingest');

const sleep = ms => new Promise(r => setTimeout(r, ms));

const activeLoops = new Map();

const BELLE_ID = process.env.BELLE_WALLET || 'belle.epoch.base.eth';

// ─── Simulated agents for non-Belle providers ───────────────────────────────
// When a human provider goes online, these agents generate bids so the
// clearing loop has something to clear (demo + marketplace activity).

const SIM_AGENTS = [
  { id: 'ATLAS-7', intrinsic: 0.0080, aggression: 1.2 },
  { id: 'NEXUS-3', intrinsic: 0.0060, aggression: 0.9 },
  { id: 'FORGE-1', intrinsic: 0.0045, aggression: 0.7 },
  { id: 'SIGMA-9', intrinsic: 0.0030, aggression: 0.6 },
  { id: 'ECHO-4',  intrinsic: 0.0015, aggression: 0.4 },
];

function generateProviderSimBids(providerId, epochId, capacity) {
  // Pick a random subset of agents (at least capacity+1 so there are losers)
  const count = Math.min(SIM_AGENTS.length, (capacity || 1) + 2);
  const shuffled = [...SIM_AGENTS].sort(() => Math.random() - 0.5);
  const bidders = shuffled.slice(0, count);

  return bidders.map(agent => {
    const direction = Math.random() > 0.5 ? 1 : -1;
    const variation = 0.2 + Math.random() * 0.2;
    const drift = 1 + direction * variation;
    const maxBid = parseFloat((agent.intrinsic * agent.aggression * drift).toFixed(4));
    return {
      agentId: agent.id,
      maxBid: Math.max(0.0001, maxBid),
      epochId,
      timestamp: Date.now(),
      signature: `sim-${agent.id}-provider-${epochId}`,
    };
  });
}

// ─── Start a per-provider epoch loop ────────────────────────────────────────

async function startProviderLoop(provider) {
  if (activeLoops.get(provider.id) === true) {
    console.log(`[loop] ${provider.id} already running`);
    return;
  }

  console.log(`[loop] starting for ${provider.id}`);
  activeLoops.set(provider.id, true);

  const isBelle = provider.id === BELLE_ID;

  if (isBelle) {
    // ── Belle: delegates to existing engine.runEpoch() ──────────────────
    // This preserves sim bids, settlement, revenue routing, on-chain
    // recording, margin logging — everything the current engine does.
    while (activeLoops.get(provider.id) === true) {
      const start = Date.now();
      try {
        await engine.runEpoch();
      } catch (err) {
        console.error(`[loop] ${provider.id} epoch error:`, err.message);
      }
      const elapsed = Date.now() - start;
      await sleep(Math.max(0, (provider.epochMs || engine.EPOCH_DURATION) - elapsed));
    }
  } else {
    // ── Other providers: per-provider clearing ──────────────────────────
    const lastId = await redis.get(`provider:${provider.id}:lastEpochId`);
    let epochId = lastId ? parseInt(lastId) + 1 : 1;

    while (activeLoops.get(provider.id) === true) {
      const start = Date.now();

      try {
        // Provider-scoped bids (separate from Belle's global bid pool)
        const bidKey = `provider:${provider.id}:epoch:${epochId}:bids`;

        // Generate sim bids for this provider if in dev mode
        if (process.env.NODE_ENV !== 'production') {
          const simBids = generateProviderSimBids(provider.id, epochId, provider.capacitySlots);
          for (const bid of simBids) {
            await redis.lpush(bidKey, JSON.stringify(bid));
          }
          await redis.expire(bidKey, 120);
        }

        const raw = await redis.lrange(bidKey, 0, -1);
        const bids = raw.map(s => JSON.parse(s));

        if (bids.length === 0) {
          // No bids — close silently. Zero gas. Zero chain call.
          console.log(`[loop] ${provider.id} epoch ${epochId} — no bids, idle`);
        } else {
          const sorted = [...bids].sort((a, b) => b.maxBid - a.maxBid);
          const capacity = provider.capacitySlots || 1;
          const winners = sorted.slice(0, capacity);
          const losers = sorted.slice(capacity);
          const clearingPrice = winners[winners.length - 1].maxBid;

          console.log(
            `[loop] ${provider.id} epoch ${epochId} — ` +
            `${bids.length} bids, price ${clearingPrice.toFixed(4)}, ` +
            `${winners.length} winners`
          );

          // On-chain call ONLY when there are real winners
          if (winners.length > 0 && engine.onChainRecorder) {
            const result = {
              epochId,
              clearingPrice,
              slotsFilled: winners.length,
              totalBids: bids.length,
              winners: winners.map(w => ({
                agentId: w.agentId,
                pays: clearingPrice,
                signer: w.signer || null,
                identityAddress: w.identityAddress || null,
              })),
              losers: losers.map(l => ({ agentId: l.agentId, pays: 0 })),
            };

            engine.onChainRecorder(result).catch(err =>
              console.error(`[loop] ${provider.id} on-chain error:`, err.message)
            );

            // Update aggregate stats
            await redis.incrbyfloat(
              `provider:${provider.id}:totalVolume`,
              clearingPrice * winners.length
            );
            await redis.incrby(
              `provider:${provider.id}:totalWinners`,
              winners.length
            );
          }

          // Update provider's current clearing price (for marketplace display)
          const providerRaw = await redis.get(`humans:provider:${provider.id}`) || await redis.get(`provider:${provider.id}`);
          if (providerRaw) {
            const providerData = JSON.parse(providerRaw);
            providerData.currentClearingPrice = clearingPrice;
            providerData.epochsServed = (providerData.epochsServed || 0) + 1;
            providerData.lastEpochAt = new Date().toISOString();
            const storeKey = providerData.type === 'human' ? `humans:provider:${provider.id}` : `provider:${provider.id}`;
            await redis.set(storeKey, JSON.stringify(providerData));
          }

          // Store epoch result so payment endpoint can find it
          const resultObj = {
            epochId,
            providerId: provider.id,
            clearingPrice,
            slotsFilled: winners.length,
            totalBids: bids.length,
            winners: winners.map(w => ({
              agentId: w.agentId,
              pays: clearingPrice,
              signer: w.signer || null,
              identityAddress: w.identityAddress || null,
            })),
            losers: losers.map(l => ({ agentId: l.agentId, pays: 0 })),
          };
          await redis.set(`provider:${provider.id}:epoch:${epochId}:result`, JSON.stringify(resultObj));
          await redis.expire(`provider:${provider.id}:epoch:${epochId}:result`, 300);

          // Publish to feed events
          const feedEvent = {
            epochId,
            provider: provider.id,
            providerEns: provider.ens || provider.id,
            clearingPrice,
            slotsFilled: winners.length,
            totalBids: bids.length,
            chain: provider.chain || 'base',
            timestamp: Date.now(),
            resourceId: provider.resource || 'unknown',
          };
          await redis.lpush('feed:events', JSON.stringify(feedEvent));
          await redis.ltrim('feed:events', 0, 9999);

          // Feed Beast's market intelligence pipeline
          beastIngest(feedEvent).catch(err =>
            console.error('[beast] ingest error:', err.message)
          );

          // Clean up bid key
          await redis.del(bidKey);
        }

        await redis.incr(`provider:${provider.id}:epochsRun`);
        await redis.set(`provider:${provider.id}:lastEpochId`, epochId);
      } catch (err) {
        console.error(`[loop] ${provider.id} epoch ${epochId} error:`, err.message);
        // Keep loop alive through errors
      }

      epochId++;
      const elapsed = Date.now() - start;
      await sleep(Math.max(0, (provider.epochMs || 30000) - elapsed));
    }
  }

  activeLoops.delete(provider.id);
  console.log(`[loop] ${provider.id} stopped`);
}

// ─── Stop a provider loop ───────────────────────────────────────────────────

function stopProviderLoop(providerId) {
  activeLoops.set(providerId, false);
  console.log(`[loop] ${providerId} marked for stop`);
}

// ─── Check if a loop is active ──────────────────────────────────────────────

function isLoopActive(providerId) {
  return activeLoops.get(providerId) === true;
}

// ─── Get a provider's current epoch ID ──────────────────────────────────────

async function getProviderEpochId(providerId) {
  const lastId = await redis.get(`provider:${providerId}:lastEpochId`);
  return lastId ? parseInt(lastId) + 1 : 1; // next epoch
}

module.exports = { startProviderLoop, stopProviderLoop, isLoopActive, getProviderEpochId };
