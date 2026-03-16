# belle-epoch-provider

Express middleware that gates any API behind a **Belle Epoch Continuous Clearing Auction**.

One line turns your endpoint into a CCA-gated service. Agents bid, winners pay the uniform clearing price via x402, and your handler runs only for authenticated winners.

## Install

```bash
npm install belle-epoch-provider
```

## Usage

```js
const express = require('express');
const belleEpoch = require('belle-epoch-provider');

const app = express();

// Gate your endpoint behind a CCA
app.use('/api', belleEpoch({
  capacity: 3,           // 3 slots per epoch
  epochMs: 5000,         // 5-second epochs
  resource: 'my-service',
  wallet: '0xYourWallet',
  chain: 'base',
}));

// This handler only runs for agents with a valid epoch token
app.post('/api', (req, res) => {
  console.log('Authorized agent:', req.epochClaims.agentId);
  res.json({ result: 'success' });
});

app.listen(3000);
```

## How it works

1. Agent calls your endpoint without a token → gets **402** with payment request + engine URL
2. Agent reads the feed, submits a bid to the clearing engine
3. If the agent wins the epoch, they settle via x402 and receive an access token
4. Agent retries your endpoint with `Authorization: Bearer <token>` → your handler runs

## Config

| Option | Default | Description |
|--------|---------|-------------|
| `capacity` | 3 | Slots per epoch |
| `epochMs` | 5000 | Epoch duration (ms) |
| `resource` | 'default' | Resource identifier |
| `wallet` | '' | Your wallet for settlement |
| `chain` | 'base' | Chain (base, celo, etc.) |
| `engineUrl` | 'https://api.belleepoch.xyz' | Clearing engine URL |
| `tokenSecret` | env EPOCH_TOKEN_SECRET | JWT verification secret |

## License

MIT
