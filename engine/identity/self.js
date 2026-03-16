// identity/self.js — Self Protocol ZK attestation verification
// Docs: https://app.ai.self.xyz

const SELF_API_BASE = process.env.SELF_API_URL || 'https://app.ai.self.xyz/api/v1';
const SELF_APP_ID = process.env.SELF_APP_ID || '';
const SELF_API_KEY = process.env.SELF_API_KEY || '';

let initialized = false;

function init() {
  if (!SELF_APP_ID || !SELF_API_KEY) {
    console.log('[Self] Missing SELF_APP_ID or SELF_API_KEY — attestation verification disabled');
    return false;
  }
  initialized = true;
  console.log(`[Self] Protocol active — app: ${SELF_APP_ID}`);
  return true;
}

/// Verify a Self Protocol ZK attestation proof.
/// Returns { valid, attestation } or { valid: false, error }.
///
/// selfAttestationProof is the proof blob from the Self app.
/// expectedType: 'human-provider' | 'agent-operator'
async function verifyAttestation(selfAttestationProof, expectedType) {
  if (!selfAttestationProof) {
    return { valid: false, error: 'Missing Self attestation proof' };
  }

  // If Self Protocol is not configured, reject (no fallback for identity)
  if (!initialized) {
    return { valid: false, error: 'Self Protocol not configured' };
  }

  try {
    const response = await fetch(`${SELF_API_BASE}/verify`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${SELF_API_KEY}`,
        'X-App-Id': SELF_APP_ID,
      },
      body: JSON.stringify({
        proof: selfAttestationProof,
        expectedType,
        appId: SELF_APP_ID,
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      return { valid: false, error: `Self API returned ${response.status}: ${text}` };
    }

    const result = await response.json();

    if (!result.verified) {
      return { valid: false, error: result.reason || 'Attestation verification failed' };
    }

    return {
      valid: true,
      attestation: {
        subject: result.subject,         // the attested identity
        type: result.attestationType,    // 'human-provider' or 'agent-operator'
        issuedAt: result.issuedAt,
        expiresAt: result.expiresAt,
        credentials: result.credentials || [],  // e.g. ['medical', 'legal']
        uniqueId: result.uniqueId,       // Sybil-resistant unique ID
      },
    };
  } catch (err) {
    return { valid: false, error: `Self API error: ${err.message}` };
  }
}

/// Check if an agent has a valid Self Agent ID linked to an operator wallet.
/// Used for Sybil resistance — one unique identity per operator.
async function verifyAgentIdentity(agentId, operatorWallet) {
  if (!initialized) {
    // If Self is not configured, skip Sybil check (allow all)
    return { valid: true, skipped: true };
  }

  try {
    const response = await fetch(`${SELF_API_BASE}/agents/${agentId}`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${SELF_API_KEY}`,
        'X-App-Id': SELF_APP_ID,
      },
    });

    if (!response.ok) {
      if (response.status === 404) {
        return { valid: false, error: `Agent ${agentId} not found in Self registry` };
      }
      return { valid: false, error: `Self API returned ${response.status}` };
    }

    const agent = await response.json();

    // Verify the agent is linked to the claimed operator
    if (agent.operator && agent.operator.toLowerCase() !== operatorWallet.toLowerCase()) {
      return { valid: false, error: 'Agent operator mismatch' };
    }

    return {
      valid: true,
      agent: {
        id: agent.id,
        operator: agent.operator,
        uniqueId: agent.uniqueId,
        verified: agent.verified,
      },
    };
  } catch (err) {
    return { valid: false, error: `Self API error: ${err.message}` };
  }
}

/// Check if a human expert of a given type exists in Redis (Self-attested providers).
/// This is called by the query router for human-routing queries.
async function findVerifiedExpert(redis, expertType) {
  const providers = await redis.lrange('self:providers', 0, -1);

  for (const raw of providers) {
    const provider = JSON.parse(raw);
    if (!provider.selfVerified) continue;

    // Check if the provider has the requested credential type
    const hasCredential = provider.credentials &&
      provider.credentials.some(c =>
        c.toLowerCase().includes(expertType.toLowerCase())
      );

    if (hasCredential && provider.active) {
      return provider;
    }
  }

  return null;
}

module.exports = {
  init,
  verifyAttestation,
  verifyAgentIdentity,
  findVerifiedExpert,
};
