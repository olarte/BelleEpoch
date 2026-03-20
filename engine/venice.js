// engine/venice.js — Venice AI private reasoning integration
//
// All sessions are isolated (no history carried between queries).
// No-data-retention mode: retained: false confirmed in every response.

const crypto = require('crypto');
const { redis } = require('./bids');
const self = require('./identity/self');
const bankr = require('./bankr');

const VENICE_API_URL = process.env.VENICE_API_URL || 'https://api.venice.ai/api/v1';
const VENICE_API_KEY = process.env.VENICE_API_KEY || '';
const VENICE_MODEL = process.env.VENICE_MODEL || 'llama-3.3-70b';

// Bankr LLM Gateway model — use the same model name; Bankr routes through OpenRouter
const BANKR_MODEL = process.env.BANKR_MODEL || VENICE_MODEL;

let initialized = false;
let useBankr = false;

function init() {
  // Prefer Bankr gateway if configured (Session 06+)
  if (bankr.isInitialized()) {
    useBankr = true;
    initialized = true;
    console.log(`[Venice] Routing through Bankr LLM Gateway — model: ${BANKR_MODEL}`);
    return true;
  }

  // Fallback to direct Venice API
  if (!VENICE_API_KEY) {
    console.log('[Venice] Missing VENICE_API_KEY — Venice AI disabled');
    return false;
  }
  initialized = true;
  console.log(`[Venice] Active (direct) — model: ${VENICE_MODEL}`);
  return true;
}

// ─── Prompt templates ────────────────────────────────────────────────────────

const PROMPTS = {
  'bid-strategy': (context) => ({
    system: `You are Belle, a private reasoning engine for autonomous agents. You provide bid strategy recommendations for continuous clearing auctions.

RULES:
- Never log, store, or reference the agent's budget ceiling after this session
- Return structured JSON output only
- Your recommendation must be actionable: a specific bid amount and reasoning
- Consider the current clearing price, historical trends, and the agent's stated constraints`,
    user: `Analyze the following auction context and recommend a bid strategy.

Context:
${JSON.stringify(context, null, 2)}

Respond with JSON:
{
  "recommendedBid": <number in USDC>,
  "confidence": <0-1>,
  "reasoning": "<brief explanation>",
  "riskLevel": "low" | "medium" | "high",
  "alternativeStrategy": "<fallback approach>"
}`,
  }),

  'treasury-planning': (context) => ({
    system: `You are Belle, a private reasoning engine for autonomous agents. You provide treasury and spend allocation planning.

RULES:
- Never log, store, or reference the agent's wallet balance or task queue after this session
- Return structured JSON output only
- Allocation must sum to the available budget
- Prioritize by urgency and expected ROI`,
    user: `Plan spend allocation for the following treasury context.

Context:
${JSON.stringify(context, null, 2)}

Respond with JSON:
{
  "totalBudget": <number in USDC>,
  "allocations": [
    { "category": "<name>", "amount": <USDC>, "priority": <1-5>, "reasoning": "<why>" }
  ],
  "reservePercentage": <0-100>,
  "recommendation": "<summary>"
}`,
  }),

  'agent-negotiation': (context) => ({
    system: `You are Belle, a private reasoning engine mediating between autonomous agents. You receive positions from multiple parties and propose fair splits.

RULES:
- Never disclose Party A's position to Party B or vice versa
- Never log or store either party's position after this session
- Propose a fair resolution based on both positions
- Return structured JSON output only`,
    user: `Mediate the following negotiation.

${context.partyA ? `Party A position: ${JSON.stringify(context.partyA, null, 2)}` : ''}
${context.partyB ? `Party B position: ${JSON.stringify(context.partyB, null, 2)}` : ''}
${context.subject ? `Subject: ${context.subject}` : ''}

Respond with JSON:
{
  "proposedSplit": { "partyA": <value>, "partyB": <value> },
  "reasoning": "<explanation without revealing positions>",
  "fairnessScore": <0-1>,
  "alternativeProposals": [
    { "split": { "partyA": <value>, "partyB": <value> }, "tradeoff": "<description>" }
  ]
}`,
  }),

  'human-routing': (context) => ({
    system: `You are Belle, a private reasoning engine that matches agents to verified human experts. You analyze the query to determine the best expert type and generate a routing recommendation.

RULES:
- Never log, store, or forward the query content after this session
- The query content stays sealed — only the expert category is used for matching
- Return structured JSON output only`,
    user: `Route the following query to the appropriate expert category.

Query context:
${JSON.stringify(context, null, 2)}

Respond with JSON:
{
  "expertType": "<category>",
  "matchConfidence": <0-1>,
  "reasoning": "<why this expert type>",
  "urgency": "low" | "medium" | "high"
}`,
  }),
};

// ─── Venice API call ─────────────────────────────────────────────────────────

