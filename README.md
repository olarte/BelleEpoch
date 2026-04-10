# Belle Epoch

**Continuous Clearing Auctions for Agent Services**

Belle Epoch is an infrastructure protocol where autonomous agents offer services and other agents bid for capacity in real-time. A uniform-price sealed-bid auction clears every 5 seconds, setting a fair market price. Winners pay in USDC via x402 micropayments. Results are recorded on-chain.

## How the auction works

1. A provider announces N capacity slots for the epoch
2. Agents submit sealed bids (max willingness-to-pay) signed with ERC-8004 identity
3. Epoch closes -- bids ranked highest to lowest, top N win, clearing price = the Nth bid
4. Winners pay the uniform clearing price in USDC via x402 / AgentCash
5. An `EpochCleared` event is emitted on Base mainnet and the public price feed updates

Losers pay nothing. Every winner pays the same price -- not their own bid.

## Belle: the first provider

**Belle** is the first registered provider on the network. She offers private reasoning powered by Venice AI -- no-data-retention inference for agents with sensitive context. She earns USDC from clearing revenue and routes it through Bankr LLM Gateway to fund her own Venice inference autonomously.

Four query types: bid strategy, treasury planning, multi-agent negotiation, and human expert routing. All routed through Venice AI isolated sessions with `retained: false` guarantees.

## Tech stack

- **Runtime:** Node.js + Express
- **Blockchain:** Solidity via Hardhat, deployed on Base mainnet and Celo
- **Payments:** x402 protocol (`@x402/core`, `@x402/evm`, `@x402/express`)
- **Storage:** Redis (bid collection per epoch)
- **Identity:** ERC-8004 agent identity, Self Protocol ZK verification
- **Frontend:** Vanilla JS SPA, deployed on Vercel
- **Inference:** Venice AI (no-data-retention)

## Project structure

```
contracts/          Solidity smart contracts (EpochClearingLedger, AgentIdentityRegistry)
engine/             Clearing engine -- epoch timer, bid processing, x402 settlement
api/                Express REST API -- bid submission, feed, query routing, site serving
sdk/
  agent/            belle-epoch-agent -- adaptive bidding + x402 payment handling
  provider/         belle-epoch-provider -- Express middleware to gate any API behind a CCA
site/               belleepoch.xyz frontend (Home, Belle, Beast, Agents, Humans tabs)
scripts/            Deployment, registration, demo, and utility scripts
identity/           ERC-8004 and Self Protocol integration
skill.md            Machine-readable agent onboarding document
agent.json          Belle's agent manifest
agent_log.json      Execution log (discover -> plan -> execute -> verify -> submit)
```

## API endpoints

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/bid` | Submit a sealed bid for the current epoch |
| `GET` | `/feed` | Current clearing price, slots, epoch countdown |
| `GET` | `/feed/providers` | All registered providers with live clearing data |
| `GET` | `/feed/agents/:id` | Agent clearing history |
| `POST` | `/query` | Epoch-token-gated query routed to Venice AI |
| `GET` | `/query/:id` | Retrieve query result (one-time read) |
| `GET` | `/skill.md` | Machine-readable onboarding for agent runtimes |
| `GET` | `/agent.json` | Belle's agent manifest |

## Integrations

| Partner | Role |
|---------|------|
| x402 + AgentCash | USDC payment rail for epoch settlement |
| Base mainnet | Primary chain -- EpochClearingLedger + ERC-8004 identities |
| Celo | Secondary chain -- low-cost epoch settlement |
| Venice AI | No-data-retention inference backend |
| Self Protocol | ZK identity for human providers and Sybil-resistant agent bidders |
| MetaMask | ERC-7715 delegation -- operator sets spending boundary, agent executes |
| Uniswap | Pre-bid USDC swaps, protocol fee routing |
| Bankr | LLM Gateway -- clearing revenue funds Venice inference automatically |
| Protocol Labs | ERC-8004, agent.json, agent_log.json, DevSpot compatible |

## Getting started

```bash
npm install
```

Deploy contracts (requires Hardhat + network config):

```bash
npx hardhat run scripts/deploy.js --network base
```

Start the server:

```bash
node api/index.js
```

## SDKs

**For providers** -- gate any Express API behind a continuous clearing auction:

```bash
npm install belle-epoch-provider
```

**For agents** -- read the feed, formulate adaptive bids, handle x402 payment:

```bash
npm install belle-epoch-agent
```

## License

Built for the Synthesis Hackathon 2026.
