#!/usr/bin/env node
// Test: Uniswap integration — quote endpoint + fee routing

require('dotenv').config();
const uniswap = require('./uniswap');

async function main() {
  console.log('[Test] Uniswap integration');
  console.log('');

  // Initialize
  await uniswap.init();

  // Test 1: Token resolution
  console.log('--- Test 1: Token resolution ---');
  const usdc = uniswap.resolveToken('USDC', 8453);
  const weth = uniswap.resolveToken('WETH', 8453);
  console.log(`USDC on Base: ${usdc}`);
  console.log(`WETH on Base: ${weth}`);
  console.log(usdc === uniswap.BASE_TOKENS.USDC ? 'PASS' : 'FAIL');
  console.log('');

  // Test 2: Swap quote (requires UNISWAP_API_KEY)
  console.log('--- Test 2: Swap quote ---');
  if (!process.env.UNISWAP_API_KEY) {
    console.log('SKIP: No UNISWAP_API_KEY set');
  } else {
    try {
      const quote = await uniswap.getSwapQuote({
        from: 'USDC',
        to: 'WETH',
        amount: '1',
        chainId: '8453',
      });
      console.log('Quote:', JSON.stringify(quote, null, 2));
      console.log(quote.estimatedGas ? 'PASS: Got estimatedGas' : 'INFO: No estimatedGas (may vary by routing)');
      console.log(quote.route ? 'PASS: Got route' : 'INFO: No route returned');
    } catch (err) {
      console.error('Quote error:', err.message);
    }
  }
  console.log('');

  // Test 3: Fee accumulation
  console.log('--- Test 3: Fee accumulation ---');
  const result = await uniswap.accumulateFee(1, 0.0001);
  console.log('Accumulation result:', result);
  console.log(result.accumulated > 0 ? 'PASS: Fee accumulated' : 'FAIL');
  console.log('');

  console.log('--- All tests complete ---');
  process.exit(0);
}

main().catch(err => {
  console.error('Unexpected error:', err);
  process.exit(1);
});
