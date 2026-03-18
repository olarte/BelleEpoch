// belle-epoch-agent — Agent SDK for Belle Epoch Continuous Clearing Auctions
//
// Usage:
//   const { BelleAgent } = require('belle-epoch-agent');
//   const agent = new BelleAgent({ wallet: '0x...or private key', strategy: 'adaptive', maxBid: 0.05 });
//   const token = await agent.bid({ resource: 'private-reasoning', endpoint: 'https://api.belleepoch.xyz' });

const { ethers } = require('ethers');

const DEFAULT_ENDPOINT = 'https://api.belleepoch.xyz';

class BelleAgent {
  /**
   * @param {Object} opts
   * @param {string} opts.wallet     — private key (hex) or ethers.Wallet instance
   * @param {string} opts.strategy   — 'adaptive' | 'conservative' | 'aggressive'
   * @param {number} opts.maxBid     — maximum bid in USDC (e.g. 0.05)
   * @param {string} [opts.agentId]  — agent identifier (default: derived from wallet)
   */
  constructor({ wallet, strategy = 'adaptive', maxBid = 0.01, agentId } = {}) {
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
   * Execute a full bid cycle: read feed → calculate bid → sign → submit → handle 402 → return token.
   *
   * @param {Object} opts
   * @param {string} opts.resource  — resource to bid on (e.g. 'private-reasoning')
   * @param {string} [opts.endpoint] — engine URL (default: https://api.belleepoch.xyz)
   * @returns {Object} { accessToken, epochId, clearingPrice, txHash }
   */
  async bid({ resource, endpoint = DEFAULT_ENDPOINT } = {}) {
    if (!resource) throw new Error('resource is required');

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
    await new Promise(resolve => setTimeout(resolve, waitMs + 500));

    // Step 6: Check if we won — poll payment endpoint
    const paymentRes = await fetch(`${endpoint}/epoch/${usedEpochId}/payment/${this.agentId}`);
    const paymentData = await paymentRes.json();

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
      const settlementResult = await this._settlePayment(
        endpoint,
        usedEpochId,
        paymentData.clearingPrice,
        resource
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
   * Settle a winning bid via the x402 payment flow.
   * Constructs a payment proof and POSTs to /bid with X-Payment-Proof.
   */
  async _settlePayment(endpoint, epochId, clearingPrice, resource) {
    // Construct simulated payment proof (for the sim flow)
    // In production, this would create a real USDC transaction
    const paymentProof = `agent-payment-${this.agentId}-${epochId}-${Date.now()}`;

    const settleRes = await fetch(`${endpoint}/bid`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Payment-Proof': paymentProof,
      },
      body: JSON.stringify({
        epochId,
        agentId: this.agentId,
        resource,
      }),
    });

    const settleData = await settleRes.json();

    if (settleData.accessToken) {
      return {
        accessToken: settleData.accessToken,
        txHash: settleData.txHash || null,
      };
    }

    // Payment verification may require a real on-chain proof
    // Return what we have
    return {
      accessToken: null,
      txHash: settleData.txHash || null,
      settlementError: settleData.error || null,
    };
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
