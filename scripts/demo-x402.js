#!/usr/bin/env node
// scripts/demo-x402.js — One-shot real x402 USDC settlement for demo recording
//
// Runs exactly ONE bid cycle with real USDC payment on Base mainnet:
//   1. Read feed → calculate bid
//   2. Sign and submit bid to current epoch
//   3. Wait for epoch to close
//   4. Check if won → if yes, transfer real USDC on-chain
//   5. Submit tx hash as X-Payment-Proof → get access token
//   6. Use token to query Venice AI
//
// Usage:
//   node scripts/demo-x402.js
//
// Requires in .env:
//   AGENT_PRIVATE_KEY — wallet with USDC on Base (even 0.01 USDC is enough)
//   BASE_RPC_URL      — Base mainnet RPC
//
// The wallet needs a tiny amount of ETH for gas + USDC for the clearing price (~0.005 USDC).

require('dotenv').config({ path: require('path').resolve(__dirname, '..', '.env') });

const { ethers } = require('ethers');

const AGENT_PRIVATE_KEY = process.env.AGENT_PRIVATE_KEY;
const ENDPOINT = process.env.AGENT_ENDPOINT || process.env.ENDPOINT || 'https://api.belleepoch.xyz';
const BASE_RPC_URL = process.env.BASE_RPC_URL || 'https://mainnet.base.org';
const USDC_ADDRESS = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const RESOURCE = 'private-reasoning';

if (!AGENT_PRIVATE_KEY) {
  console.error('ERROR: Set AGENT_PRIVATE_KEY in .env (wallet with USDC on Base)');
  process.exit(1);
}

const wallet = new ethers.Wallet(AGENT_PRIVATE_KEY);
const agentId = `agent-${wallet.address.slice(2, 10)}`;

