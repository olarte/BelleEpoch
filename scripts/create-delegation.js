#!/usr/bin/env node
// scripts/create-delegation.js — Create an ERC-7715 delegation for Belle Epoch
//
// Constructs, signs, and broadcasts an ERC-7715 delegation to Base mainnet.
// The signed delegation is published as calldata in a self-transaction,
// making it permanently verifiable on BaseScan.
//
// Usage:
//   OPERATOR_PRIVATE_KEY=0x... node scripts/create-delegation.js
//   OPERATOR_PRIVATE_KEY=0x... ENGINE_WALLET=0x... node scripts/create-delegation.js

require('dotenv').config({ path: require('path').resolve(__dirname, '..', '.env') });

const { ethers } = require('ethers');

const OPERATOR_PRIVATE_KEY = process.env.OPERATOR_PRIVATE_KEY || process.env.ENGINE_PRIVATE_KEY;
const ENGINE_WALLET = process.env.ENGINE_WALLET || process.env.DELEGATE_WALLET;
const BASE_RPC_URL = process.env.BASE_RPC_URL || 'https://mainnet.base.org';

if (!OPERATOR_PRIVATE_KEY) {
  console.error('ERROR: OPERATOR_PRIVATE_KEY (or ENGINE_PRIVATE_KEY) env var is required');
  process.exit(1);
}

const provider = new ethers.JsonRpcProvider(BASE_RPC_URL);
const operatorWallet = new ethers.Wallet(OPERATOR_PRIVATE_KEY, provider);
const delegateAddress = ENGINE_WALLET || operatorWallet.address;

// ERC-7715 delegation parameters
const delegation = {
  delegator: operatorWallet.address,
  delegate: delegateAddress,
  chainId: 8453, // Base mainnet
  caveats: {
    maxBidPerEpoch: 15000,         // 0.015 USDC (6-decimal units)
    allowedResources: ['private-reasoning'],
    dailySpendCap: 2000000,        // 2 USDC (6-decimal units)
    validUntil: Math.floor(Date.now() / 1000) + 30 * 86400, // 30 days
  },
};

// EIP-712 typed data for the delegation
const domain = {
  name: 'BelleEpoch',
  version: '1',
  chainId: 8453,
  verifyingContract: '0x0000000000000000000000000000000000007715', // ERC-7715 conceptual address
};

const types = {
  Delegation: [
    { name: 'delegator', type: 'address' },
    { name: 'delegate', type: 'address' },
    { name: 'chainId', type: 'uint256' },
    { name: 'maxBidPerEpoch', type: 'uint256' },
    { name: 'dailySpendCap', type: 'uint256' },
    { name: 'validUntil', type: 'uint256' },
    { name: 'allowedResources', type: 'string' },
  ],
};

const value = {
  delegator: delegation.delegator,
  delegate: delegation.delegate,
  chainId: delegation.chainId,
  maxBidPerEpoch: delegation.caveats.maxBidPerEpoch,
  dailySpendCap: delegation.caveats.dailySpendCap,
  validUntil: delegation.caveats.validUntil,
  allowedResources: delegation.caveats.allowedResources.join(','),
};

