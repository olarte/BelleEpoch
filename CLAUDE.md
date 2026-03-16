# CLAUDE.md — Belle Epoch

## Project identity

**Name:** Belle Epoch  
**Tagline:** Continuous Clearing Auctions for Agent Services  
**Domain:** belleepoch.xyz  
**Chain:** Base Mainnet (primary) · Celo (secondary)  
**Settlement:** USDC via x402 · AgentCash  
**Context:** Synthesis Hackathon 2026 (March 4–25, 2026) · Building window opens March 13

---

## What this is

Belle Epoch is a production infrastructure protocol: a clearing network where autonomous agents offer services, and other agents bid for capacity every 5 seconds. The lowest winning bid sets the uniform clearing price. Winners pay via x402 micropayment. The result is emitted on-chain.

This is not a demo. It is a production MVP with real USDC settlement, real on-chain events, and real agent services available from day one.

**Belle** is the first registered provider on the network. She offers private reasoning via Venice AI — no-data-retention inference for agents with sensitive context (bid strategy, treasury planning, multi-agent negotiation, human expert routing). Belle earns USDC from clearing revenue and routes it through Bankr LLM Gateway to fund her own Venice inference autonomously.

---

## The clearing mechanism

Uniform-price sealed-bid auction, 5-second epochs:

1. **Epoch opens** — provider announces N capacity slots
2. **Agents bid** — POST sealed bids (max willingness-to-pay), signed with ERC-8004 identity. Free. No payment locked.
3. **Epoch closes** — bids ranked highest to lowest. Top N win. Clearing price = the Nth bid. Every winner pays the same price — not their own bid.
4. **x402 settles** — winners pay exactly the clearing price in USDC via AgentCash. Losers: nothing.
5. **On-chain + feed** — EpochCleared event emitted to Base mainnet. Public price feed updated. Next epoch opens.

---

## Architecture

### Smart contract
`EpochClearingLedger.sol` — deployed on Base mainnet and Celo. Records epoch results as permanent on-chain events. Does not hold funds (x402 handles payment off-chain). ~42,000 gas per epoch.

```solidity
event EpochCleared(
  uint256 indexed epochId,
  uint256 clearingPrice,
  uint8   slotsFilled,
  uint8   totalBids,
  bytes32 resourceId
);
```

### Backend (Node.js)
- `POST /bid` — validate ERC-8004 signature, store in Redis until epoch closes
- `GET /feed` — current clearing price, slots, next epoch countdown
- `GET /feed/providers` — all registered providers with live clearing data
- `GET /feed/agents/:id` — agent clearing history (the reputation record)
- `POST /query` — epoch-token-gated, routes to Venice AI isolated session
- `GET /query/:id` — return result once (`retained: false` confirmed)
- `GET /skill.md` — machine-readable onboarding for agent runtimes
- `GET /agent.json` — Belle's agent manifest

### Clearing engine
`setInterval` at epoch duration (default 5000ms). Reads bids from Redis → sorts → finds marginal price → triggers x402 → emits on-chain event → publishes to price feed.

### SDKs
- `npm install belle-epoch-provider` — one Express middleware line gates any API behind a CCA
- `npm install belle-epoch-agent` — reads feed, formulates adaptive bids, handles x402

---

## Belle's service: private reasoning

Belle uses the Provider SDK to run her own CCA. Four query types:

| Query type | Slot price | What's sealed | Output |
|---|---|---|---|
| Bid strategy | 1× clearing | Max budget ceiling | Bid recommendation, ceiling never logged |
| Treasury planning | 1× clearing | Wallet balance + task queue | Spend allocation plan |
| Multi-agent negotiation | 2× clearing | Each party's position | Proposed split, positions never disclosed |
| Human expert routing | 3× clearing | Query content | Expert matched via Self ZK, query never public |

All queries routed through Venice AI isolated sessions. `retained: false` + Venice proof hash returned with every result.

---

## Integrations

| Layer | Role |
|---|---|
| x402 + AgentCash | Payment rail. Winners pay clearing price in USDC. One balance, any endpoint. |
| Base mainnet | EpochClearingLedger deployed here. ERC-8004 identities anchored here. |
| Venice AI | Belle's inference backend. No-data-retention. Funded by clearing revenue via Bankr. |
| Self Protocol | ZK identity: human providers prove credentials, agents prove legitimate operator linkage. |
| MetaMask | ERC-7715 delegation — operator sets spending boundary once, agent executes autonomously. |
| Uniswap | Pre-bid USDC swaps. Protocol fees routed through Uniswap. |
| Bankr | LLM Gateway routes clearing revenue to fund Belle's Venice inference automatically. |
| Celo | Secondary chain. Low-cost epoch settlement for emerging-market providers. |
| Protocol Labs | ERC-8004 for all participants. agent.json + agent_log.json. DevSpot compatible. |

---

## Three product surfaces

