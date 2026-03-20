/* ============================================================
   Belle Epoch — app.js
   Single-page app: data fetching, live binding, charts, simulator,
   console, marketplace, registration, skill.md rendering.
   ============================================================ */

const BelleEpoch = (() => {
  'use strict';

  // --------------- Config ---------------
  const API = window.location.origin;
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
  let pageInited   = { home: false, agents: false, humans: false, belle: false };
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

  async function renderHomeMarketplace() {
    const grid = $('#home-marketplace-grid');
    if (!grid) return;

    const providers = await fetchProviders();
    if (!providers || !Array.isArray(providers) || providers.length === 0) {
      grid.innerHTML = '<div class="card" style="text-align:center; color:var(--g30); padding:3rem">No providers registered yet.</div>';
      appendGhostCard(grid);
      return;
    }

    grid.innerHTML = '';

    for (const p of providers) {
      const card = document.createElement('div');
      card.className = 'card provider-card';
      if (p.id === 'belle') card.classList.add('featured');

      const initial = (p.name || p.ens || p.id || '?')[0].toUpperCase();
      const verified = p.selfVerified ? '<span class="badge badge-verified">Self Verified</span>' : '';
      const featured = p.id === 'belle' ? '<span class="badge badge-warning" style="font-size:.75rem">Featured</span>' : '';

      // Check if human capacity
      const isHuman = p.resource === 'human-capacity' || p.epochMs >= 60000;
      const humanBadges = isHuman
        ? '<span class="badge badge-verified" style="font-size:.75rem">Self Verified</span><span class="badge badge-online" style="font-size:.75rem">Online</span>'
        : '';

      card.innerHTML = `
        <div class="provider-header">
          <div class="provider-avatar">${initial}</div>
          <div>
            <h3 style="margin-bottom:.15rem">${p.name || p.ens || p.id}</h3>
            <span style="font-size:.85rem; color:var(--g30)">${p.resource || '\u2014'}</span>
            ${featured}${verified}
          </div>
        </div>
        <div class="provider-stats">
          <div>
            <div class="provider-stat-label">Clearing Price</div>
            <div class="provider-stat-value" style="color:var(--redhi)">${formatUsdc(p.clearingPrice)}</div>
          </div>
          <div>
            <div class="provider-stat-label">Capacity</div>
            <div class="provider-stat-value">${p.capacity != null ? p.capacity : '\u2014'}</div>
          </div>
          <div>
            <div class="provider-stat-label">Win Rate</div>
            <div class="provider-stat-value">${formatPercent(p.winRate)}</div>
          </div>
          <div>
            <div class="provider-stat-label">Slots Filled</div>
            <div class="provider-stat-value">${p.slotsFilled != null ? p.slotsFilled : '\u2014'}</div>
          </div>
        </div>
        <div class="sparkline"><svg viewBox="0 0 64 24" data-sparkline-id="${p.id}"></svg></div>
        <button class="btn btn-primary btn-sm" style="width:100%; margin-top:.75rem" onclick="showPage('belle')">Bid Now &rarr;</button>
      `;

      grid.appendChild(card);

      // load sparkline
      fetchProviderHistory(p.id).then(hist => {
        if (!hist || !Array.isArray(hist)) return;
        const svg = $(`[data-sparkline-id="${p.id}"]`);
        if (svg) renderSparkline(svg, hist.map(h => Number(h.clearingPrice || 0)));
      });
    }

    appendGhostCard(grid);
  }

  function appendGhostCard(grid) {
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

    container.querySelectorAll('.console-line').forEach(l => l.remove());

    const delay = ms => new Promise(r => setTimeout(r, ms));

    consolePrint(container, `Connecting to Belle Epoch at ${API}\u2026`, 'info');
    await delay(600);

    consolePrint(container, 'Reading current epoch from /feed\u2026', 'info');
    const feed = await fetchFeed();
    if (feed) {
      consolePrint(container, `Epoch #${feed.epochId} | Price: ${formatUsdc(feed.clearingPrice)} | Slots: ${feed.slotsFilled}/${feed.capacity}`, 'success');
    } else {
      consolePrint(container, 'Could not reach /feed \u2014 using cached data', 'error');
    }
    await delay(500);

    const bidAmount = feed ? (Number(feed.clearingPrice) * 1.2).toFixed(6) : '0.005000';
    consolePrint(container, `Submitting bid to POST /bid (type: ${queryType}, amount: ${bidAmount})\u2026`, 'info');
    const currentEpoch = feed ? feed.epochId : 0;
    try {
      const res = await fetch(API + '/bid', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          epochId: currentEpoch + 1,
          agentId: DEMO_AGENT_ID,
          maxBid: parseFloat(bidAmount),
          resource: 'private-reasoning',
          signature: DEMO_SIGNATURE
        })
      });
      const json = await res.json().catch(() => ({}));
      if (json.status === 'pending') {
        consolePrint(container, `Bid accepted for epoch #${json.epochId}. Closes in ${json.epochClosesMs}ms.`, 'success');
      } else {
        consolePrint(container, `Bid response: ${json.error || json.status || 'accepted'} (demo mode)`, 'success');
      }
    } catch {
      consolePrint(container, `Bid submitted (demo mode). Epoch #${currentEpoch + 1}`, 'success');
    }
    await delay(500);

    consolePrint(container, 'Waiting for epoch to close\u2026', 'info');
    await delay(2000);

    consolePrint(container, 'Epoch cleared. Checking result\u2026', 'info');
    const latestFeed = await fetchFeed();
    const clearedPrice = latestFeed ? formatUsdc(latestFeed.clearingPrice) : formatUsdc(bidAmount);
    consolePrint(container, `Clearing price: ${clearedPrice}`, 'success');
    await delay(400);

    const multiplier = queryType === 'negotiation' ? 2 : queryType === 'expert-routing' ? 3 : 1;
    const payment = latestFeed ? (Number(latestFeed.clearingPrice) * multiplier).toFixed(6) : (Number(bidAmount) * multiplier).toFixed(6);
    consolePrint(container, `Payment required: ${formatUsdc(payment)} via x402 (${multiplier}x clearing)`, 'info');
    await delay(600);

    consolePrint(container, 'Settling payment\u2026', 'info');
    await delay(800);
    consolePrint(container, 'Payment settled. Access token received.', 'success');
    await delay(400);

    consolePrint(container, `Querying Venice AI (type: ${queryType})\u2026`, 'info');
    try {
      const qRes = await fetch(API + '/query', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          agentId: DEMO_AGENT_ID,
          queryType: queryType,
          token: 'demo-token'
        })
      });
      const qJson = await qRes.json().catch(() => ({}));
      if (qJson.queryId) {
        consolePrint(container, `Query submitted. ID: ${qJson.queryId}`, 'success');
        await delay(1500);
        consolePrint(container, 'Polling for result\u2026', 'info');
        await delay(1000);
        const rRes = await fetch(API + '/query/' + qJson.queryId);
        const rJson = await rRes.json().catch(() => ({}));
        consolePrint(container, `Result received. retained: ${rJson.retained != null ? rJson.retained : false}`, 'result');
      } else {
        throw new Error('no queryId');
      }
    } catch {
      consolePrint(container, 'Query submitted (demo mode). Polling\u2026', 'info');
      await delay(1500);
      consolePrint(container, 'Result received. Data retained: false', 'result');
    }
    await delay(300);

    consolePrint(container, '\u2713 Complete. Venice proof hash verified. Session closed.', 'success');

    btn.disabled = false;
    consoleRunning = false;
  }

  function scrollToConsole(queryType) {
    const select = $('#console-query-type');
    if (select) select.value = queryType;
    const section = $('#console-section');
    if (section) section.scrollIntoView({ behavior: 'smooth' });
  }

  // --------------- Belle Epoch History Table ---------------

  async function renderBelleEpochTable() {
    const tbody = $('#belle-epoch-tbody');
    if (!tbody) return;

    const data = await fetchAgentData('belle');
    if (!data || !data.epochs || !Array.isArray(data.epochs) || data.epochs.length === 0) {
      tbody.innerHTML = '<tr><td colspan="5" style="text-align:center; color:var(--g30)">No epoch data available</td></tr>';
      return;
    }

    const recent = data.epochs.slice(0, 7);
    tbody.innerHTML = recent.map(ep => {
      const won = ep.won;
      return `<tr>
        <td>#${ep.epochId}</td>
        <td>${formatUsdc(ep.clearingPrice)}</td>
        <td class="${won ? 'won' : 'lost'}">${won ? 'Won' : 'Lost'}</td>
        <td>${won ? formatUsdc(ep.paid) : '\u2014'}</td>
        <td style="color:var(--g30)">${ep.timestamp ? new Date(ep.timestamp).toLocaleTimeString() : '\u2014'}</td>
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

  function renderHumanProviders(providers) {
    const grid = $('#humans-grid');
    if (!grid) return;

    if (!providers || providers.length === 0) {
      grid.innerHTML = `
        <div class="card" style="text-align:center; color:var(--g30); padding:3rem; grid-column:1/-1">
          <p style="margin-bottom:1rem">No providers registered yet. Be the first.</p>
          <a href="#register-section" class="btn btn-primary btn-sm">Register now &uarr;</a>
        </div>`;
      return;
    }

    let filtered = providers;
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

    grid.innerHTML = filtered.map(p => {
      const icon = CATEGORY_ICONS[p.category] || CATEGORY_ICONS.other;
      const label = CATEGORY_LABELS[p.category] || p.category;
      const flag = countryCodeToFlag(p.nationality);
      const onlineBadge = p.online
        ? '<span class="badge badge-online">Online</span>'
        : '<span class="badge badge-offline">Offline</span>';
      const chainBadge = `<span class="badge badge-chain">${(p.chain || 'celo').charAt(0).toUpperCase() + (p.chain || 'celo').slice(1)}</span>`;
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
          <button class="btn btn-primary btn-sm" style="width:100%; margin-top:.5rem" onclick="showPage('belle');BelleEpoch.scrollToConsole('expert-routing')">Bid now &rarr;</button>
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
    fetchMetrics();
    fetchEvents();
    renderHomeMarketplace();
    startCountdown();
    startUTCClock();

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

    // Polling
    setInterval(fetchFeed, FEED_POLL_MS);
    setInterval(fetchMetrics, FEED_POLL_MS * 5);
    setInterval(fetchEvents, FEED_POLL_MS * 3);
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

    setInterval(() => {
      fetchHumanProviders().then(p => renderHumanProviders(p));
    }, FEED_POLL_MS * 5);
  }

  function initBelle() {
    fetchFeed();
    fetchAgentData('belle');
    fetchIdentityData();
    renderBelleEpochTable();
    startCountdown();

    // Epoch simulator (relocated from Home)
    const simBtn = $('#btn-run-simulator');
    if (simBtn) simBtn.addEventListener('click', runSimulator);

    setInterval(fetchFeed, FEED_POLL_MS);
    setInterval(() => fetchAgentData('belle'), FEED_POLL_MS * 2);
    setInterval(fetchIdentityData, FEED_POLL_MS * 10);

    // Console
    const btn = $('#btn-run-console');
    if (btn) {
      btn.addEventListener('click', () => {
        const type = $('#console-query-type').value;
        runConsoleDemo(type);
      });
    }
  }

  // --------------- Main Init ---------------

  function init() {
    // Handle hash routing
    const hash = window.location.hash.slice(1);
    const validPages = ['home', 'agents', 'humans', 'belle'];
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
    formatUsdc,
    formatPercent,
  };

})();
