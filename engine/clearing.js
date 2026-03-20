// engine/clearing.js — Clearing engine core + epoch timer

const { getBids, clearEpoch, recordAgentEpoch, storeEpochResult, storeEpochHistory, redis } = require('./bids');
const { PROTOCOL_FEE_RATE } = require('./x402');

// Simulated agents — provide market activity for CCA demonstration.
// Enabled by default. Set SIMS_DISABLED=true to disable.
let generateBids, settleEpoch;
if (process.env.SIMS_DISABLED === 'true') {
  generateBids = async () => {};
  settleEpoch = async () => [];
  console.log('[sims] simulated agents disabled (SIMS_DISABLED=true)');
} else {
  const sims = require('./sims');
  generateBids = sims.generateBids;
  settleEpoch = sims.settleEpoch;
  console.log('[sims] simulated agents active');
}
const bankr = require('./bankr');
let uniswap = null;
try { uniswap = require('./uniswap'); } catch (e) { /* optional */ }

const EPOCH_DURATION = parseInt(process.env.EPOCH_DURATION || '5000', 10);
const CAPACITY = parseInt(process.env.CAPACITY || '3', 10);

let currentEpochId = 1;
let currentEpochStartedAt = Date.now();

// Restore epoch counter from Redis so restarts don't collide on-chain
async function initEpochId() {
  const stored = await redis.get('belle:epochId');
  if (stored) {
    currentEpochId = parseInt(stored, 10) + 1;
    console.log(`[Engine] Resuming from epoch ${currentEpochId}`);
  }
}

async function persistEpochId(epochId) {
  await redis.set('belle:epochId', epochId);
}
const feed = {
  epochId: 0,
  clearingPrice: 0,
  slotsFilled: 0,
  totalBids: 0,
  nextEpochMs: EPOCH_DURATION,
  timestamp: null,
};

// On-chain recorder — set externally by api/index.js when contract is available
let onChainRecorder = null;

function setOnChainRecorder(fn) {
  onChainRecorder = fn;
}

async function clear(epochId, capacity) {
  const bids = await getBids(epochId);
  const sorted = [...bids].sort((a, b) => b.maxBid - a.maxBid);
  const totalBids = sorted.length;

  if (totalBids === 0) {
    return {
      epochId,
      clearingPrice: 0,
      slotsFilled: 0,
      totalBids: 0,
      winners: [],
      losers: [],
    };
  }

  const winners = sorted.slice(0, capacity);
  const losers = sorted.slice(capacity);

  // Clearing price = the marginal winner's bid (the Nth highest)
  const clearingPrice = winners[winners.length - 1].maxBid;

  return {
    epochId,
    clearingPrice,
    slotsFilled: winners.length,
    totalBids,
    winners: winners.map(b => ({ agentId: b.agentId, pays: clearingPrice, signer: b.signer || null, identityAddress: b.identityAddress || null })),
    losers: losers.map(b => ({ agentId: b.agentId, pays: 0 })),
  };
}

function getCurrentEpochId() {
  return currentEpochId;
}

function getEpochTimestamp() {
  return currentEpochStartedAt;
}

