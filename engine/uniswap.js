// engine/uniswap.js — Uniswap Trading API integration (quotes + protocol fee routing)

const { ethers } = require('ethers');
const { redis } = require('./bids');

const UNISWAP_API_URL = 'https://trade-api.gateway.uniswap.org/v1';
const UNISWAP_API_KEY = process.env.UNISWAP_API_KEY || '';

// Well-known token addresses on Base (chainId 8453)
const BASE_TOKENS = {
  USDC: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  WETH: '0x4200000000000000000000000000000000000006',
  ETH:  '0x0000000000000000000000000000000000000000',
  DAI:  '0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb',
  USDbC: '0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA',
};

// Common chain IDs
const CHAIN_IDS = {
  ethereum: 1,
  base: 8453,
  optimism: 10,
  arbitrum: 42161,
  polygon: 137,
  celo: 42220,
};

// Permit2 contract (canonical address on all chains)
const PERMIT2 = '0x000000000022D473030F116dDEE9F6B43aC78BA3';
// Uniswap SwapRouter02 on Base
const SWAP_ROUTER_02 = '0x2626664c2603336E57B271c5C0b26F421741e481';

// Protocol wallet that receives fee revenue
const PROTOCOL_WALLET = process.env.PROTOCOL_WALLET || '';
const ENGINE_PRIVATE_KEY = process.env.ENGINE_PRIVATE_KEY || '';
const BASE_RPC_URL = process.env.BASE_RPC_URL || '';

// Accumulated fees awaiting routing (in USDC, 6 decimals)
let accumulatedFeeUsdc = 0;
const FEE_ROUTING_THRESHOLD = parseFloat(process.env.FEE_ROUTING_THRESHOLD || '0.01'); // Route when threshold reached

// ─── Resolve token symbol to address ─────────────────────────────────────────
function resolveToken(symbolOrAddress, chainId) {
  if (symbolOrAddress.startsWith('0x') && symbolOrAddress.length === 42) {
    return symbolOrAddress;
  }
  const upper = symbolOrAddress.toUpperCase();
  if (chainId === 8453 && BASE_TOKENS[upper]) {
    return BASE_TOKENS[upper];
  }
  // Fallback: common tokens on Ethereum mainnet
  const ETH_TOKENS = {
    USDC: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
    WETH: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
    ETH:  '0x0000000000000000000000000000000000000000',
    DAI:  '0x6B175474E89094C44Da98b954EedeAC495271d0F',
    USDT: '0xdAC17F958D2ee523a2206206994597C13D831ec7',
  };
  if (ETH_TOKENS[upper]) return ETH_TOKENS[upper];
  return null;
}

// ─── GET /feed/swap — quote a swap ──────────────────────────────────────────
async function getSwapQuote({ from, to, amount, chainId }) {
  const chain = parseInt(chainId || '8453', 10);
  const tokenIn = resolveToken(from, chain);
  const tokenOut = resolveToken(to, chain);

  if (!tokenIn) throw new Error(`Unknown token: ${from}`);
  if (!tokenOut) throw new Error(`Unknown token: ${to}`);
  if (!UNISWAP_API_KEY) throw new Error('UNISWAP_API_KEY not configured');

  // Amount in smallest unit (e.g. USDC has 6 decimals, ETH has 18)
  // Caller provides human-readable amount; we convert based on known decimals
  const decimals = guessDecimals(from, chain);
  const amountRaw = ethers.parseUnits(String(amount), decimals).toString();

  const body = {
    type: 'EXACT_INPUT',
    amount: amountRaw,
    tokenInChainId: chain,
    tokenOutChainId: chain,
    tokenIn,
    tokenOut,
    swapper: PROTOCOL_WALLET,
    slippageTolerance: 0.5,
    routingPreference: 'BEST_PRICE',
  };

  const res = await fetch(`${UNISWAP_API_URL}/quote`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': UNISWAP_API_KEY,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Uniswap API ${res.status}: ${text}`);
  }

  const data = await res.json();
  const quote = data.quote || {};

  return {
    quote: {
      input: quote.input || null,
      output: quote.output || null,
      swapper: quote.swapper || PROTOCOL_WALLET,
      chainId: chain,
      tradeType: quote.tradeType || 'EXACT_INPUT',
      slippage: quote.slippage || '0.5',
      priceImpact: quote.priceImpact || null,
    },
    route: quote.route || [],
    estimatedGas: quote.gasUseEstimate || quote.gasFee || null,
    gasFeeUSD: quote.gasFeeUSD || null,
    routing: data.routing || null,
    requestId: data.requestId || null,
    permitData: data.permitData || null,
  };
}

function guessDecimals(symbol, chainId) {
  const upper = (symbol || '').toUpperCase();
  if (upper === 'USDC' || upper === 'USDT' || upper === 'USDB' || upper === 'USDBC') return 6;
  if (upper === 'WBTC') return 8;
  return 18; // ETH, WETH, DAI, most ERC-20s
}

// ─── Protocol fee routing through Uniswap ───────────────────────────────────
// Called after each epoch clear with the protocol fee amount.
// Accumulates fees, then routes through Uniswap v4 pool when threshold reached.
async function accumulateFee(epochId, feeUsdc) {
  accumulatedFeeUsdc += feeUsdc;

  // Persist accumulated amount
  await redis.set('uniswap:fees:accumulated', accumulatedFeeUsdc.toString());

  if (accumulatedFeeUsdc >= FEE_ROUTING_THRESHOLD) {
    return routeFeeThroughUniswap(epochId, accumulatedFeeUsdc);
  }

  return { routed: false, accumulated: accumulatedFeeUsdc };
}

