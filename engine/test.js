// engine/test.js — Clearing engine tests (async, Redis-backed)

const { addBid, getBids, clearEpoch, redis } = require('./bids');
const { clear } = require('./index');

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
  // --- Test: Epoch 042 — exact clearing price and winner/loser assignment ---
  console.log('\n=== Epoch 042 — Uniform-price clearing ===\n');

  const EPOCH = 42;
  await clearEpoch(EPOCH);

  const bids = [
    { agentId: 'ATLAS-7', maxBid: 0.0081, epochId: EPOCH },
    { agentId: 'BELLE',   maxBid: 0.0073, epochId: EPOCH },
    { agentId: 'NEXUS-3', maxBid: 0.0058, epochId: EPOCH },
    { agentId: 'FORGE-1', maxBid: 0.0041, epochId: EPOCH },
    { agentId: 'SIGMA-9', maxBid: 0.0034, epochId: EPOCH },
    { agentId: 'ECHO-4',  maxBid: 0.0022, epochId: EPOCH },
    { agentId: 'PRISM-2', maxBid: 0.0011, epochId: EPOCH },
  ];

  for (const bid of bids) {
    await addBid(bid);
  }

  const result = await clear(EPOCH, 3);

  // Clearing price = 3rd highest bid = NEXUS-3's 0.0058
  assert(result.clearingPrice === 0.0058, `Clearing price is 0.0058 (got ${result.clearingPrice})`);

  // Winners
  const winnerIds = result.winners.map(w => w.agentId);
  assert(winnerIds.includes('ATLAS-7'), 'ATLAS-7 is a winner');
  assert(winnerIds.includes('BELLE'),   'BELLE is a winner');
  assert(winnerIds.includes('NEXUS-3'), 'NEXUS-3 is a winner');
  assert(winnerIds.length === 3,        `Exactly 3 winners (got ${winnerIds.length})`);

  // All winners pay uniform clearing price
  for (const winner of result.winners) {
    assert(winner.pays === 0.0058, `${winner.agentId} pays clearing price 0.0058 (got ${winner.pays})`);
  }

  // Losers
  const loserIds = result.losers.map(l => l.agentId);
  assert(loserIds.includes('FORGE-1'), 'FORGE-1 is a loser');
  assert(loserIds.includes('SIGMA-9'), 'SIGMA-9 is a loser');
  assert(loserIds.includes('ECHO-4'),  'ECHO-4 is a loser');
  assert(loserIds.includes('PRISM-2'), 'PRISM-2 is a loser');
  assert(loserIds.length === 4,        `Exactly 4 losers (got ${loserIds.length})`);

  // Losers pay nothing
  for (const loser of result.losers) {
    assert(loser.pays === 0, `${loser.agentId} pays 0 (got ${loser.pays})`);
  }

  // Slot counts
  assert(result.slotsFilled === 3, `slotsFilled is 3 (got ${result.slotsFilled})`);
  assert(result.totalBids === 7,   `totalBids is 7 (got ${result.totalBids})`);

  // --- Test: Empty epoch ---
  console.log('\n=== Empty epoch — no bids ===\n');

  const emptyResult = await clear(999, 3);
  assert(emptyResult.clearingPrice === 0, 'Empty epoch clearing price is 0');
  assert(emptyResult.slotsFilled === 0,   'Empty epoch has 0 slots filled');
  assert(emptyResult.winners.length === 0, 'Empty epoch has no winners');

  // --- Test: Fewer bids than capacity ---
  console.log('\n=== Partial fill — 2 bids, 3 slots ===\n');

  await clearEpoch(100);
  await addBid({ agentId: 'A', maxBid: 0.01, epochId: 100 });
  await addBid({ agentId: 'B', maxBid: 0.005, epochId: 100 });

  const partialResult = await clear(100, 3);
  assert(partialResult.slotsFilled === 2,       'Partial fill: 2 slots filled');
  assert(partialResult.clearingPrice === 0.005,  'Partial fill: clearing price is lowest winner');
  assert(partialResult.losers.length === 0,      'Partial fill: no losers');

  // Cleanup
  await clearEpoch(EPOCH);
  await clearEpoch(100);

  // --- Summary ---
  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);

  await redis.quit();
  process.exit(failed > 0 ? 1 : 0);
}

run().catch((err) => {
  console.error('Test error:', err);
  process.exit(1);
});
