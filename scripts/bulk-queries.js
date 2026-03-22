#!/usr/bin/env node
// scripts/bulk-queries.js
// Runs 52 unique queries (13 variations x 4 types) through BOTH Venice direct
// AND Bankr LLM Gateway = 104 total API calls. Writes comprehensive evidence.

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const VENICE_API_URL = process.env.VENICE_API_URL || 'https://api.venice.ai/api/v1';
const VENICE_API_KEY = process.env.VENICE_API_KEY;
const VENICE_MODEL = process.env.VENICE_MODEL || 'llama-3.3-70b';

const BANKR_LLM_URL = process.env.BANKR_LLM_URL || 'https://llm.bankr.bot';
const BANKR_API_KEY = process.env.BANKR_API_KEY;
const BANKR_MODEL = process.env.BANKR_MODEL || 'gemini-3-flash';

const DELAY_MS = 500;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function rand(min, max, decimals) { return +(min + Math.random() * (max - min)).toFixed(decimals || 4); }
function randInt(min, max) { return Math.floor(min + Math.random() * (max - min + 1)); }

// ─── Context variation generators ─────────────────────────────────────────

function generateBidStrategyVariations(count) {
  const scenarios = [
    { label: 'low-competition', competitorRange: [2, 4], slotRange: [3, 5] },
    { label: 'high-competition', competitorRange: [8, 15], slotRange: [2, 3] },
    { label: 'surplus-slots', competitorRange: [2, 3], slotRange: [5, 8] },
    { label: 'tight-market', competitorRange: [6, 8], slotRange: [3, 4] },
    { label: 'volatile-pricing', competitorRange: [4, 10], slotRange: [2, 6] },
  ];
  const variations = [];
  for (let i = 0; i < count; i++) {
    const s = scenarios[i % scenarios.length];
    const cp = rand(0.001, 0.05);
    variations.push({
      variationId: `bid-${i + 1}`,
      scenarioLabel: s.label,
      context: {
        currentClearingPrice: cp,
        historicalAvg: rand(cp * 0.6, cp * 1.2),
        epochsRemaining: randInt(20, 500),
        agentBudgetCeiling: rand(cp * 5, cp * 20),
        slotsAvailable: randInt(s.slotRange[0], s.slotRange[1]),
        competitorCount: randInt(s.competitorRange[0], s.competitorRange[1]),
      },
    });
  }
  return variations;
}

function generateTreasuryVariations(count) {
  const taskSets = [
    ['inference-queries', 'data-enrichment', 'monitoring'],
    ['bid-execution', 'portfolio-rebalancing'],
    ['inference-queries', 'agent-coordination', 'on-chain-settlement', 'reporting'],
    ['data-scraping', 'model-fine-tuning', 'api-serving'],
    ['monitoring', 'alerting', 'auto-scaling'],
    ['content-generation', 'seo-analysis', 'distribution'],
    ['security-scanning', 'patch-management'],
    ['market-making', 'arbitrage', 'risk-hedging'],
    ['translation', 'summarization', 'classification'],
    ['image-generation', 'video-processing', 'storage'],
    ['contract-auditing', 'vulnerability-scanning'],
    ['on-chain-analytics', 'whale-tracking', 'liquidation-alerts'],
    ['cross-chain-bridging', 'gas-optimization'],
  ];
  const runways = ['12 hours', '24 hours', '48 hours', '72 hours', '1 week'];
  const variations = [];
  for (let i = 0; i < count; i++) {
    variations.push({
      variationId: `treasury-${i + 1}`,
      context: {
        walletBalance: rand(0.5, 50, 2),
        currency: 'USDC',
        activeTasks: taskSets[i % taskSets.length],
        epochCost: rand(0.002, 0.02),
        runwayTarget: runways[i % runways.length],
      },
    });
  }
  return variations;
}