async function runEpoch() {
  const epochId = currentEpochId++;
  currentEpochStartedAt = Date.now();
  await persistEpochId(epochId);

  // Simulated agents bid based on current feed
  await generateBids(epochId, feed);

  // Clear the epoch
  const result = await clear(epochId, CAPACITY);

  // Update feed
  feed.epochId = result.epochId;
  feed.clearingPrice = result.clearingPrice;
  feed.slotsFilled = result.slotsFilled;
  feed.totalBids = result.totalBids;
  feed.nextEpochMs = EPOCH_DURATION;
  feed.timestamp = new Date().toISOString();

  // Log
  const winnerIds = result.winners.map(w => w.agentId).join(', ');
  const loserIds = result.losers.map(l => l.agentId).join(', ');
  console.log(
    `[Epoch ${String(epochId).padStart(3, '0')}] ` +
    `price: ${result.clearingPrice.toFixed(4)} USDC | ` +
    `${result.slotsFilled}/${result.totalBids} slots | ` +
    `winners: [${winnerIds}] | ` +
    `losers: [${loserIds}]`
  );

  // Record agent history
  const ts = new Date().toISOString();
  for (const w of result.winners) {
    await recordAgentEpoch(w.agentId, {
      epochId, clearingPrice: result.clearingPrice, won: true, paid: w.pays, timestamp: ts,
    });
  }
  for (const l of result.losers) {
    await recordAgentEpoch(l.agentId, {
      epochId, clearingPrice: result.clearingPrice, won: false, paid: 0, timestamp: ts,
    });
  }

  // Store epoch result for payment retrieval
  await storeEpochResult(epochId, result);

  // Store epoch history for feed/history endpoint
  await storeEpochHistory(epochId, result);

  // On-chain recording disabled in background loop to conserve gas.
  // Real on-chain settlement only happens via POST /demo/run.

  // Simulated agents settle their winning bids (sim proofs only — no real USDC)
  settleEpoch(epochId).then(async (settlements) => {
    const paid = settlements.filter(s => s.paid > 0);
    if (paid.length > 0) {
      const ids = paid.map(s => s.agentId).join(', ');
      console.log(`[x402] epoch ${epochId} settled: [${ids}] paid ${result.clearingPrice.toFixed(4)} USDC each (sim)`);
    }

    // ─── Track earnings in Redis (no real on-chain transfers) ────────
    if (result.slotsFilled > 0) {
      const belleWon = result.winners.some(w => w.agentId === 'belle');

      if (belleWon) {
        await redis.incr('belle:wins:total');
        await redis.lpush('belle:wins:log', JSON.stringify({
          epochId,
          clearingPrice: result.clearingPrice,
          timestamp: new Date().toISOString(),
        }));
      }

      // Track protocol fees in Redis (accumulated, not routed on-chain)
      const epochProtocolFee = result.clearingPrice * result.slotsFilled * PROTOCOL_FEE_RATE;
      if (epochProtocolFee > 0) {
        await redis.incrbyfloat('protocol:fees:total', epochProtocolFee);
      }
    }

    // ─── Margin logging ────────────────────────────────────────────────
    const earned = result.clearingPrice * result.slotsFilled;
    const belleEntry = result.winners.find(w => w.agentId === 'belle');
    const belleBidCost = belleEntry ? result.clearingPrice : 0;
    const epochInferenceCost = result.slotsFilled > 0 ? 0.0005 * result.slotsFilled : 0;
    const spent = belleBidCost + epochInferenceCost;
    const netMargin = earned - spent;
    const marginPct = earned > 0 ? ((netMargin / earned) * 100).toFixed(1) : '0.0';

    await redis.incrbyfloat('belle:margin:earned', earned);
    await redis.incrbyfloat('belle:margin:spent', spent);

    if (epochId % 50 === 0) {
      console.log(
        `[Margin] epoch ${epochId} | ` +
        `earned: ${earned.toFixed(6)} | spent: ${spent.toFixed(6)} | ` +
        `net: ${netMargin.toFixed(6)} | margin: ${marginPct}%`
      );
    }
  }).catch(err => console.error(`[x402] epoch ${epochId} settlement error:`, err.message));

  // Free bid keys for this epoch (result keys persist for payment retrieval)
  await clearEpoch(epochId);

  return result;
}

async function getFeed() {
  const accumulatedRaw = await redis.get('protocol:fees:total');
  const earnedRaw = await redis.get('belle:margin:earned');
  const spentRaw = await redis.get('belle:margin:spent');
  const routedRaw = await redis.get('belle:earnings:routed');
  const winsRaw = await redis.get('belle:wins:total');
  return {
    ...feed,
    capacity: CAPACITY,
    epochStartedAt: new Date(currentEpochStartedAt).toISOString(),
    protocolFeeRate: PROTOCOL_FEE_RATE,
    protocolFeeAccumulated: parseFloat(accumulatedRaw || '0'),
    belle: {
      totalEarned: parseFloat(earnedRaw || '0'),
      totalSpent: parseFloat(spentRaw || '0'),
      totalRouted: parseFloat(routedRaw || '0'),
      totalWins: parseInt(winsRaw || '0', 10),
      bankrWallet: bankr.getWallet(),
    },
  };
}

module.exports = { clear, runEpoch, getFeed, getCurrentEpochId, getEpochTimestamp, setOnChainRecorder, get onChainRecorder() { return onChainRecorder; }, initEpochId, CAPACITY, EPOCH_DURATION };
