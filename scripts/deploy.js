// scripts/deploy.js — Deploy EpochClearingLedger to Base and Celo
const hre = require('hardhat');
const fs = require('fs');
const path = require('path');

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  const network = hre.network.name;

  console.log(`Deploying EpochClearingLedger on ${network} with account: ${deployer.address}`);
  console.log(`Balance: ${hre.ethers.formatEther(await deployer.provider.getBalance(deployer.address))} ETH`);

  const Factory = await hre.ethers.getContractFactory('EpochClearingLedger');
  const contract = await Factory.deploy(deployer.address); // engine = deployer
  await contract.waitForDeployment();

  const address = await contract.getAddress();
  console.log(`EpochClearingLedger deployed to: ${address}`);

  // Save address
  const addressesPath = path.join(__dirname, '..', 'contracts', 'addresses.json');
  let addresses = {};
  if (fs.existsSync(addressesPath)) {
    addresses = JSON.parse(fs.readFileSync(addressesPath, 'utf8'));
  }
  addresses[network] = {
    EpochClearingLedger: address,
    deployer: deployer.address,
    deployedAt: new Date().toISOString(),
  };
  fs.writeFileSync(addressesPath, JSON.stringify(addresses, null, 2));
  console.log(`Address saved to contracts/addresses.json`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