function generateNegotiationVariations(count) {
  const domains = [
    { subject: 'Real-time data feed pricing for market agents', roleA: 'data-provider', roleB: 'consumer' },
    { subject: 'GPU compute allocation for model training', roleA: 'compute-provider', roleB: 'ml-agent' },
    { subject: 'Decentralized storage capacity for agent logs', roleA: 'storage-provider', roleB: 'logging-agent' },
    { subject: 'Inference API throughput guarantee', roleA: 'inference-provider', roleB: 'orchestrator-agent' },
    { subject: 'Uptime monitoring SLA for clearing nodes', roleA: 'monitoring-provider', roleB: 'protocol-operator' },
    { subject: 'Bandwidth allocation for cross-chain messaging', roleA: 'relay-provider', roleB: 'bridge-agent' },
    { subject: 'Oracle data delivery frequency negotiation', roleA: 'oracle-provider', roleB: 'defi-agent' },
    { subject: 'Content moderation throughput for social platform', roleA: 'moderation-provider', roleB: 'platform-agent' },
    { subject: 'Indexing service pricing for on-chain analytics', roleA: 'indexer', roleB: 'analytics-agent' },
    { subject: 'KYC verification capacity for onboarding flow', roleA: 'kyc-provider', roleB: 'onboarding-agent' },
    { subject: 'Translation service throughput for multilingual agent', roleA: 'translation-provider', roleB: 'multilingual-agent' },
    { subject: 'Embedding generation pricing for RAG pipeline', roleA: 'embedding-provider', roleB: 'rag-agent' },
    { subject: 'Notification delivery pricing for alert system', roleA: 'notification-provider', roleB: 'alert-agent' },
  ];
  const terms = ['hourly', 'daily', 'weekly', 'monthly'];
  const variations = [];
  for (let i = 0; i < count; i++) {
    const d = domains[i % domains.length];
    const minPrice = rand(0.003, 0.02);
    variations.push({
      variationId: `negotiation-${i + 1}`,
      subject: d.subject,
      partyA: { role: d.roleA, minPrice, volume: `${randInt(100, 2000)} queries/day`, preferredTerm: pick(terms) },
      partyB: { role: d.roleB, maxBudget: rand(minPrice * 0.5, minPrice * 0.9), volume: `${randInt(50, 1000)} queries/day`, preferredTerm: pick(terms) },
    });
  }
  return variations;
}

function generateHumanRoutingVariations(count) {
  const specs = [
    { domain: 'smart-contract-security', desc: 'Audit a Solidity clearing auction contract for reentrancy and flash loan attack vectors' },
    { domain: 'legal-compliance', desc: 'Review agent-to-agent service terms for regulatory compliance under MiCA framework' },
    { domain: 'medical-data-privacy', desc: 'Evaluate HIPAA compliance of an agent handling de-identified patient triage data' },
    { domain: 'financial-risk', desc: 'Assess treasury exposure of an autonomous agent holding multi-chain USDC positions' },
    { domain: 'mechanical-engineering', desc: 'Review IoT sensor calibration protocol managed by an autonomous maintenance agent' },
    { domain: 'cryptographic-audit', desc: 'Verify ZK proof construction for Self Protocol identity attestation' },
    { domain: 'tokenomics-review', desc: 'Evaluate sustainability of clearing revenue distribution to protocol stakers' },
    { domain: 'ai-safety', desc: 'Red-team an autonomous bidding agent for adversarial prompt injection via bid metadata' },
    { domain: 'infrastructure-reliability', desc: 'Assess fault tolerance of epoch clearing engine under network partition scenarios' },
    { domain: 'data-governance', desc: 'Review data retention policies for Venice AI isolated sessions handling sensitive queries' },
    { domain: 'supply-chain-logistics', desc: 'Optimize autonomous fleet routing agent for last-mile delivery cost reduction' },
    { domain: 'environmental-compliance', desc: 'Verify carbon offset calculations for an energy-trading agent on Celo' },
    { domain: 'intellectual-property', desc: 'Assess IP implications of agent-generated content sold through clearing auctions' },
  ];
  const urgencies = ['low', 'medium', 'high', 'critical'];
  const variations = [];
  for (let i = 0; i < count; i++) {
    const s = specs[i % specs.length];
    variations.push({
      variationId: `routing-${i + 1}`,
      context: { domain: s.domain, urgency: urgencies[i % urgencies.length], description: s.desc, budget: rand(0.01, 0.1) },
    });
  }
  return variations;
}

// ─── Prompt builders ──────────────────────────────────────────────────────

const SYSTEM_PROMPTS = {
  'bid-strategy': 'You are Belle, a private reasoning engine for autonomous agents. You provide bid strategy recommendations for continuous clearing auctions. Never log or store the agent\'s budget ceiling. Return structured JSON only.',
  'treasury-planning': 'You are Belle, a private reasoning engine for autonomous agents. You provide treasury and spend allocation planning. Never log or store the agent\'s wallet balance. Return structured JSON only.',
  'agent-negotiation': 'You are Belle, a private reasoning engine mediating between autonomous agents. Never disclose Party A\'s position to Party B. Return structured JSON only.',
  'human-routing': 'You are Belle, a private reasoning engine that matches agents to verified human experts. Never log or forward the query content. Return structured JSON only.',
};

