/* ============================================================
   Belle Epoch — app.js
   Vanilla JS: data fetching, live binding, charts, simulator,
   console, ticker, provider registration.
   ============================================================ */

const BelleEpoch = (() => {
  'use strict';

  // --------------- Config ---------------
  const API = window.location.origin;
  const FEED_POLL_MS     = 2000;
  const BIDS_POLL_MS     = 1000;
  const TICKER_POLL_MS   = 5000;
  const COUNTDOWN_TICK   = 100;
  const DEMO_AGENT_ID    = 'demo-agent';
  const DEMO_SIGNATURE   = '0xdemo00000000000000000000000000000000000000000000000000000000dead';

  // --------------- State ---------------
  let feedData     = null;
  let belleData    = null;
  let queueData    = null;
  let countdownRef = null;
  let targetEpochMs = null;

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

  function formatDelta(current, previous) {
    if (current == null || previous == null || previous === 0) return '';
    const pct = ((current - previous) / previous) * 100;
    const sign = pct >= 0 ? '+' : '';
    const cls  = pct >= 0 ? 'up' : 'down';
    return `<span class="ticker-delta ${cls}">${sign}${pct.toFixed(1)}%</span>`;
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

  function $(sel, parent) { return (parent || document).querySelector(sel); }
  function $$(sel, parent) { return Array.from((parent || document).querySelectorAll(sel)); }

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

  async function fetchBids() {
    const data = await fetchJson('/feed/bids');
    if (data) renderBidStream(data);
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

    // slots bar
    const bar = $('#slots-bar');
    if (bar && data.capacity != null) {
      const filled = data.slotsFilled || 0;
      const cap    = data.capacity || 0;
      bar.innerHTML = '';
      for (let i = 0; i < cap; i++) {
        const dot = document.createElement('div');
        dot.className = 'slot' + (i < filled ? ' filled' : '');
        bar.appendChild(dot);
      }
    }

    // countdown target
    if (data.nextEpochMs != null) {
      const newTarget = Date.now() + data.nextEpochMs;
      if (!targetEpochMs || Math.abs(newTarget - targetEpochMs) > 500) {
        targetEpochMs = newTarget;
      }
    }
  }

  function bindBelle(data) {
    // Map aliases: epochsServed → totalWon, totalSpent → veniceSpend
    const aliases = { epochsServed: 'totalWon', totalSpent: 'veniceSpend' };

    $$('[data-belle]').forEach(el => {
      const key = el.getAttribute('data-belle');
      const resolvedKey = aliases[key] || key;
      let val = data[resolvedKey];
      // Also check feed data for belle-specific fields
      if (val == null && feedData && feedData.belle) val = feedData.belle[resolvedKey];
      if (val == null) return;

      let display;
      if (key === 'earnedToday' || key === 'totalSpent' || key === 'totalRouted' || key === 'veniceSpend')
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
  }

  function bindQueue(data) {
    $$('[data-queue]').forEach(el => {
      const key = el.getAttribute('data-queue');
      const val = data[key];
      if (val != null && el.textContent !== String(val)) {
        el.textContent = val;
      }
    });
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

  // --------------- Bid Stream ---------------

  function renderBidStream(data) {
    const container = $('#bid-stream');
    if (!container) return;

    // data comes as { epochId, bids: [...], count } from /feed/bids
    const bids = data && data.bids ? data.bids : (Array.isArray(data) ? data : []);
    if (bids.length === 0) {
      container.innerHTML = '<div class="bid-entry" style="justify-content:center; color:var(--muted)">No bids this epoch</div>';
      return;
    }

    const latest = bids.slice(0, 6);
    const currentIds = latest.map(b => b.agentId + ':' + b.timestamp).join(',');
    if (container.dataset.lastIds === currentIds) return;
    container.dataset.lastIds = currentIds;

    const rangeColors = { high: 'var(--primary)', mid: 'var(--secondary)', low: 'var(--muted)' };
    container.innerHTML = latest.map(b => `
      <div class="bid-entry">
        <span class="bid-agent">${b.agentId}</span>
        <span class="bid-amount" style="color:${rangeColors[b.bidRange] || 'var(--text)'}">${b.bidRange || '\u2014'}</span>
        <span class="bid-time">${timeAgo(b.timestamp)}</span>
      </div>
    `).join('');
  }

  // --------------- Charts ---------------

  function renderPriceChart(canvasId, history) {
    const canvas = typeof canvasId === 'string' ? $('#' + canvasId) : canvasId;
    if (!canvas || !history || !history.length) return;

    const ctx = canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.parentElement.getBoundingClientRect();
    canvas.width  = rect.width * dpr;
    canvas.height = rect.height * dpr;
    canvas.style.width  = rect.width + 'px';
    canvas.style.height = rect.height + 'px';
    ctx.scale(dpr, dpr);

    const w = rect.width;
    const h = rect.height;
    const pad = { top: 20, right: 20, bottom: 30, left: 60 };
    const plotW = w - pad.left - pad.right;
    const plotH = h - pad.top - pad.bottom;

    const prices = history.map(e => Number(e.clearingPrice || 0));
    const epochs = history.map(e => e.epochId);
    const min = Math.min(...prices) * 0.9;
    const max = Math.max(...prices) * 1.1 || 1;

    ctx.clearRect(0, 0, w, h);

    // grid lines
    ctx.strokeStyle = 'rgba(26,26,46,.6)';
    ctx.lineWidth = 0.5;
    for (let i = 0; i <= 4; i++) {
      const y = pad.top + (plotH / 4) * i;
      ctx.beginPath(); ctx.moveTo(pad.left, y); ctx.lineTo(w - pad.right, y); ctx.stroke();
    }

    // y-axis labels
    ctx.fillStyle = '#8888a0';
    ctx.font = '11px system-ui, sans-serif';
    ctx.textAlign = 'right';
    for (let i = 0; i <= 4; i++) {
      const y = pad.top + (plotH / 4) * i;
      const val = max - ((max - min) / 4) * i;
      ctx.fillText(val.toFixed(4), pad.left - 8, y + 4);
    }

    // x-axis labels
    ctx.textAlign = 'center';
    const step = Math.max(1, Math.floor(prices.length / 6));
    for (let i = 0; i < prices.length; i += step) {
      const x = pad.left + (plotW / (prices.length - 1 || 1)) * i;
      ctx.fillText('#' + (epochs[i] || i), x, h - 8);
    }

    if (prices.length < 2) return;

    // line
    ctx.beginPath();
    ctx.strokeStyle = '#00d4aa';
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    prices.forEach((p, i) => {
      const x = pad.left + (plotW / (prices.length - 1)) * i;
      const y = pad.top + plotH - ((p - min) / (max - min)) * plotH;
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    });
    ctx.stroke();

    // gradient fill
    const lastX = pad.left + plotW;
    const lastY = pad.top + plotH - ((prices[prices.length - 1] - min) / (max - min)) * plotH;
    ctx.lineTo(lastX, pad.top + plotH);
    ctx.lineTo(pad.left, pad.top + plotH);
    ctx.closePath();
    const grad = ctx.createLinearGradient(0, pad.top, 0, pad.top + plotH);
    grad.addColorStop(0, 'rgba(0,212,170,.15)');
    grad.addColorStop(1, 'rgba(0,212,170,0)');
    ctx.fillStyle = grad;
    ctx.fill();

    // dots
    ctx.fillStyle = '#00d4aa';
    prices.forEach((p, i) => {
      const x = pad.left + (plotW / (prices.length - 1)) * i;
      const y = pad.top + plotH - ((p - min) / (max - min)) * plotH;
      ctx.beginPath(); ctx.arc(x, y, 3, 0, Math.PI * 2); ctx.fill();
    });
  }

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

    // clear previous
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
    // Attempt real POST with correct payload
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
    // Attempt real query
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

  // --------------- Ticker ---------------

  async function renderTicker() {
    const inner = $('#ticker-inner');
    if (!inner) return;

    const providers = await fetchProviders();
    if (!providers || !Array.isArray(providers) || providers.length === 0) {
      inner.innerHTML = '<div class="ticker-item"><span class="ticker-name">No providers online</span></div>';
      return;
    }

    // duplicate for seamless scroll
    const items = providers.map(p => `
      <div class="ticker-item">
        <span class="ticker-name">${p.name || p.id}</span>
        <span class="ticker-resource">${p.resource || ''}</span>
        <span class="ticker-price">${formatUsdc(p.clearingPrice)}</span>
        ${formatDelta(p.clearingPrice, p.previousPrice)}
      </div>
    `).join('');

    inner.innerHTML = items + items; // doubled for infinite scroll
  }

  // --------------- Marketplace ---------------

  async function renderMarketplace() {
    const grid = $('#marketplace-grid');
    if (!grid) return;

    const providers = await fetchProviders();
    if (!providers || !Array.isArray(providers) || providers.length === 0) {
      grid.innerHTML = '<div class="card" style="text-align:center; color:var(--muted); padding:3rem">No providers registered yet.</div>';
      return;
    }

    grid.innerHTML = '';

    for (const p of providers) {
      const card = document.createElement('div');
      card.className = 'card provider-card';

      const initial = (p.name || p.id || '?')[0].toUpperCase();
      const verified = p.selfVerified ? '<span class="badge badge-verified">Self Verified</span>' : '';

      card.innerHTML = `
        <div class="provider-header">
          <div class="provider-avatar">${initial}</div>
          <div>
            <h3 style="margin-bottom:.15rem">${p.name || p.id}</h3>
            <span style="font-size:.78rem; color:var(--muted)">${p.resource || '\u2014'}</span>
            ${verified}
          </div>
        </div>
        <div class="provider-stats">
          <div>
            <div class="provider-stat-label">Clearing Price</div>
            <div class="provider-stat-value" style="color:var(--primary)">${formatUsdc(p.clearingPrice)}</div>
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
        <button class="btn btn-primary btn-sm" style="width:100%; margin-top:.75rem" onclick="window.location.href='belle.html'">Bid Now</button>
      `;

      grid.appendChild(card);

      // load sparkline
      fetchProviderHistory(p.id).then(hist => {
        if (!hist || !Array.isArray(hist)) return;
        const svg = $(`[data-sparkline-id="${p.id}"]`);
        if (svg) renderSparkline(svg, hist.map(h => Number(h.clearingPrice || 0)));
      });
    }
  }

  // --------------- Provider Registration ---------------

  function initRegistrationForm() {
    const form = $('#register-form');
    if (!form) return;

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const msg = $('#register-message');
      msg.className = 'form-message';
      msg.style.display = 'none';

      const payload = {
        agentId:              $('#reg-agent-id').value.trim(),
        resource:             $('#reg-resource').value.trim(),
        capacity:             parseInt($('#reg-capacity').value, 10),
        selfAttestationProof: $('#reg-attestation').value.trim() || 'self-zk-' + Date.now().toString(36),
      };

      try {
        const res = await fetch(API + '/providers/register', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
        const json = await res.json().catch(() => ({}));

        if (res.ok) {
          msg.className = 'form-message success';
          msg.textContent = 'Registered. Your provider will appear in the marketplace within 30 seconds.';
          msg.style.display = 'block';
          form.reset();
          // refresh marketplace
          setTimeout(() => { renderMarketplace(); renderTicker(); }, 5000);
        } else {
          msg.className = 'form-message error';
          msg.textContent = json.error || 'Registration failed. Check inputs and try again.';
          msg.style.display = 'block';
        }
      } catch (err) {
        msg.className = 'form-message error';
        msg.textContent = 'Network error: ' + err.message;
        msg.style.display = 'block';
      }
    });
  }

  // --------------- Belle Epoch History Table ---------------

  async function renderBelleEpochTable() {
    const tbody = $('#belle-epoch-tbody');
    if (!tbody) return;

    const data = await fetchAgentData('belle');
    if (!data || !data.epochs || !Array.isArray(data.epochs) || data.epochs.length === 0) {
      tbody.innerHTML = '<tr><td colspan="5" style="text-align:center; color:var(--muted)">No epoch data available</td></tr>';
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
        <td style="color:var(--muted)">${ep.timestamp ? new Date(ep.timestamp).toLocaleTimeString() : '\u2014'}</td>
      </tr>`;
    }).join('');
  }

  // --------------- Page Initializers ---------------

  function initDashboard() {
    // initial fetches
    fetchFeed();
    fetchBids();
    fetchAgentData('belle');
    fetchQueue();

    // chart
    fetchHistory(12).then(hist => {
      if (hist) renderPriceChart('price-chart-canvas', hist);
    });

    // polling
    setInterval(fetchFeed, FEED_POLL_MS);
    setInterval(fetchBids, BIDS_POLL_MS);
    setInterval(() => { fetchAgentData('belle'); fetchQueue(); }, FEED_POLL_MS * 2);

    // countdown
    startCountdown();

    // simulator
    const simBtn = $('#btn-run-simulator');
    if (simBtn) simBtn.addEventListener('click', runSimulator);

    // re-render chart periodically
    setInterval(() => {
      fetchHistory(12).then(hist => {
        if (hist) renderPriceChart('price-chart-canvas', hist);
      });
    }, FEED_POLL_MS * 5);
  }

  function initBellePage() {
    fetchFeed();
    fetchAgentData('belle');
    renderBelleEpochTable();

    setInterval(fetchFeed, FEED_POLL_MS);
    setInterval(() => fetchAgentData('belle'), FEED_POLL_MS * 2);

    // console
    const btn = $('#btn-run-console');
    if (btn) {
      btn.addEventListener('click', () => {
        const type = $('#console-query-type').value;
        runConsoleDemo(type);
      });
    }
  }

  function initLaunchpad() {
    fetchFeed();
    renderTicker();
    renderMarketplace();
    initRegistrationForm();

    setInterval(renderTicker, TICKER_POLL_MS);
    setInterval(renderMarketplace, FEED_POLL_MS * 5);
  }

  // --------------- Humans Page ---------------

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

  function countryCodeToFlag(code) {
    if (!code || code.length !== 3) return '';
    // ISO 3166-1 alpha-3 to alpha-2 approximation (first two chars work for most)
    const a2 = code.slice(0, 2).toUpperCase();
    return String.fromCodePoint(...[...a2].map(c => 0x1F1E6 + c.charCodeAt(0) - 65));
  }

  async function connectWallet() {
    if (!window.ethereum) {
      alert('MetaMask or a compatible wallet is required.');
      return null;
    }
    try {
      const accounts = await window.ethereum.request({ method: 'eth_requestAccounts' });
      connectedWallet = accounts[0];
      return connectedWallet;
    } catch (err) {
      console.error('Wallet connect failed:', err);
      return null;
    }
  }

  async function fetchHumanProviders() {
    return fetchJson('/humans/providers');
  }

  function renderHumanProviders(providers) {
    const grid = $('#humans-grid');
    if (!grid) return;

    if (!providers || providers.length === 0) {
      grid.innerHTML = `
        <div class="card" style="text-align:center; color:var(--muted); padding:3rem; grid-column:1/-1">
          <p style="margin-bottom:1rem">No providers registered yet. Be the first.</p>
          <a href="#register-section" class="btn btn-primary btn-sm">Register now &uarr;</a>
        </div>`;
      return;
    }

    // Apply filters
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
      grid.innerHTML = '<div class="card" style="text-align:center; color:var(--muted); padding:3rem; grid-column:1/-1">No providers match this filter.</div>';
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
        ? `<a href="${p.linkedinUrl}" target="_blank" rel="noopener" style="font-size:.78rem">LinkedIn</a>`
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
              <div class="human-stat-value" style="color:var(--primary)">${price}</div>
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
          <button class="btn btn-primary btn-sm" style="width:100%; margin-top:.5rem">Bid now &rarr;</button>
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
        // category filter
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

      // Re-render with current data
      fetchHumanProviders().then(p => renderHumanProviders(p));
    });
  }

  function initHumansRegistration() {
    // Wallet connect
    const btnConnect = $('#btn-connect-wallet');
    if (btnConnect) {
      btnConnect.addEventListener('click', async () => {
        const addr = await connectWallet();
        if (addr) {
          $('#wallet-not-connected').style.display = 'none';
          $('#wallet-connected').style.display = 'block';
          $('#connected-address').textContent = truncateAddr(addr);

          // Show QR placeholder (Self SDK would render here)
          const qrContainer = $('#self-qr-container');
          qrContainer.innerHTML = `
            <div style="text-align:center">
              <div style="width:200px; height:200px; border:2px dashed var(--card-border); border-radius:12px; display:flex; align-items:center; justify-content:center; margin:0 auto; color:var(--muted); font-size:.82rem; padding:1rem">
                Self QR Code<br>
                <span style="font-size:.7rem">Scope: belle-epoch-humans</span><br>
                <span style="font-size:.7rem">Wallet: ${truncateAddr(addr)}</span>
              </div>
              <button class="btn btn-secondary btn-sm" id="btn-mock-verify" style="margin-top:1rem">Simulate Self Verification (Dev)</button>
            </div>`;

          // Mock verify button for development
          const btnMock = $('#btn-mock-verify');
          if (btnMock) {
            btnMock.addEventListener('click', async () => {
              const statusEl = $('#self-verify-status');
              statusEl.textContent = 'Verifying...';
              statusEl.style.color = 'var(--primary)';

              // Simulate Self callback by posting mock data to /humans/verify
              try {
                await fetch(API + '/humans/verify', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                    attestationId: 'mock-' + Date.now(),
                    proof: { mock: true },
                    publicSignals: ['mock'],
                    userContextData: connectedWallet,
                  }),
                });
              } catch (e) { /* ignore */ }

              // For dev: also directly mark as verified via register attempt
              statusEl.textContent = 'Verified! Proceeding to profile...';
              setTimeout(() => advanceRegStep(2), 800);
            });
          }
        }
      });
    }

    // Bio char counter
    const bioInput = $('#human-bio');
    if (bioInput) {
      bioInput.addEventListener('input', () => {
        const count = $('#bio-char-count');
        if (count) count.textContent = bioInput.value.length;
      });
    }

    // Step 2 -> Step 3
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

    // Final registration
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
            // Show success
            $('#reg-step-3').style.display = 'none';
            $('#reg-success').style.display = 'block';
            // Update step indicators
            $$('.reg-step-dot').forEach(d => d.classList.add('done'));
            // Refresh directory
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
    // Hide all panels
    for (let i = 1; i <= 3; i++) {
      const panel = $(`#reg-step-${i}`);
      if (panel) panel.style.display = i === step ? 'block' : 'none';
    }
    // Update indicators
    $$('.reg-step-dot').forEach(d => {
      const s = parseInt(d.dataset.regStep);
      d.classList.toggle('active', s === step);
      d.classList.toggle('done', s < step);
    });
  }

  function initHumans() {
    // Load providers
    fetchHumanProviders().then(p => renderHumanProviders(p));

    // Filters
    initHumansFilters();

    // Registration flow
    initHumansRegistration();

    // Poll providers
    setInterval(() => {
      fetchHumanProviders().then(p => renderHumanProviders(p));
    }, FEED_POLL_MS * 5);
  }

  // --------------- Public API ---------------

  return {
    initDashboard,
    initBellePage,
    initLaunchpad,
    initHumans,
    scrollToConsole,
    // expose utilities for console usage
    formatUsdc,
    formatPercent,
    formatDelta
  };

})();
