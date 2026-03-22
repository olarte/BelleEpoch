// belle-epoch-agent — Agent SDK for Belle Epoch Continuous Clearing Auctions
//
// Usage:
//   const { BelleAgent } = require('belle-epoch-agent');
//   const agent = new BelleAgent({ wallet: '0x...or private key', strategy: 'adaptive', maxBid: 0.05 });
//   const token = await agent.bid({ resource: 'private-reasoning', endpoint: 'https://api.belleepoch.xyz' });

const { ethers } = require('ethers');

const DEFAULT_ENDPOINT = 'https://api.belleepoch.xyz';

// Uniswap / Token constants on Base mainnet
const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const WETH_BASE = '0x4200000000000000000000000000000000000006';
const SWAP_ROUTER_02 = '0x2626664c2603336E57B271c5C0b26F421741e481';
const PERMIT2 = '0x000000000022D473030F116dDEE9F6B43aC78BA3';

class BelleAgent {
  /**
   * @param {Object} opts
   * @param {string} opts.wallet     — private key (hex) or ethers.Wallet instance
   * @param {string} opts.strategy   — 'adaptive' | 'conservative' | 'aggressive'
   * @param {number} opts.maxBid     — maximum bid in USDC (e.g. 0.05)
   * @param {string} [opts.agentId]  — agent identifier (default: derived from wallet)
   * @param {boolean} [opts.autoSwap] — if true, swap to USDC via Uniswap before bidding (default: false)
   * @param {string} [opts.rpcUrl]   — Base mainnet RPC URL override
   */
  constructor({ wallet, strategy = 'adaptive', maxBid = 0.01, agentId, autoSwap = false, rpcUrl } = {}) {
    if (!wallet) throw new Error('wallet is required (private key or ethers.Wallet)');

    if (typeof wallet === 'string') {
      this.wallet = new ethers.Wallet(wallet);
    } else {
      this.wallet = wallet;
    }

    this.strategy = strategy;
    this.maxBid = maxBid;
    this.agentId = agentId || `agent-${this.wallet.address.slice(2, 10)}`;
    this.feedHistory = [];
    this.autoSwap = autoSwap;
    this.rpcUrl = rpcUrl || process.env.BASE_RPC_URL || 'https://mainnet.base.org';
  }

  /**
   * Read the clearing feed from the target endpoint.
   * @param {string} endpoint — base URL of the Belle Epoch engine
   * @returns {Object} feed data
   */
  async readFeed(endpoint = DEFAULT_ENDPOINT) {
    const res = await fetch(`${endpoint}/feed`);
    if (!res.ok) throw new Error(`Feed request failed: ${res.status}`);
    const feed = await res.json();
    this.feedHistory.push({ ...feed, readAt: Date.now() });
    if (this.feedHistory.length > 100) this.feedHistory.shift();
    return feed;
  }

  /**
   * Calculate bid amount based on strategy and feed history.
   * @param {Object} feed — current feed data
   * @returns {number} bid amount in USDC
   */
  calculateBid(feed) {
    const currentPrice = feed.clearingPrice || 0;

    switch (this.strategy) {
      case 'aggressive':
        // Always bid maxBid
        return this.maxBid;

      case 'conservative':
        // Bid 10% above current clearing price, capped at maxBid
        if (currentPrice === 0) return this.maxBid * 0.5;
        return Math.min(currentPrice * 1.1, this.maxBid);

      case 'adaptive':
      default:
        return this._adaptiveBid(feed);
    }
  }

