#!/usr/bin/env node
'use strict';

const express = require('express');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { execSync, spawn } = require('child_process');

const LOG_FILE = '/var/log/polymarket-scanner.log';

const PORT = 3000;
const DATA_FILE = path.join(__dirname, 'data', 'results.json');

const app = express();

function loadResults() {
  try {
    if (!fs.existsSync(DATA_FILE)) return null;
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    return JSON.parse(raw);
  } catch (e) {
    return null;
  }
}

function fetchExecutorStatus() {
  return new Promise((resolve) => {
    const req = http.get('http://127.0.0.1:3002/status', { timeout: 3000 }, (res) => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (_) { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

function fmt(n, decimals = 2) {
  if (n === null || n === undefined || isNaN(n)) return 'N/A';
  return Number(n).toFixed(decimals);
}

function pctFmt(n) {
  if (n === null || n === undefined || isNaN(n)) return 'N/A';
  return (n * 100).toFixed(1) + '%';
}

function pnlFmt(n) {
  if (n === null || n === undefined || isNaN(n)) return 'N/A';
  const sign = n >= 0 ? '+' : '';
  return `${sign}$${n.toFixed(2)}`;
}

function pnlClass(n) {
  if (n === null || n === undefined || isNaN(n)) return '';
  return n >= 0 ? 'pos' : 'neg';
}

function shortAddr(addr) {
  if (!addr) return '';
  return addr.slice(0, 6) + '…' + addr.slice(-4);
}

function buildTableRows(wallets) {
  if (!wallets || wallets.length === 0) {
    return '<tr><td colspan="11" class="empty">No qualifying wallets found</td></tr>';
  }
  return wallets.map((w, idx) => {
    const profileUrl = `https://polymarket.com/profile/${w.address}`;
    const tierBadges = (w.tiers || []).map(t =>
      `<span class="badge t${t}">T${t}</span>`
    ).join(' ');
    const rankBadge = idx === 0 ? '<span class="rank gold">#1</span>'
      : idx === 1 ? '<span class="rank silver">#2</span>'
      : idx === 2 ? '<span class="rank bronze">#3</span>'
      : `<span class="rank">#${idx + 1}</span>`;
    return `
      <tr>
        <td>${rankBadge}</td>
        <td><a href="${profileUrl}" target="_blank" rel="noopener">${shortAddr(w.address)}</a></td>
        <td>${w.totalQualifying ?? 'N/A'}</td>
        <td>${pctFmt(w.winRate)}</td>
        <td class="${isNaN(w.winRate7d) ? '' : (w.winRate7d >= 0.5 ? 'pos' : 'neg')}">${pctFmt(w.winRate7d)}</td>
        <td class="${isNaN(w.winRate30d) ? '' : (w.winRate30d >= 0.5 ? 'pos' : 'neg')}">${pctFmt(w.winRate30d)}</td>
        <td>$${fmt(w.avgEntryPrice, 3)}</td>
        <td class="${pnlClass(w.overallPnl)}">${pnlFmt(w.overallPnl)}</td>
        <td>${w.lastTradeDate || 'N/A'}</td>
        <td>${tierBadges}</td>
        <td class="score">${fmt(w.score, 3)}</td>
      </tr>`;
  }).join('');
}

function buildExecutionTab(exec) {
  if (!exec) {
    return `<div class="exec-offline">
      <p>Executor is <strong>offline</strong>. Start it with: <code>pm2 start executor.js --name polymarket-executor</code></p>
    </div>`;
  }

  const ds = exec.dailyStats || {};
  const buckets = exec.buckets || {};
  const botBadge = exec.botEnabled
    ? '<span class="badge-live">LIVE</span>'
    : '<span class="badge-sim">SIMULATION</span>';
  const wsBadge = exec.wsConnected
    ? '<span class="ws-ok">WS ✓</span>'
    : '<span class="ws-off">WS ✗</span>';

  // Bot status + daily limits
  const statusSection = `
    <div class="exec-header">
      <div class="exec-stat">Mode: ${botBadge}</div>
      <div class="exec-stat">WebSocket: ${wsBadge}</div>
      <div class="exec-stat">Started: <strong>${exec.startedAt ? new Date(exec.startedAt).toLocaleString('en-US', { timeZone: 'UTC' }) + ' UTC' : 'N/A'}</strong></div>
    </div>
    <div class="exec-grid">
      <div class="exec-card">
        <div class="exec-card-title">Daily Trades</div>
        <div class="exec-card-val">${ds.tradeCount ?? 0} <span class="exec-limit">/ 5 max</span></div>
      </div>
      <div class="exec-card">
        <div class="exec-card-title">Daily PnL</div>
        <div class="exec-card-val ${(ds.dailyPnl ?? 0) >= 0 ? 'pos' : 'neg'}">${pnlFmt(ds.dailyPnl ?? 0)}</div>
      </div>
      <div class="exec-card">
        <div class="exec-card-title">Open Positions</div>
        <div class="exec-card-val">${(exec.openPositions || []).length} <span class="exec-limit">/ 24 max</span></div>
      </div>
      <div class="exec-card">
        <div class="exec-card-title">Monitored Wallets</div>
        <div class="exec-card-val">${(exec.monitoredWallets || []).length}</div>
      </div>
    </div>`;

  // Category buckets
  const catSection = `
    <h2 class="exec-section-title">Category Status</h2>
    <div class="exec-grid">
      ${['S_TIER','TOP5_PNL','FALCON'].map(cat => {
        const b = buckets[cat] || {};
        const label = cat === 'S_TIER' ? 'S-Tier' : cat === 'TOP5_PNL' ? 'Top 5 PnL' : 'Falcon Elite';
        const color = cat === 'S_TIER' ? '#ffd700' : cat === 'TOP5_PNL' ? '#3fb950' : '#a371f7';
        return `<div class="exec-card" style="border-top: 2px solid ${color}">
          <div class="exec-card-title" style="color:${color}">${label}</div>
          <div class="exec-card-row">Wallets: <strong>${b.walletsMonitored ?? 0}</strong></div>
          <div class="exec-card-row">Detected: <strong>${b.tradesDetected ?? 0}</strong></div>
          <div class="exec-card-row">Mirrored: <strong>${b.tradesMirrored ?? 0}</strong></div>
          <div class="exec-card-row">Open: <strong>${b.openCount ?? 0} / 8</strong></div>
        </div>`;
      }).join('')}
    </div>`;

  // Open positions table
  const positions = exec.openPositions || [];
  const posRows = positions.length === 0
    ? '<tr><td colspan="7" class="empty">No open positions</td></tr>'
    : positions.map(p => `
        <tr>
          <td>${p.entryTime ? new Date(p.entryTime).toLocaleString('en-US', { timeZone: 'UTC' }) : 'N/A'}</td>
          <td>${p.source || p.bucket || ''}</td>
          <td><span class="mono">${p.address || ''}</span></td>
          <td class="mono">${(p.question || p.conditionId || '').slice(0, 40)}</td>
          <td>${p.outcomeIndex ?? ''}</td>
          <td>$${fmt(p.entryPrice, 3)}</td>
          <td>$${fmt(p.size)}</td>
        </tr>`).join('');

  const posSection = `
    <h2 class="exec-section-title">Open Positions (${positions.length})</h2>
    <div class="table-wrap">
      <table>
        <thead><tr>
          <th>Entry Time</th><th>Source</th><th>Wallet</th>
          <th>Market</th><th>Outcome</th><th>Entry $</th><th>Size</th>
        </tr></thead>
        <tbody>${posRows}</tbody>
      </table>
    </div>`;

  // Trade log
  const trades = exec.tradeLog || [];
  const tradeRows = trades.length === 0
    ? '<tr><td colspan="8" class="empty">No trades yet</td></tr>'
    : trades.map(t => `
        <tr>
          <td>${t.time ? new Date(t.time).toLocaleString('en-US', { timeZone: 'UTC' }) : 'N/A'}</td>
          <td><span class="badge ${t.status === 'LIVE' ? 'badge-live-sm' : 'badge-sim-sm'}">${t.status || 'SIM'}</span></td>
          <td>${t.source || t.bucket || ''}</td>
          <td><span class="mono">${t.sourceAddress || ''}</span></td>
          <td class="mono">${(t.question || t.conditionId || '').slice(0, 35)}</td>
          <td>$${fmt(t.entryPrice, 3)}</td>
          <td>$${fmt(t.size)}</td>
          <td class="${t.result === 'WIN' ? 'pos' : t.result === 'LOSS' ? 'neg' : ''}">${t.result || 'OPEN'}</td>
        </tr>`).join('');

  const tradeSection = `
    <h2 class="exec-section-title">Last ${trades.length} Trades</h2>
    <div class="table-wrap">
      <table>
        <thead><tr>
          <th>Time</th><th>Mode</th><th>Source</th><th>Wallet</th>
          <th>Market</th><th>Entry $</th><th>Size</th><th>Result</th>
        </tr></thead>
        <tbody>${tradeRows}</tbody>
      </table>
    </div>`;

  // Monitored wallets
  const wallets = exec.monitoredWallets || [];
  const walletRows = wallets.length === 0
    ? '<tr><td colspan="6" class="empty">No wallets loaded</td></tr>'
    : wallets.map(w => {
        const catColor = w.source === 'S_TIER' ? '#ffd700' : w.source === 'TOP5_PNL' ? '#3fb950' : '#a371f7';
        const catLabel = w.source === 'S_TIER' ? 'S-Tier' : w.source === 'TOP5_PNL' ? 'Top5PnL' : 'Falcon';
        return `<tr>
          <td><a href="https://polymarket.com/profile/${w.address}" target="_blank" rel="noopener" class="mono">${shortAddr(w.address)}</a></td>
          <td><span style="color:${catColor}">${catLabel}</span></td>
          <td>${pctFmt(w.winRate)}</td>
          <td class="${pnlClass(w.overallPnl)}">${pnlFmt(w.overallPnl ?? 0)}</td>
          <td>${fmt(w.score, 3)}</td>
          <td>${w.lastSeen ? new Date(w.lastSeen).toLocaleString('en-US', { timeZone: 'UTC' }) : 'Never'}</td>
        </tr>`;
      }).join('');

  const walletSection = `
    <h2 class="exec-section-title">Monitored Wallets (${wallets.length})</h2>
    <div class="table-wrap">
      <table>
        <thead><tr>
          <th>Wallet</th><th>Category</th><th>Win Rate</th><th>PnL</th><th>Score</th><th>Last Seen</th>
        </tr></thead>
        <tbody>${walletRows}</tbody>
      </table>
    </div>`;

  return statusSection + catSection + posSection + tradeSection + walletSection;
}

function buildPage(results, execStatus) {
  const scanTime = results
    ? new Date(results.scanTime).toLocaleString('en-US', { timeZone: 'UTC' }) + ' UTC'
    : 'No scan data';
  const stats = results?.stats || {};

  const tierSRows  = buildTableRows(results?.segment2?.tierS ?? results?.tierS);
  const tier1Rows  = buildTableRows(results?.tier1);
  const tier2Rows  = buildTableRows(results?.tier2);
  const tier3Rows  = buildTableRows(results?.tier3);
  const multiRows  = buildTableRows(results?.multiTier);

  const tableHeaders = `
    <tr>
      <th>#</th>
      <th>Wallet</th>
      <th>Qualifying Trades</th>
      <th>Win Rate (All)</th>
      <th>Win Rate 7d</th>
      <th>Win Rate 30d</th>
      <th>Avg Entry Price</th>
      <th>Overall PnL</th>
      <th>Last Trade</th>
      <th>Tiers</th>
      <th>Score ▼</th>
    </tr>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>Polymarket Wallet Scanner</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: 'Segoe UI', system-ui, sans-serif;
      background: #0d1117;
      color: #c9d1d9;
      min-height: 100vh;
      padding: 24px 16px;
    }
    h1 { color: #58a6ff; font-size: 1.6rem; margin-bottom: 4px; }
    .subtitle { color: #8b949e; font-size: 0.85rem; margin-bottom: 16px; }
    .stats-bar { display: flex; flex-wrap: wrap; gap: 12px; margin-bottom: 28px; }
    .stat-chip {
      background: #161b22; border: 1px solid #30363d;
      border-radius: 6px; padding: 8px 14px; font-size: 0.82rem;
    }
    .stat-chip strong { color: #58a6ff; }
    section { margin-bottom: 40px; }
    h2 { font-size: 1.1rem; margin-bottom: 12px; padding-bottom: 6px; border-bottom: 1px solid #21262d; }
    .stier h2 { color: #58a6ff; }
    .tier1 h2 { color: #ffd700; }
    .tier2 h2 { color: #c0c0c0; }
    .tier3 h2 { color: #cd7f32; }
    .multi  h2 { color: #a371f7; }
    .table-wrap { overflow-x: auto; }
    table { width: 100%; border-collapse: collapse; font-size: 0.83rem; min-width: 900px; }
    th {
      background: #161b22; color: #8b949e;
      text-align: left; padding: 8px 10px;
      border-bottom: 2px solid #21262d;
      white-space: nowrap;
    }
    td { padding: 7px 10px; border-bottom: 1px solid #161b22; vertical-align: middle; }
    tr:hover td { background: #161b22; }
    a { color: #58a6ff; text-decoration: none; }
    a:hover { text-decoration: underline; }
    .mono { font-family: monospace; }
    .pos { color: #3fb950; }
    .neg { color: #f85149; }
    .empty { text-align: center; color: #8b949e; padding: 20px; }
    .score { color: #e3b341; font-weight: 600; font-family: monospace; }
    .badge {
      display: inline-block; border-radius: 4px;
      padding: 1px 6px; font-size: 0.72rem; font-weight: 600; margin: 1px;
    }
    .badge.t1 { background: #3a2e00; color: #ffd700; border: 1px solid #ffd700; }
    .badge.t2 { background: #1e1e1e; color: #c0c0c0; border: 1px solid #c0c0c0; }
    .badge.t3 { background: #2a1a0e; color: #cd7f32; border: 1px solid #cd7f32; }
    .rank { font-size: 0.75rem; font-weight: 600; font-family: monospace; color: #6e7681; }
    .rank.gold   { color: #ffd700; }
    .rank.silver { color: #c0c0c0; }
    .rank.bronze { color: #cd7f32; }
    .refresh-note { font-size: 0.75rem; color: #6e7681; margin-top: 32px; }
    .filter-note {
      font-size: 0.78rem; color: #8b949e; background: #161b22;
      border: 1px solid #30363d; border-radius: 6px;
      padding: 10px 14px; margin-bottom: 20px;
    }
    .filter-note strong { color: #c9d1d9; }
    /* Tabs */
    .tabs { display: flex; gap: 4px; margin-bottom: 24px; border-bottom: 1px solid #21262d; }
    .tab-btn {
      background: none; border: none; color: #8b949e;
      padding: 8px 18px; cursor: pointer; font-size: 0.9rem;
      border-bottom: 2px solid transparent; margin-bottom: -1px;
    }
    .tab-btn:hover { color: #c9d1d9; }
    .tab-btn.active { color: #58a6ff; border-bottom-color: #58a6ff; }
    .tab-panel { display: none; }
    .tab-panel.active { display: block; }
    /* Execution tab */
    .exec-offline { color: #8b949e; padding: 24px; text-align: center; }
    .exec-offline code { background: #161b22; padding: 2px 8px; border-radius: 4px; font-size: 0.85rem; }
    .exec-header { display: flex; flex-wrap: wrap; gap: 16px; margin-bottom: 20px; align-items: center; }
    .exec-stat { font-size: 0.88rem; color: #8b949e; }
    .exec-stat strong { color: #c9d1d9; }
    .exec-grid { display: flex; flex-wrap: wrap; gap: 12px; margin-bottom: 28px; }
    .exec-card {
      background: #161b22; border: 1px solid #30363d; border-radius: 8px;
      padding: 14px 18px; min-width: 160px; flex: 1;
    }
    .exec-card-title { font-size: 0.75rem; color: #8b949e; margin-bottom: 6px; text-transform: uppercase; letter-spacing: 0.05em; }
    .exec-card-val { font-size: 1.4rem; font-weight: 700; color: #c9d1d9; }
    .exec-card-row { font-size: 0.82rem; color: #8b949e; margin-top: 4px; }
    .exec-card-row strong { color: #c9d1d9; }
    .exec-limit { font-size: 0.7rem; color: #6e7681; font-weight: 400; }
    .exec-section-title { font-size: 1rem; color: #8b949e; margin: 24px 0 12px; padding-bottom: 6px; border-bottom: 1px solid #21262d; }
    .badge-live { background: #0d3320; color: #3fb950; border: 1px solid #3fb950; border-radius: 4px; padding: 2px 8px; font-size: 0.78rem; font-weight: 700; }
    .badge-sim  { background: #1a1a2e; color: #a371f7; border: 1px solid #a371f7; border-radius: 4px; padding: 2px 8px; font-size: 0.78rem; font-weight: 700; }
    .badge-live-sm { background: #0d3320; color: #3fb950; border-radius: 3px; padding: 1px 5px; font-size: 0.7rem; }
    .badge-sim-sm  { background: #1a1a2e; color: #a371f7; border-radius: 3px; padding: 1px 5px; font-size: 0.7rem; }
    .ws-ok  { color: #3fb950; font-size: 0.82rem; }
    .ws-off { color: #f85149; font-size: 0.82rem; }
  </style>
</head>
<body>
  <h1>Polymarket Wallet Scanner</h1>
  <div class="subtitle">Scanner last updated: <strong>${scanTime}</strong></div>

  <div class="tabs">
    <button class="tab-btn active" onclick="switchTab('scanner', this)">Scanner</button>
    <button class="tab-btn" onclick="switchTab('execution', this)">Execution</button>
  </div>

  <div id="tab-scanner" class="tab-panel active">

  <div class="filter-note">
    <strong>Filters applied:</strong> BUY trades only · Entry price &lt; $0.50 · Market resolves within 14 days · Active in last 7 days · Positive overall PnL<br/>
    <strong>Score formula:</strong> Win Rate 7d × 0.5 + Win Rate 30d × 0.3 + Win Rate All × 0.2 + entry price bonus
  </div>

  <div class="stats-bar">
    <div class="stat-chip">Wallets scanned: <strong>${stats.walletsScanned ?? '—'}</strong></div>
    <div class="stat-chip">Skipped (bot): <strong>${stats.skippedBot ?? 0}</strong></div>
    <div class="stat-chip">Skipped (inactive): <strong>${stats.skippedActivity ?? 0}</strong></div>
    <div class="stat-chip">S-Tier: <strong>${stats.tierSCount ?? 0}</strong></div>
    <div class="stat-chip">Tier 1: <strong>${stats.tier1Count ?? 0}</strong></div>
    <div class="stat-chip">Tier 2: <strong>${stats.tier2Count ?? 0}</strong></div>
    <div class="stat-chip">Tier 3: <strong>${stats.tier3Count ?? 0}</strong></div>
    <div class="stat-chip">Multi-Tier: <strong>${stats.multiTierCount ?? 0}</strong></div>
  </div>

  <!-- S TIER -->
  <section class="stier">
    <h2>⭐ S-Tier — Elite (20+ resolved · 70%+ win rate · Positive PnL)</h2>
    <div class="table-wrap">
      <table>
        <thead>${tableHeaders}</thead>
        <tbody>${tierSRows}</tbody>
      </table>
    </div>
  </section>

  <!-- TIER 1 -->
  <section class="tier1">
    <h2>🥇 Tier 1 — Strict (30+ qualifying trades · 60%+ win rate · Positive PnL)</h2>
    <div class="table-wrap">
      <table>
        <thead>${tableHeaders}</thead>
        <tbody>${tier1Rows}</tbody>
      </table>
    </div>
  </section>

  <!-- TIER 2 -->
  <section class="tier2">
    <h2>🥈 Tier 2 — Moderate (20+ qualifying trades · 55%+ win rate · Positive PnL)</h2>
    <div class="table-wrap">
      <table>
        <thead>${tableHeaders}</thead>
        <tbody>${tier2Rows}</tbody>
      </table>
    </div>
  </section>

  <!-- TIER 3 -->
  <section class="tier3">
    <h2>🥉 Tier 3 — Emerging (15+ qualifying trades · 50%+ win rate · Positive PnL)</h2>
    <div class="table-wrap">
      <table>
        <thead>${tableHeaders}</thead>
        <tbody>${tier3Rows}</tbody>
      </table>
    </div>
  </section>

  <!-- MULTI-TIER -->
  <section class="multi">
    <h2>⭐ Best Targets — Appearing in Multiple Tiers</h2>
    <div class="table-wrap">
      <table>
        <thead>${tableHeaders}</thead>
        <tbody>${multiRows}</tbody>
      </table>
    </div>
  </section>

  <p class="refresh-note">Data loaded from latest scan on each page load. Scanner runs daily at 08:00 UTC.</p>

  </div><!-- end tab-scanner -->

  <div id="tab-execution" class="tab-panel">
    ${buildExecutionTab(execStatus)}
  </div>

  <script>
    function switchTab(name, btn) {
      document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      document.getElementById('tab-' + name).classList.add('active');
      btn.classList.add('active');
    }
  </script>
</body>
</html>`;
}

app.get('/', async (req, res) => {
  const [results, execStatus] = await Promise.all([
    Promise.resolve(loadResults()),
    fetchExecutorStatus(),
  ]);
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(buildPage(results, execStatus));
});

app.get('/api/results', (req, res) => {
  const results = loadResults();
  if (!results) return res.status(404).json({ error: 'No scan data yet' });
  res.json(results);
});

app.get('/api/executor', async (req, res) => {
  const status = await fetchExecutorStatus();
  if (!status) return res.status(503).json({ error: 'Executor not running' });
  res.json(status);
});

app.get('/api/logs', (req, res) => {
  const lines = Math.min(parseInt(req.query.lines || '100', 10), 2000);
  try {
    const output = execSync(`tail -n ${lines} ${LOG_FILE} 2>/dev/null || echo "Log file not found"`, { encoding: 'utf8' });
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.send(output);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/scan/trigger', (req, res) => {
  try {
    const existing = execSync("pgrep -f 'node.*scanner.js' || true", { encoding: 'utf8' }).trim();
    if (existing) {
      return res.json({ status: 'already_running', pids: existing.split('\n') });
    }
    const child = spawn('node', [path.join(__dirname, 'scanner.js')], {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
    res.json({ status: 'triggered', pid: child.pid });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/health', (req, res) => res.json({ status: 'ok', time: new Date().toISOString() }));

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Polymarket Scanner dashboard running at http://0.0.0.0:${PORT}`);
});
