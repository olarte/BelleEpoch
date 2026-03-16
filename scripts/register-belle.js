// scripts/register-belle.js — Deploy AgentIdentityRegistry + register Belle's ERC-8004 identity
//
// Usage: npx hardhat run scripts/register-belle.js --network base

require('dotenv').config();
const { ethers } = require('hardhat');
const fs = require('fs');
const path = require('path');

const ADDRESSES_PATH = path.join(__dirname, '..', 'contracts', 'addresses.json');

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log(`[ERC-8004] Deployer/operator: ${deployer.address}`);

  const balance = await ethers.provider.getBalance(deployer.address);
  console.log(`[ERC-8004] Balance: ${ethers.formatEther(balance)} ETH`);

  // Load existing addresses
  let addresses = {};
  if (fs.existsSync(ADDRESSES_PATH)) {
    addresses = JSON.parse(fs.readFileSync(ADDRESSES_PATH, 'utf8'));
  }

  // ─── Step 1: Deploy AgentIdentityRegistry ────────────────────────────────
  let registryAddress = addresses.base?.AgentIdentityRegistry;

  if (registryAddress) {
    console.log(`[ERC-8004] Registry already deployed: ${registryAddress}`);
  } else {
    console.log('[ERC-8004] Deploying AgentIdentityRegistry...');
    const Registry = await ethers.getContractFactory('AgentIdentityRegistry');
    const registry = await Registry.deploy();
    await registry.waitForDeployment();
    registryAddress = await registry.getAddress();
    console.log(`[ERC-8004] Registry deployed: ${registryAddress}`);

    // Save to addresses.json
    if (!addresses.base) addresses.base = {};
    addresses.base.AgentIdentityRegistry = registryAddress;
    fs.writeFileSync(ADDRESSES_PATH, JSON.stringify(addresses, null, 2));
  }

  // ─── Step 2: Register Belle ──────────────────────────────────────────────
  const registry = await ethers.getContractAt('AgentIdentityRegistry', registryAddress);

  // Check if already registered
  const existingIdentity = await registry.identityOf(deployer.address);
  if (existingIdentity !== ethers.ZeroAddress) {
    console.log(`[ERC-8004] Belle already registered: ${existingIdentity}`);
    addresses.base.BELLE_ERC8004 = existingIdentity;
    fs.writeFileSync(ADDRESSES_PATH, JSON.stringify(addresses, null, 2));
    console.log('[ERC-8004] Done.');
    return;
  }

  console.log('[ERC-8004] Registering Belle...');
  const tx = await registry.register(
    'Belle',
    'https://belleepoch.xyz/agent.json'
  );
  console.log(`[ERC-8004] Registration tx: ${tx.hash}`);
  const receipt = await tx.wait();
  console.log(`[ERC-8004] Confirmed in block ${receipt.blockNumber}`);

  // Extract identity address from event
  const event = receipt.logs.find(log => {
    try {
      const parsed = registry.interface.parseLog({ topics: log.topics, data: log.data });
      return parsed && parsed.name === 'AgentRegistered';
    } catch { return false; }
  });

  let belleIdentity;
  if (event) {
    const parsed = registry.interface.parseLog({ topics: event.topics, data: event.data });
    belleIdentity = parsed.args.identity || parsed.args[0];
    console.log(`[ERC-8004] Belle identity: ${belleIdentity}`);
  } else {
    // Fallback: read from contract
    belleIdentity = await registry.identityOf(deployer.address);
    console.log(`[ERC-8004] Belle identity (from contract): ${belleIdentity}`);
  }

  // Save to addresses.json
  addresses.base.BELLE_ERC8004 = belleIdentity;
  addresses.base.ERC8004_REGISTRY_ADDRESS = registryAddress;
  fs.writeFileSync(ADDRESSES_PATH, JSON.stringify(addresses, null, 2));

  console.log(`[ERC-8004] Saved to ${ADDRESSES_PATH}`);
  console.log('[ERC-8004] Done. Verify on BaseScan:');
  console.log(`  Registry: https://basescan.org/address/${registryAddress}`);
  console.log(`  Belle:    https://basescan.org/address/${belleIdentity}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