  /**
   * Adaptive strategy: uses feed history to find optimal bid.
   * - If slots are consistently full, bid higher (competitive)
   * - If slots are undersubscribed, bid lower (save USDC)
   * - Mean-revert toward recent average clearing price
   */
  _adaptiveBid(feed) {
    const currentPrice = feed.clearingPrice || 0;

    if (this.feedHistory.length < 3 || currentPrice === 0) {
      // Not enough history — bid 50% of maxBid
      return this.maxBid * 0.5;
    }

    // Average clearing price over recent history
    const recent = this.feedHistory.slice(-10);
    const avgPrice = recent.reduce((s, f) => s + (f.clearingPrice || 0), 0) / recent.length;

    // Competition factor: how full are slots?
    const avgFill = recent.reduce((s, f) => s + (f.slotsFilled || 0), 0) / recent.length;
    const capacity = feed.capacity || 3;
    const fillRatio = avgFill / capacity;

    // Base bid: weighted average of current and historical
    let bid = avgPrice * 0.6 + currentPrice * 0.4;

    // Adjust for competition
    if (fillRatio > 0.9) {
      // Slots nearly full — bid 20% above average
      bid *= 1.2;
    } else if (fillRatio < 0.5) {
      // Slots undersubscribed — bid 20% below average
      bid *= 0.8;
    }

    // Add small random jitter (+-5%) to avoid bid collision
    const jitter = 1 + (Math.random() - 0.5) * 0.1;
    bid *= jitter;

    // Clamp to [0.0001, maxBid]
    return Math.max(0.0001, Math.min(bid, this.maxBid));
  }

  /**
   * Sign a bid message with the agent's wallet (ERC-8004 compatible).
   * @param {Object} bidBody — { epochId, agentId, maxBid, resource }
   * @returns {string} signature
   */
  async signBid(bidBody) {
    const message = `belle-epoch:bid:${bidBody.epochId}:${bidBody.agentId}:${bidBody.maxBid}:${bidBody.resource}`;
    return this.wallet.signMessage(message);
  }

  /**
   * Ensure the agent has at least `minAmount` USDC on Base.
   * If insufficient, swaps from `fromToken` (default WETH) to USDC via Uniswap SwapRouter02.
   *
   * @param {number} minAmount       — minimum USDC needed (human-readable, e.g. 0.05)
   * @param {Object} [options]
   * @param {string} [options.fromToken] — input token address (default: WETH on Base)
   * @param {number} [options.poolFee]   — Uniswap pool fee tier (default: 500 = 0.05%)
   * @returns {{ swapped: boolean, txHash: string|null, amountIn: string|null, amountOut: string|null }}
   */
  async ensureUsdcBalance(minAmount, options = {}) {
    const { fromToken = WETH_BASE, poolFee = 500 } = options;
    const provider = new ethers.JsonRpcProvider(this.rpcUrl);
    const connected = this.wallet.connect(provider);

    const usdc = new ethers.Contract(USDC_BASE, [
      'function balanceOf(address) view returns (uint256)',
    ], connected);
    const balance = await usdc.balanceOf(this.wallet.address);
    const needed = BigInt(Math.round(minAmount * 1e6));

    if (balance >= needed) {
      return { swapped: false, txHash: null, amountIn: null, amountOut: null };
    }

    const deficit = needed - balance;
    console.log(`[uniswap] USDC deficit: ${ethers.formatUnits(deficit, 6)}. Swapping from ${fromToken}...`);

    // Approve input token → Permit2
    const inputToken = new ethers.Contract(fromToken, [
      'function approve(address, uint256) returns (bool)',
      'function allowance(address, address) view returns (uint256)',
      'function balanceOf(address) view returns (uint256)',
    ], connected);

    const allowance = await inputToken.allowance(this.wallet.address, PERMIT2);
    if (allowance < deficit * 100n) {
      const tx = await inputToken.approve(PERMIT2, ethers.MaxUint256);
      await tx.wait();
    }

    // Permit2 → SwapRouter02
    const permit2 = new ethers.Contract(PERMIT2, [
      'function approve(address token, address spender, uint160 amount, uint48 expiration)',
      'function allowance(address, address, address) view returns (uint160, uint48, uint48)',
    ], connected);
    const [p2Amount] = await permit2.allowance(this.wallet.address, fromToken, SWAP_ROUTER_02);
    if (BigInt(p2Amount) < deficit * 100n) {
      const maxU160 = (1n << 160n) - 1n;
      const tx = await permit2.approve(fromToken, SWAP_ROUTER_02, maxU160, Math.floor(Date.now() / 1000) + 86400 * 30);
      await tx.wait();
    }

    // Execute exactOutputSingle swap
    const router = new ethers.Contract(SWAP_ROUTER_02, [
      'function exactOutputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountOut, uint256 amountInMaximum, uint160 sqrtPriceLimitX96)) external payable returns (uint256 amountIn)',
    ], connected);

    const inputBalance = await inputToken.balanceOf(this.wallet.address);
    const swapTx = await router.exactOutputSingle({
      tokenIn: fromToken,
      tokenOut: USDC_BASE,
      fee: poolFee,
      recipient: this.wallet.address,
      amountOut: deficit,
      amountInMaximum: inputBalance,
      sqrtPriceLimitX96: 0n,
    });
    const receipt = await swapTx.wait();

    console.log(`[uniswap] Swap complete: ${ethers.formatUnits(deficit, 6)} USDC acquired | tx: ${swapTx.hash}`);
    return { swapped: true, txHash: swapTx.hash, amountIn: null, amountOut: ethers.formatUnits(deficit, 6) };
  }

