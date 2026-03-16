// engine/x402.js — x402 payment integration (AgentCash / Coinbase x402)

const jwt = require('jsonwebtoken');

const PROTOCOL_WALLET = process.env.PROTOCOL_WALLET || '';
const PROTOCOL_FEE_RATE = parseFloat(process.env.PROTOCOL_FEE_RATE || '0.015');
const EPOCH_TOKEN_SECRET = process.env.EPOCH_TOKEN_SECRET || 'belle-epoch-dev-secret';
const FACILITATOR_URL = process.env.X402_FACILITATOR_URL || 'https://x402.org/facilitator';
const NETWORK = process.env.X402_NETWORK || 'eip155:8453'; // Base mainnet

// ─── Payment request generation ──────────────────────────────────────────────
// Generates a standard x402 PaymentRequired object for a winning agent.
// This is what the agent receives and uses to construct their payment.
function createPaymentRequest(epochId, agentId, clearingPrice, resource) {
  return {
    x402Version: 1,
    accepts: [
      {
        scheme: 'exact',
        network: NETWORK,
        maxAmountRequired: String(Math.round(clearingPrice * 1e6)), // USDC 6 decimals
        resource: `epoch:${epochId}:${resource}`,
        description: `Clearing payment for epoch ${epochId} — ${clearingPrice.toFixed(6)} USDC`,
        mimeType: 'application/json',
        payTo: PROTOCOL_WALLET,
        extra: {
          epochId,
          agentId,
          clearingPrice,
          name: 'USDC',
          version: '2',
        },
      },
    ],
  };
}

// ─── Payment verification ────────────────────────────────────────────────────
// Verifies an X-Payment-Proof header via the x402 facilitator.
// Returns { valid: true, txHash } or { valid: false, error }.
async function verifyPayment(paymentProof, epochId, clearingPrice) {
  // For simulated/test payments, accept a known test proof format
  if (paymentProof && paymentProof.startsWith('sim-payment-')) {
    return { valid: true, txHash: `sim-tx-${paymentProof}`, simulated: true };
  }

  try {
    const response = await fetch(`${FACILITATOR_URL}/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        payload: paymentProof,
        paymentRequirements: {
          scheme: 'exact',
          network: NETWORK,
          maxAmountRequired: String(Math.round(clearingPrice * 1e6)),
          payTo: PROTOCOL_WALLET,
        },
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      return { valid: false, error: `Facilitator returned ${response.status}: ${text}` };
    }

    const result = await response.json();
    return { valid: !!result.valid, txHash: result.transaction || null };
  } catch (err) {
    return { valid: false, error: err.message };
  }
}

// ─── Settle payment via facilitator ──────────────────────────────────────────
// After verification, actually execute the on-chain settlement.
async function settlePayment(paymentProof, epochId, clearingPrice) {
  // Simulated payments settle instantly
  if (paymentProof && paymentProof.startsWith('sim-payment-')) {
    return { settled: true, txHash: `sim-tx-${paymentProof}`, simulated: true };
  }

  try {
    const response = await fetch(`${FACILITATOR_URL}/settle`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        payload: paymentProof,
        paymentRequirements: {
          scheme: 'exact',
          network: NETWORK,
          maxAmountRequired: String(Math.round(clearingPrice * 1e6)),
          payTo: PROTOCOL_WALLET,
        },
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      return { settled: false, error: `Facilitator returned ${response.status}: ${text}` };
    }

    const result = await response.json();
    return { settled: true, txHash: result.transaction || null };
  } catch (err) {
    return { settled: false, error: err.message };
  }
}

// ─── Access token (JWT) ──────────────────────────────────────────────────────
// Signs a JWT granting access to the won slot for the duration of the epoch.
function signAccessToken(epochId, agentId, slot, resource, epochEndTimestamp) {
  const payload = {
    epochId,
    agentId,
    slot,
    resource,
    iat: Math.floor(Date.now() / 1000),
  };

  return jwt.sign(payload, EPOCH_TOKEN_SECRET, {
    expiresIn: Math.max(1, Math.floor((epochEndTimestamp - Date.now()) / 1000)),
    subject: agentId,
    issuer: 'belle-epoch',
  });
}

// ─── Verify access token ────────────────────────────────────────────────────
function verifyAccessToken(token) {
  try {
    return jwt.verify(token, EPOCH_TOKEN_SECRET, { issuer: 'belle-epoch' });
  } catch (err) {
    return null;
  }
}

// ─── Protocol fee split ──────────────────────────────────────────────────────
// Splits the clearing price into protocol fee and provider share.
function splitFee(clearingPrice) {
  const protocolFee = parseFloat((clearingPrice * PROTOCOL_FEE_RATE).toFixed(6));
  const providerShare = parseFloat((clearingPrice - protocolFee).toFixed(6));
  return { protocolFee, providerShare };
}

module.exports = {
  createPaymentRequest,
  verifyPayment,
  settlePayment,
  signAccessToken,
  verifyAccessToken,
  splitFee,
  PROTOCOL_WALLET,
  PROTOCOL_FEE_RATE,
  FACILITATOR_URL,
};
