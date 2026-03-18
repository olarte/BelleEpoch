#!/usr/bin/env node
// scripts/create-delegation.js — Create an ERC-7715 delegation for Belle Epoch
//
// Constructs and signs an ERC-7715 intent-based delegation object.
// The operator (Daniel) delegates autonomous spending authority to the engine wallet (Belle).
//
// Usage:
//   OPERATOR_PRIVATE_KEY=0x... node scripts/create-delegation.js
//   OPERATOR_PRIVATE_KEY=0x... ENGINE_WALLET=0x... node scripts/create-delegation.js

require('dotenv').config({ path: require('path').resolve(__dirname, '..', '.env') });

const { ethers } = require('ethers');

const OPERATOR_PRIVATE_KEY = process.env.OPERATOR_PRIVATE_KEY || process.env.ENGINE_PRIVATE_KEY;
const ENGINE_WALLET = process.env.ENGINE_WALLET || process.env.DELEGATE_WALLET;

if (!OPERATOR_PRIVATE_KEY) {
  console.error('ERROR: OPERATOR_PRIVATE_KEY (or ENGINE_PRIVATE_KEY) env var is required');
  process.exit(1);
}

const operatorWallet = new ethers.Wallet(OPERATOR_PRIVATE_KEY);
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
  console.log('');
  console.log('Caveats:');
  console.log(`  maxBidPerEpoch:     ${delegation.caveats.maxBidPerEpoch} (${delegation.caveats.maxBidPerEpoch / 1e6} USDC)`);
  console.log(`  dailySpendCap:      ${delegation.caveats.dailySpendCap} (${delegation.caveats.dailySpendCap / 1e6} USDC)`);
  console.log(`  allowedResources:   [${delegation.caveats.allowedResources.join(', ')}]`);
  console.log(`  validUntil:         ${new Date(delegation.caveats.validUntil * 1000).toISOString()}`);
  console.log('');

  // Sign the delegation with EIP-712
  const signature = await operatorWallet.signTypedData(domain, types, value);
  console.log(`Signature: ${signature}`);

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

  // Output the full signed delegation object
  const signedDelegation = {
    ...delegation,
    signature,
    delegationHash,
    signedAt: new Date().toISOString(),
    eip712: { domain, types, value },
  };

  console.log('Signed delegation (JSON):');
  console.log(JSON.stringify(signedDelegation, null, 2));

  // Verify the signature
  const recovered = ethers.verifyTypedData(domain, types, value, signature);
  console.log('');
  console.log(`Verified signer: ${recovered}`);
  console.log(`Matches delegator: ${recovered.toLowerCase() === delegation.delegator.toLowerCase()}`);

  // Suggest env var to set
  console.log('');
  console.log('To activate this delegation, set in .env:');
  console.log(`  DELEGATION_HASH=${delegationHash}`);
  console.log(`  OPERATOR_WALLET=${delegation.delegator}`);
  console.log(`  ENGINE_WALLET=${delegation.delegate}`);
}

main().catch(err => {
  console.error(`Error: ${err.message}`);
  process.exit(1);
});
