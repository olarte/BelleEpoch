// scripts/beast-backfill.js — Backfill Beast's Redis from on-chain EpochCleared events
//
// Strategy: Use Blockscout's log API (no rate limits, no RPC scanning)
// to fetch all EpochCleared events, then load into Beast's Redis.
// Falls back to direct RPC with aggressive throttling if Blockscout fails.
//
// Usage: node scripts/beast-backfill.js

require('dotenv').config();
const { ethers } = require('ethers');
const Redis = require('ioredis');
const fs = require('fs');
const path = require('path');

const ADDRESSES_PATH = path.join(__dirname, '..', 'contracts', 'addresses.json');

// EpochCleared event topic hash
const EVENT_TOPIC = '0x46f4c7439e29749b49d0348ecc1dcea73dc5a9fa6dfd8efb054458c7324981bb';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ── BLOCKSCOUT LOG FETCHER ──────────────────────────────────────────────

async function fetchLogsFromBlockscout(contractAddress) {
  console.log('Fetching logs from Blockscout API...');

  const allLogs = [];
  const seen = new Set(); // deduplicate by txHash+logIndex
  let page = 1;
  let consecutive_empty = 0;

  while (true) {
    const url = `https://base.blockscout.com/api?module=logs&action=getLogs` +
      `&fromBlock=0&toBlock=latest` +
      `&address=${contractAddress}` +
      `&topic0=${EVENT_TOPIC}` +
      `&page=${page}&offset=100`;

    process.stdout.write(`  Page ${page}... `);

    let data;
    try {
      const resp = await fetch(url);
      data = await resp.json();
    } catch (err) {
      console.log(`fetch error: ${err.message}`);
      break;
    }

    if (data.status !== '1' || !Array.isArray(data.result) || data.result.length === 0) {
      console.log('empty / end of data');
      break;
    }

    let newCount = 0;
    for (const log of data.result) {
      const key = `${log.transactionHash}:${log.logIndex}`;
      if (!seen.has(key)) {
        seen.add(key);
        allLogs.push(log);
        newCount++;
      }
    }

    console.log(`${data.result.length} returned, ${newCount} new (${allLogs.length} total)`);

    // If we got zero new entries, the API is likely repeating
    if (newCount === 0) {
      consecutive_empty++;
      if (consecutive_empty >= 3) {
        console.log('  3 consecutive pages with no new data — stopping pagination');
        break;
      }
    } else {
      consecutive_empty = 0;
    }

    page++;
    await sleep(200); // be polite
  }

  return allLogs;
}

// ── DIRECT RPC FALLBACK ─────────────────────────────────────────────────

async function fetchLogsFromRPC(contractAddress, rpcProvider) {
  console.log('Falling back to direct RPC scan...');

  const currentBlock = await rpcProvider.getBlockNumber();
  console.log('Current block:', currentBlock);

  // 10-day lookback at ~2 blocks/sec
  const fromBlock = Math.max(0, currentBlock - 2 * 10 * 86400);
  console.log(`Scanning blocks ${fromBlock} to ${currentBlock}`);

  const abi = JSON.parse(fs.readFileSync(
    path.join(__dirname, '..', 'contracts', 'EpochClearingLedger.abi.json'), 'utf8'
  ));
  const contract = new ethers.Contract(contractAddress, abi, rpcProvider);

  const CHUNK = 50000; // larger chunks, fewer requests
  const allEvents = [];
  let start = fromBlock;

  while (start <= currentBlock) {
    const end = Math.min(start + CHUNK - 1, currentBlock);
    process.stdout.write(`  Blocks ${start}–${end}... `);

    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const events = await contract.queryFilter(
          contract.filters.EpochCleared(), start, end
        );
        allEvents.push(...events);
        console.log(`${events.length} events`);
        break;
      } catch (err) {
        if (attempt < 2) {
          const wait = (attempt + 1) * 3000;
          console.log(`rate limited — waiting ${wait / 1000}s...`);
          await sleep(wait);
        } else {
          console.log(`failed after 3 attempts: ${err.message}`);
        }
      }
    }

    start = end + 1;
    await sleep(500); // throttle between chunks
  }

  return allEvents;
}

// ── DECODE BLOCKSCOUT RAW LOG ───────────────────────────────────────────

