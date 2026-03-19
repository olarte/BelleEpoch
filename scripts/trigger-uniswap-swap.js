#!/usr/bin/env node
// scripts/trigger-uniswap-swap.js — Force a real Uniswap swap on Base mainnet
// Swaps protocol-accumulated USDC → WETH via Uniswap V3 SwapRouter on Base
// Uses Permit2 for token approval (required by Base deployment)

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { ethers } = require('ethers');
const fs = require('fs');
const path = require('path');

// ── Config ──────────────────────────────────────────────────────────────────
const BASE_RPC_URL = process.env.BASE_RPC_URL || 'https://mainnet.base.org';
const ENGINE_PRIVATE_KEY = process.env.ENGINE_PRIVATE_KEY;
const PROTOCOL_WALLET = process.env.PROTOCOL_WALLET;

// Base mainnet addresses
const USDC_ADDRESS = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const WETH_ADDRESS = '0x4200000000000000000000000000000000000006';
const SWAP_ROUTER_02 = '0x2626664c2603336E57B271c5C0b26F421741e481';
const PERMIT2 = '0x000000000022D473030F116dDEE9F6B43aC78BA3';

// Swap amount: 0.03 USDC
const SWAP_AMOUNT_USDC = 0.03;
const SWAP_AMOUNT_RAW = BigInt(Math.round(SWAP_AMOUNT_USDC * 1e6));

// ABIs
const ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
];

const PERMIT2_ABI = [
  'function allowance(address owner, address token, address spender) view returns (uint160 amount, uint48 expiration, uint48 nonce)',
  'function approve(address token, address spender, uint160 amount, uint48 expiration)',
];

const SWAP_ROUTER_ABI = [
  'function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96)) external payable returns (uint256 amountOut)',
];

