// engine/beast/identity.js — Beast's ERC-8004 identity + provider registration
//
// Beast has its own identity, separate from Belle. On startup it registers
// itself as a provider in Redis and (when configured) on-chain via ERC-8004.

const { redis } = require('../bids');

const BEAST_ID = 'beast.epoch.base.eth';

async function registerBeast() {
  const existing = await redis.get(`provider:${BEAST_ID}`);
  if (existing) {
    console.log('[beast] already registered');
    const p = JSON.parse(existing);
    p.online = true;
    await redis.set(`provider:${BEAST_ID}`, JSON.stringify(p));
    return;
  }

  // On-chain ERC-8004 registration (when wallet + registry are configured)
  let erc8004Tx = null;
  if (process.env.BEAST_WALLET_PRIVATE_KEY && process.env.ERC8004_REGISTRY_ADDRESS) {
    try {
      const { ethers } = require('ethers');
      const provider = new ethers.JsonRpcProvider(process.env.BASE_RPC_URL);
      const wallet = new ethers.Wallet(process.env.BEAST_WALLET_PRIVATE_KEY, provider);

      const registry = new ethers.Contract(
        process.env.ERC8004_REGISTRY_ADDRESS,
        [
          'function registerAgent(address agent, string metadata) external',
        ],
        wallet
      );

      const tx = await registry.registerAgent(
        wallet.address,
        JSON.stringify({
          name: 'Beast',
          service: 'market-intelligence',
          endpoint: 'https://api.belleepoch.xyz/beast',
          version: '1.0.0',
        })
      );
      await tx.wait();
      erc8004Tx = tx.hash;
      console.log(`[beast] ERC-8004 registered: ${tx.hash}`);
    } catch (err) {
      console.log(`[beast] ERC-8004 registration skipped: ${err.message}`);
    }
  } else {
    console.log('[beast] ERC-8004 registration skipped (no wallet or registry configured)');
  }

  // Store Beast as a provider in Redis
  const beast = {
    id:            BEAST_ID,
    name:          'Beast',
    type:          'agent',
    resource:      'market-intelligence',
    description:   'Market intelligence for Belle Epoch. Price history, provider comparison, demand signals, optimal bid timing, market summaries.',
    capacitySlots: 5,
    epochMs:       30000,   // 30s epochs — queries need compute time
    chain:         'base',
    online:        true,
    erc8004Tx:     erc8004Tx,
    registeredAt:  new Date().toISOString(),
    epochsServed:  0,
    totalEarned:   0,
  };

  await redis.set(`provider:${BEAST_ID}`, JSON.stringify(beast));
  await redis.zadd('providers', Date.now(), BEAST_ID);
  console.log('[beast] registered as provider');
}

module.exports = { registerBeast, BEAST_ID };
