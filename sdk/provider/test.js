#!/usr/bin/env node
// Test: belle-epoch-provider gates an echo endpoint behind a CCA

const express = require('express');
const belleEpoch = require('./index');

const ENGINE_URL = process.env.ENGINE_URL || 'http://localhost:3001';

const app = express();
app.use(express.json());

// Gate the /echo endpoint behind a CCA
app.use('/echo', belleEpoch({
  capacity: 3,
  epochMs: 5000,
  resource: 'echo-test',
  wallet: '0x168025fD748b63Cc6fB3bd59F197a6c79e6812c0',
  chain: 'base',
  engineUrl: ENGINE_URL,
  tokenSecret: process.env.EPOCH_TOKEN_SECRET || 'belle-epoch-token-secret-change-in-production',
}));

// The actual handler — only runs when agent has valid epoch token
app.post('/echo', (req, res) => {
  res.json({
    echo: req.body,
    agent: req.epochClaims.agentId,
    epoch: req.epochClaims.epochId,
  });
});

const PORT = 3099;
const server = app.listen(PORT, async () => {
  console.log(`[Test] Echo server on port ${PORT}`);
  console.log(`[Test] Engine URL: ${ENGINE_URL}`);
  console.log('');

  // Test 1: Request without token → should get 402
  console.log('--- Test 1: No token → 402 ---');
  try {
    const res = await fetch(`http://localhost:${PORT}/echo`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'hello' }),
    });
    const data = await res.json();
    console.log(`Status: ${res.status}`);
    console.log('Response:', JSON.stringify(data, null, 2));
    console.log(res.status === 402 ? 'PASS: Got 402 as expected' : 'FAIL: Expected 402');
  } catch (err) {
    console.error('FAIL:', err.message);
  }

  console.log('');

  // Test 2: Request with valid JWT → should get echo response
  console.log('--- Test 2: Valid token → 200 ---');
  try {
    const jwt = require('jsonwebtoken');
    const secret = process.env.EPOCH_TOKEN_SECRET || 'belle-epoch-token-secret-change-in-production';
    const token = jwt.sign(
      { epochId: 1, agentId: 'test-agent', slot: 0, resource: 'echo-test' },
      secret,
      { expiresIn: 60, subject: 'test-agent', issuer: 'belle-epoch' }
    );

    const res = await fetch(`http://localhost:${PORT}/echo`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify({ message: 'hello from test agent' }),
    });
    const data = await res.json();
    console.log(`Status: ${res.status}`);
    console.log('Response:', JSON.stringify(data, null, 2));
    console.log(res.status === 200 ? 'PASS: Got 200 with echo' : 'FAIL: Expected 200');
  } catch (err) {
    console.error('FAIL:', err.message);
  }

  console.log('');

  // Test 3: Request with invalid token → should get 402
  console.log('--- Test 3: Invalid token → 402 ---');
  try {
    const res = await fetch(`http://localhost:${PORT}/echo`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer invalid-token-here',
      },
      body: JSON.stringify({ message: 'should fail' }),
    });
    const data = await res.json();
    console.log(`Status: ${res.status}`);
    console.log(res.status === 402 ? 'PASS: Got 402 for invalid token' : 'FAIL: Expected 402');
  } catch (err) {
    console.error('FAIL:', err.message);
  }

  console.log('\n--- All tests complete ---');
  server.close();
  process.exit(0);
});
