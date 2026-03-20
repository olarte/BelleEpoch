// engine/sims.js — simulated agents that auto-bid each epoch
// Belle is the PROVIDER — she does not bid on her own service.

const { addBid, getEpochResult, markPaid, redis } = require('./bids');
const { verifyPayment, signAccessToken, splitFee } = require('./x402');

// Each agent has an intrinsic valuation (what the service is worth to them)
// plus aggression that scales their willingness to bid above/below intrinsic
const AGENTS = [
  { id: 'ATLAS-7', intrinsic: 0.0080, aggression: 1.2 },
  { id: 'NEXUS-3', intrinsic: 0.0060, aggression: 0.9 },
  { id: 'FORGE-1', intrinsic: 0.0045, aggression: 0.7 },
  { id: 'SIGMA-9', intrinsic: 0.0030, aggression: 0.6 },
  { id: 'ECHO-4',  intrinsic: 0.0015, aggression: 0.4 },
];

async function generateBids(epochId, feed) {
  const feedPrice = feed && feed.clearingPrice > 0
    ? feed.clearingPrice
    : null;

  for (const agent of AGENTS) {
    // Blend intrinsic valuation with market signal (70% intrinsic, 30% feed)
    const base = feedPrice !== null
      ? agent.intrinsic * 0.7 + feedPrice * 0.3
      : agent.intrinsic;

    // +-20% to +-40% random variation
    const direction = Math.random() > 0.5 ? 1 : -1;
    const variation = 0.2 + Math.random() * 0.2;
    const drift = 1 + direction * variation;
    const maxBid = parseFloat((base * agent.aggression * drift).toFixed(4));

    await addBid({
      agentId: agent.id,
      maxBid: Math.max(0.0001, maxBid),
      epochId,
      timestamp: Date.now(),
      signature: `sim-${agent.id}-${epochId}`,
    });
  }
}

// Simulate the full x402 payment flow for winners of a completed epoch.
// Winners: receive 402 → "pay" (sim proof) → receive access token.
// Losers: receive 404 — no payment request generated.
async function settleEpoch(epochId) {
  const result = await getEpochResult(epochId);
  if (!result || result.winners.length === 0) return [];

  const settlements = [];

  for (const winner of result.winners) {
    // Skip sim settlement for external agents (non-sim bidders settle themselves)
    const isSimAgent = AGENTS.some(a => a.id === winner.agentId);
    if (!isSimAgent) continue;

    // Simulate: agent constructs payment proof after receiving 402
    const simProof = `sim-payment-${winner.agentId}-${epochId}`;

    // Verify (sim proofs are accepted by verifyPayment)
    const verification = await verifyPayment(simProof, epochId, result.clearingPrice);

    if (verification.valid) {
      await markPaid(epochId, winner.agentId, verification.txHash);

      // Protocol fee split
      const { protocolFee, providerShare } = splitFee(result.clearingPrice);

      // Accumulate protocol fees in Redis
      await redis.incrbyfloat('protocol:fees:total', protocolFee);

      console.log(
        `[Fee] epoch ${epochId} | ${winner.agentId} | ` +
        `clearing: ${result.clearingPrice.toFixed(4)} | ` +
        `fee: ${protocolFee.toFixed(6)} | ` +
        `provider: ${providerShare.toFixed(6)}`
      );

      const slot = result.winners.indexOf(winner);
      const epochEndTimestamp = Date.now() + 5000;
      const accessToken = signAccessToken(epochId, winner.agentId, slot, 'private-reasoning', epochEndTimestamp);

      settlements.push({
        agentId: winner.agentId,
        paid: result.clearingPrice,
        protocolFee,
        providerShare,
        txHash: verification.txHash,
        accessToken,
      });
    }
  }

  // Losers get nothing — no payment request, no settlement attempt
  for (const loser of result.losers) {
    settlements.push({
      agentId: loser.agentId,
      paid: 0,
      txHash: null,
      accessToken: null,
    });
  }

  return settlements;
}

module.exports = { generateBids, settleEpoch, AGENTS };
