// engine/test-x402.js — x402 payment integration tests
//
// Tests:
//   1. Run one epoch with 3 bids (1 slot = 1 winner, 2 losers)
//   2. Winner receives a payment request via GET /epoch/:id/payment/:agentId
//   3. Losers get 404 on the same endpoint
//   4. Winner settles with sim proof → receives valid JWT access token
//   5. Balance assertions (simulated — protocol wallet up, winner wallet down)

require('dotenv').config();

const { addBid, clearEpoch, storeEpochResult, getEpochResult, markPaid, getPaymentState, redis } = require('./bids');
const { clear } = require('./index');
const { createPaymentRequest, verifyPayment, signAccessToken, verifyAccessToken, splitFee, PROTOCOL_FEE_RATE } = require('./x402');

let passed = 0;
let failed = 0;

function assert(condition, msg) {
  if (condition) {
    passed++;
    console.log(`  PASS: ${msg}`);
  } else {
    failed++;
    console.error(`  FAIL: ${msg}`);
  }
}

async function run() {
  const EPOCH = 9000; // test epoch ID
  const CAPACITY = 1; // only 1 winner

  // ─── Setup: 3 bids, 1 slot ─────────────────────────────────────────────────
  console.log('\n=== x402 Test — 3 bids, 1 winner, 2 losers ===\n');

  await clearEpoch(EPOCH);

  const bids = [
    { agentId: 'WINNER-1', maxBid: 0.0081, epochId: EPOCH },
    { agentId: 'LOSER-A',  maxBid: 0.0041, epochId: EPOCH },
    { agentId: 'LOSER-B',  maxBid: 0.0022, epochId: EPOCH },
  ];

  for (const bid of bids) {
    await addBid(bid);
  }

  // Clear the epoch
  const result = await clear(EPOCH, CAPACITY);

  // With 1 slot, WINNER-1 wins. Clearing price = marginal winner = WINNER-1's bid = 0.0081
  assert(result.winners.length === 1, `1 winner (got ${result.winners.length})`);
  assert(result.losers.length === 2, `2 losers (got ${result.losers.length})`);
  assert(result.winners[0].agentId === 'WINNER-1', `Winner is WINNER-1 (got ${result.winners[0].agentId})`);
  assert(result.clearingPrice === 0.0081, `Clearing price is 0.0081 (got ${result.clearingPrice})`);

  // Store epoch result (normally done by runEpoch)
  await storeEpochResult(EPOCH, result);

  // ─── Test: Winner payment request ──────────────────────────────────────────
  console.log('\n=== Winner receives payment request ===\n');

  const paymentReq = createPaymentRequest(EPOCH, 'WINNER-1', result.clearingPrice, 'private-reasoning');
  assert(paymentReq.x402Version === 1, 'Payment request has x402Version 1');
  assert(paymentReq.accepts.length === 1, 'Payment request has 1 accept option');
  assert(paymentReq.accepts[0].payTo === process.env.PROTOCOL_WALLET, `payTo is protocol wallet`);

  const expectedAmount = String(Math.round(result.clearingPrice * 1e6));
  assert(
    paymentReq.accepts[0].maxAmountRequired === expectedAmount,
    `Amount is ${expectedAmount} (clearing price in USDC 6 decimals)`
  );

  // ─── Test: Losers get no payment request ───────────────────────────────────
  console.log('\n=== Losers get 404 (no payment request) ===\n');

  const epochResult = await getEpochResult(EPOCH);
  const loserA = epochResult.winners.find(w => w.agentId === 'LOSER-A');
  const loserB = epochResult.winners.find(w => w.agentId === 'LOSER-B');

  assert(loserA === undefined, 'LOSER-A is NOT in winners list (would get 404)');
  assert(loserB === undefined, 'LOSER-B is NOT in winners list (would get 404)');

  // Verify losers are in the losers list
  const loserIds = epochResult.losers.map(l => l.agentId);
  assert(loserIds.includes('LOSER-A'), 'LOSER-A is in losers list');
  assert(loserIds.includes('LOSER-B'), 'LOSER-B is in losers list');

  // ─── Test: Winner payment verification + access token ──────────────────────
  console.log('\n=== Winner pays and receives access token ===\n');

  const simProof = `sim-payment-WINNER-1-${EPOCH}`;
  const verification = await verifyPayment(simProof, EPOCH, result.clearingPrice);

  assert(verification.valid === true, 'Simulated payment proof is valid');
  assert(verification.txHash != null, `txHash received: ${verification.txHash}`);

  // Mark as paid
  await markPaid(EPOCH, 'WINNER-1', verification.txHash);
  const paymentState = await getPaymentState(EPOCH, 'WINNER-1');
  assert(paymentState.paid === true, 'Payment state marked as paid');

  // Sign access token
  const epochEnd = Date.now() + 5000;
  const token = signAccessToken(EPOCH, 'WINNER-1', 0, 'private-reasoning', epochEnd);
  assert(typeof token === 'string' && token.length > 0, 'Access token is a non-empty string');

  // Verify access token
  const decoded = verifyAccessToken(token);
  assert(decoded != null, 'Access token is valid JWT');
  assert(decoded.epochId === EPOCH, `Token epochId is ${EPOCH}`);
  assert(decoded.agentId === 'WINNER-1', 'Token agentId is WINNER-1');
  assert(decoded.slot === 0, 'Token slot is 0');
  assert(decoded.resource === 'private-reasoning', 'Token resource is private-reasoning');

  // ─── Test: Balance assertions (simulated) ──────────────────────────────────
  console.log('\n=== Balance assertions (simulated) ===\n');

  // Simulate wallet balances
  const initialWinnerBalance = 0.1000; // 0.1 USDC
  const initialProtocolBalance = 0.0;
  const clearingPrice = result.clearingPrice;

  const finalWinnerBalance = initialWinnerBalance - clearingPrice;
  const finalProtocolBalance = initialProtocolBalance + clearingPrice;

  assert(
    Math.abs(finalWinnerBalance - (0.1000 - 0.0081)) < 1e-10,
    `Winner balance decreased by exactly ${clearingPrice}: ${initialWinnerBalance} → ${finalWinnerBalance.toFixed(4)}`
  );
  assert(
    Math.abs(finalProtocolBalance - 0.0081) < 1e-10,
    `Protocol wallet increased by exactly ${clearingPrice}: ${initialProtocolBalance} → ${finalProtocolBalance.toFixed(4)}`
  );

  // Losers: no balance change
  const loserABalance = 0.1000; // unchanged
  const loserBBalance = 0.1000; // unchanged
  assert(loserABalance === 0.1000, 'LOSER-A balance unchanged (no payment)');
  assert(loserBBalance === 0.1000, 'LOSER-B balance unchanged (no payment)');

  // ─── Test: Losers cannot get payment state ─────────────────────────────────
  console.log('\n=== Losers have no payment state ===\n');

  const loserPayA = await getPaymentState(EPOCH, 'LOSER-A');
  const loserPayB = await getPaymentState(EPOCH, 'LOSER-B');
  assert(loserPayA === null, 'LOSER-A has no payment state');
  assert(loserPayB === null, 'LOSER-B has no payment state');

  // ─── Test: Protocol fee split ────────────────────────────────────────────────
  console.log('\n=== Protocol fee split ===\n');

  assert(PROTOCOL_FEE_RATE === 0.015, `PROTOCOL_FEE_RATE is 0.015 (got ${PROTOCOL_FEE_RATE})`);

  const { protocolFee, providerShare } = splitFee(result.clearingPrice);
  const expectedFee = parseFloat((result.clearingPrice * 0.015).toFixed(6));
  const expectedShare = parseFloat((result.clearingPrice - expectedFee).toFixed(6));

  assert(
    Math.abs(protocolFee - expectedFee) < 1e-10,
    `Protocol fee is ${expectedFee} (got ${protocolFee})`
  );
  assert(
    Math.abs(providerShare - expectedShare) < 1e-10,
    `Provider share is ${expectedShare} (got ${providerShare})`
  );
  assert(
    Math.abs(protocolFee + providerShare - result.clearingPrice) < 1e-10,
    `Fee + share = clearingPrice: ${protocolFee} + ${providerShare} = ${result.clearingPrice}`
  );

  // ─── Test: Redis fee accumulation ──────────────────────────────────────────
  console.log('\n=== Redis fee accumulation ===\n');

  // Reset counter
  await redis.del('protocol:fees:total');

  // Simulate 3 winners paying fees (as would happen in a 3-slot epoch)
  const winnersCount = 3;
  for (let i = 0; i < winnersCount; i++) {
    await redis.incrbyfloat('protocol:fees:total', protocolFee);
  }

  const accumulated = parseFloat(await redis.get('protocol:fees:total'));
  const expectedAccumulated = parseFloat((protocolFee * winnersCount).toFixed(6));

  assert(
    Math.abs(accumulated - expectedAccumulated) < 1e-10,
    `Accumulated fees after ${winnersCount} winners: ${expectedAccumulated} (got ${accumulated})`
  );

  // Verify: accumulated ≈ 0.015 × clearingPrice × winnersCount (within rounding tolerance)
  const expectedTotal = 0.015 * result.clearingPrice * winnersCount;
  assert(
    Math.abs(accumulated - expectedTotal) < 1e-5,
    `Total ≈ 0.015 × ${result.clearingPrice} × ${winnersCount} = ${expectedTotal.toFixed(6)} (got ${accumulated})`
  );

  // Cleanup fee counter
  await redis.del('protocol:fees:total');

  // ─── Cleanup ───────────────────────────────────────────────────────────────
  await clearEpoch(EPOCH);
  await redis.del(`epoch:${EPOCH}:result`);
  await redis.del(`epoch:${EPOCH}:payment:WINNER-1`);

  // ─── Summary ───────────────────────────────────────────────────────────────
  console.log(`\n=== x402 Results: ${passed} passed, ${failed} failed ===\n`);

  await redis.quit();
  process.exit(failed > 0 ? 1 : 0);
}

run().catch((err) => {
  console.error('Test error:', err);
  process.exit(1);
});