function buildUserPrompt(type, v) {
  if (type === 'bid-strategy') return `Analyze the following auction context and recommend a bid strategy.\n\nContext:\n${JSON.stringify(v.context, null, 2)}\n\nRespond with JSON: { "recommendedBid": <USDC>, "confidence": <0-1>, "reasoning": "<brief>", "riskLevel": "low"|"medium"|"high", "alternativeStrategy": "<fallback>" }`;
  if (type === 'treasury-planning') return `Plan spend allocation for the following treasury context.\n\nContext:\n${JSON.stringify(v.context, null, 2)}\n\nRespond with JSON: { "totalBudget": <USDC>, "allocations": [{ "category": "<name>", "amount": <USDC>, "priority": <1-5>, "reasoning": "<why>" }], "reservePercentage": <0-100>, "recommendation": "<summary>" }`;
  if (type === 'agent-negotiation') return `Mediate the following negotiation.\n\nParty A position: ${JSON.stringify(v.partyA)}\nParty B position: ${JSON.stringify(v.partyB)}\nSubject: ${v.subject}\n\nRespond with JSON: { "proposedSplit": { "partyA": <value>, "partyB": <value> }, "reasoning": "<explanation without revealing positions>", "fairnessScore": <0-1>, "alternativeProposals": [{ "split": { "partyA": <value>, "partyB": <value> }, "tradeoff": "<description>" }] }`;
  if (type === 'human-routing') return `Route the following query to the appropriate expert category.\n\nQuery context:\n${JSON.stringify(v.context, null, 2)}\n\nRespond with JSON: { "expertType": "<category>", "matchConfidence": <0-1>, "reasoning": "<why this expert type>", "urgency": "low"|"medium"|"high" }`;
}

// ─── API callers ──────────────────────────────────────────────────────────