async function main() {
  if (!ENGINE_PRIVATE_KEY) throw new Error('ENGINE_PRIVATE_KEY not set');

  const provider = new ethers.JsonRpcProvider(BASE_RPC_URL);
  const wallet = new ethers.Wallet(ENGINE_PRIVATE_KEY, provider);
  const walletAddress = wallet.address;

  console.log(`Engine wallet: ${walletAddress}`);

  // Check balances
  const usdc = new ethers.Contract(USDC_ADDRESS, ERC20_ABI, wallet);
  const balance = await usdc.balanceOf(walletAddress);
  const balanceUsdc = Number(balance) / 1e6;
  const ethBalance = await provider.getBalance(walletAddress);
  console.log(`USDC balance: ${balanceUsdc}`);
  console.log(`ETH balance:  ${ethers.formatEther(ethBalance)}`);

  if (balance < SWAP_AMOUNT_RAW) {
    console.error(`Insufficient USDC. Have ${balanceUsdc}, need ${SWAP_AMOUNT_USDC}`);
    process.exit(1);
  }

  // Step 1: Approve Permit2 to spend USDC (standard ERC20 approve)
  const permit2Allowance = await usdc.allowance(walletAddress, PERMIT2);
  if (permit2Allowance < SWAP_AMOUNT_RAW) {
    console.log('Approving USDC for Permit2...');
    const approveTx = await usdc.approve(PERMIT2, ethers.MaxUint256);
    console.log(`Approve tx: ${approveTx.hash}`);
    await approveTx.wait();
    console.log('Permit2 approval confirmed.');
  } else {
    console.log('USDC already approved for Permit2.');
  }

  // Step 2: Grant Permit2 allowance to SwapRouter02
  const permit2 = new ethers.Contract(PERMIT2, PERMIT2_ABI, wallet);
  const [currentAmount, expiration] = await permit2.allowance(walletAddress, USDC_ADDRESS, SWAP_ROUTER_02);

  const now = Math.floor(Date.now() / 1000);
  if (currentAmount < SWAP_AMOUNT_RAW || expiration <= now) {
    console.log('Granting Permit2 allowance to SwapRouter02...');
    const maxUint160 = (1n << 160n) - 1n;
    const futureExpiration = now + 86400 * 30; // 30 days
    const permit2Tx = await permit2.approve(USDC_ADDRESS, SWAP_ROUTER_02, maxUint160, futureExpiration);
    console.log(`Permit2 allowance tx: ${permit2Tx.hash}`);
    await permit2Tx.wait();
    console.log('Permit2 allowance confirmed.');
  } else {
    console.log('Permit2 allowance already granted to SwapRouter02.');
  }

  // Step 3: Execute swap — USDC → WETH via Uniswap V3
  const feeTiers = [500, 3000, 10000];
  const router = new ethers.Contract(SWAP_ROUTER_02, SWAP_ROUTER_ABI, wallet);
  let swapResult = null;

  for (const fee of feeTiers) {
    console.log(`\nAttempting swap with fee tier ${fee} (${fee / 10000}%)...`);
    try {
      const params = {
        tokenIn: USDC_ADDRESS,
        tokenOut: WETH_ADDRESS,
        fee,
        recipient: walletAddress,
        amountIn: SWAP_AMOUNT_RAW,
        amountOutMinimum: 0n,
        sqrtPriceLimitX96: 0n,
      };

      const gasEstimate = await router.exactInputSingle.estimateGas(params);
      console.log(`Gas estimate: ${gasEstimate.toString()}`);

      const tx = await router.exactInputSingle(params, {
        gasLimit: gasEstimate * 130n / 100n,
      });

      console.log(`Swap tx submitted: ${tx.hash}`);
      const receipt = await tx.wait();
      console.log(`Swap confirmed in block ${receipt.blockNumber}`);

      let amountOut = '(check BaseScan)';
      for (const log of receipt.logs) {
        if (log.address.toLowerCase() === WETH_ADDRESS.toLowerCase() && log.topics.length >= 3) {
          try {
            amountOut = ethers.formatEther(BigInt(log.data));
          } catch {}
        }
      }

      swapResult = {
        txHash: tx.hash,
        blockNumber: receipt.blockNumber,
        amountIn: SWAP_AMOUNT_USDC,
        amountOut,
        feeTier: fee,
        gasUsed: receipt.gasUsed.toString(),
      };
      break;
    } catch (err) {
      console.log(`Fee tier ${fee} failed: ${err.message?.slice(0, 200)}`);
    }
  }

  if (!swapResult) {
    console.error('\nAll fee tiers failed.');
    process.exit(1);
  }

  // Save evidence
  const evidence = {
    txHash: swapResult.txHash,
    date: new Date().toISOString(),
    amountUsdc: swapResult.amountIn,
    amountOutWeth: swapResult.amountOut,
    feeTier: swapResult.feeTier,
    blockNumber: swapResult.blockNumber,
    gasUsed: swapResult.gasUsed,
    chain: 'Base Mainnet (8453)',
    router: SWAP_ROUTER_02,
    wallet: walletAddress,
    basescanUrl: `https://basescan.org/tx/${swapResult.txHash}`,
  };

  const evidencePath = path.join(__dirname, 'evidence', 'uniswap-swap.json');
  fs.writeFileSync(evidencePath, JSON.stringify(evidence, null, 2) + '\n');

  console.log('\n═══════════════════════════════════════════════');
  console.log('  UNISWAP SWAP COMPLETE');
  console.log('═══════════════════════════════════════════════');
  console.log(`  TxHash:     ${swapResult.txHash}`);
  console.log(`  Amount In:  ${swapResult.amountIn} USDC`);
  console.log(`  Amount Out: ${swapResult.amountOut} WETH`);
  console.log(`  Fee Tier:   ${swapResult.feeTier / 10000}%`);
  console.log(`  Block:      ${swapResult.blockNumber}`);
  console.log(`  BaseScan:   https://basescan.org/tx/${swapResult.txHash}`);
  console.log(`  Evidence:   ${evidencePath}`);
  console.log('═══════════════════════════════════════════════');

  process.exit(0);
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
