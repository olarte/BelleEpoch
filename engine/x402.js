// engine/x402.js — x402 payment integration (AgentCash / Coinbase x402)

const jwt = require('jsonwebtoken');

const PROTOCOL_WALLET = process.env.PROTOCOL_WALLET || '';
const PROTOCOL_FEE_RATE = parseFloat(process.env.PROTOCOL_FEE_RATE || '0.015');
const EPOCH_TOKEN_SECRET = process.env.EPOCH_TOKEN_SECRET || 'belle-epoch-dev-secret';
const FACILITATOR_URL = process.env.X402_FACILITATOR_URL || 'https://x402.org/facilitator';
const NETWORK = process.env.X402_NETWORK || 'eip155:8453'; // Base mainnet
const BASE_RPC_URL = process.env.BASE_RPC_URL || 'https://mainnet.base.org';
const USDC_ADDRESS = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

// ─── On-chain USDC transfer verification ─────────────────────────────────────
// Verifies a real tx hash represents a USDC transfer to the protocol wallet.
async function verifyOnChainTransfer(txHash, clearingPrice) {
  try {
    const { ethers } = require('ethers');
    const provider = new ethers.JsonRpcProvider(BASE_RPC_URL);
    const receipt = await provider.getTransactionReceipt(txHash);

    if (!receipt) {
      return { valid: false, error: 'Transaction not found or not yet confirmed' };
    }

    if (receipt.status !== 1) {
      return { valid: false, error: 'Transaction reverted' };
    }

    // Look for USDC Transfer event: Transfer(address,address,uint256)
    const transferTopic = ethers.id('Transfer(address,address,uint256)');
    const expectedAmount = BigInt(Math.round(clearingPrice * 1e6));
    const protocolWalletPadded = ethers.zeroPadValue(PROTOCOL_WALLET.toLowerCase(), 32);

    for (const log of receipt.logs) {
      if (log.address.toLowerCase() !== USDC_ADDRESS.toLowerCase()) continue;
      if (log.topics[0] !== transferTopic) continue;
      if (log.topics[2].toLowerCase() !== protocolWalletPadded.toLowerCase()) continue;

      const transferredAmount = BigInt(log.data);
      if (transferredAmount >= expectedAmount) {
        console.log(`[x402] On-chain USDC transfer verified: ${txHash} — ${transferredAmount} units to ${PROTOCOL_WALLET}`);
        return { valid: true, txHash };
      }
    }

    return { valid: false, error: 'No matching USDC transfer to protocol wallet found in transaction' };
  } catch (err) {
    return { valid: false, error: `On-chain verification failed: ${err.message}` };
  }
}

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
  // For simulated/test payments — only accepted in development
  if (paymentProof && paymentProof.startsWith('sim-payment-')) {
    if (process.env.NODE_ENV === 'production') {
      return { valid: false, error: 'Simulated payments are not accepted in production' };
    }
    console.warn('[x402] WARNING: accepting sim proof in dev mode');
    return { valid: true, txHash: `sim-tx-${paymentProof}`, simulated: true };
  }

  // On-chain tx hash verification (real USDC transfer proof)
  if (paymentProof && paymentProof.startsWith('0x') && paymentProof.length === 66) {
    return await verifyOnChainTransfer(paymentProof, clearingPrice);
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
  // Simulated payments settle instantly — only in development
  if (paymentProof && paymentProof.startsWith('sim-payment-')) {
    if (process.env.NODE_ENV === 'production') {
      return { settled: false, error: 'Simulated payments are not accepted in production' };
    }
    console.warn('[x402] WARNING: accepting sim settlement in dev mode');
    return { settled: true, txHash: `sim-tx-${paymentProof}`, simulated: true };
  }

  // On-chain tx hash: already settled on-chain, just confirm
  if (paymentProof && paymentProof.startsWith('0x') && paymentProof.length === 66) {
    return { settled: true, txHash: paymentProof };
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
