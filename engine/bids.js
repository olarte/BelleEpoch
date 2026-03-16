// engine/bids.js — Redis-backed bid store (ioredis)

const Redis = require('ioredis');

const EPOCH_DURATION = 5000; // must match engine config

const redis = new Redis(process.env.REDIS_URL || 'redis://127.0.0.1:6379', {
  maxRetriesPerRequest: 3,
  lazyConnect: true,
});

redis.on('error', (err) => {
  console.error('[Redis] connection error:', err.message);
});

// Connect eagerly so callers don't have to await
redis.connect().catch(() => {});

function bidKey(epochId) {
  return `epoch:${epochId}:bids`;
}

function agentKey(agentId) {
  return `agent:${agentId}:history`;
}

async function addBid(bid) {
  const key = bidKey(bid.epochId);
  const payload = JSON.stringify({
    agentId: bid.agentId,
    maxBid: bid.maxBid,
    timestamp: bid.timestamp || Date.now(),
    epochId: bid.epochId,
    signature: bid.signature || null,
    signer: bid.signer || null,
    identityAddress: bid.identityAddress || null,
  });
  await redis.lpush(key, payload);
  // Auto-expire stale bids after 2x epoch duration
  await redis.expire(key, Math.ceil((EPOCH_DURATION * 2) / 1000));
}

async function getBids(epochId) {
  const key = bidKey(epochId);
  const raw = await redis.lrange(key, 0, -1);
  return raw.map((s) => JSON.parse(s));
}

async function clearEpoch(epochId) {
  await redis.del(bidKey(epochId));
}

// Agent clearing history — append epoch result for an agent
async function recordAgentEpoch(agentId, epochResult) {
  const key = agentKey(agentId);
  await redis.lpush(key, JSON.stringify(epochResult));
  // Keep last 1000 epochs per agent
  await redis.ltrim(key, 0, 999);
}

async function getAgentHistory(agentId) {
  const key = agentKey(agentId);
  const raw = await redis.lrange(key, 0, -1);
  return raw.map((s) => JSON.parse(s));
}

// ─── Epoch result storage (for payment retrieval) ────────────────────────────

function epochResultKey(epochId) {
  return `epoch:${epochId}:result`;
}

async function storeEpochResult(epochId, result) {
  const key = epochResultKey(epochId);
  await redis.set(key, JSON.stringify(result));
  // Keep epoch results for 5 minutes (long enough for payment settlement)
  await redis.expire(key, 300);
}

async function getEpochResult(epochId) {
  const key = epochResultKey(epochId);
  const raw = await redis.get(key);
  return raw ? JSON.parse(raw) : null;
}

// ─── Payment state tracking ─────────────────────────────────────────────────

function paymentKey(epochId, agentId) {
  return `epoch:${epochId}:payment:${agentId}`;
}

async function markPaid(epochId, agentId, txHash) {
  const key = paymentKey(epochId, agentId);
  await redis.set(key, JSON.stringify({ paid: true, txHash, paidAt: Date.now() }));
  await redis.expire(key, 300);
}

async function getPaymentState(epochId, agentId) {
  const key = paymentKey(epochId, agentId);
  const raw = await redis.get(key);
  return raw ? JSON.parse(raw) : null;
}

// ─── Epoch history storage (last 100 clearing results) ─────────────────────

async function storeEpochHistory(epochId, result) {
  const entry = {
    epochId,
    clearingPrice: result.clearingPrice,
    slotsFilled: result.slotsFilled,
    totalBids: result.totalBids,
    timestamp: new Date().toISOString(),
    winners: result.winners.map(w => w.agentId),
  };
  await redis.lpush('epoch:history', JSON.stringify(entry));
  await redis.ltrim('epoch:history', 0, 99);
}

async function getEpochHistory(n) {
  const count = Math.min(Math.max(n || 12, 1), 100);
  const raw = await redis.lrange('epoch:history', 0, count - 1);
  return raw.map(s => JSON.parse(s));
}

async function getActiveBids(epochId) {
  const bids = await getBids(epochId);
  return bids.map(b => ({
    agentId: b.agentId,
    bidRange: b.maxBid > 0.005 ? 'high' : b.maxBid > 0.002 ? 'mid' : 'low',
    timestamp: b.timestamp,
    epochId: b.epochId,
  }));
}

module.exports = {
  addBid, getBids, clearEpoch, recordAgentEpoch, getAgentHistory,
  storeEpochResult, getEpochResult, markPaid, getPaymentState,
  storeEpochHistory, getEpochHistory, getActiveBids,
  redis,
};