function decodeBlockscoutLog(log) {
  // topics[0] = event sig, topics[1] = indexed epochId
  const epochId = parseInt(log.topics[1], 16);

  // data contains: clearingPrice (uint256), slotsFilled (uint8),
  //                totalBids (uint8), resourceId (bytes32)
  // Each is padded to 32 bytes
  const data = log.data.replace('0x', '');
  const clearingPriceRaw = BigInt('0x' + data.slice(0, 64));
  const slotsFilled      = parseInt(data.slice(64, 128), 16);
  const totalBids        = parseInt(data.slice(128, 192), 16);
  const resourceIdHex    = '0x' + data.slice(192, 256);

  const clearingPrice = parseFloat(ethers.formatUnits(clearingPriceRaw, 6));

  let resourceId;
  try {
    resourceId = ethers.decodeBytes32String(resourceIdHex).replace(/\0/g, '') || 'private-reasoning';
  } catch {
    resourceId = 'private-reasoning';
  }

  const timestamp = parseInt(log.timeStamp, 16) * 1000;

  return {
    epochId,
    clearingPrice,
    slotsFilled,
    totalBids,
    resourceId,
    timestamp,
    txHash: log.transactionHash,
    blockNumber: parseInt(log.blockNumber, 16),
  };
}

// ── MAIN ────────────────────────────────────────────────────────────────