async function main() {
  console.log('ERC-7715 Delegation Creator — Belle Epoch');
  console.log('==========================================');
  console.log('');
  console.log(`Delegator (operator): ${delegation.delegator}`);
  console.log(`Delegate (engine):    ${delegation.delegate}`);
  console.log(`Chain:                Base (${delegation.chainId})`);
  console.log(`RPC:                  ${BASE_RPC_URL}`);
  console.log('');
  console.log('Caveats:');
  console.log(`  maxBidPerEpoch:     ${delegation.caveats.maxBidPerEpoch} (${delegation.caveats.maxBidPerEpoch / 1e6} USDC)`);
  console.log(`  dailySpendCap:      ${delegation.caveats.dailySpendCap} (${delegation.caveats.dailySpendCap / 1e6} USDC)`);
  console.log(`  allowedResources:   [${delegation.caveats.allowedResources.join(', ')}]`);
  console.log(`  validUntil:         ${new Date(delegation.caveats.validUntil * 1000).toISOString()}`);
  console.log('');

  // Check operator ETH balance for gas
  const balance = await provider.getBalance(operatorWallet.address);
  console.log(`Operator ETH balance: ${ethers.formatEther(balance)} ETH`);
  if (balance === 0n) {
    console.error('ERROR: Operator wallet has no ETH for gas');
    process.exit(1);
  }

  // Sign the delegation with EIP-712
  const signature = await operatorWallet.signTypedData(domain, types, value);
  console.log(`EIP-712 Signature: ${signature}`);

  // Compute delegation hash
  const encoded = ethers.AbiCoder.defaultAbiCoder().encode(
    ['address', 'address', 'uint256', 'uint256', 'uint256', 'string[]'],
    [
      delegation.delegator,
      delegation.delegate,
      delegation.chainId,
      delegation.caveats.maxBidPerEpoch,
      delegation.caveats.dailySpendCap,
      delegation.caveats.allowedResources,
    ]
  );
  const delegationHash = ethers.keccak256(encoded);
  console.log(`Delegation hash: ${delegationHash}`);
  console.log('');

  // Build calldata: the full signed delegation as ABI-encoded bytes
  // This makes the delegation permanently verifiable on-chain via BaseScan
  const calldata = ethers.AbiCoder.defaultAbiCoder().encode(
    ['bytes32', 'address', 'address', 'uint256', 'uint256', 'uint256', 'uint256', 'string[]', 'bytes'],
    [
      delegationHash,
      delegation.delegator,
      delegation.delegate,
      delegation.chainId,
      delegation.caveats.maxBidPerEpoch,
      delegation.caveats.dailySpendCap,
      delegation.caveats.validUntil,
      delegation.caveats.allowedResources,
      signature,
    ]
  );

  console.log('Broadcasting delegation to Base mainnet...');
  console.log(`  Calldata size: ${calldata.length / 2 - 1} bytes`);

  // Send self-transaction with delegation calldata
  const tx = await operatorWallet.sendTransaction({
    to: operatorWallet.address, // self-transaction
    value: 0,
    data: calldata,
  });

  console.log(`  Tx hash: ${tx.hash}`);
  console.log('  Waiting for confirmation...');

  const receipt = await tx.wait();
  console.log('');
  console.log('=== DELEGATION PUBLISHED ON-CHAIN ===');
  console.log(`  Transaction hash: ${receipt.hash}`);
  console.log(`  Block number:     ${receipt.blockNumber}`);
  console.log(`  Gas used:         ${receipt.gasUsed.toString()}`);
  console.log(`  BaseScan:         https://basescan.org/tx/${receipt.hash}`);
  console.log('');

  // Verify the signature
  const recovered = ethers.verifyTypedData(domain, types, value, signature);
  console.log(`Verified signer: ${recovered}`);
  console.log(`Matches delegator: ${recovered.toLowerCase() === delegation.delegator.toLowerCase()}`);

  // Output for updating agent.json and .env
  console.log('');
  console.log('=== UPDATE agent.json ===');
  console.log(JSON.stringify({
    identity: {
      metamaskDelegation: 'ERC-7715',
      delegationHash: delegationHash,
      delegationTxHash: receipt.hash,
      delegationBlock: receipt.blockNumber,
    },
  }, null, 2));

  console.log('');
  console.log('=== UPDATE .env ===');
  console.log(`  DELEGATION_HASH=${delegationHash}`);
  console.log(`  DELEGATION_TX_HASH=${receipt.hash}`);
  console.log(`  OPERATOR_WALLET=${delegation.delegator}`);
  console.log(`  ENGINE_WALLET=${delegation.delegate}`);
}

main().catch(err => {
  console.error(`Error: ${err.message}`);
  process.exit(1);
});