function log(step, msg) {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[${ts}] [Step ${step}] ${msg}`);
}

async function main() {
  console.log('');
  console.log('═══════════════════════════════════════════════════');
  console.log('  Belle Epoch — Real x402 USDC Settlement Demo');
  console.log('═══════════════════════════════════════════════════');
  console.log(`  Agent:    ${agentId}`);
  console.log(`  Wallet:   ${wallet.address}`);
  console.log(`  Endpoint: ${ENDPOINT}`);
  console.log('');

  // ── Step 1: Read feed ──────────────────────────────────────────────────
  log(1, 'Reading clearing feed...');
  const feedRes = await fetch(`${ENDPOINT}/feed`);
  if (!feedRes.ok) {
    console.error(`Feed unavailable: ${feedRes.status}`);
    process.exit(1);
  }
  const feed = await feedRes.json();
  if (feed.status === 'idle') {
    console.error('No active providers — start the engine first');
    process.exit(1);
  }
  log(1, `Epoch ${feed.epochId} | Clearing price: ${feed.clearingPrice} USDC | Slots: ${feed.slotsFilled}/${feed.capacity}`);

  // ── Step 2: Calculate and submit bid ───────────────────────────────────
  // Bid aggressively (2x clearing price) to guarantee a win
  const bidAmount = parseFloat(Math.max(feed.clearingPrice * 2, 0.01).toFixed(4));
  log(2, `Bidding ${bidAmount} USDC (aggressive — 2x clearing price)`);

  const bidBody = { epochId: feed.epochId, agentId, maxBid: bidAmount, resource: RESOURCE };
  const message = `belle-epoch:bid:${bidBody.epochId}:${bidBody.agentId}:${bidBody.maxBid}:${bidBody.resource}`;
  const signature = await wallet.signMessage(message);

  let bidData;
  let usedEpochId = feed.epochId;

  for (let attempt = 0; attempt < 3; attempt++) {
    const body = { ...bidBody, epochId: usedEpochId, signature };
    const bidRes = await fetch(`${ENDPOINT}/bid`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    bidData = await bidRes.json();

    if (bidRes.status === 400 && bidData.currentEpochId) {
      usedEpochId = bidData.currentEpochId;
      // Re-sign with correct epoch
      const newMessage = `belle-epoch:bid:${usedEpochId}:${agentId}:${bidAmount}:${RESOURCE}`;
      const newSig = await wallet.signMessage(newMessage);
      body.signature = newSig;
      continue;
    }
    if (!bidRes.ok) {
      console.error(`Bid rejected: ${JSON.stringify(bidData)}`);
      process.exit(1);
    }
    break;
  }

  log(2, `Bid accepted for epoch ${usedEpochId} — closes in ${bidData.epochClosesMs}ms`);

  // ── Step 3: Wait for epoch to close ────────────────────────────────────
  const waitMs = (bidData.epochClosesMs || 5000) + 1500;
  log(3, `Waiting ${waitMs}ms for epoch to close...`);
  await new Promise(r => setTimeout(r, waitMs));

  // ── Step 4: Check if we won ────────────────────────────────────────────
  log(4, 'Checking auction result...');
  let paymentData;
  for (let poll = 0; poll < 5; poll++) {
    const payRes = await fetch(`${ENDPOINT}/epoch/${usedEpochId}/payment/${agentId}`);
    if (payRes.status === 404) {
      if (poll < 4) {
        await new Promise(r => setTimeout(r, 2000));
        continue;
      }
      log(4, 'Lost auction (did not win a slot). Try again.');
      process.exit(0);
    }
    paymentData = await payRes.json();
    break;
  }

  if (paymentData.status === 'already_paid') {
    log(4, `Already settled — tx: ${paymentData.txHash}`);
    process.exit(0);
  }

  const clearingPrice = paymentData.clearingPrice;
  const payTo = paymentData.paymentRequest?.accepts?.[0]?.payTo;
  log(4, `WON! Clearing price: ${clearingPrice} USDC | Pay to: ${payTo}`);
  log(4, `Payment request: ${JSON.stringify(paymentData.paymentRequest.accepts[0])}`);

  // ── Step 5: Real USDC transfer on Base ─────────────────────────────────
  log(5, 'Executing real USDC transfer on Base mainnet...');

  const provider = new ethers.JsonRpcProvider(BASE_RPC_URL);
  const connectedWallet = wallet.connect(provider);
  const usdc = new ethers.Contract(USDC_ADDRESS, [
    'function transfer(address to, uint256 amount) returns (bool)',
    'function balanceOf(address) view returns (uint256)',
  ], connectedWallet);

  const amount = BigInt(Math.round(clearingPrice * 1e6));
  const balance = await usdc.balanceOf(wallet.address);
  log(5, `Wallet USDC balance: ${ethers.formatUnits(balance, 6)} | Transfer amount: ${ethers.formatUnits(amount, 6)}`);

  if (balance < amount) {
    console.error(`Insufficient USDC: have ${ethers.formatUnits(balance, 6)}, need ${ethers.formatUnits(amount, 6)}`);
    process.exit(1);
  }

  const tx = await usdc.transfer(payTo, amount);
  log(5, `USDC transfer submitted: ${tx.hash}`);

  const receipt = await tx.wait();
  log(5, `Confirmed in block ${receipt.blockNumber} — gas used: ${receipt.gasUsed.toString()}`);

  // ── Step 6: Submit payment proof → get access token ────────────────────
  log(6, 'Submitting tx hash as x402 payment proof...');

  const settleRes = await fetch(`${ENDPOINT}/bid`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Payment-Proof': tx.hash,
    },
    body: JSON.stringify({
      epochId: usedEpochId,
      agentId,
      resource: RESOURCE,
    }),
  });

  const settleData = await settleRes.json();
  if (!settleRes.ok) {
    console.error(`Settlement failed: ${JSON.stringify(settleData)}`);
    process.exit(1);
  }

  log(6, `Payment verified! Access token: ${settleData.accessToken.slice(0, 40)}...`);

  // ── Step 7: Query Venice AI with the access token ──────────────────────
  log(7, 'Querying Venice AI (private reasoning)...');

  const queryRes = await fetch(`${ENDPOINT}/query`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${settleData.accessToken}`,
    },
    body: JSON.stringify({
      type: 'bid-strategy',
      context: {
        currentPrice: clearingPrice,
        budget: bidAmount,
        strategy: 'adaptive',
        note: 'Real x402 demo — paid with on-chain USDC',
      },
    }),
  });

  const queryData = await queryRes.json();
  log(7, `Query submitted: ${queryData.queryId} (${queryData.status})`);

  // Poll for result
  log(7, 'Waiting for Venice response...');
  for (let i = 0; i < 15; i++) {
    await new Promise(r => setTimeout(r, 2000));
    const resultRes = await fetch(`${ENDPOINT}/query/${queryData.queryId}`);
    if (!resultRes.ok) continue;
    const result = await resultRes.json();
    if (result.status === 'processing') {
      process.stdout.write('.');
      continue;
    }
    console.log('');
    log(7, `Venice responded! Retained: ${result.retained} | Proof: ${(result.veniceProof || 'n/a').slice(0, 24)}...`);
    if (result.result) {
      console.log('');
      console.log('─── Venice Response ───');
      console.log(typeof result.result === 'string' ? result.result : JSON.stringify(result.result, null, 2));
      console.log('───────────────────────');
    }
    break;
  }

  // ── Summary ────────────────────────────────────────────────────────────
  console.log('');
  console.log('═══════════════════════════════════════════════════');
  console.log('  DEMO COMPLETE — Full x402 Flow');
  console.log('═══════════════════════════════════════════════════');
  console.log(`  Epoch:          ${usedEpochId}`);
  console.log(`  Clearing price: ${clearingPrice} USDC`);
  console.log(`  USDC tx:        ${tx.hash}`);
  console.log(`  Block:          ${receipt.blockNumber}`);
  console.log(`  BaseScan:       https://basescan.org/tx/${tx.hash}`);
  console.log(`  Access token:   ${settleData.accessToken.slice(0, 32)}...`);
  console.log('═══════════════════════════════════════════════════');
  console.log('');
}

main().catch(err => {
  console.error(`Fatal: ${err.message}`);
  process.exit(1);
});
