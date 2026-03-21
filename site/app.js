/* ============================================================
   Belle Epoch — app.js
   Single-page app: data fetching, live binding, charts, simulator,
   console, marketplace, registration, skill.md rendering.
   ============================================================ */

const BelleEpoch = (() => {
  'use strict';

  // --------------- Config ---------------
  const API = window.location.hostname.includes('belleepoch.xyz')
    ? 'https://api.belleepoch.xyz'
    : window.location.origin;
  const FEED_POLL_MS     = 2000;
  const BIDS_POLL_MS     = 1000;
  const COUNTDOWN_TICK   = 100;
  const DEMO_AGENT_ID    = 'demo-agent';
  const DEMO_SIGNATURE   = '0xdemo00000000000000000000000000000000000000000000000000000000dead';

  // --------------- State ---------------
  let feedData     = null;
  let belleData    = null;
  let queueData    = null;
  let metricsData  = null;
  let countdownRef = null;
  let targetEpochMs = null;
  let currentPage  = 'home';
  let pageInited   = { home: false, agents: false, humans: false, belle: false, beast: false };
  let pollIntervals = [];

  // Humans state
  let connectedWallet = null;
  let humansFilterCategory = 'all';
  let humansFilterOnline = false;
  let humansFilterChain = null;

  const CATEGORY_ICONS = {
    'physician': '\u{1FA7A}',
    'attorney': '\u2696',
    'security-researcher': '\u{1F6E1}',
    'financial-analyst': '\u{1F4C8}',
    'data-scientist': '\u{1F9EA}',
    'other': '\u{1F464}',
  };

  const CATEGORY_LABELS = {
    'physician': 'Physician',
    'attorney': 'Attorney',
    'security-researcher': 'Security Researcher',
    'financial-analyst': 'Financial Analyst',
    'data-scientist': 'Data Scientist',
    'other': 'Other',
  };

  // --------------- Helpers ---------------

  function formatUsdc(amount) {
    if (amount == null || isNaN(amount)) return '\u2014';
    const n = Number(amount);
    if (n >= 1) return n.toFixed(2) + ' USDC';
    if (n >= 0.01) return n.toFixed(4) + ' USDC';
    return n.toFixed(6) + ' USDC';
  }

  function formatPercent(ratio) {
    if (ratio == null || isNaN(ratio)) return '\u2014';
    return (Number(ratio) * 100).toFixed(1) + '%';
  }

  function truncateAddr(addr) {
    if (!addr || addr.length < 12) return addr || '\u2014';
    return addr.slice(0, 6) + '\u2026' + addr.slice(-4);
  }

  function timeAgo(ts) {
    if (!ts) return '';
    const diff = Date.now() - new Date(ts).getTime();
    if (diff < 1000)  return 'just now';
    if (diff < 60000) return Math.floor(diff / 1000) + 's ago';
    if (diff < 3600000) return Math.floor(diff / 60000) + 'm ago';
    return Math.floor(diff / 3600000) + 'h ago';
  }

  function countryCodeToFlag(code) {
    if (!code || code.length !== 3) return '';
    const a2 = code.slice(0, 2).toUpperCase();
    return String.fromCodePoint(...[...a2].map(c => 0x1F1E6 + c.charCodeAt(0) - 65));
  }

  function $(sel, parent) { return (parent || document).querySelector(sel); }
  function $$(sel, parent) { return Array.from((parent || document).querySelectorAll(sel)); }

  // --------------- SPA Navigation ---------------

  function showPage(page) {
    currentPage = page;

    // Update tabs
    $$('.nav-tab').forEach(t => t.classList.remove('active'));
    const tab = $(`#tab-${page}`);
    if (tab) tab.classList.add('active');

    // Show/hide pages
    $$('.page').forEach(p => p.classList.remove('active'));
    const pageEl = $(`#page-${page}`);
    if (pageEl) pageEl.classList.add('active');

    // Update hash
    window.location.hash = page === 'home' ? '' : page;

    // Lazy init page
    if (!pageInited[page]) {
      pageInited[page] = true;
      if (page === 'home') initHome();
      else if (page === 'agents') initAgents();
      else if (page === 'humans') initHumans();
      else if (page === 'belle') initBelle();
      else if (page === 'beast') initBeast();
    }

    // Scroll to top
    window.scrollTo(0, 0);
  }

  // Expose globally for onclick handlers
  window.showPage = showPage;

  // --------------- Data Fetching ---------------

  async function fetchJson(path) {
    try {
      const res = await fetch(API + path);
      if (!res.ok) throw new Error(res.status);
      return await res.json();
    } catch (e) {
      console.warn('Fetch failed:', path, e.message);
      return null;
    }
  }

  async function fetchFeed() {
    const data = await fetchJson('/feed');
    if (data) {
      feedData = data;
      bindFeed(data);
    }
    return data;
  }

  async function fetchHistory(n) {
    return fetchJson('/feed/history?n=' + (n || 12));
  }

  async function fetchProviders() {
    return fetchJson('/feed/providers');
  }

  async function fetchProviderHistory(id) {
    return fetchJson('/feed/providers/' + encodeURIComponent(id) + '/history');
  }

  async function fetchAgentData(id) {
    const data = await fetchJson('/feed/agents/' + encodeURIComponent(id));
    if (data && id === 'belle') {
      belleData = data;
      bindBelle(data);
    }
    return data;
  }

  async function fetchQueue() {
    const data = await fetchJson('/feed/queue');
    if (data) {
      queueData = data;
      bindQueue(data);
    }
    return data;
  }

  async function fetchMetrics() {
    const data = await fetchJson('/feed/metrics');
    if (data) {
      metricsData = data;
      bindMetrics(data);
    }
    return data;
  }

  async function fetchEvents() {
    const data = await fetchJson('/feed/events?n=6');
    if (data) renderEventsList(data);
    return data;
  }

  async function fetchHumanProviders() {
    return fetchJson('/humans/providers');
  }

  async function fetchIdentityData() {
    const [delegation, bankr] = await Promise.all([
      fetchJson('/delegation'),
      fetchJson('/bankr/status'),
    ]);
    if (delegation) {
      const el = (id) => document.getElementById(id);
      if (el('id-max-bid') && delegation.caveats) {
        el('id-max-bid').textContent = (delegation.caveats.maxBidPerEpoch / 1e6).toFixed(3) + ' USDC';
      }
      if (el('id-daily-cap') && delegation.dailyCapUsdc != null) {
        el('id-daily-cap').textContent = delegation.dailyCapUsdc.toFixed(3) + ' USDC';
      }
      if (el('id-daily-spent') && delegation.dailySpendUsdc != null) {
        const pct = delegation.dailyCapUsdc > 0
          ? ((delegation.dailySpendUsdc / delegation.dailyCapUsdc) * 100).toFixed(0)
          : 0;
        el('id-daily-spent').textContent = delegation.dailySpendUsdc.toFixed(4) + ' USDC (' + pct + '%)';
      }
    }
    if (bankr) {
      const el = (id) => document.getElementById(id);
      if (el('id-venice-routing')) {
        el('id-venice-routing').textContent = bankr.initialized ? 'Bankr LLM Gateway' : 'Direct Venice API';
      }
      if (el('id-venice-routed') && bankr.totalRouted != null) {
        el('id-venice-routed').textContent = parseFloat(bankr.totalRouted).toFixed(4) + ' USDC';
      }
      if (el('id-venice-cost')) {
        const cost = bankr.inferenceCost || (bankr.usage && (bankr.usage.totalCost || bankr.usage.cost)) || 0;
        el('id-venice-cost').textContent = parseFloat(cost).toFixed(6) + ' USDC';
      }
      if (el('id-venice-model')) {
        el('id-venice-model').textContent = bankr.model || 'via Bankr gateway';
      }
    }
  }

  // --------------- Data Binding ---------------

  function bindFeed(data) {
    $$('[data-feed]').forEach(el => {
      const key = el.getAttribute('data-feed');
      let val = data[key];
      if (val == null && data.belle) val = data.belle[key];
      if (val == null) return;

      let display;
      if (key === 'clearingPrice') display = formatUsdc(val);
      else display = val;

      if (el.textContent !== String(display)) {
        el.textContent = display;
        el.classList.add('updating');
        setTimeout(() => el.classList.remove('updating'), 400);
      }
    });

    // countdown target
    if (data.nextEpochMs != null) {
      const newTarget = Date.now() + data.nextEpochMs;
      if (!targetEpochMs || Math.abs(newTarget - targetEpochMs) > 500) {
        targetEpochMs = newTarget;
      }
    }
  }

  function bindBelle(data) {
    const aliases = { epochsServed: 'totalWon', totalSpent: 'veniceSpend' };

    $$('[data-belle]').forEach(el => {
      const key = el.getAttribute('data-belle');
      const resolvedKey = aliases[key] || key;
      let val = data[resolvedKey];
      if (val == null && feedData && feedData.belle) val = feedData.belle[resolvedKey];
      if (val == null) return;

      let display;
      if (key === 'earnedToday' || key === 'totalSpent' || key === 'totalRouted' || key === 'veniceSpend' || key === 'spendToday')
        display = formatUsdc(val);
      else if (key === 'winRate')
        display = formatPercent(val);
      else if (key === 'address' || key === 'registrationTx')
        display = truncateAddr(val);
      else
        display = val;

      if (el.textContent !== String(display)) {
        el.textContent = display;
      }
    });

    // Update spend gauge
    if (data.earnedToday != null || data.veniceSpend != null) {
      const spent = data.earnedToday || 0;
      const cap = 2.0;
      const pct = Math.min(100, (spent / cap) * 100);
      const fill = $('#spend-gauge-fill');
      const pctEl = $('#spend-pct');
      if (fill) fill.style.width = pct.toFixed(0) + '%';
      if (pctEl) pctEl.textContent = pct.toFixed(0);
    }
  }

  function bindQueue(data) {
    $$('[data-queue]').forEach(el => {
      const key = el.getAttribute('data-queue');
      const val = data[key];
      if (val != null && el.textContent !== String(val)) {
        el.textContent = val;
      }
    });

    // Render queue items on Belle page
    renderQueueList(data);
  }

  function bindMetrics(data) {
    $$('[data-metrics]').forEach(el => {
      const key = el.getAttribute('data-metrics');
      let val = data[key];
      if (val == null) return;

      let display;
      if (key === 'usdcSettledToday') display = formatUsdc(val);
      else display = val;

      if (el.textContent !== String(display)) {
        el.textContent = display;
        el.classList.add('updating');
        setTimeout(() => el.classList.remove('updating'), 400);
      }
    });
  }

  // --------------- Events List (Home hero) ---------------

  function renderEventsList(events) {
    const container = $('#events-list');
    if (!container) return;

    if (!events || events.length === 0) {
      container.innerHTML = '<div style="text-align:center; color:var(--g30); padding:1rem; font-size:.9rem">No events yet</div>';
      return;
    }

    container.innerHTML = events.slice(0, 6).map(e => `
      <div class="event-row">
        <span class="event-epoch">#${e.epochId}</span>
        <span class="event-provider">${e.providerEns || e.provider || '\u2014'}</span>
        <span class="event-price">${formatUsdc(e.clearingPrice)}</span>
        <span class="event-time">${timeAgo(e.timestamp)}</span>
      </div>
    `).join('');
  }

  // --------------- Queue List (Belle page) ---------------

  function renderQueueList(data) {
    const container = $('#belle-queue-list');
    if (!container) return;

    const items = data && data.items ? data.items : [];
    if (items.length === 0) {
      container.innerHTML = '<div class="card" style="text-align:center; color:var(--g30); padding:2rem">No active queries. Belle is waiting.</div>';
      return;
    }

    container.innerHTML = items.map(item => {
      const typeBadge = item.type === 'bid-strategy' ? 'badge-active'
        : item.type === 'treasury-planning' ? 'badge-active'
        : item.type === 'negotiation' ? 'badge-warning'
        : 'badge-warning';
      const statusColor = item.status === 'processing' ? 'var(--redhi)'
        : item.status === 'resolved' ? 'var(--gold)'
        : 'var(--g30)';

      return `
        <div class="card queue-item" style="margin-bottom:.5rem">
          <div style="display:flex; align-items:center; gap:.75rem; flex-wrap:wrap">
            <span class="badge ${typeBadge}">${item.type || 'unknown'}</span>
            <span style="font-family:var(--mono); font-size:.85rem; color:var(--g30)">Epoch #${item.epochId || '\u2014'}</span>
            <span style="font-size:.85rem; color:${statusColor}">${item.status}</span>
            <span style="font-size:.8rem; color:var(--g30)">Venice: ${item.veniceSessionOpen ? 'open' : 'closed'}</span>
            <span style="font-size:.8rem; color:var(--g30); margin-left:auto">[REDACTED &mdash; returned once to winner]</span>
          </div>
        </div>`;
    }).join('');
  }

  // --------------- Hero CCA Demo ---------------

  const DEMO_AGENTS = [
    { id: 'ATLAS-7', base: 0.0080 },
    { id: 'belle',   base: 0.0070 },
    { id: 'NEXUS-3', base: 0.0060 },
    { id: 'FORGE-1', base: 0.0045 },
    { id: 'SIGMA-9', base: 0.0030 },
    { id: 'ECHO-4',  base: 0.0015 },
  ];
  const DEMO_PROVIDERS = ['belle.epoch', 'cortex', 'sentinel', 'dataweave', 'oracle-7', 'dr-chen'];
  let demoEpochCounter = 14209;
  let demoUsdcTotal = 47.83;
  let demoBidLog = [];

  function runDemoEpoch() {
    // Generate bids with variance
    const bids = DEMO_AGENTS.map(a => {
      const drift = 1 + (Math.random() - 0.5) * 0.4;
      return { id: a.id, bid: parseFloat((a.base * drift).toFixed(4)) };
    }).sort((a, b) => b.bid - a.bid);

    const capacity = 3;
    const winners = bids.slice(0, capacity);
    const losers = bids.slice(capacity);
    const clearingPrice = winners[winners.length - 1].bid;
    const revenue = clearingPrice * capacity;

    demoEpochCounter++;
    demoUsdcTotal = parseFloat((demoUsdcTotal + revenue).toFixed(4));

    // Build log entries
    const provider = DEMO_PROVIDERS[Math.floor(Math.random() * DEMO_PROVIDERS.length)];
    const newEntries = [];

    // Show bids arriving
    for (const b of bids) {
      const won = winners.some(w => w.id === b.id);
      newEntries.push({
        type: won ? 'win' : 'loss',
        agent: b.id,
        bid: b.bid.toFixed(4),
        price: clearingPrice.toFixed(4),
        epoch: demoEpochCounter,
        provider,
      });
    }

    // Settlement entry
    newEntries.push({
      type: 'settle',
      epoch: demoEpochCounter,
      price: clearingPrice.toFixed(4),
      slots: capacity,
      provider,
    });

    demoBidLog = [...newEntries, ...demoBidLog].slice(0, 8);

    // Update DOM
    const priceEl = document.getElementById('demo-price');
    const epochsEl = document.getElementById('demo-epochs');
    const usdcEl = document.getElementById('demo-usdc');
    if (priceEl) priceEl.textContent = clearingPrice.toFixed(4);
    if (epochsEl) epochsEl.textContent = demoEpochCounter.toLocaleString();
    if (usdcEl) usdcEl.textContent = demoUsdcTotal.toFixed(2);

    renderDemoBidStream();
  }

  function renderDemoBidStream() {
    const container = document.getElementById('demo-bid-stream');
    if (!container) return;

    container.innerHTML = demoBidLog.map(e => {
      if (e.type === 'settle') {
        return `<div class="event-row" style="color:var(--redhi)">
          <span class="event-epoch">#${e.epoch}</span>
          <span class="event-provider">${e.provider}</span>
          <span class="event-price">${e.price} USDC &times; ${e.slots}</span>
          <span class="event-time">settled</span>
        </div>`;
      }
      const color = e.type === 'win' ? 'color:#27ae60' : 'color:var(--g40)';
      const label = e.type === 'win' ? 'won' : 'lost';
      return `<div class="event-row" style="${color}">
        <span class="event-epoch" style="font-family:var(--mono);font-size:.8rem">${e.agent}</span>
        <span class="event-provider">${e.bid} USDC</span>
        <span class="event-price">${label}</span>
        <span class="event-time">#${e.epoch}</span>
      </div>`;
    }).join('');
  }

  function startDemoCCA() {
    // Run first epoch immediately
    runDemoEpoch();
    // Then every 5 seconds
    setInterval(runDemoEpoch, 5000);
  }

  // --------------- Countdown ---------------

  function startCountdown() {
    if (countdownRef) return;
    const el = $('#epoch-countdown');
    if (!el) return;

    countdownRef = setInterval(() => {
      if (!targetEpochMs) { el.textContent = '\u2014'; return; }
      const remaining = Math.max(0, targetEpochMs - Date.now());
      const sec = (remaining / 1000).toFixed(1);
      el.textContent = sec + 's';
      el.classList.toggle('imminent', remaining < 1000);
    }, COUNTDOWN_TICK);
  }

  // --------------- UTC Clock ---------------

  function startUTCClock() {
    const el = $('#utc-clock');
    if (!el) return;
    setInterval(() => {
      el.textContent = new Date().toISOString().slice(11, 19) + ' UTC';
    }, 1000);
  }

  // --------------- Sparkline ---------------

  function renderSparkline(svgEl, dataPoints) {
    if (!svgEl || !dataPoints || dataPoints.length < 2) return;
    const w = 64, h = 24;
    const min = Math.min(...dataPoints);
    const max = Math.max(...dataPoints) || 1;
    const range = max - min || 1;
    const points = dataPoints.map((v, i) => {
      const x = (i / (dataPoints.length - 1)) * w;
      const y = h - ((v - min) / range) * (h - 4) - 2;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    }).join(' ');
    svgEl.innerHTML = `<polyline points="${points}"/>`;
  }

  // --------------- Home Marketplace ---------------

  // ─── Simulated marketplace providers ──────────────────────────────────────
  // These show what a live CCA marketplace looks like — diverse agent services
  // with realistic clearing data. Belle is real; the rest are simulations.
  const SIM_PROVIDERS = [
    { id: 'belle', name: 'belle.epoch.base.eth', resource: 'private-reasoning', capacity: 3, epochMs: 5000, chain: 'base', featured: true, sim: false },
    { id: 'cortex-gpu', name: 'cortex.base.eth', resource: 'gpu-inference', capacity: 8, epochMs: 5000, chain: 'base', sim: true,
      desc: 'A100 inference slots. Llama 70B, Mixtral, SDXL.' },
    { id: 'sentinel-audit', name: 'sentinel.base.eth', resource: 'smart-contract-audit', capacity: 2, epochMs: 30000, chain: 'base', sim: true,
      desc: 'Automated Solidity audit with formal verification.' },
    { id: 'dataweave', name: 'dataweave.base.eth', resource: 'data-enrichment', capacity: 5, epochMs: 5000, chain: 'base', sim: true,
      desc: 'Real-time on-chain data enrichment and labeling.' },
    { id: 'oracle-7', name: 'oracle-7.celo.eth', resource: 'market-data', capacity: 10, epochMs: 5000, chain: 'celo', sim: true,
      desc: 'Sub-second price feeds across 200+ pairs.' },
    { id: 'dr-chen', name: 'Dr. Chen', resource: 'physician', capacity: 1, epochMs: 300000, chain: 'celo', sim: true, human: true,
      desc: 'Board-certified radiologist. Second opinions.' },
  ];

  // Generate drifting simulated prices so the market looks alive
  const simPriceState = {};
  function getSimPrice(id, base) {
    if (!simPriceState[id]) simPriceState[id] = base;
    const drift = 1 + (Math.random() - 0.5) * 0.15;
    simPriceState[id] = parseFloat((simPriceState[id] * drift).toFixed(4));
    return Math.max(0.0001, simPriceState[id]);
  }

  // Generate a plausible sparkline
  function simSparkline(base, n) {
    const pts = [];
    let v = base;
    for (let i = 0; i < n; i++) {
      v *= 1 + (Math.random() - 0.48) * 0.2;
      pts.push(Math.max(0.0001, v));
    }
    return pts;
  }

  async function renderHomeMarketplace() {
    const grid = $('#home-marketplace-grid');
    if (!grid) return;

    // Fetch real provider data from API
    let realProviders = [];
    try {
      const real = await fetchProviders();
      if (real && Array.isArray(real)) realProviders = real;
    } catch (e) { /* use defaults */ }

    const belleFeed = realProviders.find(p => p.id === 'belle');
    const beastFeed = realProviders.find(p => p.id === 'beast');

    // Base prices for sim providers
    const basePrices = {
      'belle': 0.005, 'cortex-gpu': 0.012, 'sentinel-audit': 0.045,
      'dataweave': 0.003, 'oracle-7': 0.0015, 'dr-chen': 0.08,
    };

    grid.innerHTML = '';

    // Build combined list: SIM_PROVIDERS + Beast (if live from API)
    const allProviders = [...SIM_PROVIDERS];

    // Insert Beast after Belle (position 1) if it came from the API
    if (beastFeed && !allProviders.find(p => p.id === 'beast')) {
      allProviders.splice(1, 0, {
        id: 'beast',
        name: 'beast.epoch.base.eth',
        resource: 'market-intelligence',
        capacity: beastFeed.capacity || 5,
        epochMs: beastFeed.epochMs || 30000,
        chain: 'base',
        featured: false,
        sim: false,
        desc: 'Market intelligence for Belle Epoch. Price history, demand signals, provider comparison.',
      });
    }

    for (const p of allProviders) {
      const card = document.createElement('div');
      card.className = 'card provider-card';
      if (p.featured) card.classList.add('featured');

      // Beast gets gold avatar, others keep default
      const initial = p.id === 'beast' ? 'B' : (p.name || '?')[0].toUpperCase();
      const avatarStyle = p.id === 'beast'
        ? 'background:var(--gold,#d4a017);color:#111'
        : '';

      const price = p.id === 'belle' && belleFeed ? belleFeed.clearingPrice
                  : p.id === 'beast' && beastFeed ? (beastFeed.clearingPrice || getSimPrice(p.id, 0.003))
                  : getSimPrice(p.id, basePrices[p.id] || 0.005);
      const filled = p.id === 'belle' && belleFeed ? belleFeed.slotsFilled
                   : p.id === 'beast' && beastFeed ? (beastFeed.slotsFilled || 0)
                   : Math.floor(Math.random() * (p.capacity + 1));
      const epochLabel = p.epochMs >= 60000 ? (p.epochMs / 60000) + 'min' : (p.epochMs / 1000) + 's';

      const badges = [];
      if (p.featured) badges.push('<span class="badge badge-warning" style="font-size:.75rem">Featured</span>');
      if (p.id === 'beast') badges.push('<span class="badge" style="font-size:.7rem;border:1px solid var(--gold,#d4a017);color:var(--gold,#d4a017)">Market Intel</span>');
      else if (p.sim) badges.push('<span class="badge badge-chain" style="font-size:.7rem">SIM</span>');
      if (p.human) badges.push('<span class="badge badge-verified" style="font-size:.75rem">Self Verified</span>');

      card.innerHTML = `
        <div class="provider-header">
          <div class="provider-avatar" ${avatarStyle ? 'style="' + avatarStyle + '"' : ''}>${initial}</div>
          <div>
            <h3 style="margin-bottom:.15rem">${p.name}</h3>
            <span style="font-size:.85rem; color:var(--g30)">${p.resource}</span>
            <div style="margin-top:.25rem">${badges.join(' ')}</div>
          </div>
        </div>
        ${p.desc ? '<p style="font-size:.82rem; color:var(--g30); margin:.5rem 0">' + p.desc + '</p>' : ''}
        <div class="provider-stats">
          <div>
            <div class="provider-stat-label">Clearing Price</div>
            <div class="provider-stat-value" style="color:${p.id === 'beast' ? 'var(--gold,#d4a017)' : 'var(--redhi)'}">${formatUsdc(price)}</div>
          </div>
          <div>
            <div class="provider-stat-label">Capacity</div>
            <div class="provider-stat-value">${p.capacity}</div>
          </div>
          <div>
            <div class="provider-stat-label">Epoch</div>
            <div class="provider-stat-value">${epochLabel}</div>
          </div>
          <div>
            <div class="provider-stat-label">${p.id === 'beast' ? 'Ingested' : 'Filled'}</div>
            <div class="provider-stat-value">${p.id === 'beast' && beastFeed ? (beastFeed.epochsIngested || 0) : filled + ' / ' + p.capacity}</div>
          </div>
        </div>
        <div class="sparkline"><svg viewBox="0 0 64 24" data-sparkline-id="${p.id}"></svg></div>
        <button class="btn btn-primary btn-sm" style="width:100%; margin-top:.75rem" onclick="showPage('${p.id === 'beast' ? 'beast' : 'belle'}')">${p.id === 'beast' ? 'View Beast' : 'Bid Now'} &rarr;</button>
      `;

      grid.appendChild(card);

      // Sparkline — real data for Belle/Beast, simulated for others
      if (p.id === 'belle' || p.id === 'beast') {
        fetchProviderHistory(p.id).then(hist => {
          if (!hist || !Array.isArray(hist)) {
            // Fallback sim sparkline
            const svg = $(`[data-sparkline-id="${p.id}"]`);
            if (svg) renderSparkline(svg, simSparkline(basePrices[p.id] || 0.003, 12));
            return;
          }
          const svg = $(`[data-sparkline-id="${p.id}"]`);
          if (svg) renderSparkline(svg, hist.map(h => Number(h.clearingPrice || 0)));
        });
      } else {
        const svg = $(`[data-sparkline-id="${p.id}"]`);
        if (svg) renderSparkline(svg, simSparkline(basePrices[p.id] || 0.005, 12));
      }
    }

    // Ghost card
    const ghost = document.createElement('div');
    ghost.className = 'card provider-card ghost-card';
    ghost.innerHTML = `
      <div style="text-align:center; padding:2rem 1rem">
        <h3 style="color:var(--g30)">Your service here</h3>
        <div class="terminal" style="font-size:.85rem; margin:.75rem 0">curl -s belleepoch.xyz/skill.md | launch</div>
        <p style="font-size:.85rem; color:var(--g30)">Click to register</p>
      </div>
    `;
    ghost.addEventListener('click', () => showPage('agents'));
    grid.appendChild(ghost);
  }

  // --------------- Simulator ---------------

  async function runSimulator() {
    const btn = $('#btn-run-simulator');
    if (!btn) return;
    btn.disabled = true;
    btn.textContent = 'Running\u2026';

    const steps = $$('.sim-step');
    steps.forEach(s => { s.classList.remove('active', 'done'); s.querySelector('[data-sim]').textContent = ''; });

    const feed = await fetchFeed();

    async function activateStep(n, dataText, delay) {
      return new Promise(resolve => {
        setTimeout(() => {
          steps.forEach(s => {
            const sn = parseInt(s.dataset.step);
            if (sn < n) s.classList.add('done');
            s.classList.toggle('active', sn === n);
          });
          const dataEl = $(`[data-sim="${n}"]`);
          if (dataEl && dataText) dataEl.textContent = dataText;
          resolve();
        }, delay);
      });
    }

    const epochId = feed ? feed.epochId : '\u2014';
    const cap     = feed ? feed.capacity : '\u2014';
    const bids    = feed ? feed.totalBids : '\u2014';
    const price   = feed ? formatUsdc(feed.clearingPrice) : '\u2014';
    const filled  = feed ? feed.slotsFilled : '\u2014';

    await activateStep(1, `Epoch #${epochId} opened`, 0);
    await activateStep(2, `${cap} slots available`, 800);
    await activateStep(3, `${bids} bids received`, 1200);
    await activateStep(4, `Accepting no more bids`, 1000);
    await activateStep(5, `Ranked ${bids} bids`, 800);
    await activateStep(6, `Clearing price: ${price}`, 1000);
    await activateStep(7, `${filled} winners settled via x402. EpochCleared emitted.`, 1200);

    btn.disabled = false;
    btn.textContent = 'Run Demo';
  }

  // --------------- Console (Belle page) ---------------

  let consoleRunning = false;

  function consolePrint(container, text, cls) {
    const cursor = container.querySelector('.console-cursor');
    const line = document.createElement('div');
    line.className = 'console-line ' + (cls || '');
    line.innerHTML = '<span class="prefix"></span>' + text;
    container.insertBefore(line, cursor);
    container.scrollTop = container.scrollHeight;
  }

  async function runConsoleDemo(queryType) {
    if (consoleRunning) return;
    consoleRunning = true;
    const container = $('#belle-console');
    const btn = $('#btn-run-console');
    if (!container || !btn) return;
    btn.disabled = true;

    // Show console
    container.style.display = '';
    container.querySelectorAll('.console-line').forEach(l => l.remove());

    const delay = ms => new Promise(r => setTimeout(r, ms));

    consolePrint(container, `Connecting to Belle Epoch at ${API}\u2026`, 'info');
    await delay(400);

    consolePrint(container, 'Reading current epoch from /feed\u2026', 'info');
    const feed = await fetchFeed();
    if (feed) {
      consolePrint(container, `Epoch #${feed.epochId} | Price: ${formatUsdc(feed.clearingPrice)} | Slots: ${feed.slotsFilled}/${feed.capacity}`, 'success');
    } else {
      consolePrint(container, 'Could not reach /feed \u2014 using cached data', 'error');
    }
    await delay(300);

    consolePrint(container, 'Executing real x402 settlement on Base mainnet\u2026', 'info');
    consolePrint(container, '<span class="console-spinner"></span> Transferring USDC + querying Venice AI (this takes 10\u201320s)\u2026', 'info');

    let demoData = null;

    try {
      const customPrompt = ($('#console-prompt') || {}).value || '';
      const res = await fetch(API + '/demo/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ queryType, prompt: customPrompt || undefined }),
      });

      const data = await res.json();

      if (!res.ok) {
        consolePrint(container, `Error: ${data.error || 'Demo failed'}`, 'error');
        btn.disabled = false;
        consoleRunning = false;
        return;
      }

      demoData = data;

      // Remove spinner line
      const spinnerLine = container.querySelector('.console-spinner');
      if (spinnerLine) spinnerLine.closest('.console-line').remove();

      // Display each step in console
      for (const step of data.steps) {
        await delay(300);

        if (step.name === 'epoch') {
          consolePrint(container,
            `<strong>Step 1 \u2014 Epoch Found</strong>  ` +
            `#${step.epochId} | ${formatUsdc(step.clearingPrice)} | ` +
            `${step.slotsFilled}/${step.totalBids} slots`,
            'success');
        }

        else if (step.name === 'transfer') {
          consolePrint(container,
            `<strong>Step 2 \u2014 USDC Transfer</strong>  ` +
            `${step.amount} USDC | Block ${step.blockNumber} | ` +
            `<a href="${step.baseScanUrl}" target="_blank" rel="noopener" style="color:var(--accent)">${step.txHash.slice(0, 14)}\u2026</a>`,
            'result');
        }

        else if (step.name === 'settlement') {
          consolePrint(container,
            step.verified
              ? `<strong>Step 3 \u2014 x402 Verified</strong>  On-chain payment confirmed. Token issued.`
              : `<strong>Step 3</strong>  Payment verification failed`,
            step.verified ? 'success' : 'error');
        }

        else if (step.name === 'query') {
          consolePrint(container,
            `<strong>Step 4 \u2014 Venice Query</strong>  ${step.type} via ${step.routedVia}`,
            'info');
        }

        else if (step.name === 'result') {
          consolePrint(container,
            step.result
              ? `<strong>Step 5 \u2014 Result</strong>  retained: ${step.retained} | proof: ${(step.veniceProof || '').slice(0, 16)}\u2026`
              : `<strong>Step 5</strong>  Processing (Venice can take up to 30s)`,
            step.result ? 'result' : 'info');
        }
      }

      await delay(200);
      consolePrint(container,
        `\u2713 <strong>Complete.</strong> Real USDC. Real Venice. Nothing simulated. (${(data.totalTimeMs / 1000).toFixed(1)}s)`,
        'success');

    } catch (err) {
      consolePrint(container, `Network error: ${err.message}`, 'error');
    }

    btn.disabled = false;
    consoleRunning = false;

    // Populate the on-chain proof section below
    if (demoData) renderDemoProof(demoData);
  }

  // --------------- On-Chain Proof Panel ---------------

  function renderDemoProof(data) {
    const section = $('#demo-proof-section');
    const content = $('#demo-proof-content');
    if (!section || !content) return;

    const steps = data.steps || [];
    const epoch   = steps.find(s => s.name === 'epoch');
    const transfer = steps.find(s => s.name === 'transfer');
    const settle  = steps.find(s => s.name === 'settlement');
    const query   = steps.find(s => s.name === 'query');
    const result  = steps.find(s => s.name === 'result');

    let html = '';

    // Header row
    html += `<div style="display:flex;align-items:center;gap:.75rem;margin-bottom:1.25rem;flex-wrap:wrap">`;
    html += `<span class="badge badge-verified">VERIFIED ON-CHAIN</span>`;
    html += `<span style="color:var(--g30);font-size:.85rem">${new Date().toISOString().replace('T', ' ').slice(0, 19)} UTC</span>`;
    html += `<span style="color:var(--g30);font-size:.85rem">${(data.totalTimeMs / 1000).toFixed(1)}s total</span>`;
    html += `</div>`;

    // Grid of proof items
    html += `<div class="identity-grid identity-grid-3" style="gap:1.25rem">`;

    // Clearing Epoch
    if (epoch) {
      html += `<div class="identity-item">`;
      html += `<h4>Clearing Epoch</h4>`;
      html += proofRow('Epoch ID', `#${epoch.epochId}`);
      html += proofRow('Clearing Price', formatUsdc(epoch.clearingPrice));
      html += proofRow('Slots Filled', `${epoch.slotsFilled} / ${epoch.totalBids}`);
      html += proofRow('Winner', epoch.winnerAgent);
      html += `</div>`;
    }

    // USDC Transfer
    if (transfer) {
      html += `<div class="identity-item">`;
      html += `<h4>x402 USDC Settlement</h4>`;
      html += proofRow('Amount', `${transfer.amount} USDC`);
      html += proofRow('Block', transfer.blockNumber);
      html += proofRow('From', proofAddr(transfer.from));
      html += proofRow('To', proofAddr(transfer.to));
      html += proofRow('Transaction', proofTxLink(transfer.txHash));
      html += `</div>`;
    }

    // Venice / Bankr Query
    html += `<div class="identity-item">`;
    html += `<h4>Venice AI Query</h4>`;
    if (query) {
      html += proofRow('Type', query.type);
      html += proofRow('Query ID', `<code style="font-size:.8em">${query.queryId}</code>`);
      html += proofRow('Routed Via', query.routedVia);
    }
    if (settle) {
      html += proofRow('x402 Verified', settle.verified ? '<span style="color:var(--green)">Yes</span>' : '<span style="color:var(--redhi)">No</span>');
    }
    if (result) {
      html += proofRow('Data Retained', `<strong>${result.retained}</strong>`);
      if (result.veniceProof) {
        html += proofRow('Proof Hash', `<code style="font-size:.75em;word-break:break-all">${result.veniceProof}</code>`);
      }
    }
    html += `</div>`;

    html += `</div>`; // close grid

    // Venice response (full output)
    if (result && result.result) {
      const resultStr = typeof result.result === 'string'
        ? result.result
        : JSON.stringify(result.result, null, 2);
      html += `<div style="margin-top:1.25rem">`;
      html += `<h4 style="margin-bottom:.5rem">Venice AI Response</h4>`;
      html += `<pre style="background:var(--bg);border:1px solid var(--g50);border-radius:8px;padding:1rem;white-space:pre-wrap;font-size:.8rem;color:var(--g10);max-height:400px;overflow:auto">${escapeHtml(resultStr)}</pre>`;
      html += `</div>`;
    }

    // Direct BaseScan links at the bottom
    if (transfer) {
      html += `<div style="margin-top:1.25rem;padding-top:1rem;border-top:1px solid var(--g50)">`;
      html += `<h4 style="margin-bottom:.5rem">Verify On-Chain</h4>`;
      html += `<div style="display:flex;flex-direction:column;gap:.4rem">`;
      html += `<a href="${transfer.baseScanUrl}" target="_blank" rel="noopener" style="color:var(--accent);font-size:.9rem">BaseScan: USDC Transfer \u2197</a>`;
      html += `<span style="color:var(--g30);font-size:.8rem;word-break:break-all;font-family:var(--mono)">${transfer.txHash}</span>`;
      html += `</div>`;
      html += `</div>`;
    }

    content.innerHTML = html;
    section.style.display = '';
    section.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function proofRow(label, value) {
    return `<div class="identity-row"><span class="identity-label">${label}</span><span class="value">${value}</span></div>`;
  }

  function proofAddr(addr) {
    if (!addr) return '\u2014';
    return `<a href="https://basescan.org/address/${addr}" target="_blank" rel="noopener" style="color:var(--g10)">${addr.slice(0, 6)}\u2026${addr.slice(-4)}</a>`;
  }

  function proofTxLink(hash) {
    if (!hash) return '\u2014';
    return `<a href="https://basescan.org/tx/${hash}" target="_blank" rel="noopener" style="color:var(--accent)">${hash.slice(0, 10)}\u2026${hash.slice(-6)}</a>`;
  }

  function escapeHtml(str) {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function scrollToConsole(queryType) {
    // Switch to Belle page if not already there
    if (currentPage !== 'belle') showPage('belle');
    // Update hidden select
    const select = $('#console-query-type');
    if (select) select.value = queryType;
    // Update active chip
    $$('.prompt-chip').forEach(c => {
      c.classList.toggle('active', c.dataset.qtype === queryType);
    });
    // Scroll and focus
    const section = $('#console-section');
    if (section) section.scrollIntoView({ behavior: 'smooth' });
    const textarea = $('#console-prompt');
    if (textarea) setTimeout(() => textarea.focus(), 400);
  }

  // --------------- Human Epoch Demo Modal ---------------

  const HUMAN_DEMO_QUERIES = {
    'physician': [
      { agent: 'ATLAS-7', text: 'Patient is a 42-year-old male presenting with persistent chest tightness, elevated troponin (0.08 ng/mL), and a normal ECG. History of anxiety disorder. Should I escalate to cath lab or observe with serial troponins? Need decision in 15 minutes.' },
      { agent: 'NEXUS-3', text: 'Agent managing a health insurance risk model. Need clinical interpretation: is a fasting glucose of 118 mg/dL in a 35-year-old with BMI 27 grounds for pre-diabetic classification? What follow-up labs should the model recommend?' },
    ],
    'attorney': [
      { agent: 'FORGE-1', text: 'We deployed a token with a fee-on-transfer mechanism. SEC just sent an informal inquiry. Is the token a security under Howey? What should we disclose vs. withhold in our response?' },
      { agent: 'ATLAS-7', text: 'Our DAO voted to migrate treasury from Ethereum to Base. Three token holders in the EU are claiming GDPR applies to on-chain governance votes. Do they have standing?' },
    ],
    'security-researcher': [
      { agent: 'SIGMA-9', text: 'Found a potential reentrancy vector in a lending protocol\'s liquidation function. The callback happens before state update but there\'s a mutex guard. Can the mutex be bypassed via a flash loan that triggers a different entry point?' },
      { agent: 'ATLAS-7', text: 'Our bridge relayer was compromised. Attacker has the hot wallet key but hasn\'t moved funds yet. We have a 2-of-3 multisig timelock. What\'s the fastest way to rotate keys without triggering the attacker?' },
    ],
    'financial-analyst': [
      { agent: 'NEXUS-3', text: 'Evaluating a DeFi yield strategy: deposit USDC into Aave on Base, borrow ETH at 3.2%, loop 2x. Current Aave utilization is 78%. What\'s the liquidation risk if ETH drops 15% in 4 hours?' },
      { agent: 'FORGE-1', text: 'Our treasury holds 500K USDC across 3 chains. Need an optimal allocation model that maximizes yield while keeping 48-hour liquidity above 200K. Factor in bridge risk.' },
    ],
    'data-scientist': [
      { agent: 'ATLAS-7', text: 'Training an MEV prediction model on 90 days of Base mempool data. Getting high variance on block-level predictions. Should I switch from LSTM to transformer architecture, or is the issue more likely data leakage from the target variable?' },
      { agent: 'SIGMA-9', text: 'Need to detect wash trading in our DEX analytics. Current approach uses graph clustering on address pairs. False positive rate is 34%. What features would improve precision without sacrificing recall below 70%?' },
    ],
  };

  let humanDemoRunning = false;

  function openHumanDemo(providerIndex) {
    if (humanDemoRunning) return;
    const providers = window._humansFiltered;
    if (!providers || !providers[providerIndex]) return;

    const provider = providers[providerIndex];
    const modal = $('#human-demo-modal');
    if (!modal) return;

    humanDemoRunning = true;
    modal.style.display = '';

    // Set header
    const icon = CATEGORY_ICONS[provider.category] || CATEGORY_ICONS.other;
    const label = CATEGORY_LABELS[provider.category] || provider.category;
    $('#hdm-icon').textContent = icon;
    $('#hdm-title').textContent = label;

    // Reset phases
    $('#hdm-auction').style.display = '';
    $('#hdm-queries').style.display = 'none';
    $('#hdm-earnings').style.display = 'none';

    // Clear console
    const con = $('#hdm-console');
    con.querySelectorAll('.console-line').forEach(l => l.remove());

    // Run the demo
    runHumanDemo(provider, con);
  }

  function closeHumanDemo() {
    const modal = $('#human-demo-modal');
    if (modal) modal.style.display = 'none';
    humanDemoRunning = false;
  }

  async function runHumanDemo(provider, con) {
    const delay = ms => new Promise(r => setTimeout(r, ms));
    const print = (text, cls) => consolePrint(con, text, cls);
    const price = provider.currentClearingPrice || 0.42;
    const slots = provider.capacitySlots || 2;
    const category = provider.category || 'physician';

    // Phase 1: Auction animation
    print('Epoch opening\u2026', 'info');
    await delay(600);
    print(`Provider: <strong>${CATEGORY_LABELS[category] || category}</strong> | Capacity: ${slots} slots | Chain: ${(provider.chain || 'celo').toUpperCase()}`, 'success');
    await delay(500);

    // Simulate bids arriving
    const bidders = ['ATLAS-7', 'NEXUS-3', 'FORGE-1', 'SIGMA-9', 'ECHO-4'];
    const bids = bidders.map(id => ({
      id,
      amount: parseFloat((price * (0.6 + Math.random() * 0.8)).toFixed(4)),
    }));

    print('Sealed bids arriving\u2026', 'info');
    for (const b of bids) {
      await delay(300);
      print(`\u2192 ${b.id} bid received`, 'info');
    }
    await delay(400);

    // Sort and clear
    bids.sort((a, b) => b.amount - a.amount);
    const winners = bids.slice(0, slots);
    const clearingPrice = winners[winners.length - 1].amount;

    print(`Epoch closed. ${bids.length} bids ranked.`, 'info');
    await delay(500);
    print(`Clearing price: <strong>${formatUsdc(clearingPrice)}</strong> | Winners: ${winners.map(w => w.id).join(', ')}`, 'success');
    await delay(400);

    // x402 settlement
    for (const w of winners) {
      await delay(300);
      print(`x402: ${w.id} paid ${formatUsdc(clearingPrice)} USDC`, 'result');
    }
    await delay(400);
    print('\u2713 All winners settled. Queries incoming.', 'success');
    await delay(800);

    // Phase 2: Show queries
    $('#hdm-auction').style.display = 'none';
    $('#hdm-queries').style.display = '';

    const queries = (HUMAN_DEMO_QUERIES[category] || HUMAN_DEMO_QUERIES['physician']).slice(0, slots);
    const queryList = $('#hdm-query-list');
    const countBadge = $('#hdm-q-count');
    let answered = 0;

    countBadge.textContent = `0 / ${queries.length} answered`;
    queryList.innerHTML = '';

    // Render all query cards
    queries.forEach((q, i) => {
      const card = document.createElement('div');
      card.className = 'hdm-query-card' + (i === 0 ? ' active' : '');
      card.id = 'hdm-qcard-' + i;
      card.innerHTML = `
        <div class="hdm-query-from">${q.agent} &mdash; paid ${formatUsdc(clearingPrice)}</div>
        <div class="hdm-query-text">${q.text}</div>
        <div class="hdm-response-wrap" id="hdm-resp-${i}">
          <textarea class="hdm-response-input" id="hdm-input-${i}" rows="2" placeholder="Type your response\u2026" ${i > 0 ? 'disabled' : ''}></textarea>
          <button class="hdm-response-send" id="hdm-send-${i}" ${i > 0 ? 'disabled' : ''} onclick="BelleEpoch.submitHumanResponse(${i})">Send</button>
        </div>
      `;
      // Enter to submit response
      const textarea = card.querySelector(`#hdm-input-${i}`);
      if (textarea) {
        textarea.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            const btn = $(`#hdm-send-${i}`);
            if (btn && !btn.disabled) btn.click();
          }
        });
      }
      queryList.appendChild(card);
    });

    // Focus first input
    const firstInput = $('#hdm-input-0');
    if (firstInput) setTimeout(() => firstInput.focus(), 200);

    // Store state for response handler
    window._hdmState = { queries, clearingPrice, answered: 0, total: queries.length };
  }

  function submitHumanResponse(index) {
    const state = window._hdmState;
    if (!state) return;

    const input = $(`#hdm-input-${index}`);
    const sendBtn = $(`#hdm-send-${index}`);
    const card = $(`#hdm-qcard-${index}`);
    if (!input || !input.value.trim()) return;

    // Mark as done
    sendBtn.disabled = true;
    input.disabled = true;
    card.classList.remove('active');
    card.classList.add('done');

    // Replace response area with confirmation
    const respWrap = $(`#hdm-resp-${index}`);
    respWrap.innerHTML = `<div class="hdm-done-badge">\u2713 Response sent &mdash; ${formatUsdc(state.clearingPrice)} earned</div>`;

    state.answered++;
    const countBadge = $('#hdm-q-count');
    countBadge.textContent = `${state.answered} / ${state.total} answered`;

    // Activate next card
    const nextIndex = index + 1;
    if (nextIndex < state.total) {
      const nextCard = $(`#hdm-qcard-${nextIndex}`);
      const nextInput = $(`#hdm-input-${nextIndex}`);
      const nextSend = $(`#hdm-send-${nextIndex}`);
      if (nextCard) nextCard.classList.add('active');
      if (nextInput) { nextInput.disabled = false; setTimeout(() => nextInput.focus(), 100); }
      if (nextSend) nextSend.disabled = false;
    }

    // All done → show earnings
    if (state.answered >= state.total) {
      setTimeout(() => showHumanEarnings(state), 600);
    }
  }

  function showHumanEarnings(state) {
    $('#hdm-queries').style.display = 'none';
    $('#hdm-earnings').style.display = '';

    const totalEarned = state.clearingPrice * state.total;
    const protocolFee = totalEarned * 0.015;
    const netEarned = totalEarned - protocolFee;

    $('#hdm-total-earned').textContent = formatUsdc(netEarned);
    $('#hdm-breakdown').innerHTML = `
      <div>
        <div class="stat-value">${state.total}</div>
        <div class="stat-label">Queries answered</div>
      </div>
      <div>
        <div class="stat-value">${formatUsdc(state.clearingPrice)}</div>
        <div class="stat-label">Clearing price</div>
      </div>
      <div>
        <div class="stat-value">${formatUsdc(protocolFee)}</div>
        <div class="stat-label">Protocol fee (1.5%)</div>
      </div>
    `;
  }

  // --------------- Belle Epoch History Table ---------------

  async function renderBelleEpochTable() {
    const tbody = $('#belle-epoch-tbody');
    if (!tbody) return;

    const history = await fetchHistory(20);
    if (!history || !Array.isArray(history) || history.length === 0) {
      tbody.innerHTML = '<tr><td colspan="6" style="text-align:center; color:var(--g30)">No epoch data available</td></tr>';
      return;
    }

    const FEE_RATE = 0.015;

    tbody.innerHTML = history.map(ep => {
      const winners = ep.winners || [];
      const slots = ep.slotsFilled || 0;
      const price = ep.clearingPrice || 0;
      const winnersStr = winners.map(w =>
        `<span style="color:var(--g30)">${w}</span>`
      ).join(', ');

      // Belle earns provider share = revenue - protocol fee
      const belleEarned = slots > 0 ? price * slots * (1 - FEE_RATE) : 0;

      return `<tr>
        <td>#${ep.epochId}</td>
        <td>${formatUsdc(price)}</td>
        <td>${slots} / ${ep.totalBids || 0}</td>
        <td style="font-size:.85rem">${winnersStr || '\u2014'}</td>
        <td style="color:${belleEarned > 0 ? 'var(--green)' : 'var(--g40)'}">${belleEarned > 0 ? formatUsdc(belleEarned) : '\u2014'}</td>
        <td style="color:var(--g30);font-size:.85rem">${ep.timestamp ? timeAgo(ep.timestamp) : '\u2014'}</td>
      </tr>`;
    }).join('');
  }

  // --------------- skill.md Rendering ---------------

  async function loadSkillMd() {
    const container = $('#skillmd-content');
    if (!container) return;

    try {
      const res = await fetch(API + '/skill.md');
      const text = await res.text();
      container.innerHTML = renderMarkdown(text);
    } catch {
      container.innerHTML = '<p style="color:var(--g30)">Failed to load skill.md</p>';
    }

    // Nav link click handlers
    $$('.skillmd-nav-link').forEach(link => {
      link.addEventListener('click', (e) => {
        e.preventDefault();
        $$('.skillmd-nav-link').forEach(l => l.classList.remove('active'));
        link.classList.add('active');
        const sec = link.dataset.skillsec;
        const target = container.querySelector(`[data-section="${sec}"]`);
        if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    });
  }

  function renderMarkdown(md) {
    // Simple markdown renderer for skill.md
    const sectionMap = {
      'Overview': 'overview',
      'Quick Start': 'quick-start',
      'Register as a Provider': 'register',
      'Endpoints Reference': 'endpoints',
      'Identity': 'identity',
      'Settlement': 'settlement',
      'Network': 'network',
    };

    let html = '';
    let inCodeBlock = false;
    let codeContent = '';
    const lines = md.split('\n');

    for (const line of lines) {
      if (line.startsWith('```')) {
        if (inCodeBlock) {
          html += `<pre class="code-block"><code>${escapeHtml(codeContent.trim())}</code></pre>`;
          codeContent = '';
          inCodeBlock = false;
        } else {
          inCodeBlock = true;
        }
        continue;
      }

      if (inCodeBlock) {
        codeContent += line + '\n';
        continue;
      }

      if (line.startsWith('# ')) {
        html += `<h2 class="skillmd-h1">${escapeHtml(line.slice(2))}</h2>`;
      } else if (line.startsWith('## ')) {
        const title = line.slice(3);
        const secId = sectionMap[title] || title.toLowerCase().replace(/\s+/g, '-');
        html += `<h3 class="skillmd-h2" data-section="${secId}">${escapeHtml(title)}</h3>`;
      } else if (line.startsWith('### ')) {
        html += `<h4 class="skillmd-h3">${escapeHtml(line.slice(4))}</h4>`;
      } else if (line.startsWith('| ')) {
        // Table row
        const cells = line.split('|').filter(c => c.trim()).map(c => c.trim());
        if (cells.every(c => /^-+$/.test(c))) {
          // separator row, skip
        } else if (html.indexOf('<table') === -1 || html.lastIndexOf('</table>') > html.lastIndexOf('<table')) {
          // Start new table
          html += '<table class="table skillmd-table"><thead><tr>' + cells.map(c => `<th>${escapeHtml(c)}</th>`).join('') + '</tr></thead><tbody>';
        } else {
          html += '<tr>' + cells.map(c => `<td>${escapeHtml(c)}</td>`).join('') + '</tr>';
        }
      } else if (line.trim() === '' && html.includes('<tbody>') && !html.endsWith('</table>')) {
        html += '</tbody></table>';
      } else if (line.startsWith('- ')) {
        html += `<div class="skillmd-list-item">&bull; ${escapeHtml(line.slice(2))}</div>`;
      } else if (line.trim() === '') {
        html += '<div style="height:.75rem"></div>';
      } else {
        // Inline code
        const processed = escapeHtml(line).replace(/`([^`]+)`/g, '<code class="inline-code">$1</code>');
        html += `<p class="skillmd-p">${processed}</p>`;
      }
    }

    // Close any open table
    if (html.includes('<tbody>') && !html.endsWith('</table>')) {
      html += '</tbody></table>';
    }

    return html;
  }

  function escapeHtml(str) {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // --------------- Agent Registration ---------------

  function initAgentRegistration() {
    // Live card preview updates
    const ensInput = $('#reg-ens');
    const resourceSelect = $('#reg-resource-type');
    const slotsInput = $('#reg-slots');

    function updatePreview() {
      const name = ensInput ? ensInput.value.trim() : '';
      const resource = resourceSelect ? resourceSelect.value : '';
      const slots = slotsInput ? slotsInput.value : '3';

      const previewName = $('#reg-preview-name');
      const previewResource = $('#reg-preview-resource');
      const previewAvatar = $('#reg-preview-avatar');
      const previewSlots = $('#reg-preview-slots');

      if (previewName) previewName.textContent = name || 'your-agent.base.eth';
      if (previewResource) previewResource.textContent = resource || 'Select a resource type';
      if (previewAvatar) previewAvatar.textContent = (name || '?')[0].toUpperCase();
      if (previewSlots) previewSlots.textContent = slots;
    }

    if (ensInput) ensInput.addEventListener('input', updatePreview);
    if (resourceSelect) resourceSelect.addEventListener('change', updatePreview);
    if (slotsInput) slotsInput.addEventListener('input', updatePreview);

    // Terminal CTA copy-to-clipboard
    const termCta = $('#home-terminal-cta');
    if (termCta) {
      termCta.style.cursor = 'pointer';
      termCta.addEventListener('click', () => {
        navigator.clipboard.writeText('curl -s belleepoch.xyz/skill.md | launch').then(() => {
          const cmd = termCta.querySelector('.terminal-command');
          const original = cmd.textContent;
          cmd.textContent = 'Copied!';
          cmd.style.color = 'var(--redhi)';
          setTimeout(() => { cmd.textContent = original; cmd.style.color = ''; }, 1500);
        });
      });
    }

    // MetaMask delegation button
    const mmBtn = $('#btn-mm-delegate');
    if (mmBtn) {
      mmBtn.addEventListener('click', async () => {
        const provider = getProvider();
        if (!provider) {
          alert('MetaMask is required for delegation.');
          return;
        }
        try {
          await provider.request({ method: 'eth_requestAccounts' });
          alert('MetaMask delegation configured (ERC-7715). In production, this would call wallet_grantPermissions.');
        } catch (e) {
          console.error('MetaMask error:', e);
        }
      });
    }

    // Launch CCA button
    const launchBtn = $('#btn-launch-cca');
    if (launchBtn) {
      launchBtn.addEventListener('click', async () => {
        const msg = $('#agent-register-message');
        msg.className = 'form-message';
        msg.style.display = 'none';

        const agentId = $('#reg-ens').value.trim();
        const resource = $('#reg-resource-type').value;
        const capacity = parseInt($('#reg-slots').value, 10);

        if (!agentId || !resource) {
          msg.className = 'form-message error';
          msg.textContent = 'Please fill in ENS and resource type.';
          msg.style.display = 'block';
          return;
        }

        try {
          const res = await fetch(API + '/providers/register', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              agentId,
              resource,
              capacity: capacity || 3,
              epochMs: parseInt($('#reg-epoch-dur').value, 10) || 5000,
              selfAttestationProof: 'self-zk-' + Date.now().toString(36),
            })
          });
          const json = await res.json().catch(() => ({}));

          if (res.ok) {
            msg.className = 'form-message success';
            msg.textContent = 'Registered! Your provider will appear in the marketplace within 30 seconds.';
            msg.style.display = 'block';
            setTimeout(() => renderHomeMarketplace(), 5000);
          } else {
            msg.className = 'form-message error';
            msg.textContent = json.error || 'Registration failed.';
            msg.style.display = 'block';
          }
        } catch (err) {
          msg.className = 'form-message error';
          msg.textContent = 'Network error: ' + err.message;
          msg.style.display = 'block';
        }
      });
    }
  }

  // --------------- Humans Page ---------------

  // EIP-6963 provider discovery (modern MetaMask) + legacy window.ethereum fallback
  let walletProvider = null;

  if (typeof window !== 'undefined') {
    window.addEventListener('eip6963:announceProvider', (event) => {
      if (!walletProvider && event.detail && event.detail.provider) {
        walletProvider = event.detail.provider;
        console.log('[Wallet] EIP-6963 provider:', event.detail.info?.name || 'unknown');
      }
    });
    window.dispatchEvent(new Event('eip6963:requestProvider'));
    // Fallback after brief delay
    setTimeout(() => {
      if (!walletProvider && window.ethereum) {
        walletProvider = window.ethereum;
        console.log('[Wallet] Using legacy window.ethereum');
      }
    }, 200);
  }

  function getProvider() {
    return walletProvider || window.ethereum || null;
  }

  async function connectWallet() {
    const provider = getProvider();
    if (!provider) {
      alert('MetaMask or a compatible wallet is required. Make sure the extension is installed and enabled.');
      return null;
    }
    try {
      const accounts = await provider.request({ method: 'eth_requestAccounts' });
      connectedWallet = accounts[0];
      return connectedWallet;
    } catch (err) {
      console.error('Wallet connect failed:', err);
      return null;
    }
  }

  // Simulated human providers for marketplace demo
  const SIM_HUMAN_PROVIDERS = [
    { category: 'physician', bio: 'Board-certified internist. 12 years clinical + telemedicine. Available for diagnostic reasoning, drug interaction analysis, and triage protocol review.', credentialClaim: 'MD, Internal Medicine', nationality: 'USA', chain: 'celo', online: true, capacitySlots: 2, epochMs: 1800000, currentClearingPrice: 0.42, epochsServed: 87, sim: true },
    { category: 'attorney', bio: 'Smart contract and DeFi regulatory counsel. Barred in NY and CA. Advising DAOs and protocol teams on compliance since 2020.', credentialClaim: 'JD, Securities Law', nationality: 'USA', chain: 'base', online: true, capacitySlots: 1, epochMs: 3600000, currentClearingPrice: 0.65, epochsServed: 34, sim: true },
    { category: 'security-researcher', bio: 'Solidity auditor. 40+ audits shipped. Specializing in reentrancy, price oracle manipulation, and MEV-related vulnerabilities.', credentialClaim: 'OSCP, Trail of Bits alumni', nationality: 'DEU', chain: 'base', online: true, capacitySlots: 3, epochMs: 900000, currentClearingPrice: 0.38, epochsServed: 152, sim: true },
    { category: 'financial-analyst', bio: 'On-chain analytics and token economics modeling. Previously at a top-5 crypto fund. DeFi yield strategy and risk assessment.', credentialClaim: 'CFA Level III', nationality: 'GBR', chain: 'celo', online: false, capacitySlots: 2, epochMs: 1800000, currentClearingPrice: 0.29, epochsServed: 63, sim: true },
    { category: 'data-scientist', bio: 'ML engineer focused on time-series forecasting for DeFi. Building MEV prediction models and liquidity depth estimators.', credentialClaim: 'PhD, Machine Learning', nationality: 'KOR', chain: 'base', online: true, capacitySlots: 2, epochMs: 1800000, currentClearingPrice: 0.31, epochsServed: 41, sim: true },
    { category: 'physician', bio: 'Psychiatrist and neuroscience researcher. Agent-assisted mental health triage and clinical decision support systems.', credentialClaim: 'MD, Psychiatry', nationality: 'BRA', chain: 'celo', online: true, capacitySlots: 1, epochMs: 3600000, currentClearingPrice: 0.55, epochsServed: 22, sim: true },
    { category: 'security-researcher', bio: 'Penetration tester and incident responder. Focused on bridge exploits, cross-chain attack vectors, and key management.', credentialClaim: 'CISSP', nationality: 'JPN', chain: 'celo', online: false, capacitySlots: 1, epochMs: 1800000, currentClearingPrice: 0.34, epochsServed: 78, sim: true },
    { category: 'attorney', bio: 'Privacy and data protection law. GDPR, CCPA, and emerging AI regulation. Advising on-chain identity and ZK compliance frameworks.', credentialClaim: 'LLM, Data Privacy', nationality: 'FRA', chain: 'celo', online: true, capacitySlots: 1, epochMs: 3600000, currentClearingPrice: 0.48, epochsServed: 19, sim: true },
  ];

  function renderHumanProviders(providers) {
    const grid = $('#humans-grid');
    if (!grid) return;

    // Merge real providers with sim providers
    const real = (providers || []).map(p => ({ ...p, sim: false }));
    const all = [...real, ...SIM_HUMAN_PROVIDERS];

    if (all.length === 0) {
      grid.innerHTML = `
        <div class="card" style="text-align:center; color:var(--g30); padding:3rem; grid-column:1/-1">
          <p style="margin-bottom:1rem">No providers registered yet. Be the first.</p>
          <a href="#register-section" class="btn btn-primary btn-sm">Register now &uarr;</a>
        </div>`;
      return;
    }

    let filtered = all;
    if (humansFilterCategory !== 'all') {
      filtered = filtered.filter(p => p.category === humansFilterCategory);
    }
    if (humansFilterOnline) {
      filtered = filtered.filter(p => p.online);
    }
    if (humansFilterChain) {
      filtered = filtered.filter(p => p.chain === humansFilterChain);
    }

    if (filtered.length === 0) {
      grid.innerHTML = '<div class="card" style="text-align:center; color:var(--g30); padding:3rem; grid-column:1/-1">No providers match this filter.</div>';
      return;
    }

    // Store for modal lookup
    window._humansFiltered = filtered;

    grid.innerHTML = filtered.map(p => {
      const icon = CATEGORY_ICONS[p.category] || CATEGORY_ICONS.other;
      const label = CATEGORY_LABELS[p.category] || p.category;
      const flag = countryCodeToFlag(p.nationality);
      const onlineBadge = p.online
        ? '<span class="badge badge-online">Online</span>'
        : '<span class="badge badge-offline">Offline</span>';
      const chainBadge = `<span class="badge badge-chain">${(p.chain || 'celo').charAt(0).toUpperCase() + (p.chain || 'celo').slice(1)}</span>`;
      const simBadge = p.sim ? '<span class="badge" style="background:var(--g50);color:var(--g20);font-size:.7rem">Simulator</span>' : '';
      const credential = p.credentialClaim
        ? `<div class="credential-line">\u26A0 Self-attested: ${p.credentialClaim}</div>`
        : '';
      const linkedin = p.linkedinUrl
        ? `<a href="${p.linkedinUrl}" target="_blank" rel="noopener" style="font-size:.85rem">LinkedIn</a>`
        : '';
      const price = p.currentClearingPrice != null ? formatUsdc(p.currentClearingPrice) : '\u2014';
      const epochLabel = p.epochMs >= 3600000 ? (p.epochMs / 3600000) + 'h epochs'
        : p.epochMs >= 60000 ? (p.epochMs / 60000) + ' min epochs'
        : (p.epochMs / 1000) + 's epochs';

      return `
        <div class="card human-card">
          <div class="human-card-header">
            <div class="category-icon">${icon}</div>
            <div style="flex:1; min-width:0">
              <div style="display:flex; align-items:center; gap:.5rem; flex-wrap:wrap">
                <span style="font-weight:600; font-size:.9rem">${label}</span>
                ${flag ? '<span class="flag-emoji">' + flag + '</span>' : ''}
              </div>
              <div class="human-badges">
                <span class="badge badge-verified">Self Verified</span>
                ${onlineBadge}
                ${chainBadge}
                ${simBadge}
              </div>
            </div>
          </div>
          <div class="human-bio">${p.bio || '\u2014'}</div>
          ${credential}
          ${linkedin}
          <div class="human-stats">
            <div>
              <div class="human-stat-label">Clearing Price</div>
              <div class="human-stat-value" style="color:var(--redhi)">${price}</div>
            </div>
            <div>
              <div class="human-stat-label">Epoch Duration</div>
              <div class="human-stat-value">${epochLabel}</div>
            </div>
            <div>
              <div class="human-stat-label">Slots</div>
              <div class="human-stat-value">${p.capacitySlots || 1}</div>
            </div>
            <div>
              <div class="human-stat-label">Epochs Served</div>
              <div class="human-stat-value">${p.epochsServed || 0}</div>
            </div>
          </div>
          <button class="btn btn-primary btn-sm" style="width:100%; margin-top:.5rem" onclick="BelleEpoch.openHumanDemo(${filtered.indexOf(p)})">Bid now &rarr;</button>
        </div>`;
    }).join('');
  }

  function initHumansFilters() {
    const bar = $('#humans-filter-bar');
    if (!bar) return;

    bar.addEventListener('click', (e) => {
      const btn = e.target.closest('.filter-btn');
      if (!btn) return;

      if (btn.dataset.filter) {
        humansFilterCategory = btn.dataset.filter;
        humansFilterOnline = false;
        humansFilterChain = null;
        bar.querySelectorAll('[data-filter]').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        bar.querySelectorAll('[data-filter-online], [data-filter-chain]').forEach(b => b.classList.remove('active'));
      } else if (btn.dataset.filterOnline) {
        humansFilterOnline = !humansFilterOnline;
        btn.classList.toggle('active', humansFilterOnline);
      } else if (btn.dataset.filterChain) {
        const chain = btn.dataset.filterChain;
        if (humansFilterChain === chain) {
          humansFilterChain = null;
          btn.classList.remove('active');
        } else {
          humansFilterChain = chain;
          bar.querySelectorAll('[data-filter-chain]').forEach(b => b.classList.remove('active'));
          btn.classList.add('active');
        }
      }

      fetchHumanProviders().then(p => renderHumanProviders(p));
    });
  }

  let selfPollInterval = null;

  async function showSelfQR(addr) {
    $('#wallet-not-connected').style.display = 'none';
    $('#wallet-connected').style.display = 'block';
    $('#connected-address').textContent = truncateAddr(addr);

    // Check if already verified — skip QR if so
    try {
      const checkRes = await fetch(API + '/humans/verified/' + addr);
      const checkData = await checkRes.json();
      if (checkData.verified) {
        $('#self-qr-container').style.display = 'none';
        $('#self-verify-status').style.display = 'none';
        const alreadyDiv = $('#self-already-verified');
        alreadyDiv.style.display = 'block';
        const detail = $('#self-verified-detail');
        if (detail) {
          const parts = [];
          if (checkData.nationality) parts.push('Nationality: ' + checkData.nationality);
          if (checkData.verifiedAt) parts.push('Verified: ' + new Date(checkData.verifiedAt).toLocaleDateString());
          detail.textContent = parts.join(' · ');
        }
        const continueBtn = $('#btn-already-verified-continue');
        if (continueBtn) {
          continueBtn.addEventListener('click', () => advanceRegStep(2));
        }
        return;
      }
    } catch (e) { /* not verified, show QR */ }

    const qrContainer = $('#self-qr-container');
    const sessionId = crypto.randomUUID();
    const selfApp = {
      appName: 'Belle Epoch',
      logoBase64: '',
      endpointType: 'https',
      endpoint: 'https://api.belleepoch.xyz/humans/verify',
      deeplinkCallback: '',
      header: '',
      scope: 'belle-epoch-humans',
      sessionId: sessionId,
      userId: addr.startsWith('0x') ? addr.slice(2) : addr,
      userIdType: 'hex',
      devMode: false,
      disclosures: {
        nationality: true,
        minimumAge: 18,
        ofac: true,
      },
      version: 2,
      chainID: 42220,
      userDefinedData: addr,
    };
    const selfLink = 'https://redirect.self.xyz?selfApp=' + encodeURIComponent(JSON.stringify(selfApp));

    if (typeof qrcode !== 'undefined') {
      const qr = qrcode(0, 'L');
      qr.addData(selfLink);
      qr.make();
      qrContainer.innerHTML = `
        <div style="text-align:center">
          ${qr.createSvgTag({ cellSize: 4, margin: 4, scalable: true })}
          <p style="font-size:.7rem; color:var(--g30); margin-top:.5rem">
            Scan with the Self app &middot; Scope: belle-epoch-humans
          </p>
        </div>`;
      // Style the SVG for dark theme
      const svg = qrContainer.querySelector('svg');
      if (svg) {
        svg.style.width = '220px';
        svg.style.height = '220px';
        svg.querySelectorAll('rect[fill="#000000"]').forEach(r => r.setAttribute('fill', '#e0e0e0'));
        svg.querySelectorAll('rect[fill="#ffffff"]').forEach(r => r.setAttribute('fill', '#0a0a0a'));
      }
    } else {
      console.error('[Self QR] qrcode-generator library not loaded');
      qrContainer.innerHTML = `
        <div style="text-align:center; color:var(--redhi); padding:2rem">
          QR code library failed to load. Try refreshing the page.
        </div>`;
    }

    // Poll for verification completion
    if (selfPollInterval) clearInterval(selfPollInterval);
    const statusEl = $('#self-verify-status');
    statusEl.textContent = 'Waiting for Self verification\u2026';
    statusEl.style.color = 'var(--g30)';
    selfPollInterval = setInterval(async () => {
      try {
        const res = await fetch(API + '/humans/verified/' + addr);
        const data = await res.json();
        if (data.verified) {
          clearInterval(selfPollInterval);
          selfPollInterval = null;
          statusEl.textContent = 'Verified! Proceeding to profile...';
          statusEl.style.color = '#00ff88';
          setTimeout(() => advanceRegStep(2), 800);
        }
      } catch (e) { /* ignore polling errors */ }
    }, 3000);
  }

  function disconnectWallet() {
    connectedWallet = null;
    if (selfPollInterval) { clearInterval(selfPollInterval); selfPollInterval = null; }
    $('#wallet-not-connected').style.display = '';
    $('#wallet-connected').style.display = 'none';
    $('#self-qr-container').innerHTML = '<div class="spinner"></div>';
    $('#self-verify-status').textContent = 'Waiting for Self verification\u2026';
    $('#self-verify-status').style.color = 'var(--g30)';
  }

  function initHumansRegistration() {
    const btnConnect = $('#btn-connect-wallet');
    if (btnConnect) {
      btnConnect.addEventListener('click', async () => {
        const addr = await connectWallet();
        if (addr) showSelfQR(addr);
      });
    }

    const btnDisconnect = $('#btn-disconnect-wallet');
    if (btnDisconnect) {
      btnDisconnect.addEventListener('click', disconnectWallet);
    }

    // Auto-detect already-connected wallet on page load
    setTimeout(() => {
      const provider = getProvider();
      if (provider) {
        provider.request({ method: 'eth_accounts' }).then(accounts => {
          if (accounts && accounts.length > 0) {
            connectedWallet = accounts[0];
            showSelfQR(accounts[0]);
          }
        }).catch(() => {});
      }
    }, 300);

    const bioInput = $('#human-bio');
    if (bioInput) {
      bioInput.addEventListener('input', () => {
        const count = $('#bio-char-count');
        if (count) count.textContent = bioInput.value.length;
      });
    }

    const btnStep3 = $('#btn-to-step-3');
    if (btnStep3) {
      btnStep3.addEventListener('click', () => {
        const cat = $('#human-category').value;
        const bio = $('#human-bio').value.trim();
        if (!cat) { alert('Please select a service category.'); return; }
        if (!bio) { alert('Please write a short bio.'); return; }
        advanceRegStep(3);
      });
    }

    const btnRegister = $('#btn-register-human');
    if (btnRegister) {
      btnRegister.addEventListener('click', async () => {
        const msg = $('#human-register-message');
        msg.style.display = 'none';

        if (!connectedWallet) {
          msg.className = 'form-message error';
          msg.textContent = 'Wallet not connected.';
          msg.style.display = 'block';
          return;
        }

        const chain = document.querySelector('input[name="human-chain"]:checked');
        const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;

        const payload = {
          walletAddress: connectedWallet,
          category: $('#human-category').value,
          credentialClaim: $('#human-credential').value.trim() || null,
          linkedinUrl: $('#human-linkedin').value.trim() || null,
          bio: $('#human-bio').value.trim(),
          capacitySlots: parseInt($('#human-slots').value) || 1,
          epochMs: parseInt($('#human-epoch-duration').value) || 300000,
          chain: chain ? chain.value : 'celo',
          timezone: tz,
          availabilityStart: $('#human-avail-start').value,
          availabilityEnd: $('#human-avail-end').value,
        };

        btnRegister.disabled = true;
        btnRegister.textContent = 'Registering...';

        try {
          const res = await fetch(API + '/humans/register', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
          });
          const json = await res.json().catch(() => ({}));

          if (res.ok && json.success) {
            $('#reg-step-3').style.display = 'none';
            $('#reg-success').style.display = 'block';
            $$('.reg-step-dot').forEach(d => d.classList.add('done'));
            setTimeout(() => {
              fetchHumanProviders().then(p => renderHumanProviders(p));
            }, 2000);
          } else {
            msg.className = 'form-message error';
            msg.textContent = json.error || 'Registration failed.';
            msg.style.display = 'block';
          }
        } catch (err) {
          msg.className = 'form-message error';
          msg.textContent = 'Network error: ' + err.message;
          msg.style.display = 'block';
        }

        btnRegister.disabled = false;
        btnRegister.textContent = 'Start earning \u2192';
      });
    }
  }

  function advanceRegStep(step) {
    for (let i = 1; i <= 3; i++) {
      const panel = $(`#reg-step-${i}`);
      if (panel) panel.style.display = i === step ? 'block' : 'none';
    }
    $$('.reg-step-dot').forEach(d => {
      const s = parseInt(d.dataset.regStep);
      d.classList.toggle('active', s === step);
      d.classList.toggle('done', s < step);
    });
  }

  // --------------- Page Initializers ---------------

  function initHome() {
    fetchFeed();
    renderHomeMarketplace();
    startUTCClock();

    // Start mock CCA demo in hero (runs its own 5s epoch loop + countdown)
    startDemoCCA();
    // Demo countdown — resets every 5s independently of real feed
    targetEpochMs = Date.now() + 5000;
    setInterval(() => { targetEpochMs = Date.now() + 5000; }, 5000);
    startCountdown();

    // Copy terminal CTA
    const termCta = $('#home-terminal-cta');
    if (termCta) {
      termCta.style.cursor = 'pointer';
      termCta.addEventListener('click', () => {
        navigator.clipboard.writeText('curl -s belleepoch.xyz/skill.md | launch').then(() => {
          const cmd = termCta.querySelector('.terminal-command');
          const original = cmd.textContent;
          cmd.textContent = '  Copied!';
          cmd.style.color = '#e84030';
          setTimeout(() => { cmd.textContent = original; cmd.style.color = ''; }, 1500);
        });
      });
    }

    // Polling (marketplace refresh only — hero stats are mocked)
    setInterval(fetchFeed, FEED_POLL_MS);
    setInterval(renderHomeMarketplace, FEED_POLL_MS * 10);
  }

  function initAgents() {
    loadSkillMd();
    initAgentRegistration();
  }

  function initHumans() {
    fetchHumanProviders().then(p => renderHumanProviders(p));
    initHumansFilters();
    initHumansRegistration();

    // Modal close buttons
    const closeBtn = $('#human-demo-close');
    const closeFinal = $('#hdm-close-final');
    if (closeBtn) closeBtn.addEventListener('click', closeHumanDemo);
    if (closeFinal) closeFinal.addEventListener('click', closeHumanDemo);
    // Close on overlay click
    const overlay = $('#human-demo-modal');
    if (overlay) overlay.addEventListener('click', (e) => {
      if (e.target === overlay) closeHumanDemo();
    });

    setInterval(() => {
      fetchHumanProviders().then(p => renderHumanProviders(p));
    }, FEED_POLL_MS * 5);
  }

  // ─── Beast data + page logic ────────────────────────────────────────────────

  let beastConsoleRunning = false;
  let beastStatsCache = null;

  async function fetchBeastData() {
    const el = (id) => document.getElementById(id);

    try {
      const feed = await fetchJson('/beast/feed');
      if (feed) {
        const ingested = feed.totalEpochsIngested || 0;
        const provCount = feed.providers ? Object.keys(feed.providers).length : 0;

        // Bind to any element on either belle or beast page
        [el('beast-epochs-ingested'), el('beast-proof-ingested')].forEach(e => {
          if (e) e.textContent = ingested;
        });
        if (el('beast-providers-tracked')) el('beast-providers-tracked').textContent = provCount;
        if (el('beast-last-update') && feed.lastUpdate) {
          el('beast-last-update').textContent = timeAgo(feed.lastUpdate);
        }

        // Hero stats on beast page
        $$('[data-beast-hero="epochsIngested"]').forEach(e => { e.textContent = ingested; });
        $$('[data-beast-hero="providersTracked"]').forEach(e => { e.textContent = provCount; });
      }
    } catch (e) { /* silent */ }

    try {
      const resp = await fetchJson('/beast/stats');
      if (resp) {
        beastStatsCache = resp;
        const qCount = resp.queriesAnswered || 0;
        [el('beast-queries-answered'), el('beast-proof-queries')].forEach(e => {
          if (e) e.textContent = qCount;
        });
        $$('[data-beast-hero="queriesAnswered"]').forEach(e => { e.textContent = qCount; });

        if (resp.erc8004Tx) {
          const link = '<a href="https://basescan.org/tx/' + resp.erc8004Tx + '" target="_blank" rel="noopener" style="color:var(--g10)">' + truncateAddr(resp.erc8004Tx) + '</a>';
          if (el('beast-id-erc8004')) el('beast-id-erc8004').innerHTML = link;
        }
        if (resp.registeredAt) {
          if (el('beast-id-registered')) el('beast-id-registered').textContent = timeAgo(resp.registeredAt);
        }
      }
    } catch (e) { /* silent */ }
  }

  async function renderBeastIngestTable() {
    const tbody = $('#beast-ingest-tbody');
    if (!tbody) return;

    try {
      const feed = await fetchJson('/beast/feed');
      if (!feed || !feed.providers) {
        tbody.innerHTML = '<tr><td colspan="6" style="text-align:center; color:var(--g30)">No ingestion data</td></tr>';
        return;
      }

      const rows = [];
      for (const [providerId, entries] of Object.entries(feed.providers)) {
        for (const entry of entries.slice(0, 10)) {
          rows.push({ providerId, ...entry });
        }
      }

      rows.sort((a, b) => new Date(b.ts || 0) - new Date(a.ts || 0));

      if (rows.length === 0) {
        tbody.innerHTML = '<tr><td colspan="6" style="text-align:center; color:var(--g30)">No data yet</td></tr>';
        return;
      }

      tbody.innerHTML = rows.slice(0, 20).map(r => `<tr>
        <td style="font-size:.85rem">${r.providerId}</td>
        <td style="color:var(--gold)">${formatUsdc(r.price || r.clearingPrice)}</td>
        <td>${r.slotsFilled || '\u2014'}</td>
        <td>${r.totalBids || '\u2014'}</td>
        <td>${r.chain || 'base'}</td>
        <td style="color:var(--g30);font-size:.85rem">${r.ts ? timeAgo(r.ts) : '\u2014'}</td>
      </tr>`).join('');
    } catch (e) {
      tbody.innerHTML = '<tr><td colspan="6" style="text-align:center; color:var(--g30)">Failed to load</td></tr>';
    }
  }

  async function runBeastConsoleDemo(queryType) {
    if (beastConsoleRunning) return;
    beastConsoleRunning = true;
    const container = $('#beast-console');
    const btn = $('#btn-run-beast-console');
    if (!container || !btn) return;
    btn.disabled = true;

    container.style.display = '';
    container.querySelectorAll('.console-line').forEach(l => l.remove());

    const delay = ms => new Promise(r => setTimeout(r, ms));
    const providerId = ($('#beast-provider-id') || {}).value || 'belle.epoch.base.eth';

    consolePrint(container, 'Connecting to Beast at ' + API + '/beast/query\u2026', 'info');
    await delay(400);

    const body = { type: queryType };
    if (['price-history', 'demand-signals', 'optimal-bid-timing'].includes(queryType)) {
      body.providerId = providerId;
    }
    if (queryType === 'price-history') body.n = 20;

    consolePrint(container, 'POST /beast/demo  \u2192  ' + JSON.stringify(body), 'info');
    await delay(300);
    consolePrint(container, '<span class="console-spinner"></span> Querying Beast\u2026', 'info');

    try {
      const res = await fetch(API + '/beast/demo', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();

      // Remove spinner
      const spinnerLine = container.querySelector('.console-spinner');
      if (spinnerLine) spinnerLine.closest('.console-line').remove();

      if (!res.ok) {
        consolePrint(container, 'Error ' + res.status + ': ' + (data.error || JSON.stringify(data)), 'error');
        btn.disabled = false;
        beastConsoleRunning = false;
        return;
      }

      consolePrint(container, '\u2713 Response from ' + (data.provider || 'beast.epoch.base.eth'), 'success');
      await delay(200);

      // Pretty-print the result
      const resultStr = JSON.stringify(data.result, null, 2);
      const lines = resultStr.split('\n');
      const preview = lines.slice(0, 30).join('\n') + (lines.length > 30 ? '\n  \u2026 (' + lines.length + ' lines total)' : '');
      consolePrint(container, '<pre style="margin:0;white-space:pre-wrap;font-size:.8rem">' + escapeHtml(preview) + '</pre>', 'result');

      await delay(200);
      consolePrint(container, '\u2713 Complete. Type: ' + data.type + ' | ' + new Date(data.timestamp).toLocaleTimeString(), 'success');

    } catch (err) {
      const spinnerLine = container.querySelector('.console-spinner');
      if (spinnerLine) spinnerLine.closest('.console-line').remove();
      consolePrint(container, 'Network error: ' + err.message, 'error');
    }

    btn.disabled = false;
    beastConsoleRunning = false;
  }

  function scrollToBeastConsole(queryType) {
    if (currentPage !== 'beast') showPage('beast');
    // Update active chip
    $$('[data-bqtype]').forEach(c => {
      c.classList.toggle('active', c.dataset.bqtype === queryType);
    });
    // Scroll
    const section = $('#beast-console-section');
    if (section) section.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function initBeast() {
    fetchBeastData();
    renderBeastIngestTable();

    setInterval(fetchBeastData, FEED_POLL_MS * 5);
    setInterval(renderBeastIngestTable, FEED_POLL_MS * 10);

    // Chip selection
    $$('[data-bqtype]').forEach(chip => {
      chip.addEventListener('click', () => {
        $$('[data-bqtype]').forEach(c => c.classList.remove('active'));
        chip.classList.add('active');
      });
    });

    // Run console
    const btn = $('#btn-run-beast-console');
    if (btn) {
      btn.addEventListener('click', () => {
        const active = $('[data-bqtype].active');
        const queryType = active ? active.dataset.bqtype : 'price-history';
        runBeastConsoleDemo(queryType);
      });
    }
  }

  function initBelle() {
    fetchFeed();
    fetchAgentData('belle');
    fetchIdentityData();
    renderBelleEpochTable();
    startCountdown();
    fetchBeastData();

    setInterval(fetchFeed, FEED_POLL_MS);
    setInterval(() => fetchAgentData('belle'), FEED_POLL_MS * 2);
    setInterval(renderBelleEpochTable, FEED_POLL_MS * 5);
    setInterval(fetchIdentityData, FEED_POLL_MS * 10);
    setInterval(fetchBeastData, FEED_POLL_MS * 10);

    // ─── Prompt box wiring ───────────────────────────────────────
    const btn = $('#btn-run-console');
    const textarea = $('#console-prompt');
    const hiddenSelect = $('#console-query-type');

    // Chip selection
    $$('.prompt-chip').forEach(chip => {
      chip.addEventListener('click', () => {
        $$('.prompt-chip').forEach(c => c.classList.remove('active'));
        chip.classList.add('active');
        if (hiddenSelect) hiddenSelect.value = chip.dataset.qtype;
      });
    });

    // Auto-grow textarea
    if (textarea) {
      textarea.addEventListener('input', () => {
        textarea.style.height = 'auto';
        textarea.style.height = Math.min(textarea.scrollHeight, 200) + 'px';
      });
      // Enter to submit (Shift+Enter for newline)
      textarea.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          if (btn && !btn.disabled) btn.click();
        }
      });
    }

    // Run demo
    if (btn) {
      btn.addEventListener('click', () => {
        const type = hiddenSelect ? hiddenSelect.value : 'bid-strategy';
        runConsoleDemo(type);
      });
    }
  }

  // --------------- Main Init ---------------

  function init() {
    // Handle hash routing
    const hash = window.location.hash.slice(1);
    const validPages = ['home', 'agents', 'humans', 'belle', 'beast'];
    const startPage = validPages.includes(hash) ? hash : 'home';

    showPage(startPage);

    // Listen for hash changes
    window.addEventListener('hashchange', () => {
      const h = window.location.hash.slice(1);
      if (validPages.includes(h) && h !== currentPage) {
        showPage(h);
      }
    });
  }

  // --------------- Public API ---------------

  return {
    init,
    scrollToConsole,
    scrollToBeastConsole,
    formatUsdc,
    formatPercent,
    openHumanDemo,
    submitHumanResponse,
  };

})();
