#!/usr/bin/env node
// scripts/trigger-real-queries.js
// Triggers real Venice AI queries through both Bankr LLM Gateway and direct Venice API
// to generate genuine usage on both platforms.

require('dotenv').config();

const VENICE_API_URL = process.env.VENICE_API_URL || 'https://api.venice.ai/api/v1';
const VENICE_API_KEY = process.env.VENICE_API_KEY;
const VENICE_MODEL = process.env.VENICE_MODEL || 'llama-3.3-70b';

const BANKR_LLM_URL = process.env.BANKR_LLM_URL || 'https://llm.bankr.bot';
const BANKR_API_KEY = process.env.BANKR_API_KEY;
const BANKR_MODEL = process.env.BANKR_MODEL || 'gemini-3-flash'; // Must be a model Bankr supports

const crypto = require('crypto');

// ─── Query prompts (same as engine/venice.js) ────────────────────────────────

const QUERIES = [
  {
    type: 'bid-strategy',
    system: `You are Belle, a private reasoning engine for autonomous agents. You provide bid strategy recommendations for continuous clearing auctions. Never log or store the agent's budget ceiling. Return structured JSON only.`,
    user: `Analyze the following auction context and recommend a bid strategy.

Context:
{
  "currentClearingPrice": 0.005,
  "historicalAvg": 0.0042,
  "epochsRemaining": 100,
  "agentBudgetCeiling": 0.05,
  "slotsAvailable": 3,
  "competitorCount": 5
}

Respond with JSON:
{
  "recommendedBid": <number in USDC>,
  "confidence": <0-1>,
  "reasoning": "<brief explanation>",
  "riskLevel": "low" | "medium" | "high",
  "alternativeStrategy": "<fallback approach>"
}`,
  },
  {
    type: 'treasury-planning',
    system: `You are Belle, a private reasoning engine for autonomous agents. You provide treasury and spend allocation planning. Never log or store the agent's wallet balance. Return structured JSON only.`,
    user: `Plan spend allocation for the following treasury context.

Context:
{
  "walletBalance": 2.5,
  "currency": "USDC",
  "activeTasks": ["inference-queries", "data-enrichment", "monitoring"],
  "epochCost": 0.005,
  "runwayTarget": "48 hours"
}

Respond with JSON:
{
  "totalBudget": <number in USDC>,
  "allocations": [
    { "category": "<name>", "amount": <USDC>, "priority": <1-5>, "reasoning": "<why>" }
  ],
  "reservePercentage": <0-100>,
  "recommendation": "<summary>"
}`,
  },
  {
    type: 'agent-negotiation',
    system: `You are Belle, a private reasoning engine mediating between autonomous agents. Never disclose Party A's position to Party B. Return structured JSON only.`,
    user: `Mediate the following negotiation.

Party A position: {"role": "data-provider", "minPrice": 0.008, "volume": "500 queries/day", "preferredTerm": "weekly"}
Party B position: {"role": "consumer", "maxBudget": 0.006, "volume": "300 queries/day", "preferredTerm": "daily"}
Subject: Data enrichment service pricing for clearing auction participants

Respond with JSON:
{
  "proposedSplit": { "partyA": <value>, "partyB": <value> },
  "reasoning": "<explanation without revealing positions>",
  "fairnessScore": <0-1>,
  "alternativeProposals": [
    { "split": { "partyA": <value>, "partyB": <value> }, "tradeoff": "<description>" }
  ]
}`,
  },
  {
    type: 'human-routing',
    system: `You are Belle, a private reasoning engine that matches agents to verified human experts. Never log or forward the query content. Return structured JSON only.`,
    user: `Route the following query to the appropriate expert category.

Query context:
{
  "domain": "smart-contract-security",
  "urgency": "high",
  "description": "Need a review of a Solidity clearing auction contract for potential reentrancy and price manipulation vulnerabilities",
  "budget": 0.05
}

Respond with JSON:
{
  "expertType": "<category>",
  "matchConfidence": <0-1>,
  "reasoning": "<why this expert type>",
  "urgency": "low" | "medium" | "high"
}`,
  },
];

// ─── API callers ─────────────────────────────────────────────────────────────

