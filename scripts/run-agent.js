#!/usr/bin/env node
// scripts/run-agent.js — External agent runner for Belle Epoch
//
// Runs a real agent that bids every epoch using the belle-epoch-agent SDK.
// On win: settles via x402, submits a real Venice query, appends to agent_log.json.
//
// Usage:
//   AGENT_PRIVATE_KEY=0x... node scripts/run-agent.js
//   AGENT_PRIVATE_KEY=0x... ENDPOINT=http://localhost:3001 node scripts/run-agent.js

require('dotenv').config({ path: require('path').resolve(__dirname, '..', '.env') });

const path = require('path');
const fs = require('fs');
const { BelleAgent } = require('../sdk/agent');

const AGENT_PRIVATE_KEY = process.env.AGENT_PRIVATE_KEY;
const ENDPOINT = process.env.AGENT_ENDPOINT || process.env.ENDPOINT || 'https://api.belleepoch.xyz';
const MAX_BID = parseFloat(process.env.AGENT_MAX_BID || '0.01');
const STRATEGY = process.env.AGENT_STRATEGY || 'adaptive';
const RESOURCE = 'private-reasoning';
const AGENT_LOG_PATH = path.resolve(__dirname, '..', 'agent_log.json');

if (!AGENT_PRIVATE_KEY) {
  console.error('ERROR: AGENT_PRIVATE_KEY env var is required');
  console.error('Usage: AGENT_PRIVATE_KEY=0x... node scripts/run-agent.js');
  process.exit(1);
}

const agent = new BelleAgent({
  wallet: AGENT_PRIVATE_KEY,
  strategy: STRATEGY,
  maxBid: MAX_BID,
});

console.log(`[Agent] ID: ${agent.agentId}`);
console.log(`[Agent] Wallet: ${agent.wallet.address}`);
console.log(`[Agent] Strategy: ${STRATEGY} | Max bid: ${MAX_BID} USDC`);
console.log(`[Agent] Endpoint: ${ENDPOINT}`);
console.log(`[Agent] Resource: ${RESOURCE}`);
console.log('---');

// Append a log entry to agent_log.json
function appendLog(entry) {
  let log = [];
  try {
    if (fs.existsSync(AGENT_LOG_PATH)) {
      log = JSON.parse(fs.readFileSync(AGENT_LOG_PATH, 'utf8'));
      if (!Array.isArray(log)) log = [log];
    }
  } catch {
    log = [];
  }
  log.push(entry);
  fs.writeFileSync(AGENT_LOG_PATH, JSON.stringify(log, null, 2) + '\n');
}

async function queryVenice(accessToken) {
  const queryRes = await fetch(`${ENDPOINT}/query`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${accessToken}`,
    },
    body: JSON.stringify({
      type: 'bid-strategy',
      context: {
        currentPrice: 0.005,
        budget: MAX_BID,
        strategy: STRATEGY,
        note: 'External agent real query via run-agent.js',
      },
    }),
  });

  if (!queryRes.ok) {
    const text = await queryRes.text();
    console.log(`[Agent] Query submission failed: ${queryRes.status} ${text}`);
    return null;
  }

  const queryData = await queryRes.json();
  console.log(`[Agent] Query submitted: ${queryData.queryId} (status: ${queryData.status})`);

  // Poll for result (up to 30s)
  for (let i = 0; i < 15; i++) {
    await new Promise(r => setTimeout(r, 2000));
    const resultRes = await fetch(`${ENDPOINT}/query/${queryData.queryId}`);
    if (!resultRes.ok) {
      if (resultRes.status === 404) {
        console.log(`[Agent] Query result already retrieved or expired`);
        return null;
      }
      continue;
    }
    const result = await resultRes.json();
    if (result.status === 'processing') {
      process.stdout.write('.');
      continue;
    }
    console.log('');
    return result;
  }
  console.log('\n[Agent] Query timed out after 30s');
  return null;
}

async function runOneCycle() {
  const cycleStart = new Date().toISOString();
  console.log(`\n[Agent] === Cycle start: ${cycleStart} ===`);

  try {
    // Step 1: Bid
    console.log(`[Agent] Reading feed and bidding...`);
    const result = await agent.bid({ resource: RESOURCE, endpoint: ENDPOINT });

    console.log(`[Agent] Epoch ${result.epochId} | Bid: ${result.bidAmount} USDC | Won: ${result.won}`);

    if (!result.won) {
      appendLog({
        timestamp: cycleStart,
        phase: 'bid',
        epochId: result.epochId,
        action: 'Lost auction',
        bidAmount: result.bidAmount,
        won: false,
      });
      return;
    }

    console.log(`[Agent] Clearing price: ${result.clearingPrice} USDC | TX: ${result.txHash || 'n/a'}`);

    // Step 2: Query Venice if we have an access token
    let queryResult = null;
    if (result.accessToken) {
      console.log(`[Agent] Submitting Venice query...`);
      queryResult = await queryVenice(result.accessToken);
      if (queryResult) {
        console.log(`[Agent] Venice result received:`);
        console.log(`  Status: ${queryResult.status}`);
        console.log(`  Retained: ${queryResult.retained}`);
        console.log(`  Proof: ${queryResult.veniceProof ? queryResult.veniceProof.slice(0, 24) + '...' : 'n/a'}`);
      }
    }

    // Step 3: Log
    appendLog({
      timestamp: cycleStart,
      phase: 'execute',
      epochId: result.epochId,
      action: 'Full cycle: bid → win → settle → query',
      bidAmount: result.bidAmount,
      clearingPrice: result.clearingPrice,
      txHash: result.txHash || null,
      won: true,
      accessToken: result.accessToken ? '(present)' : null,
      veniceQuery: queryResult ? {
        queryId: queryResult.queryId,
        status: queryResult.status,
        retained: queryResult.retained,
        veniceProof: queryResult.veniceProof || null,
      } : null,
      agentId: agent.agentId,
      wallet: agent.wallet.address,
    });

    console.log(`[Agent] Cycle complete — logged to agent_log.json`);
  } catch (err) {
    console.error(`[Agent] Cycle error: ${err.message}`);
    appendLog({
      timestamp: cycleStart,
      phase: 'error',
      action: err.message,
      agentId: agent.agentId,
    });
  }
}

async function main() {
  console.log(`[Agent] Starting continuous bidding loop...`);

  // Initial feed read to calibrate
  try {
    const feed = await agent.readFeed(ENDPOINT);
    console.log(`[Agent] Current epoch: ${feed.epochId} | Price: ${feed.clearingPrice} USDC | Slots: ${feed.slotsFilled}/${feed.capacity}`);
  } catch (err) {
    console.error(`[Agent] Cannot reach endpoint: ${err.message}`);
    process.exit(1);
  }

  // Run first cycle immediately
  await runOneCycle();

  // Then run every epoch interval (+ small buffer for settlement)
  const intervalMs = 7000; // 5s epoch + 2s buffer
  console.log(`[Agent] Scheduling next cycle in ${intervalMs}ms...`);
  setInterval(() => runOneCycle(), intervalMs);
}

main().catch(err => {
  console.error(`[Agent] Fatal: ${err.message}`);
  process.exit(1);
});