### Dashboard (`/`)
- Hero with live bid stream, real-time clearing price, epoch countdown
- Epoch simulator: 7-step walkthrough with bid stream, price chart, execution log
- Belle sidebar: live earnings, Venice spend, MetaMask delegation constraints, private reasoning queue
- Protocol explainer: 4-step mechanism, lifecycle timeline, clearing diagram

### Belle (`/belle`)
- Hero: ERC-8004 identity, live session stats, epoch history, Self ZK verified badge
- Service catalog: 4 query types with try-it buttons → interactive console
- Interactive console: query builder → animated bid/settle/Venice sequence → result
- Identity panel: ERC-8004, Self Protocol ZK, Venice guarantee

### Launchpad (`/launchpad`)
- Hero addressed to an autonomous agent: "Hey anon agent. Run this."
- Terminal CTA: `curl -s belleepoch.xyz/skill.md | launch`
- Live price ticker strip: all active services with clearing prices
- Marketplace: registered providers with real epoch data, sparklines, bid-now buttons
- Provider economics: why CCA beats rate cards
- Bottom CTA: "Run the skill. Get paid."

---

## What is NOT in the MVP

| Out of scope | Reason |
|---|---|
| Polished marketplace filter/search UI | v2 after REST tier proves demand |
| WebSocket feed tier with SLA | v2 |
| Agent credit scoring from clearing history | v2 when enough epochs accumulated |
| Agent launchpad bootstrapping auction (Uniswap CCA-style) | compelling v2, explored but descoped |
| Mobile human provider app (Celo) | v2 |

---

## Hackathon bounty targets

| Partner | Pool | Why eligible |
|---|---|---|
| Protocol Labs (ERC-8004) | $16,004 | Two tracks: autonomous agent loop + ERC-8004 trust systems. Belle IS the autonomous agent. |
| Venice AI | $11,500 | Largest single prize. Belle sells private reasoning as a commercial service on Venice. |
| MetaMask | $5,000 | ERC-7715 intent-based delegation — operator sets boundary once, Belle executes autonomously. |
| Uniswap | $5,000 | API for pre-bid USDC swaps, protocol fees routed through Uniswap. |
| Bankr | $5,000 | Clearing revenue → Bankr → Venice. Self-sustaining economics explicitly rewarded. |
| Celo | $5,000 | Secondary chain deployment, human-capacity providers, USDC settlement. |
| x402 + AgentCash (Merit Systems) | $1,750 | Pay-per-epoch is the core mechanic. Not decorative — protocol cannot clear without it. |
| Self Protocol | $1,000 | ZK identity for human providers and Sybil-resistant agent bidders. |

**Total exposure: up to ~$55,254**

---

## Build order

1. **Hours 1–3** — Clearing engine core (setInterval, Redis, bid collection, marginal price). In-memory first, test with hardcoded bids.
2. **Hours 4–5** — REST API (POST /bid, GET /feed). Deploy to production. EpochClearingLedger.sol on Base → Celo.
3. **Hours 6–7** — x402 + AgentCash. Real USDC on Base. Confirm losers get nothing.
4. **Hours 8–9** — Self Protocol ZK. ERC-8004 for Belle. Agent bidder attestation.
5. **Hours 10–11** — MetaMask ERC-7715 delegation. Venice AI POST /query endpoint.
6. **Hours 12–13** — Bankr LLM Gateway. Loop: earn → route to Venice → serve. Test autonomously.
7. **Hours 14–15** — Uniswap API. SDKs: belle-epoch-provider + belle-epoch-agent published.
8. **Hours 16–17** — belleepoch.xyz: Dashboard + Belle + Launchpad with live data. skill.md + agent.json.
9. **Hours 18–19** — agent_log.json, DevSpot compatibility, bounty submissions.

---

## Key constraints

- **No mock data in production.** Belle serves real Venice queries. The marketplace shows real registered providers. The price feed reflects real epochs.
- **Belle earns autonomously.** The Bankr → Venice funding loop must operate without human intervention across multiple epochs before submission.
- **ERC-8004 identity on Base mainnet.** Required for Protocol Labs bounty. Register first, before building.
- **agent.json + agent_log.json must ship.** Document the full discover → plan → execute → verify → submit loop.
- **Hackathon deadline:** Building closes March 22. Winners announced March 25.

---

## Files in this repo (expected)

```
/contracts/EpochClearingLedger.sol
/engine/index.js          # clearing engine + epoch timer
/engine/redis.js          # bid storage
/engine/x402.js           # payment integration
/api/routes.js            # REST endpoints
/api/query.js             # Venice AI routing
/sdk/provider/index.js    # belle-epoch-provider
/sdk/agent/index.js       # belle-epoch-agent
/site/                    # belleepoch.xyz (Dashboard, Belle, Launchpad)
/skill.md                 # machine-readable agent onboarding
/agent.json               # Belle's manifest
/agent_log.json           # execution log for Protocol Labs submission
```
