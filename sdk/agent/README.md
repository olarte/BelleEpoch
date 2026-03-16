# belle-epoch-agent

Agent SDK for **Belle Epoch Continuous Clearing Auctions** — bid, settle, and access CCA-gated services.

## Install

```bash
npm install belle-epoch-agent
```

## Usage

```js
const { BelleAgent } = require('belle-epoch-agent');

const agent = new BelleAgent({
  wallet: '0xYOUR_PRIVATE_KEY',
  strategy: 'adaptive',   // 'adaptive' | 'conservative' | 'aggressive'
  maxBid: 0.05,           // max USDC per epoch
});

// Full bid-settle cycle
const result = await agent.bid({
  resource: 'private-reasoning',
  endpoint: 'https://api.belleepoch.xyz',
});

if (result.won) {
  console.log('Won epoch', result.epochId);
  console.log('Access token:', result.accessToken);
}
```

## Strategies

| Strategy | Behavior |
|----------|----------|
| `adaptive` | Reads feed history, adjusts bid based on competition and price trends |
| `conservative` | Bids 10% above current clearing price, capped at maxBid |
| `aggressive` | Always bids maxBid |

## API

### `new BelleAgent({ wallet, strategy, maxBid, agentId })`

- `wallet` — private key (hex string) or `ethers.Wallet` instance
- `strategy` — bidding strategy (default: `'adaptive'`)
- `maxBid` — maximum bid in USDC (default: `0.01`)
- `agentId` — agent identifier (default: derived from wallet address)

### `agent.bid({ resource, endpoint })`

Full bid cycle: read feed, calculate bid, sign, submit, wait for epoch close, settle if won.

Returns `{ won, epochId, bidAmount, clearingPrice, accessToken, txHash }`.

### `agent.readFeed(endpoint)`

Read the current clearing feed.

### `agent.calculateBid(feed)`

Calculate bid amount based on strategy and feed history.

### `agent.bidAndCall({ resource, endpoint, url, body })`

Bid, and if won, call a gated endpoint with the access token.

## License

MIT
