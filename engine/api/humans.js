// engine/api/humans.js — Human provider routes (Self Protocol + Celo)

const { ethers } = require('ethers');
const { startProviderLoop, stopProviderLoop, isLoopActive } = require('../providerLoop');

module.exports = function mountHumansRoutes(app, redis) {

  // ─── Self Protocol Verifier ──────────────────────────────────────────────────
  let verifier = null;

  try {
    const { SelfBackendVerifier, DefaultConfigStore, AllIds } = require('@selfxyz/core');
    // Always use mainnet (false) — testnet RPC is unreachable (dead DNS)
    verifier = new SelfBackendVerifier(
      process.env.SELF_SCOPE || 'belle-epoch-humans',
      process.env.SELF_ENDPOINT || 'https://api.belleepoch.xyz/humans/verify',
      false,
      AllIds,
      new DefaultConfigStore({
        minimumAge: 18,
        ofac: true,
        excludedCountries: [],
      }),
      'hex'
    );
    console.log('[Humans] Self verifier initialized (mainnet)');
  } catch (err) {
    console.warn('[Humans] Self SDK not available — verification will reject all proofs:', err.message);
  }

  // ─── POST /humans/verify ────────────────────────────────────────────────────
  // Self relayers POST the ZK proof here after the user scans the QR code
  app.post('/humans/verify', async (req, res) => {
    try {
      const { attestationId, proof, publicSignals, userContextData } = req.body;

      if (!proof || !publicSignals || !attestationId || !userContextData) {
        return res.status(200).json({
          status: 'error', result: false,
          reason: 'Missing required fields',
        });
      }

      if (!verifier) {
        return res.status(200).json({
          status: 'error', result: false,
          reason: 'Self Protocol verifier not initialized',
        });
      }

      console.log(`[Humans] Verifying proof: attestationId=${attestationId}, publicSignals.length=${publicSignals?.length}, userContextData=${userContextData}`);
      const result = await verifier.verify(
        attestationId, proof, publicSignals, userContextData
      );
      console.log('[Humans] Verify result:', JSON.stringify(result?.isValidDetails || {}));

      const { isValid, isMinimumAgeValid, isOfacValid } = result.isValidDetails || {};

      if (!isValid) {
        return res.status(200).json({ status: 'error', result: false, reason: 'Proof invalid' });
      }
      if (!isMinimumAgeValid) {
        return res.status(200).json({ status: 'error', result: false, reason: 'Must be 18 or older' });
      }
      if (!isOfacValid) {
        return res.status(200).json({ status: 'error', result: false, reason: 'Sanctions check failed' });
      }

      // Extract disclosed data
      const nationality = result.discloseOutput ? result.discloseOutput.nationality : null;
      const rawWallet = result.userData ? result.userData.userDefinedData : null;
      const nullifier = result.userData ? result.userData.userIdentifier : null;

      console.log('[Humans] Extracted: wallet=%s, nationality=%s, nullifier=%s', rawWallet, nationality, nullifier);
      console.log('[Humans] Full userData:', JSON.stringify(result.userData || {}));
      console.log('[Humans] Full discloseOutput:', JSON.stringify(result.discloseOutput || {}));

      // Use userContextData as fallback wallet address (what was in the QR code)
      const walletAddress = rawWallet || userContextData || null;

      if (!walletAddress) {
        return res.status(200).json({ status: 'error', result: false, reason: 'No wallet address provided' });
      }

      // Normalize to lowercase for consistent lookups
      const walletKey = walletAddress.toLowerCase();

      // Sybil check: one passport = one registration
      // Allow re-verification if the nullifier exists but the wallet isn't actually verified
      // (handles case where first scan stored nullifier but wallet storage failed)
      if (nullifier) {
        const existingNullifier = await redis.get(`humans:nullifier:${nullifier}`);
        if (existingNullifier) {
          const existingVerified = await redis.get(`humans:verified:${existingNullifier.toLowerCase()}`);
          if (existingVerified) {
            // Wallet IS verified — this is a genuine duplicate
            return res.status(200).json({
              status: 'error', result: false,
              reason: 'This identity document has already been used to register',
            });
          }
          // Nullifier exists but wallet isn't verified — allow re-verification
          console.log(`[Humans] Allowing re-verification: nullifier exists for ${existingNullifier} but wallet not verified`);
        }
        await redis.set(`humans:nullifier:${nullifier}`, walletKey);
      }

      // Store under both lowercase and original case for safe lookups
      const verifiedData = JSON.stringify({
        nationality,
        verifiedAt: new Date().toISOString(),
        nullifier,
      });
      await redis.set(`humans:verified:${walletKey}`, verifiedData);
      if (walletAddress !== walletKey) {
        await redis.set(`humans:verified:${walletAddress}`, verifiedData);
      }

      console.log(`[Humans] Self verified wallet: ${walletKey} (nationality: ${nationality})`);
      return res.status(200).json({ status: 'success', result: true });
    } catch (err) {
      console.error('[POST /humans/verify] error:', err);
      return res.status(200).json({ status: 'error', result: false, reason: err.message });
    }
  });

  // ─── GET /humans/verified/:address ──────────────────────────────────────────
  // Check if a wallet has been Self-verified (used by frontend polling)
  app.get('/humans/verified/:address', async (req, res) => {
    try {
      const addr = req.params.address.toLowerCase();
      const raw = await redis.get(`humans:verified:${addr}`) || await redis.get(`humans:verified:${req.params.address}`);
      if (!raw) return res.json({ verified: false });
      const data = JSON.parse(raw);
      return res.json({ verified: true, nationality: data.nationality, verifiedAt: data.verifiedAt });
    } catch (err) {
      return res.json({ verified: false });
    }
  });

  // ─── POST /humans/reset-verification — clear stale verification data ────────
  app.post('/humans/reset-verification', async (req, res) => {
    const { walletAddress, secret } = req.body;
    if (secret !== process.env.ENGINE_PRIVATE_KEY?.slice(-8)) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    const addr = (walletAddress || '').toLowerCase();
    // Find and remove nullifier pointing to this wallet
    const verifiedRaw = await redis.get(`humans:verified:${addr}`);
    if (verifiedRaw) {
      const data = JSON.parse(verifiedRaw);
      if (data.nullifier) await redis.del(`humans:nullifier:${data.nullifier}`);
    }
    await redis.del(`humans:verified:${addr}`);
    await redis.del(`humans:verified:${walletAddress}`);
    console.log(`[Humans] Reset verification for ${addr}`);
    return res.json({ reset: true });
  });

  // ─── POST /humans/force-verify — admin: mark wallet as Self-verified ───────
  app.post('/humans/force-verify', async (req, res) => {
    const { walletAddress, secret, nationality } = req.body;
    if (secret !== process.env.ENGINE_PRIVATE_KEY?.slice(-8)) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    const addr = (walletAddress || '').toLowerCase();
    const verifiedData = JSON.stringify({
      nationality: nationality || 'verified',
      verifiedAt: new Date().toISOString(),
      nullifier: 'admin-verified-' + Date.now(),
    });
    await redis.set(`humans:verified:${addr}`, verifiedData);
    await redis.set(`humans:verified:${walletAddress}`, verifiedData);
    console.log(`[Humans] Force-verified wallet: ${addr}`);
    return res.json({ verified: true, wallet: addr });
  });

  // ─── POST /humans/register ──────────────────────────────────────────────────
  // Provider submits profile after Self verification
  app.post('/humans/register', async (req, res) => {
    try {
      const {
        walletAddress,
        category,
        credentialClaim,
        linkedinUrl,
        bio,
        capacitySlots,
        epochMs,
        chain,
        timezone,
        availabilityStart,
        availabilityEnd,
      } = req.body;

      if (!walletAddress || !category || !bio) {
        return res.status(400).json({ error: 'Missing required fields: walletAddress, category, bio' });
      }

      // Require Self verification first (check both original and lowercase)
      const verified = await redis.get(`humans:verified:${walletAddress.toLowerCase()}`) || await redis.get(`humans:verified:${walletAddress}`);
      if (!verified) {
        return res.status(401).json({ error: 'Self verification required first' });
      }

      const verifiedData = JSON.parse(verified);

      const validCategories = [
        'physician', 'attorney', 'security-researcher',
        'financial-analyst', 'data-scientist', 'other',
      ];
      const cat = validCategories.includes(category) ? category : 'other';

      const provider = {
        id: walletAddress,
        type: 'human',
        category: cat,
        credentialClaim: credentialClaim || null,
        linkedinUrl: linkedinUrl || null,
        bio: (bio || '').slice(0, 280),
        capacitySlots: Math.min(parseInt(capacitySlots) || 1, 5),
        epochMs: Math.max(parseInt(epochMs) || 30000, 30000),
        chain: chain || 'celo',
        timezone: timezone || 'UTC',
        availabilityStart: availabilityStart || '09:00',
        availabilityEnd: availabilityEnd || '17:00',
        selfVerified: true,
        nationality: verifiedData.nationality,
        verifiedAt: verifiedData.verifiedAt,
        registeredAt: new Date().toISOString(),
        epochsServed: 0,
        totalEarned: 0,
        winRate: null,
        currentClearingPrice: null,
        online: false,
      };

      await redis.set(`humans:provider:${walletAddress}`, JSON.stringify(provider));
      await redis.zadd('humans:providers', Date.now(), walletAddress);

      console.log(`[Humans] Provider registered: ${walletAddress} (${cat})`);
      return res.status(200).json({ success: true, provider });
    } catch (err) {
      console.error('[POST /humans/register] error:', err);
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ─── GET /humans/providers ──────────────────────────────────────────────────
  app.get('/humans/providers', async (req, res) => {
    try {
      const { category, chain, online } = req.query;

      const ids = await redis.zrevrange('humans:providers', 0, -1);
      const providers = await Promise.all(
        ids.map(id =>
          redis.get(`humans:provider:${id}`)
            .then(p => p ? JSON.parse(p) : null)
        )
      );

      let results = providers.filter(Boolean);

      if (category) results = results.filter(p => p.category === category);
      if (chain) results = results.filter(p => p.chain === chain);
      if (online === 'true') results = results.filter(p => p.online);

      return res.status(200).json(results);
    } catch (err) {
      console.error('[GET /humans/providers] error:', err);
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ─── POST /humans/heartbeat ─────────────────────────────────────────────────
  app.post('/humans/heartbeat', async (req, res) => {
    try {
      const { walletAddress, signature } = req.body;

      if (!walletAddress || !signature) {
        return res.status(400).json({ error: 'Missing walletAddress or signature' });
      }

      const recovered = ethers.verifyMessage('belle-epoch-heartbeat', signature);
      if (recovered.toLowerCase() !== walletAddress.toLowerCase()) {
        return res.status(401).json({ error: 'Invalid signature' });
      }

      const key = `humans:provider:${walletAddress}`;
      const raw = await redis.get(key);
      if (!raw) return res.status(404).json({ error: 'Provider not found' });

      const provider = JSON.parse(raw);
      provider.online = true;
      provider.lastSeen = new Date().toISOString();
      await redis.set(key, JSON.stringify(provider));

      // Auto-expire online status after 90 seconds if no new heartbeat
      await redis.set(`humans:online:${walletAddress}`, '1', 'EX', 90);

      return res.status(200).json({ online: true });
    } catch (err) {
      console.error('[POST /humans/heartbeat] error:', err);
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ─── Background job: link heartbeat to provider loops ─────────────────────
  setInterval(async () => {
    try {
      const ids = await redis.zrevrange('humans:providers', 0, -1);
      for (const id of ids) {
        const raw = await redis.get(`humans:provider:${id}`);
        if (!raw) continue;
        const provider = JSON.parse(raw);
        const heartbeatAlive = await redis.exists(`humans:online:${id}`);

        if (!heartbeatAlive && provider.online) {
          provider.online = false;
          await redis.set(`humans:provider:${id}`, JSON.stringify(provider));
          stopProviderLoop(id);
          console.log(`[heartbeat] ${id} offline — loop stopped`);
        }

        if (heartbeatAlive && !isLoopActive(id)) {
          provider.online = true;
          await redis.set(`humans:provider:${id}`, JSON.stringify(provider));
          startProviderLoop(provider).catch(err =>
            console.error(`[heartbeat] restart failed for ${id}:`, err.message)
          );
          console.log(`[heartbeat] ${id} online — loop restarted`);
        }
      }
    } catch (err) {
      console.error('[Humans] heartbeat check error:', err.message);
    }
  }, 30000);

  console.log('[Humans] routes mounted: /humans/verify, /humans/register, /humans/providers, /humans/heartbeat');
};