  /**
   * Standalone convenience: swap any token to USDC on Base via Uniswap.
   * @param {Object} opts
   * @param {string|ethers.Wallet} opts.wallet — private key or ethers.Wallet
   * @param {number} opts.amount              — USDC amount to acquire
   * @param {string} [opts.fromToken]         — input token address (default: WETH)
   * @param {string} [opts.rpcUrl]            — Base RPC URL
   */
  static async swapToUsdc({ wallet, amount, fromToken = WETH_BASE, rpcUrl } = {}) {
    const agent = new BelleAgent({ wallet, maxBid: amount, rpcUrl });
    return agent.ensureUsdcBalance(amount, { fromToken });
  }

  /**
   * Execute a full bid cycle: read feed → calculate bid → sign → submit → handle 402 → return token.
   * If autoSwap is enabled, ensures sufficient USDC balance before bidding.
   *
   * @param {Object} opts
   * @param {string} opts.resource  — resource to bid on (e.g. 'private-reasoning')
   * @param {string} [opts.endpoint] — engine URL (default: https://api.belleepoch.xyz)
   * @returns {Object} { accessToken, epochId, clearingPrice, txHash }
   */
  async bid({ resource, endpoint = DEFAULT_ENDPOINT } = {}) {
    if (!resource) throw new Error('resource is required');

    // Pre-bid USDC swap via Uniswap if autoSwap is enabled
    if (this.autoSwap) {
      try { await this.ensureUsdcBalance(this.maxBid); }
      catch (err) { console.warn(`[uniswap] Auto-swap failed: ${err.message}`); }
    }

    // Step 1: Read feed
    const feed = await this.readFeed(endpoint);

    // Step 2: Calculate bid
    const bidAmount = parseFloat(this.calculateBid(feed).toFixed(4));

    // Step 3+4: Sign and submit bid, with retry on epoch mismatch
    let bidData;
    let usedEpochId = feed.epochId;

    for (let attempt = 0; attempt < 3; attempt++) {
      const bidBody = {
        epochId: usedEpochId,
        agentId: this.agentId,
        maxBid: bidAmount,
        resource,
      };
      const signature = await this.signBid(bidBody);

      const bidRes = await fetch(`${endpoint}/bid`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...bidBody, signature }),
      });

      bidData = await bidRes.json();

      // If epoch mismatch, retry immediately with the correct epoch
      if (bidRes.status === 400 && bidData.currentEpochId && bidData.currentEpochId !== usedEpochId) {
        usedEpochId = bidData.currentEpochId;
        continue;
      }

      if (bidRes.status === 400 || bidRes.status === 401 || bidRes.status === 403) {
        throw new Error(`Bid rejected: ${bidData.error}`);
      }

      if (!bidRes.ok && bidRes.status !== 402) {
        throw new Error(`Bid failed: ${bidData.error || bidRes.status}`);
      }

      break; // success
    }

    // Step 5: Wait for epoch to close
    const waitMs = bidData.epochClosesMs || 5000;
    await new Promise(resolve => setTimeout(resolve, waitMs + 1000));

    // Step 6: Check if we won — poll payment endpoint with retry
    let paymentRes, paymentData;
    for (let poll = 0; poll < 3; poll++) {
      paymentRes = await fetch(`${endpoint}/epoch/${usedEpochId}/payment/${this.agentId}`);
      paymentData = await paymentRes.json();
      if (paymentRes.status !== 404) break;
      // Epoch result might not be stored yet — wait and retry
      await new Promise(resolve => setTimeout(resolve, 2000));
    }

    if (paymentRes.status === 404) {
      // We lost this epoch
      return {
        won: false,
        epochId: usedEpochId,
        bidAmount,
        clearingPrice: null,
        accessToken: null,
      };
    }

    if (paymentRes.status === 402 || paymentData.status === 'payment_required') {
      // We won — settle via x402
      const payTo = paymentData.paymentRequest?.accepts?.[0]?.payTo;
      const settlementResult = await this._settlePayment(
        endpoint,
        usedEpochId,
        paymentData.clearingPrice,
        resource,
        payTo
      );

      return {
        won: true,
        epochId: usedEpochId,
        bidAmount,
        clearingPrice: paymentData.clearingPrice,
        ...settlementResult,
      };
    }

    if (paymentData.status === 'already_paid') {
      return {
        won: true,
        epochId: usedEpochId,
        bidAmount,
        clearingPrice: paymentData.clearingPrice || null,
        txHash: paymentData.txHash,
        accessToken: null,
      };
    }

    return {
      won: false,
      epochId: usedEpochId,
      bidAmount,
      clearingPrice: null,
      accessToken: null,
    };
  }

  /**
   * Settle a winning bid via real USDC transfer on Base mainnet.
   * Signs and broadcasts a USDC transfer, then submits the tx hash as proof.
   */
  async _settlePayment(endpoint, epochId, clearingPrice, resource, payTo) {
    const USDC_ADDRESS = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
    const BASE_RPC_URL = process.env.BASE_RPC_URL || 'https://mainnet.base.org';
    const protocolWallet = payTo;

    if (!protocolWallet) {
      return { accessToken: null, txHash: null, settlementError: 'No payTo address in payment request' };
    }

    try {
      // Connect wallet to Base mainnet
      const provider = new ethers.JsonRpcProvider(BASE_RPC_URL);
      const connectedWallet = this.wallet.connect(provider);

      // USDC contract (6 decimals)
      const usdc = new ethers.Contract(USDC_ADDRESS, [
        'function transfer(address to, uint256 amount) returns (bool)',
        'function balanceOf(address) view returns (uint256)',
      ], connectedWallet);

      const amount = BigInt(Math.round(clearingPrice * 1e6));

      // Check balance
      const balance = await usdc.balanceOf(this.wallet.address);
      if (balance < amount) {
        return { accessToken: null, txHash: null, settlementError: `Insufficient USDC: have ${balance}, need ${amount}` };
      }

      console.log(`[x402] Transferring ${clearingPrice} USDC (${amount} units) to ${protocolWallet}...`);

      // Execute real USDC transfer
      const tx = await usdc.transfer(protocolWallet, amount);
      console.log(`[x402] USDC transfer tx: ${tx.hash}`);

      const receipt = await tx.wait();
      console.log(`[x402] USDC transfer confirmed in block ${receipt.blockNumber}`);

      // Submit tx hash as payment proof to get access token
      const settleRes = await fetch(`${endpoint}/bid`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Payment-Proof': tx.hash,
        },
        body: JSON.stringify({
          epochId,
          agentId: this.agentId,
          resource,
        }),
      });

      const settleData = await settleRes.json();

      return {
        accessToken: settleData.accessToken || null,
        txHash: tx.hash,
      };
    } catch (err) {
      console.error(`[x402] Real payment failed: ${err.message}`);
      return { accessToken: null, txHash: null, settlementError: err.message };
    }
  }

  /**
   * Convenience: bid and then call the gated endpoint with the token.
   * @param {Object} opts
   * @param {string} opts.resource  — resource to bid on
   * @param {string} opts.endpoint  — engine URL
   * @param {string} opts.url       — the actual gated endpoint to call
   * @param {Object} opts.body      — body to send to the gated endpoint
   * @returns {Object} response from the gated endpoint
   */
  async bidAndCall({ resource, endpoint = DEFAULT_ENDPOINT, url, body = {} } = {}) {
    const result = await this.bid({ resource, endpoint });

    if (!result.won || !result.accessToken) {
      return { won: false, result, response: null };
    }

    const callRes = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${result.accessToken}`,
      },
      body: JSON.stringify(body),
    });

    const response = await callRes.json();
    return { won: true, result, response };
  }
}

module.exports = { BelleAgent };