// Execute a real swap of accumulated USDC fees through Uniswap on Base.
// Swaps USDC → WETH via Uniswap V3 SwapRouter02 using Permit2 approvals.
async function routeFeeThroughUniswap(epochId, amountUsdc) {
  if (!ENGINE_PRIVATE_KEY || !BASE_RPC_URL) {
    console.log('[Uniswap] Missing config — skipping fee routing');
    return { routed: false, error: 'missing config' };
  }

  const amountRaw = BigInt(Math.round(amountUsdc * 1e6)); // USDC 6 decimals

  try {
    const provider = new ethers.JsonRpcProvider(BASE_RPC_URL);
    const wallet = new ethers.Wallet(ENGINE_PRIVATE_KEY, provider);

    // Step 1: Ensure USDC is approved to Permit2
    const usdcAbi = [
      'function allowance(address owner, address spender) view returns (uint256)',
      'function approve(address spender, uint256 amount) returns (bool)',
    ];
    const usdc = new ethers.Contract(BASE_TOKENS.USDC, usdcAbi, wallet);
    const permit2Allowance = await usdc.allowance(wallet.address, PERMIT2);
    if (permit2Allowance < amountRaw) {
      const approveTx = await usdc.approve(PERMIT2, ethers.MaxUint256);
      await approveTx.wait();
      console.log(`[Uniswap] USDC approved to Permit2: ${approveTx.hash}`);
    }

    // Step 2: Ensure Permit2 grants allowance to SwapRouter02
    const permit2Abi = [
      'function allowance(address owner, address token, address spender) view returns (uint160 amount, uint48 expiration, uint48 nonce)',
      'function approve(address token, address spender, uint160 amount, uint48 expiration)',
    ];
    const permit2 = new ethers.Contract(PERMIT2, permit2Abi, wallet);
    const [currentAmt, expiration] = await permit2.allowance(wallet.address, BASE_TOKENS.USDC, SWAP_ROUTER_02);
    const now = Math.floor(Date.now() / 1000);
    if (currentAmt < amountRaw || expiration <= now) {
      const maxUint160 = (1n << 160n) - 1n;
      const p2Tx = await permit2.approve(BASE_TOKENS.USDC, SWAP_ROUTER_02, maxUint160, now + 86400 * 30);
      await p2Tx.wait();
      console.log(`[Uniswap] Permit2 allowance granted to SwapRouter02: ${p2Tx.hash}`);
    }

    // Step 3: Execute swap USDC → WETH via SwapRouter02
    const routerAbi = [
      'function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96)) external payable returns (uint256 amountOut)',
    ];
    const router = new ethers.Contract(SWAP_ROUTER_02, routerAbi, wallet);

    const params = {
      tokenIn: BASE_TOKENS.USDC,
      tokenOut: BASE_TOKENS.WETH,
      fee: 500, // 0.05% fee tier (most liquid USDC/WETH pool on Base)
      recipient: wallet.address,
      amountIn: amountRaw,
      amountOutMinimum: 0n,
      sqrtPriceLimitX96: 0n,
    };

    const gasEstimate = await router.exactInputSingle.estimateGas(params);
    const tx = await router.exactInputSingle(params, {
      gasLimit: gasEstimate * 130n / 100n,
    });

    console.log(`[Uniswap] Fee routing tx submitted: ${tx.hash}`);
    const receipt = await tx.wait();
    console.log(`[Uniswap] Fee routing confirmed in block ${receipt.blockNumber}`);

    // Log to Redis
    const routingLog = {
      epochId,
      amountUsdc,
      txHash: tx.hash,
      blockNumber: receipt.blockNumber,
      routing: 'UNISWAP_V3',
      feeTier: 500,
      timestamp: new Date().toISOString(),
    };
    await redis.lpush('uniswap:fee:routing:log', JSON.stringify(routingLog));
    await redis.incrbyfloat('uniswap:fee:routing:total', amountUsdc);

    // Reset accumulator
    accumulatedFeeUsdc = 0;
    await redis.set('uniswap:fees:accumulated', '0');

    return { routed: true, txHash: tx.hash, amountUsdc, blockNumber: receipt.blockNumber };
  } catch (err) {
    console.error(`[Uniswap] Fee routing failed:`, err.message);
    return { routed: false, error: err.message };
  }
}

// ─── Get routing history ────────────────────────────────────────────────────
async function getRoutingLog() {
  const raw = await redis.lrange('uniswap:fee:routing:log', 0, 49);
  return raw.map(s => JSON.parse(s));
}

async function getTotalRouted() {
  const raw = await redis.get('uniswap:fee:routing:total');
  return parseFloat(raw || '0');
}

// ─── Init: restore accumulated fees from Redis ─────────────────────────────
async function init() {
  if (!UNISWAP_API_KEY) {
    console.log('[Uniswap] No UNISWAP_API_KEY — quote endpoint disabled, fee routing in fallback mode');
    return;
  }
  const stored = await redis.get('uniswap:fees:accumulated');
  if (stored) accumulatedFeeUsdc = parseFloat(stored);
  console.log(`[Uniswap] Initialized — accumulated fees: ${accumulatedFeeUsdc.toFixed(6)} USDC`);
}

module.exports = {
  getSwapQuote,
  accumulateFee,
  routeFeeThroughUniswap,
  getRoutingLog,
  getTotalRouted,
  init,
  resolveToken,
  BASE_TOKENS,
  CHAIN_IDS,
};
