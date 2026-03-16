require('dotenv').config();
require('@nomicfoundation/hardhat-ethers');

module.exports = {
  solidity: '0.8.20',
  paths: {
    sources: './contracts',
    artifacts: './artifacts',
  },
  networks: {
    base: {
      url: process.env.BASE_RPC_URL || 'https://mainnet.base.org',
      accounts: process.env.ENGINE_PRIVATE_KEY ? [process.env.ENGINE_PRIVATE_KEY] : [],
      chainId: 8453,
    },
    celo: {
      url: process.env.CELO_RPC_URL || 'https://forno.celo.org',
      accounts: process.env.ENGINE_PRIVATE_KEY ? [process.env.ENGINE_PRIVATE_KEY] : [],
      chainId: 42220,
    },
  },
};