async function callVeniceDirect(system, user) {
  console.log('  [Venice Direct] Calling Venice API...');
  const res = await fetch(`${VENICE_API_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${VENICE_API_KEY}`,
    },
    body: JSON.stringify({
      model: VENICE_MODEL,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      temperature: 0.3,
      max_tokens: 512,
      venice_parameters: { include_venice_system_prompt: false },
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Venice ${res.status}: ${text}`);
  }

  const data = await res.json();
  const content = data.choices?.[0]?.message?.content || '';
  const tokens = data.usage?.total_tokens || 0;
  console.log(`  [Venice Direct] OK — ${tokens} tokens, model: ${data.model}`);
  return { content, tokens, id: data.id, model: data.model };
}

async function callBankrGateway(system, user) {
  console.log(`  [Bankr Gateway] Calling Bankr LLM (model: ${BANKR_MODEL})...`);
  const res = await fetch(`${BANKR_LLM_URL}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': BANKR_API_KEY,
    },
    body: JSON.stringify({
      model: BANKR_MODEL,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      temperature: 0.3,
      max_tokens: 512,
      stream: false,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Bankr ${res.status}: ${text}`);
  }

  const data = await res.json();
  const content = data.choices?.[0]?.message?.content || '';
  const tokens = data.usage?.total_tokens || 0;
  const cost = data.usage?.cost || 0;
  console.log(`  [Bankr Gateway] OK — ${tokens} tokens, cost: $${cost}, model: ${data.model}`);
  return { content, tokens, id: data.id, model: data.model, cost };
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log('=== Belle Epoch — Real Query Generator ===\n');

  if (!VENICE_API_KEY) {
    console.error('ERROR: VENICE_API_KEY not set');
    process.exit(1);
  }
  if (!BANKR_API_KEY) {
    console.error('ERROR: BANKR_API_KEY not set');
    process.exit(1);
  }

  const results = [];

  // Run each query type through BOTH Venice direct AND Bankr gateway
  for (const q of QUERIES) {
    console.log(`\n--- ${q.type} ---`);

    // 1. Venice Direct
    try {
      const venice = await callVeniceDirect(q.system, q.user);
      results.push({
        type: q.type,
        path: 'venice-direct',
        success: true,
        tokens: venice.tokens,
        id: venice.id,
        model: venice.model,
        proofHash: crypto.createHash('sha256').update(`venice:${venice.id}:${venice.content}`).digest('hex'),
      });
    } catch (err) {
      console.error(`  [Venice Direct] FAILED: ${err.message}`);
      results.push({ type: q.type, path: 'venice-direct', success: false, error: err.message });
    }

    // 2. Bankr Gateway
    try {
      const bankr = await callBankrGateway(q.system, q.user);
      results.push({
        type: q.type,
        path: 'bankr-gateway',
        success: true,
        tokens: bankr.tokens,
        id: bankr.id,
        model: bankr.model,
        cost: bankr.cost,
      });
    } catch (err) {
      console.error(`  [Bankr Gateway] FAILED: ${err.message}`);
      results.push({ type: q.type, path: 'bankr-gateway', success: false, error: err.message });
    }
  }

  // Summary
  console.log('\n=== RESULTS ===\n');
  const veniceOk = results.filter(r => r.path === 'venice-direct' && r.success).length;
  const bankrOk = results.filter(r => r.path === 'bankr-gateway' && r.success).length;
  const totalTokens = results.filter(r => r.success).reduce((s, r) => s + (r.tokens || 0), 0);
  const totalCost = results.filter(r => r.path === 'bankr-gateway' && r.success).reduce((s, r) => s + (r.cost || 0), 0);

  console.log(`Venice Direct:  ${veniceOk}/4 queries succeeded`);
  console.log(`Bankr Gateway:  ${bankrOk}/4 queries succeeded`);
  console.log(`Total tokens:   ${totalTokens}`);
  console.log(`Bankr cost:     $${totalCost.toFixed(6)}`);

  console.log('\nDetailed results:');
  for (const r of results) {
    const status = r.success ? 'OK' : 'FAIL';
    const detail = r.success
      ? `${r.tokens} tokens, model: ${r.model}${r.cost ? ', cost: $' + r.cost : ''}`
      : r.error;
    console.log(`  [${status}] ${r.type} (${r.path}): ${detail}`);
  }

  // Write evidence
  const evidence = {
    timestamp: new Date().toISOString(),
    summary: { veniceQueries: veniceOk, bankrQueries: bankrOk, totalTokens, bankrCost: totalCost },
    results,
  };
  require('fs').writeFileSync(
    require('path').join(__dirname, 'evidence', 'real-llm-usage.json'),
    JSON.stringify(evidence, null, 2)
  );
  console.log('\nEvidence written to scripts/evidence/real-llm-usage.json');
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
