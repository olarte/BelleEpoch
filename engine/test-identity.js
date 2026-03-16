// engine/test-identity.js — ERC-8004 signature + Self Protocol integration tests

require('dotenv').config();

const { ethers } = require('ethers');
const erc8004 = require('../identity/erc8004');
const self = require('../identity/self');

let passed = 0;
let failed = 0;

function assert(name, condition) {
  if (condition) {
    console.log(`  PASS: ${name}`);
    passed++;
  } else {
    console.log(`  FAIL: ${name}`);
    failed++;
  }
}

async function run() {
  console.log('=== ERC-8004 Signature Verification ===\n');

  // Create a test wallet
  const wallet = ethers.Wallet.createRandom();
  console.log(`  Test wallet: ${wallet.address}\n`);

  // Test 1: Sign and verify a bid
  const bid = { epochId: 42, agentId: 'TEST-1', maxBid: 0.005, resource: 'private-reasoning' };
  const message = erc8004.canonicalBidMessage(bid);
  const signature = await wallet.signMessage(message);

  const result = await erc8004.verifyBidSignature(bid, signature);
  assert('Valid signature accepted', result.valid === true);
  assert('Correct signer recovered', result.signer === wallet.address);
  assert('Registry skipped (not configured)', result.registrySkipped === true);

  // Test 2: Invalid signature rejected
  const badResult = await erc8004.verifyBidSignature(bid, '0xdeadbeef');
  assert('Invalid signature rejected', badResult.valid === false);
  assert('Error message present', !!badResult.error);

  // Test 3: Missing signature rejected
  const noSig = await erc8004.verifyBidSignature(bid, null);
  assert('Null signature rejected', noSig.valid === false);

  const emptySig = await erc8004.verifyBidSignature(bid, '');
  assert('Empty signature rejected', emptySig.valid === false);

  // Test 4: Simulated signatures pass through
  const simResult = await erc8004.verifyBidSignature(bid, 'sim-TEST-1-42');
  assert('Simulated signature accepted', simResult.valid === true);
  assert('Simulated flag set', simResult.simulated === true);

  // Test 5: Wrong bid data doesn't match signature
  const wrongBid = { epochId: 99, agentId: 'TEST-1', maxBid: 0.005, resource: 'private-reasoning' };
  const wrongResult = await erc8004.verifyBidSignature(wrongBid, signature);
  assert('Wrong epochId: signer mismatch', wrongResult.signer !== wallet.address);

  console.log('\n=== Self Protocol (no credentials configured) ===\n');

  // Test 6: Self attestation rejected when not configured
  const attestResult = await self.verifyAttestation('some-proof', 'human-provider');
  assert('Attestation rejected without config', attestResult.valid === false);
  assert('Error mentions not configured', attestResult.error.includes('not configured'));

  // Test 7: Agent identity check skipped when not configured
  const agentCheck = await self.verifyAgentIdentity('TEST-1', wallet.address);
  assert('Agent check skipped without config', agentCheck.skipped === true);
  assert('Agent check returns valid (skipped)', agentCheck.valid === true);

  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
  process.exit(failed > 0 ? 1 : 0);
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
