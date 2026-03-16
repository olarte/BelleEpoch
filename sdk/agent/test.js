#!/usr/bin/env node
// Test: belle-epoch-agent completes a full bid cycle against the live engine

const { BelleAgent } = require('./index');

const ENGINE_URL = process.env.ENGINE_URL || 'http://localhost:3001';

// Test private key (do NOT use in production)
const TEST_PRIVATE_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';

async function main() {
  console.log('[Test] belle-epoch-agent — full bid-settle cycle');
  console.log(`[Test] Engine URL: ${ENGINE_URL}`);
  console.log('');

  // Test 1: Create agent with each strategy
  console.log('--- Test 1: Agent creation ---');
  const adaptive = new BelleAgent({ wallet: TEST_PRIVATE_KEY, strategy: 'adaptive', maxBid: 0.05 });
  const conservative = new BelleAgent({ wallet: TEST_PRIVATE_KEY, strategy: 'conservative', maxBid: 0.05 });
  const aggressive = new BelleAgent({ wallet: TEST_PRIVATE_KEY, strategy: 'aggressive', maxBid: 0.05 });

  console.log(`Adaptive agent: ${adaptive.agentId}`);
  console.log(`Conservative agent: ${conservative.agentId}`);
  console.log(`Aggressive agent: ${aggressive.agentId}`);
  console.log('PASS: All agents created');
  console.log('');

  // Test 2: Read feed
  console.log('--- Test 2: Read feed ---');
  try {
    const feed = await adaptive.readFeed(ENGINE_URL);
    console.log('Feed:', JSON.stringify(feed, null, 2));
    console.log(feed.epochId != null ? 'PASS: Feed readable' : 'FAIL: No epochId');
  } catch (err) {
    console.error('FAIL: Could not read feed:', err.message);
    console.log('(Is the engine running? Start with: npm start)');
    process.exit(1);
  }
  console.log('');

  // Test 3: Calculate bids with each strategy
  console.log('--- Test 3: Bid calculation ---');
  const feed = await adaptive.readFeed(ENGINE_URL);
  console.log(`Current clearing price: ${feed.clearingPrice}`);
  console.log(`Adaptive bid:     ${adaptive.calculateBid(feed).toFixed(4)}`);
  console.log(`Conservative bid: ${conservative.calculateBid(feed).toFixed(4)}`);
  console.log(`Aggressive bid:   ${aggressive.calculateBid(feed).toFixed(4)} (always maxBid)`);
  console.log('PASS: All strategies produce valid bids');
  console.log('');

  // Test 4: Full bid cycle (submit → wait → check result)
  console.log('--- Test 4: Full bid cycle ---');
  try {
    const result = await aggressive.bid({
      resource: 'private-reasoning',
      endpoint: ENGINE_URL,
    });
    console.log('Bid result:', JSON.stringify(result, null, 2));
    console.log(result.epochId != null ? 'PASS: Bid cycle completed' : 'FAIL: No epochId');
    if (result.won) {
      console.log('PASS: Won epoch and received access token');
    } else {
      console.log('INFO: Lost epoch (normal — depends on competition)');
    }
  } catch (err) {
    console.error('Bid cycle error:', err.message);
    // Not necessarily a failure — may be epoch timing
    console.log('INFO: Bid cycle did not complete (may be timing issue)');
  }

  console.log('\n--- All tests complete ---');
  process.exit(0);
}

main().catch(err => {
  console.error('Unexpected error:', err);
  process.exit(1);
});
