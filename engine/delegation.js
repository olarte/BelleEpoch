// engine/delegation.js — ERC-7715 MetaMask delegation management
//
// Manages the delegation from operator wallet (Daniel) to Belle's engine wallet.
// Enforces spending constraints: maxBidPerEpoch, dailySpendCap, allowedResources.

const { ethers } = require('ethers');
const { redis } = require('./bids');

// Delegation constraints (set by operator via ERC-7715)
const DELEGATION = {
  // Will be populated from env or on-chain
  hash: process.env.DELEGATION_HASH || null,
  delegator: process.env.OPERATOR_WALLET || '',        // Daniel's wallet
  delegate: process.env.ENGINE_WALLET || '',            // Belle's engine wallet
  chainId: 8453,                                        // Base Mainnet
  caveats: {
    maxBidPerEpoch: 15000,                               // 0.015 USDC (6-decimal units)
    allowedResources: ['private-reasoning'],
    dailySpendCap: 2000000,                              // 2 USDC (6-decimal units)
  },
};

let initialized = false;

function init() {
  if (!DELEGATION.hash) {
    console.log('[ERC-7715] No DELEGATION_HASH set — delegation enforcement disabled');
    return false;
  }
  initialized = true;
  console.log(`[ERC-7715] Delegation active: ${DELEGATION.hash}`);
  console.log(`[ERC-7715]   delegator: ${DELEGATION.delegator}`);
  console.log(`[ERC-7715]   delegate:  ${DELEGATION.delegate}`);
  console.log(`[ERC-7715]   maxBidPerEpoch: ${DELEGATION.caveats.maxBidPerEpoch} (${DELEGATION.caveats.maxBidPerEpoch / 1e6} USDC)`);
  console.log(`[ERC-7715]   dailySpendCap:  ${DELEGATION.caveats.dailySpendCap} (${DELEGATION.caveats.dailySpendCap / 1e6} USDC)`);
  return true;
}

// ─── Daily spend tracking ────────────────────────────────────────────────────

function dailySpendKey() {
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  return `delegation:daily:${today}`;
}

async function getDailySpend() {
  const raw = await redis.get(dailySpendKey());
  return parseInt(raw || '0', 10);
}

async function addDailySpend(amountMicroUsdc) {
  const key = dailySpendKey();
  const newTotal = await redis.incrby(key, amountMicroUsdc);
  // Expire at end of day (worst case 24h)
  await redis.expire(key, 86400);
  return newTotal;
}

// ─── Delegation verification ─────────────────────────────────────────────────

/**
 * Verify that a bid from Belle (the delegate) is within delegation constraints.
 * Returns { valid: true } or { valid: false, error: string }
 *
 * @param {string} agentId - The bidding agent's ID
 * @param {number} maxBid - The bid amount in USDC (float, e.g. 0.015)
 * @param {string} resource - The resource being bid on
 */
async function verifyDelegation(agentId, maxBid, resource) {
  // Only enforce delegation for Belle's own bids
  if (agentId !== 'belle') {
    return { valid: true, skipped: true };
  }

  // If delegation is not configured, skip enforcement
  if (!initialized) {
    return { valid: true, skipped: true };
  }

  // Convert maxBid from USDC float to micro-USDC (6 decimals)
  const maxBidMicro = Math.round(maxBid * 1e6);

  // Check 1: maxBidPerEpoch
  if (maxBidMicro > DELEGATION.caveats.maxBidPerEpoch) {
    return {
      valid: false,
      error: `Bid ${maxBidMicro} exceeds delegation maxBidPerEpoch (${DELEGATION.caveats.maxBidPerEpoch}). ` +
             `Max allowed: ${DELEGATION.caveats.maxBidPerEpoch / 1e6} USDC`,
    };
  }

  // Check 2: allowedResources
  if (!DELEGATION.caveats.allowedResources.includes(resource)) {
    return {
      valid: false,
      error: `Resource "${resource}" not in delegation allowedResources: [${DELEGATION.caveats.allowedResources.join(', ')}]`,
    };
  }

  // Check 3: dailySpendCap
  const currentSpend = await getDailySpend();
  if (currentSpend + maxBidMicro > DELEGATION.caveats.dailySpendCap) {
    return {
      valid: false,
      error: `Daily spend would exceed cap. Current: ${currentSpend / 1e6} USDC, ` +
             `bid: ${maxBid} USDC, cap: ${DELEGATION.caveats.dailySpendCap / 1e6} USDC`,
    };
  }

  return { valid: true };
}

/**
 * Record a spend against the daily cap (called after successful settlement).
 */
async function recordSpend(amountUsdc) {
  const amountMicro = Math.round(amountUsdc * 1e6);
  return addDailySpend(amountMicro);
}

/**
 * Get current delegation status for monitoring.
 */
async function getStatus() {
  const dailySpend = await getDailySpend();
  return {
    delegationHash: DELEGATION.hash,
    delegator: DELEGATION.delegator,
    delegate: DELEGATION.delegate,
    chainId: DELEGATION.chainId,
    caveats: DELEGATION.caveats,
    dailySpendUsdc: dailySpend / 1e6,
    dailyCapUsdc: DELEGATION.caveats.dailySpendCap / 1e6,
    dailyRemaining: (DELEGATION.caveats.dailySpendCap - dailySpend) / 1e6,
    initialized,
  };
}

/**
 * Create the delegation hash from delegation parameters.
 * In production this would be signed on-chain via MetaMask ERC-7715.
 * Here we compute the deterministic hash that represents the delegation.
 */
function computeDelegationHash() {
  const encoded = ethers.AbiCoder.defaultAbiCoder().encode(
    ['address', 'address', 'uint256', 'uint256', 'uint256', 'string[]'],
    [
      DELEGATION.delegator,
      DELEGATION.delegate,
      DELEGATION.chainId,
      DELEGATION.caveats.maxBidPerEpoch,
      DELEGATION.caveats.dailySpendCap,
      DELEGATION.caveats.allowedResources,
    ]
  );
  return ethers.keccak256(encoded);
}

module.exports = {
  init,
  verifyDelegation,
  recordSpend,
  getStatus,
  computeDelegationHash,
  DELEGATION,
};
