#!/usr/bin/env node
'use strict';

const express = require('express');
const fs = require('fs');
const path = require('path');

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
    return '<tr><td colspan="8" class="empty">No qualifying wallets found</td></tr>';
  }
  return wallets.map(w => {
    const profileUrl = `https://polymarket.com/profile/${w.address}`;
    const tierBadges = (w.tiers || []).map(t =>
      `<span class="badge t${t}">T${t}</span>`
    ).join(' ');
    return `
      <tr>
        <td><a href="${profileUrl}" target="_blank" rel="noopener">${shortAddr(w.address)}</a></td>
        <td>${w.totalQualifying ?? 'N/A'}</td>
        <td>${pctFmt(w.winRate)}</td>
        <td>$${fmt(w.avgEntryPrice, 3)}</td>
        <td class="${pnlClass(w.overallPnl)}">${pnlFmt(w.overallPnl)}</td>
        <td class="categories">${w.topCategories || 'N/A'}</td>
        <td>${w.lastActiveDate || 'N/A'}</td>
        <td>${tierBadges}</td>
      </tr>`;
  }).join('');
}

function buildPage(results) {
  const scanTime = results ? new Date(results.scanTime).toLocaleString('en-US', { timeZone: 'UTC' }) + ' UTC' : 'No scan data';
  const stats = results?.stats || {};

  const tier1Rows = buildTableRows(results?.tier1);
  const tier2Rows = buildTableRows(results?.tier2);
  const tier3Rows = buildTableRows(results?.tier3);
  const multiRows = buildTableRows(results?.multiTier);

  const tableHeaders = `
    <tr>
      <th>Wallet</th>
      <th>Qualifying Trades</th>
      <th>Win Rate</th>
      <th>Avg Entry Price</th>
      <th>Overall PnL</th>
      <th>Top Categories</th>
      <th>Last Active</th>
      <th>Tiers</th>
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
    h1 {
      color: #58a6ff;
      font-size: 1.6rem;
      margin-bottom: 4px;
    }
    .subtitle { color: #8b949e; font-size: 0.85rem; margin-bottom: 24px; }
    .stats-bar {
      display: flex; flex-wrap: wrap; gap: 12px; margin-bottom: 28px;
    }
    .stat-chip {
      background: #161b22; border: 1px solid #30363d;
      border-radius: 6px; padding: 8px 14px; font-size: 0.82rem;
    }
    .stat-chip strong { color: #58a6ff; }
    section { margin-bottom: 40px; }
    h2 {
      font-size: 1.1rem; margin-bottom: 12px;
      padding-bottom: 6px; border-bottom: 1px solid #21262d;
    }
    .tier1 h2 { color: #ffd700; }
    .tier2 h2 { color: #c0c0c0; }
    .tier3 h2 { color: #cd7f32; }
    .multi  h2 { color: #a371f7; }
    .table-wrap { overflow-x: auto; }
    table {
      width: 100%; border-collapse: collapse;
      font-size: 0.83rem; min-width: 720px;
    }
    th {
      background: #161b22; color: #8b949e;
      text-align: left; padding: 8px 10px;
      border-bottom: 2px solid #21262d;
      white-space: nowrap;
    }
    td {
      padding: 7px 10px;
      border-bottom: 1px solid #161b22;
      vertical-align: middle;
    }
    tr:hover td { background: #161b22; }
    a { color: #58a6ff; text-decoration: none; font-family: monospace; }
    a:hover { text-decoration: underline; }
    .pos { color: #3fb950; }
    .neg { color: #f85149; }
    .empty { text-align: center; color: #8b949e; padding: 20px; }
    .categories { max-width: 200px; font-size: 0.78rem; color: #8b949e; }
    .badge {
      display: inline-block; border-radius: 4px;
      padding: 1px 6px; font-size: 0.72rem; font-weight: 600;
      margin: 1px;
    }
    .badge.t1 { background: #3a2e00; color: #ffd700; border: 1px solid #ffd700; }
    .badge.t2 { background: #1e1e1e; color: #c0c0c0; border: 1px solid #c0c0c0; }
    .badge.t3 { background: #2a1a0e; color: #cd7f32; border: 1px solid #cd7f32; }
    .refresh-note { font-size: 0.75rem; color: #6e7681; margin-top: 32px; }
  </style>
</head>
<body>
  <h1>Polymarket Wallet Scanner</h1>
  <div class="subtitle">Last updated: <strong>${scanTime}</strong> &mdash; Wallets scanned: <strong>${stats.walletsScanned ?? '—'}</strong></div>

  <div class="stats-bar">
    <div class="stat-chip">Tier 1 (Strict): <strong>${stats.tier1Count ?? 0}</strong></div>
    <div class="stat-chip">Tier 2 (Moderate): <strong>${stats.tier2Count ?? 0}</strong></div>
    <div class="stat-chip">Tier 3 (Emerging): <strong>${stats.tier3Count ?? 0}</strong></div>
    <div class="stat-chip">Multi-Tier: <strong>${stats.multiTierCount ?? 0}</strong></div>
  </div>

  <!-- TIER 1 -->
  <section class="tier1">
    <h2>🥇 Tier 1 — Strict (30+ trades · 60%+ win rate · Positive PnL · Active 30d)</h2>
    <div class="table-wrap">
      <table>
        <thead>${tableHeaders}</thead>
        <tbody>${tier1Rows}</tbody>
      </table>
    </div>
  </section>

  <!-- TIER 2 -->
  <section class="tier2">
    <h2>🥈 Tier 2 — Moderate (20+ trades · 55%+ win rate · Positive PnL · Active 30d)</h2>
    <div class="table-wrap">
      <table>
        <thead>${tableHeaders}</thead>
        <tbody>${tier2Rows}</tbody>
      </table>
    </div>
  </section>

  <!-- TIER 3 -->
  <section class="tier3">
    <h2>🥉 Tier 3 — Emerging (15+ trades · 50%+ win rate · Positive PnL · Active 30d)</h2>
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

  <p class="refresh-note">Data auto-loaded from latest scan on each page load. Scanner runs daily at 08:00 UTC.</p>
</body>
</html>`;
}

app.get('/', (req, res) => {
  const results = loadResults();
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(buildPage(results));
});

app.get('/api/results', (req, res) => {
  const results = loadResults();
  if (!results) return res.status(404).json({ error: 'No scan data yet' });
  res.json(results);
});

app.get('/health', (req, res) => res.json({ status: 'ok', time: new Date().toISOString() }));

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Polymarket Scanner dashboard running at http://0.0.0.0:${PORT}`);
});
