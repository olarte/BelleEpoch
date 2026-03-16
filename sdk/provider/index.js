// belle-epoch-provider — Express middleware for Continuous Clearing Auctions
//
// Usage:
//   const belleEpoch = require('belle-epoch-provider');
//   app.use('/api', belleEpoch({ capacity: 3, epochMs: 5000, resource: 'my-service' }));
//   app.post('/api', (req, res) => res.json({ result: 'gated by CCA' }));

const jwt = require('jsonwebtoken');

const DEFAULT_ENGINE_URL = 'https://api.belleepoch.xyz';
const TOKEN_SECRET_HEADER = 'x-epoch-token-secret';

/**
 * belleEpoch(config) — returns Express middleware that gates requests behind a CCA.
 *
 * @param {Object} config
 * @param {number} config.capacity      — number of slots per epoch (default: 3)
 * @param {number} config.epochMs       — epoch duration in ms (default: 5000)
 * @param {string} config.resource      — resource identifier for this provider
 * @param {string} [config.wallet]      — provider wallet address (for settlement)
 * @param {string} [config.chain]       — chain id or name (default: 'base')
 * @param {string} [config.engineUrl]   — Belle Epoch engine URL
 * @param {string} [config.tokenSecret] — secret for verifying epoch access tokens
 */
function belleEpoch(config = {}) {
  const {
    capacity = 3,
    epochMs = 5000,
    resource = 'default',
    wallet = '',
    chain = 'base',
    engineUrl = DEFAULT_ENGINE_URL,
    tokenSecret = process.env.EPOCH_TOKEN_SECRET || 'belle-epoch-provider-secret',
  } = config;

  // Register with the clearing engine on startup (fire-and-forget)
  let registered = false;
  let currentEpoch = null;
  let feedCache = null;
  let feedCacheTime = 0;

  async function refreshFeed() {
    const now = Date.now();
    if (feedCache && now - feedCacheTime < epochMs * 0.8) return feedCache;
    try {
      const res = await fetch(`${engineUrl}/feed`);
      if (res.ok) {
        feedCache = await res.json();
        feedCacheTime = now;
        currentEpoch = feedCache.epochId;
      }
    } catch (e) {
      // Feed unavailable — continue with cached data
    }
    return feedCache;
  }

  // Verify an epoch access token (JWT)
  function verifyToken(token) {
    try {
      const claims = jwt.verify(token, tokenSecret, { issuer: 'belle-epoch' });
      if (claims.resource !== resource && claims.resource !== '*') return null;
      return claims;
    } catch {
      return null;
    }
  }

  // Build x402-style payment request for 402 responses
  function buildPaymentRequest(epochId, clearingPrice) {
    return {
      x402Version: 1,
      accepts: [{
        scheme: 'exact',
        network: chain === 'base' ? 'eip155:8453' : `eip155:${chain}`,
        maxAmountRequired: String(Math.round((clearingPrice || 0.01) * 1e6)),
        resource: `epoch:${epochId}:${resource}`,
        description: `CCA clearing payment — ${resource}`,
        payTo: wallet,
        extra: { epochId, resource, capacity, engineUrl },
      }],
    };
  }

  // The middleware function
  async function middleware(req, res, next) {
    // Check for Bearer token
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      const token = authHeader.slice(7);
      const claims = verifyToken(token);
      if (claims) {
        // Valid epoch token — grant access
        req.epochClaims = claims;
        return next();
      }
    }

    // No valid token — respond with 402 Payment Required
    const feed = await refreshFeed();
    const epochId = feed ? feed.epochId : 0;
    const clearingPrice = feed ? feed.clearingPrice : 0;

    const paymentRequest = buildPaymentRequest(epochId, clearingPrice);

    res.status(402).json({
      error: 'Payment required — win a clearing auction to access this endpoint',
      epochId,
      clearingPrice,
      capacity,
      resource,
      engineUrl,
      bidEndpoint: `${engineUrl}/bid`,
      feedEndpoint: `${engineUrl}/feed`,
      paymentRequest,
    });
  }

  // Attach metadata to the middleware for introspection
  middleware.config = { capacity, epochMs, resource, wallet, chain, engineUrl };
  middleware.refreshFeed = refreshFeed;
  middleware.verifyToken = verifyToken;

  return middleware;
}

module.exports = belleEpoch;
