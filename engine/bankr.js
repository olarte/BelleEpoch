// engine/bankr.js — Bankr LLM Gateway + wallet integration
//
// Handles:
// 1. LLM inference routing through Bankr gateway (pays from Bankr wallet balance)
// 2. Balance monitoring for Bankr wallet
// 3. Revenue routing: send USDC from protocol earnings → Bankr wallet

const { redis } = require('./bids');

const BANKR_API_URL = process.env.BANKR_API_URL || 'https://api.bankr.bot';
const BANKR_LLM_URL = process.env.BANKR_LLM_URL || 'https://llm.bankr.bot';
const BANKR_API_KEY = process.env.BANKR_API_KEY || '';
const BANKR_WALLET = process.env.BANKR_WALLET || '';

let initialized = false;
let walletAddress = null;

async function init() {
  if (!BANKR_API_KEY) {
    console.log('[Bankr] Missing BANKR_API_KEY — Bankr integration disabled');
    return false;
  }

  // Fetch wallet address from Bankr if not set in env
  if (BANKR_WALLET) {
    walletAddress = BANKR_WALLET;
  } else {
    try {
      const info = await getUserInfo();
      const evmWallet = info.wallets?.find(w => w.chain === 'evm');
      if (evmWallet) {
        walletAddress = evmWallet.address;
        console.log(`[Bankr] Resolved wallet: ${walletAddress}`);
      }
    } catch (err) {
      console.error('[Bankr] Could not resolve wallet:', err.message);
    }
  }

  initialized = true;
  console.log(`[Bankr] Active — gateway: ${BANKR_LLM_URL}`);
  console.log(`[Bankr] Wallet: ${walletAddress || '(not resolved)'}`);
  return true;
}

// ─── User info ──────────────────────────────────────────────────────────────

async function getUserInfo() {
  const response = await fetch(`${BANKR_API_URL}/agent/me`, {
    headers: { 'X-API-Key': BANKR_API_KEY },
  });
  if (!response.ok) {
    throw new Error(`Bankr /agent/me returned ${response.status}`);
  }
  return response.json();
}

// ─── LLM Gateway call ───────────────────────────────────────────────────────
// OpenAI-compatible chat completions through Bankr gateway.
// Bankr deducts cost from wallet balance automatically.

async function chatCompletion(model, messages, options = {}) {
  if (!initialized) {
    throw new Error('Bankr not initialized');
  }

  const response = await fetch(`${BANKR_LLM_URL}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': BANKR_API_KEY,
    },
    body: JSON.stringify({
      model,
      messages,
      temperature: options.temperature ?? 0.3,
      max_tokens: options.max_tokens ?? 1024,
      stream: false,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Bankr LLM Gateway returned ${response.status}: ${text}`);
  }

  return response.json();
}

// ─── Balance check ──────────────────────────────────────────────────────────

async function getBalance() {
  if (!BANKR_API_KEY) {
    return { usdc: 0, error: 'No API key' };
  }

  try {
    const response = await fetch(`${BANKR_API_URL}/agent/balances`, {
      headers: { 'X-API-Key': BANKR_API_KEY },
    });

    if (!response.ok) {
      const text = await response.text();
      return { usdc: 0, error: `HTTP ${response.status}: ${text}` };
    }

    const data = await response.json();

    // Extract USDC balance from Bankr response
    // Format: { balances: { base: { tokenBalances: [{ symbol, balance }], total }, ... } }
    let usdcBalance = 0;
    if (data.balances) {
      // Check Base chain first (primary), then others
      for (const chain of ['base', 'mainnet', 'polygon', 'unichain']) {
        const chainData = data.balances[chain];
        if (!chainData) continue;
        // Look for USDC in token balances
        if (Array.isArray(chainData.tokenBalances)) {
          const usdc = chainData.tokenBalances.find(t =>
            t.symbol === 'USDC' || (t.name && t.name.toLowerCase().includes('usd coin'))
          );
          if (usdc) {
            usdcBalance += parseFloat(usdc.balance || usdc.amount || '0');
          }
        }
        // Also add native balance total if available
      }
    }

    return {
      usdc: usdcBalance,
      evmAddress: data.evmAddress || null,
      raw: data,
    };
  } catch (err) {
    return { usdc: 0, error: err.message };
  }
}

// ─── LLM usage tracking ────────────────────────────────────────────────────

async function getUsage(days = 7) {
  if (!BANKR_API_KEY) return null;

  try {
    const response = await fetch(`${BANKR_LLM_URL}/v1/usage?days=${days}`, {
      headers: { 'X-API-Key': BANKR_API_KEY },
    });
    if (!response.ok) return null;
    return response.json();
  } catch {
    return null;
  }
}

// ─── Revenue routing ────────────────────────────────────────────────────────
// Routes USDC from protocol earnings to Bankr wallet.
// In production this would be a real x402 micropayment or on-chain transfer.
// For the MVP, we track it in Redis and log the simulated routing.

async function routeRevenue(epochId, amountUsdc) {
  const target = walletAddress || BANKR_WALLET;
  if (!target) {
    console.log(`[Bankr] No wallet address — skipping revenue routing for epoch ${epochId}`);
    return { routed: false, error: 'No wallet address' };
  }

  // Generate a deterministic simulated tx hash for tracking
  const crypto = require('crypto');
  const txHash = '0x' + crypto.createHash('sha256')
    .update(`bankr-route:${epochId}:${amountUsdc}:${target}:${Date.now()}`)
    .digest('hex');

  // Track cumulative routing in Redis
  await redis.incrbyfloat('bankr:routed:total', amountUsdc);
  await redis.lpush('bankr:routing:log', JSON.stringify({
    epochId,
    amount: amountUsdc,
    target,
    txHash,
    timestamp: new Date().toISOString(),
  }));
  await redis.ltrim('bankr:routing:log', 0, 999);

  console.log(
    `[Bankr] Routed ${amountUsdc.toFixed(6)} USDC → ${target.slice(0, 10)}... | tx: ${txHash.slice(0, 18)}...`
  );

  return { routed: true, txHash, amount: amountUsdc, target };
}

// ─── Routing log retrieval ──────────────────────────────────────────────────

async function getRoutingLog(limit = 50) {
  const raw = await redis.lrange('bankr:routing:log', 0, limit - 1);
  return raw.map(s => JSON.parse(s));
}

async function getTotalRouted() {
  const raw = await redis.get('bankr:routed:total');
  return parseFloat(raw || '0');
}

function getWallet() {
  return walletAddress || BANKR_WALLET || null;
}

function isInitialized() {
  return initialized;
}

module.exports = {
  init,
  chatCompletion,
  getBalance,
  getUsage,
  routeRevenue,
  getRoutingLog,
  getTotalRouted,
  getUserInfo,
  getWallet,
  isInitialized,
  BANKR_API_KEY,
  BANKR_LLM_URL,
};