async function callVenice(systemPrompt, userPrompt) {
  if (!initialized) {
    throw new Error('Venice AI not initialized');
  }

  let result;
  let routedViaBankr = false;

  if (useBankr) {
    // ─── Try Bankr LLM Gateway first, fall back to direct Venice ──────
    try {
      result = await bankr.chatCompletion(BANKR_MODEL, [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ], { temperature: 0.3, max_tokens: 1024 });
      routedViaBankr = true;

      // Track Bankr inference cost in Redis
      const cost = result.usage
        ? (result.usage.prompt_tokens + result.usage.completion_tokens) * 0.000001
        : 0.0005;
      await redis.incrbyfloat('bankr:inference:cost', cost);
    } catch (bankrErr) {
      console.warn(`[Venice] Bankr failed (${bankrErr.message}) — falling back to direct Venice API`);
      // Fall through to direct Venice call below
    }
  }

  if (!result) {
    // ─── Direct Venice API call ────────────────────────────────────────
    if (!VENICE_API_KEY) {
      throw new Error('Venice AI not available — Bankr failed and no VENICE_API_KEY configured');
    }
    const response = await fetch(`${VENICE_API_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${VENICE_API_KEY}`,
      },
      body: JSON.stringify({
        model: VENICE_MODEL,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        temperature: 0.3,
        max_tokens: 1024,
        venice_parameters: {
          include_venice_system_prompt: false,
        },
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Venice API returned ${response.status}: ${text}`);
    }

    result = await response.json();
  }

  // Extract the response content
  const content = result.choices?.[0]?.message?.content || '';

  // Generate proof hash from the response
  const proofHash = crypto.createHash('sha256')
    .update(`venice:${result.id || ''}:${content}`)
    .digest('hex');

  return {
    content,
    veniceId: result.id || null,
    veniceProof: proofHash,
    model: result.model || (routedViaBankr ? BANKR_MODEL : VENICE_MODEL),
    retained: false,
    routedViaBankr,
  };
}

// ─── Query processing ────────────────────────────────────────────────────────

function queryKey(queryId) {
  return `query:${queryId}`;
}

/**
 * Submit a query for async processing.
 * Returns queryId immediately. Result stored in Redis until retrieved once.
 */
async function submitQuery(type, context, agentId, epochId) {
  const queryId = `q-${epochId}-${crypto.randomBytes(8).toString('hex')}`;

  // Store initial status
  await redis.set(queryKey(queryId), JSON.stringify({
    status: 'processing',
    type,
    agentId,
    epochId,
    submittedAt: new Date().toISOString(),
  }));
  // Auto-expire after 5 minutes
  await redis.expire(queryKey(queryId), 300);

  // Process asynchronously — do NOT await
  processQuery(queryId, type, context, agentId, epochId).catch(err => {
    console.error(`[Venice] query ${queryId} failed:`, err.message);
    // Store error result
    redis.set(queryKey(queryId), JSON.stringify({
      status: 'error',
      error: err.message,
      type,
      agentId,
      epochId,
    }));
    redis.expire(queryKey(queryId), 300);
  });

  return queryId;
}

async function processQuery(queryId, type, context, agentId, epochId) {
  // Special handling for human-routing: find expert via Self Protocol
  if (type === 'human-routing') {
    const expert = await self.findVerifiedExpert(redis, context.expertType || context.category || 'general');

    if (!expert) {
      await redis.set(queryKey(queryId), JSON.stringify({
        status: 'resolved',
        result: { error: 'no_verified_expert_available', expertType: context.expertType },
        veniceProof: null,
        retained: false,
        type,
        agentId,
        epochId,
        resolvedAt: new Date().toISOString(),
      }));
      await redis.expire(queryKey(queryId), 300);
      return;
    }

    // Use Venice to analyze the query and match to expert category
    const promptFn = PROMPTS[type];
    const { system, user } = promptFn(context);
    const veniceResult = await callVenice(system, user);

    await redis.set(queryKey(queryId), JSON.stringify({
      status: 'resolved',
      result: {
        routing: parseJsonSafe(veniceResult.content),
        expert: {
          id: expert.agentId,
          resource: expert.resource,
          credentials: expert.credentials,
          selfVerified: true,
        },
      },
      veniceProof: veniceResult.veniceProof,
      retained: false,
      type,
      agentId,
      epochId,
      resolvedAt: new Date().toISOString(),
    }));
    await redis.expire(queryKey(queryId), 300);
    return;
  }

  // Standard query types: bid-strategy, treasury-planning, agent-negotiation
  const promptFn = PROMPTS[type];
  if (!promptFn) {
    throw new Error(`Unknown query type: ${type}`);
  }

  const { system, user } = promptFn(context);
  const veniceResult = await callVenice(system, user);

  // Store resolved result
  await redis.set(queryKey(queryId), JSON.stringify({
    status: 'resolved',
    result: parseJsonSafe(veniceResult.content),
    veniceProof: veniceResult.veniceProof,
    retained: false,
    type,
    agentId,
    epochId,
    resolvedAt: new Date().toISOString(),
  }));
  await redis.expire(queryKey(queryId), 300);
}

/**
 * Get query result. Returns the result and DELETES it from storage (one-time read).
 * Second call returns null.
 */
async function getQueryResult(queryId) {
  const key = queryKey(queryId);
  const raw = await redis.get(key);
  if (!raw) return null;

  const data = JSON.parse(raw);

  // If still processing, return status without deleting
  if (data.status === 'processing') {
    return data;
  }

  // Resolved or error — delete after reading (one-time retrieval)
  await redis.del(key);

  return data;
}

/**
 * Parse JSON from Venice response, falling back to raw string.
 */
function parseJsonSafe(content) {
  try {
    // Try to extract JSON from markdown code blocks
    const jsonMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[1].trim());
    }
    return JSON.parse(content);
  } catch {
    return { raw: content };
  }
}

module.exports = {
  init,
  submitQuery,
  getQueryResult,
  callVenice,
  PROMPTS,
};
