# Belle Epoch — Bounty Evidence

All evidence below references real on-chain transactions and live production endpoints.

## x402 + AgentCash

- Real USDC payment tx: https://basescan.org/tx/0xe814a894d59c05b195c47b731c3a0352db223de601a849a856865ca0d334ef64
- Additional payment txs:
  - https://basescan.org/tx/0xfc12ac1488345fa97423c04f11e3438b40d2d54c7ed88903c9b206e87adf9ea4
  - https://basescan.org/tx/0x2042accc34adc9c09adfde59b74e614d4dcf46d9e9b3114665e8747797790672
  - https://basescan.org/tx/0xb14df7786f708fddcb3fa685966923e7526a8d70b91ded366ee5c6b4550d759a
  - https://basescan.org/tx/0x5d16f5bc7ef1316c20cdf0ade7e3e41a2149481e6450cc6940f891623aa15f2b
- Payment proof: see [real-epoch-run.json](./real-epoch-run.json)
- Agent wallet: `0xbdBEE40a847BC8F8AadE8Ab2685E028Dc32865a9`
- USDC balance change: 1.5 → 1.4653 across 5 paid epochs

## Protocol Labs (ERC-8004 + Autonomous Loop)

- ERC-8004 identity: https://basescan.org/address/0x1bBec5c9db63b33710C9E3BddD3591fD012BA2BC
- AgentIdentityRegistry: https://basescan.org/address/0xd1782e7d2758e09032Ed2E17D2aB0a66f3674f29
- agent.json: https://belleepoch.xyz/agent.json
- agent_log.json: https://belleepoch.xyz/agent_log.json (live — regenerated from Redis on every request)
- Autonomous run: 6+ days unattended since March 13 deploy, 79,000+ epochs served
- Loop phases documented: discover → plan → execute → verify
- DevSpot compatible: agent identifier, loop phases with timestamps, metrics, on-chain proofs

## Venice AI

- Real Venice query from epoch 79209: see [real-epoch-run.json](./real-epoch-run.json)
- `retained: false` confirmed on all query responses
- Venice query ID: `q-79209-beb946176b1cf34d`
- Bankr → Venice self-funding: clearing revenue routed through Bankr LLM Gateway to fund inference

## MetaMask (ERC-7715)

- Delegation tx: https://basescan.org/tx/0xb210128c62b77a01cf3f7bb72a186a40501ae1eb97faf7f403bb2bd197c0ad99
- Delegation hash: `0x4e5fa97d914c5e106ddb55030568e794832dbbdd44d00827a3669e190ecc6ecc`
- Delegation block: 43569475
- Intent-based delegation: operator sets spending boundary once, Belle executes autonomously within constraint

## Uniswap

- Real swap tx: https://basescan.org/tx/0xace4bac9612f060e96b3de9824f4fe66a4c12b26f5aa28fe692c75fae4995de2
- GET /feed/swap endpoint: https://api.belleepoch.xyz/feed/swap
- Amount: 0.03 USDC → 0.000014093660756471 WETH (0.5% fee tier)
- Router: `0x2626664c2603336E57B271c5C0b26F421741e481` (Uniswap SwapRouter02 on Base)
- Block: 43570215
- Evidence: see [uniswap-swap.json](./uniswap-swap.json)

## Bankr

- Self-sustaining loop: clearing revenue → Bankr wallet → Venice inference
- Bankr wallet: `0x243b0b3c87dca360ec62222c6237f3b4c58f103f`
- Balance at run time: 1.00448 USDC
- Total routed through Bankr: 8.3088 USDC
- Evidence: see [real-epoch-run.json](./real-epoch-run.json) (`bankrWallet`, `bankrBalanceUsdc`, `bankrTotalRouted`)
- Bankr wallet on BaseScan: https://basescan.org/address/0x243b0b3c87dca360ec62222c6237f3b4c58f103f

## Celo

- Contract: https://celo.blockscout.com/address/0x1852f4B60e64d7BBD7514260B46889236b8526b2
- EpochCleared tx: https://celo.blockscout.com/tx/0x6efd50af8344e1ee5ecce4eecf5ac3bbbe7fb5bc00529a095ad09a3647d3a3c7
- Additional txs:
  - https://celo.blockscout.com/tx/0x7197e39e6c0cfe9e6a9f50abb166a656698c60088d5bff19c5b7af229b81625e
  - https://celo.blockscout.com/tx/0x74c56a8539e48339d4de56ae5d8249005f0bc4de889af67991c099c2c920f727
- 50+ epochs recorded on Celo mainnet
- Same epoch (79209) cleared on both Base and Celo
- Evidence: see [celo-epoch.json](./celo-epoch.json)

## Self Protocol

- Verification endpoint: https://api.belleepoch.xyz/humans/verify
- Check status: https://api.belleepoch.xyz/humans/verified/:address
- Provider registration: https://api.belleepoch.xyz/humans/register
- For Humans page: https://belleepoch.xyz (Humans tab)
- SDK: `@selfxyz/core` (SelfBackendVerifier with mainnet config)
- Sybil protection: one passport = one registration via nullifier
- Evidence: see [self-verification.json](./self-verification.json)

## npm SDKs

- belle-epoch-provider: https://www.npmjs.com/package/belle-epoch-provider
- belle-epoch-agent: https://www.npmjs.com/package/belle-epoch-agent

## Key Addresses

| Entity | Address | Chain |
|---|---|---|
| Operator wallet | `0x168025fD748b63Cc6fB3bd59F197a6c79e6812c0` | Base |
| EpochClearingLedger | `0x254fdF5a9031d63A599ddef7b4d986d7C03B4760` | Base |
| EpochClearingLedger | `0x1852f4B60e64d7BBD7514260B46889236b8526b2` | Celo |
| Belle ERC-8004 | `0x1bBec5c9db63b33710C9E3BddD3591fD012BA2BC` | Base |
| AgentIdentityRegistry | `0xd1782e7d2758e09032Ed2E17D2aB0a66f3674f29` | Base |
| Test agent wallet | `0xbdBEE40a847BC8F8AadE8Ab2685E028Dc32865a9` | Base |
| Bankr wallet | `0x243b0b3c87dca360ec62222c6237f3b4c58f103f` | Base |