async function callVeniceDirect(system, user) {
  const res = await fetch(`${VENICE_API_URL}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${VENICE_API_KEY}` },
    body: JSON.stringify({
      model: VENICE_MODEL,
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      temperature: 0.3, max_tokens: 512,
      venice_parameters: { include_venice_system_prompt: false },
    }),
  });
  if (!res.ok) throw new Error(`Venice ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  return { content: data.choices?.[0]?.message?.content || '', tokens: data.usage?.total_tokens || 0, id: data.id, model: data.model };
}

async function callBankrGateway(system, user) {
  const res = await fetch(`${BANKR_LLM_URL}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-API-Key': BANKR_API_KEY },
    body: JSON.stringify({
      model: BANKR_MODEL,
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      temperature: 0.3, max_tokens: 512, stream: false,
    }),
  });
  if (!res.ok) throw new Error(`Bankr ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  return { content: data.choices?.[0]?.message?.content || '', tokens: data.usage?.total_tokens || 0, id: data.id, model: data.model, cost: data.usage?.cost || 0 };
}

// ─── Main ─────────────────────────────────────────────────────────────────

async function main() {
  console.log('=== Belle Epoch — Bulk Query Generator (52 queries x 2 paths = 104 calls) ===\n');
  if (!VENICE_API_KEY) { console.error('ERROR: VENICE_API_KEY not set'); process.exit(1); }
  if (!BANKR_API_KEY) { console.error('ERROR: BANKR_API_KEY not set'); process.exit(1); }

  const N = 13;
  const allQueries = [
    ...generateBidStrategyVariations(N).map(v => ({ type: 'bid-strategy', variation: v })),
    ...generateTreasuryVariations(N).map(v => ({ type: 'treasury-planning', variation: v })),
    ...generateNegotiationVariations(N).map(v => ({ type: 'agent-negotiation', variation: v })),
    ...generateHumanRoutingVariations(N).map(v => ({ type: 'human-routing', variation: v })),
  ];

  console.log(`Generated ${allQueries.length} unique queries across 4 types`);
  console.log(`Will make ${allQueries.length * 2} total API calls (Venice + Bankr for each)\n`);

  const results = [];
  let completed = 0;
  const total = allQueries.length * 2;
  const startTime = Date.now();

  for (const q of allQueries) {
    const system = SYSTEM_PROMPTS[q.type];
    const user = buildUserPrompt(q.type, q.variation);
    const vid = q.variation.variationId;

    // Venice Direct
    completed++;
    process.stdout.write(`[${completed}/${total}] ${q.type} ${vid} venice-direct ... `);
    try {
      const venice = await callVeniceDirect(system, user);
      const proofHash = crypto.createHash('sha256').update(`venice:${venice.id}:${venice.content}`).digest('hex');
      results.push({ type: q.type, variationId: vid, path: 'venice-direct', success: true, tokens: venice.tokens, id: venice.id, model: venice.model, proofHash, timestamp: new Date().toISOString() });
      console.log(`OK ${venice.tokens} tokens`);
    } catch (err) {
      results.push({ type: q.type, variationId: vid, path: 'venice-direct', success: false, error: err.message, timestamp: new Date().toISOString() });
      console.log(`FAIL: ${err.message.slice(0, 80)}`);
    }
    await sleep(DELAY_MS);

    // Bankr Gateway
    completed++;
    process.stdout.write(`[${completed}/${total}] ${q.type} ${vid} bankr-gateway ... `);
    try {
      const bankr = await callBankrGateway(system, user);
      const proofHash = crypto.createHash('sha256').update(`bankr:${bankr.id}:${bankr.content}`).digest('hex');
      results.push({ type: q.type, variationId: vid, path: 'bankr-gateway', success: true, tokens: bankr.tokens, id: bankr.id, model: bankr.model, cost: bankr.cost, proofHash, timestamp: new Date().toISOString() });
      console.log(`OK ${bankr.tokens} tokens, cost: $${bankr.cost || 0}`);
    } catch (err) {
      results.push({ type: q.type, variationId: vid, path: 'bankr-gateway', success: false, error: err.message, timestamp: new Date().toISOString() });
      console.log(`FAIL: ${err.message.slice(0, 80)}`);
    }
    await sleep(DELAY_MS);
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  // Summary
  console.log('\n' + '='.repeat(70));
  const veniceOk = results.filter(r => r.path === 'venice-direct' && r.success).length;
  const bankrOk = results.filter(r => r.path === 'bankr-gateway' && r.success).length;
  const totalTokens = results.filter(r => r.success).reduce((s, r) => s + (r.tokens || 0), 0);
  const veniceTokens = results.filter(r => r.path === 'venice-direct' && r.success).reduce((s, r) => s + (r.tokens || 0), 0);
  const bankrTokens = results.filter(r => r.path === 'bankr-gateway' && r.success).reduce((s, r) => s + (r.tokens || 0), 0);
  const totalCost = results.filter(r => r.path === 'bankr-gateway' && r.success).reduce((s, r) => s + (r.cost || 0), 0);

  console.log(`Total queries:    ${results.length} (${allQueries.length} unique x 2 paths)`);
  console.log(`Successful:       ${veniceOk + bankrOk}/${results.length}`);
  console.log(`Venice Direct:    ${veniceOk}/52 ok, ${veniceTokens} tokens`);
  console.log(`Bankr Gateway:    ${bankrOk}/52 ok, ${bankrTokens} tokens, cost: $${totalCost.toFixed(6)}`);
  console.log(`Total tokens:     ${totalTokens}`);
  console.log(`Elapsed:          ${elapsed}s`);

  // Write evidence
  const evidencePath = path.join(__dirname, 'evidence', 'bulk-llm-usage.json');
  const evidence = {
    generatedAt: new Date().toISOString(),
    elapsedSeconds: parseFloat(elapsed),
    summary: { totalQueries: results.length, uniqueQueries: allQueries.length, totalSuccessful: veniceOk + bankrOk, totalTokens, veniceDirectQueries: veniceOk, veniceDirectTokens: veniceTokens, bankrGatewayQueries: bankrOk, bankrGatewayTokens: bankrTokens, bankrTotalCost: +totalCost.toFixed(6) },
    perType: ['bid-strategy', 'treasury-planning', 'agent-negotiation', 'human-routing'].map(type => {
      const tr = results.filter(r => r.type === type);
      return { type, total: tr.length, successful: tr.filter(r => r.success).length, tokens: tr.filter(r => r.success).reduce((s, r) => s + (r.tokens || 0), 0) };
    }),
    results,
  };
  fs.writeFileSync(evidencePath, JSON.stringify(evidence, null, 2));
  console.log(`\nEvidence written to ${evidencePath}`);
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