async function main() {
  const redis = new Redis(process.env.REDIS_URL || 'redis://127.0.0.1:6379');
  const rpcProvider = new ethers.JsonRpcProvider(process.env.BASE_RPC_URL);

  const addresses = JSON.parse(fs.readFileSync(ADDRESSES_PATH, 'utf8'));
  const contractAddress = addresses.base.EpochClearingLedger;

  console.log('Beast Backfill — loading on-chain history into Redis');
  console.log('Contract:', contractAddress);
  console.log('');

  // ── STEP 1: Fetch events ──

  const rawLogs = await fetchLogsFromBlockscout(contractAddress);

  let events;
  if (rawLogs.length > 0) {
    console.log(`\nBlockscout returned ${rawLogs.length} unique events`);
    events = rawLogs.map(decodeBlockscoutLog);
  } else {
    console.log('\nBlockscout returned 0 events — trying direct RPC...');
    const rpcEvents = await fetchLogsFromRPC(contractAddress, rpcProvider);
    console.log(`RPC scan found ${rpcEvents.length} events`);

    events = [];
    for (const ev of rpcEvents) {
      const block = await rpcProvider.getBlock(ev.blockNumber);
      events.push({
        epochId:       parseInt(ev.args.epochId.toString()),
        clearingPrice: parseFloat(ethers.formatUnits(ev.args.clearingPrice, 6)),
        slotsFilled:   parseInt(ev.args.slotsFilled.toString()),
        totalBids:     parseInt(ev.args.totalBids.toString()),
        resourceId:    (() => {
          try { return ethers.decodeBytes32String(ev.args.resourceId).replace(/\0/g, '') || 'private-reasoning'; }
          catch { return 'private-reasoning'; }
        })(),
        timestamp:     block.timestamp * 1000,
        txHash:        ev.transactionHash,
        blockNumber:   ev.blockNumber,
      });
      await sleep(100);
    }
  }

  // Sort by timestamp
  events.sort((a, b) => a.timestamp - b.timestamp);

  console.log(`\nTotal events to ingest: ${events.length}`);

  if (events.length === 0) {
    console.log('\nNo events found. Check that:');
    console.log('  1. The contract address is correct');
    console.log('  2. The engine has been running with ONCHAIN_INTERVAL low enough');
    console.log(`  Current ONCHAIN_INTERVAL=${process.env.ONCHAIN_INTERVAL || '100'}`);
    console.log(`  (every ${process.env.ONCHAIN_INTERVAL || '100'}th epoch recorded on-chain)`);
    await redis.quit();
    return;
  }

  // ── STEP 2: Load into Redis ──

  const BELLE_WALLET = (
    process.env.ENGINE_WALLET_ADDRESS ||
    process.env.ENGINE_WALLET ||
    process.env.BELLE_WALLET ||
    ''
  ).toLowerCase();

  // Clear existing backfill data to avoid duplicates on re-run
  const existingProviders = await redis.smembers('beast:providers');
  for (const p of existingProviders) {
    await redis.del(`beast:prices:${p}`, `beast:stats:${p}`);
  }
  await redis.del('beast:providers', 'beast:epochs:count', 'beast:last:update');
  console.log('Cleared previous Beast data');

  let ingested = 0;
  let skipped  = 0;

  for (const ev of events) {
    // Skip zero-price epochs
    if (ev.clearingPrice === 0) { skipped++; continue; }

    // Map wallet to human-readable provider ID
    // For Blockscout logs we don't have tx.from easily, so use Belle as default
    // since this contract's engine is Belle's wallet
    const providerId = 'belle.epoch.base.eth';

    const dataPoint = JSON.stringify({
      epochId:       ev.epochId,
      clearingPrice: ev.clearingPrice,
      slotsFilled:   ev.slotsFilled,
      totalBids:     ev.totalBids,
      chain:         'base',
      resourceId:    ev.resourceId,
      ts:            ev.timestamp,
      txHash:        ev.txHash,
      blockNumber:   ev.blockNumber,
      source:        'backfill',
    });

    // Store in Beast's sorted set (score = timestamp)
    await redis.zadd(`beast:prices:${providerId}`, ev.timestamp, dataPoint);

    // Track provider
    await redis.sadd('beast:providers', providerId);

    // Push to feed:events for Beast's startup backfill
    await redis.lpush('feed:events', dataPoint);

    ingested++;

    if (ingested % 100 === 0) {
      console.log(`  Ingested ${ingested} events...`);
    }
  }

  // ── STEP 3: Compute stats from the sorted data ──

  const providers = await redis.smembers('beast:providers');
  for (const providerId of providers) {
    const raw = await redis.zrange(`beast:prices:${providerId}`, 0, -1);
    const stats = {
      count: 0, sum: 0, sumSq: 0,
      min: Infinity, max: -Infinity,
      lastPrice: null, prevPrice: null,
    };

    for (const item of raw) {
      const point = JSON.parse(item);
      const price = point.clearingPrice;

      stats.prevPrice = stats.lastPrice;
      stats.lastPrice = price;
      stats.count    += 1;
      stats.sum      += price;
      stats.sumSq    += price * price;
      stats.min       = Math.min(stats.min, price);
      stats.max       = Math.max(stats.max, price);
    }

    const mean     = stats.sum / stats.count;
    const variance = stats.count > 1
      ? (stats.sumSq - stats.count * mean * mean) / (stats.count - 1)
      : 0;
    stats.mean    = mean;
    stats.stddev  = Math.sqrt(Math.max(0, variance));
    stats.updated = new Date().toISOString();

    await redis.set(`beast:stats:${providerId}`, JSON.stringify(stats));
  }

  // Trim feed:events to last 10,000
  await redis.ltrim('feed:events', 0, 9999);

  // Set global counters
  await redis.set('beast:epochs:count', ingested.toString());
  await redis.set('beast:last:update', new Date().toISOString());

  // ── STEP 4: Report ──

  console.log('\n── Backfill complete ──────────────────────────────');
  console.log(`Events found:    ${events.length}`);
  console.log(`Ingested:        ${ingested}`);
  console.log(`Skipped (zero):  ${skipped}`);

  for (const id of providers) {
    const count = await redis.zcard(`beast:prices:${id}`);
    const stats = JSON.parse(await redis.get(`beast:stats:${id}`) || '{}');

    // Show time span
    const first = JSON.parse(await redis.zrange(`beast:prices:${id}`, 0, 0).then(r => r[0] || '{}'));
    const last  = JSON.parse(await redis.zrevrange(`beast:prices:${id}`, 0, 0).then(r => r[0] || '{}'));

    console.log(`\nProvider: ${id}`);
    console.log(`  Data points: ${count}`);
    console.log(`  Mean price:  ${stats.mean?.toFixed(6)} USDC`);
    console.log(`  Std dev:     ${stats.stddev?.toFixed(6)} USDC`);
    console.log(`  Min / Max:   ${stats.min?.toFixed(6)} / ${stats.max?.toFixed(6)} USDC`);
    if (first.ts && last.ts) {
      console.log(`  Time span:   ${new Date(first.ts).toISOString()} → ${new Date(last.ts).toISOString()}`);
    }
  }

  await redis.quit();
  console.log('\nDone.');
}

main().catch(err => {
  console.error('Backfill failed:', err);
  process.exit(1);
});
