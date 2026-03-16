// identity/erc8004.js — ERC-8004 identity verification + signature validation

const { ethers } = require('ethers');

const REGISTRY_ABI = [
  'function isValidIdentity(address identity) external view returns (bool)',
  'function operatorOf(address identity) external view returns (address)',
  'function identityOf(address operator) external view returns (address)',
  'function identities(address identity) external view returns (address operator, string name, string serviceUri, uint256 registeredAt, bool active)',
];

let registryContract = null;
let provider = null;

function init() {
  const rpcUrl = process.env.BASE_RPC_URL;
  const registryAddr = process.env.ERC8004_REGISTRY_ADDRESS;

  if (!rpcUrl || !registryAddr) {
    console.log('[ERC-8004] Missing BASE_RPC_URL or ERC8004_REGISTRY_ADDRESS — verification disabled');
    return false;
  }

  provider = new ethers.JsonRpcProvider(rpcUrl);
  registryContract = new ethers.Contract(registryAddr, REGISTRY_ABI, provider);
  console.log(`[ERC-8004] Registry active: ${registryAddr}`);
  return true;
}

/// Verify a signed bid:
///   1. Recover the signer from the message + signature
///   2. Check that the signer has a valid ERC-8004 identity
///   3. Return { valid, signer, identityAddress } or { valid: false, error }
async function verifyBidSignature(bidBody, signature) {
  // Simulated signatures for test agents
  if (signature && signature.startsWith('sim-')) {
    return { valid: true, signer: null, identityAddress: null, simulated: true };
  }

  if (!signature || typeof signature !== 'string') {
    return { valid: false, error: 'Missing signature' };
  }

  // Reconstruct the canonical bid message that was signed
  const message = canonicalBidMessage(bidBody);

  let signer;
  try {
    signer = ethers.verifyMessage(message, signature);
  } catch (err) {
    return { valid: false, error: `Invalid signature: ${err.message}` };
  }

  // If registry is not configured, accept valid signatures without on-chain check
  if (!registryContract) {
    return { valid: true, signer, identityAddress: null, registrySkipped: true };
  }

  // Check on-chain: does this signer have a registered ERC-8004 identity?
  try {
    const identityAddress = await registryContract.identityOf(signer);
    if (identityAddress === ethers.ZeroAddress) {
      return { valid: false, error: `Signer ${signer} has no ERC-8004 identity registered` };
    }

    const isActive = await registryContract.isValidIdentity(identityAddress);
    if (!isActive) {
      return { valid: false, error: `ERC-8004 identity ${identityAddress} is deactivated` };
    }

    return { valid: true, signer, identityAddress };
  } catch (err) {
    return { valid: false, error: `Registry check failed: ${err.message}` };
  }
}

/// Canonical bid message format — deterministic string that agents sign
function canonicalBidMessage(bid) {
  return `belle-epoch:bid:${bid.epochId}:${bid.agentId}:${bid.maxBid}:${bid.resource}`;
}

/// Look up identity by wallet OR identity address
async function resolveIdentity(addressOrId) {
  if (!registryContract) return null;

  try {
    // First try: is it an identity address?
    const identity = await registryContract.identities(addressOrId);
    if (identity.active) {
      return {
        identityAddress: addressOrId,
        operator: identity.operator,
        name: identity.name,
        serviceUri: identity.serviceUri,
        registeredAt: Number(identity.registeredAt),
        active: true,
      };
    }

    // Second try: is it an operator wallet?
    const identityAddr = await registryContract.identityOf(addressOrId);
    if (identityAddr !== ethers.ZeroAddress) {
      const id = await registryContract.identities(identityAddr);
      return {
        identityAddress: identityAddr,
        operator: id.operator,
        name: id.name,
        serviceUri: id.serviceUri,
        registeredAt: Number(id.registeredAt),
        active: id.active,
      };
    }
  } catch (err) {
    // Not found
  }

  return null;
}

/// Get the identity address for a signer wallet (for on-chain recording)
async function getIdentityAddress(signerWallet) {
  if (!registryContract) return ethers.ZeroAddress;

  try {
    const addr = await registryContract.identityOf(signerWallet);
    return addr !== ethers.ZeroAddress ? addr : ethers.ZeroAddress;
  } catch {
    return ethers.ZeroAddress;
  }
}

module.exports = {
  init,
  verifyBidSignature,
  canonicalBidMessage,
  resolveIdentity,
  getIdentityAddress,
  REGISTRY_ABI,
};
