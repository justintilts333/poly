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

function roiFmt(net, staked) {
  if (net == null || staked == null || isNaN(net) || isNaN(staked) || staked === 0) return 'N/A';
  const pct = (net / staked) * 100;
  const sign = pct >= 0 ? '+' : '';
  return `${sign}${pct.toFixed(1)}%`;
}

function buildTableRows(wallets, execData) {
  const COL_COUNT = 21;
  if (!wallets || wallets.length === 0) {
    return `<tr><td colspan="${COL_COUNT}" class="empty">No qualifying wallets found</td></tr>`;
  }

  const droppedWallets = execData?.droppedWallets || [];
  const sigPerf = execData?.signalPerformance || {};
  const openPositions = execData?.openPositions || [];
  const openByWallet = {};
  for (const p of openPositions) {
    const key = (p.sourceAddress || '').toLowerCase();
    if (!key) continue;
    openByWallet[key] = (openByWallet[key] || 0) + (parseFloat(p.size) || 0);
  }

  // Totals accumulators
  const T = {
    sig7d: 0, sigNet: 0, sigStaked: 0, sigWon: 0, sigLost: 0, sigOpen: 0, sigTotal: 0,
    wins30: 0, loss30: 0, net30: 0, staked30: 0,
    winRateSum: 0, winRateCount: 0,
    atWins: 0, atLoss: 0, atNet: 0, atStaked: 0,
    hasSigData: false,
  };

  const rows = wallets.map((w, idx) => {
    const profileUrl = `https://polymarket.com/profile/${w.address}`;
    const addrKey = (w.address || '').toLowerCase();

    const rankBadge = idx === 0 ? '<span class="rank gold">#1</span>'
      : idx === 1 ? '<span class="rank silver">#2</span>'
      : idx === 2 ? '<span class="rank bronze">#3</span>'
      : `<span class="rank">#${idx + 1}</span>`;

    const isDropped = droppedWallets.map(a => a.toLowerCase()).includes(addrKey);
    const statusBadge = isDropped
      ? '<span style="color:#f85149;font-size:0.75rem;font-weight:600">DROPPED</span>'
      : '<span style="color:#3fb950;font-size:0.75rem;font-weight:600">ACTIVE</span>';

    // Sig columns
    const sp = sigPerf[addrKey] || sigPerf[w.address] || null;
    const sigWon    = sp?.dollarsWon  ?? null;
    const sigLost   = sp?.dollarsLost ?? null;
    const sigNet    = (sigWon != null && sigLost != null) ? sigWon - sigLost : null;
    const sigOpen   = openByWallet[addrKey] ?? null;
    const sigStaked = sp?.totalStaked ?? (sigWon != null && sigLost != null ? sigWon + sigLost : null);
    const sigRoi    = roiFmt(sigNet, sigStaked);
    const sig7d     = sp?.sigs7d  ?? null;
    const sigTotal  = sp?.resolved ?? null;
    if (sp) {
      T.hasSigData = true;
      T.sig7d    += sig7d    ?? 0;
      T.sigNet   += sigNet   ?? 0;
      T.sigStaked+= sigStaked ?? 0;
      T.sigWon   += sigWon   ?? 0;
      T.sigLost  += sigLost  ?? 0;
      T.sigOpen  += sigOpen  ?? 0;
      T.sigTotal += sigTotal ?? 0;
    }

    // 30d columns — scanner stores total30dMarkets + winRate30d, not wins30d/losses30d separately
    const _total30 = w.total30dMarkets ?? null;
    const _wr30    = w.winRate30d;
    const wins30  = w.wins30d   ?? (_total30 != null && !isNaN(_wr30) ? Math.round(_wr30 * _total30) : null);
    const loss30  = w.losses30d ?? (_total30 != null && wins30 != null ? _total30 - wins30 : null);
    const net30   = w.pnl30d    ?? null;
    const staked30= w.staked30d ?? w.invested30d ?? null;
    const roi30   = roiFmt(net30, staked30);
    if (wins30  != null) T.wins30   += wins30;
    if (loss30  != null) T.loss30   += loss30;
    if (net30   != null) T.net30    += net30;
    if (staked30!= null) T.staked30 += staked30;

    // Win Rate
    if (w.winRate != null && !isNaN(w.winRate)) { T.winRateSum += w.winRate; T.winRateCount++; }

    // AT columns
    const atWins  = w.wins       ?? null;
    const atLoss  = w.losses     ?? null;
    const atNet   = w.overallPnl ?? null;
    const atStaked= w.totalStaked ?? w.totalInvested ?? null;
    const atRoi   = w.roi != null ? `${w.roi >= 0 ? '+' : ''}${(w.roi * 100).toFixed(1)}%` : roiFmt(atNet, atStaked);
    if (atWins  != null) T.atWins   += atWins;
    if (atLoss  != null) T.atLoss   += atLoss;
    if (atNet   != null) T.atNet    += atNet;
    if (atStaked!= null) T.atStaked += atStaked;

    const dv = (v) => v != null && !isNaN(v) ? ` data-val="${v}"` : ' data-val=""';
    const fmtSig = (v) => v == null ? '<span style="color:#6e7681">—</span>' : `$${fmt(v)}`;
    const fmtN   = (v) => v == null ? 'N/A' : v;

    // Column order: Rank | Name | Address | Status | My 7d Sigs | Sig Net | Sig Staked | Sig ROI% | Sig Won | Sig Loss | Sig Open | My Total Sigs | AT ROI | 30d Wins | 30d Loss | 30d Net | 30d ROI | Win Rate | AT Wins | AT Loss | AT Net
    return `
      <tr>
        <td${dv(idx + 1)}>${rankBadge}</td>
        <td data-val="">—</td>
        <td data-val="${w.address || ''}"><a href="${profileUrl}" target="_blank" rel="noopener" class="mono">${shortAddr(w.address)}</a></td>
        <td data-val="${isDropped ? 0 : 1}">${statusBadge}</td>
        <td${dv(sig7d)}>${fmtN(sig7d)}</td>
        <td class="${pnlClass(sigNet)}"${dv(sigNet)}>${sigNet != null ? pnlFmt(sigNet) : '<span style="color:#6e7681">—</span>'}</td>
        <td${dv(sigStaked)}>${fmtSig(sigStaked)}</td>
        <td class="${sigRoi === 'N/A' ? '' : (parseFloat(sigRoi) >= 0 ? 'pos' : 'neg')}" data-val="${sigRoi === 'N/A' ? '' : parseFloat(sigRoi)}">${sigRoi}</td>
        <td class="${sigWon != null ? 'pos' : ''}"${dv(sigWon)}>${fmtSig(sigWon)}</td>
        <td class="${sigLost != null ? 'neg' : ''}"${dv(sigLost != null ? -sigLost : null)}>${fmtSig(sigLost != null ? -sigLost : null)}</td>
        <td${dv(sigOpen)}>${fmtSig(sigOpen)}</td>
        <td${dv(sigTotal)}>${fmtN(sigTotal)}</td>
        <td class="${atRoi === 'N/A' ? '' : (parseFloat(atRoi) >= 0 ? 'pos' : 'neg')}" data-val="${atRoi === 'N/A' ? '' : parseFloat(atRoi)}">${atRoi}</td>
        <td${dv(wins30)}>${fmtN(wins30)}</td>
        <td${dv(loss30)}>${fmtN(loss30)}</td>
        <td class="${pnlClass(net30)}"${dv(net30)}>${net30 != null ? pnlFmt(net30) : 'N/A'}</td>
        <td class="${roi30 === 'N/A' ? '' : (parseFloat(roi30) >= 0 ? 'pos' : 'neg')}" data-val="${roi30 === 'N/A' ? '' : parseFloat(roi30)}">${roi30}</td>
        <td${dv(w.winRate)}>${pctFmt(w.winRate)}</td>
        <td${dv(atWins)}>${fmtN(atWins)}</td>
        <td${dv(atLoss)}>${fmtN(atLoss)}</td>
        <td class="${pnlClass(atNet)}"${dv(atNet)}>${atNet != null ? pnlFmt(atNet) : 'N/A'}</td>
      </tr>`;
  });

  // Totals row
  const tSigRoi    = roiFmt(T.sigNet,  T.sigStaked);
  const tRoi30     = roiFmt(T.net30,   T.staked30);
  const tAtRoi     = roiFmt(T.atNet,   T.atStaked);
  const tWinRate   = T.winRateCount > 0 ? pctFmt(T.winRateSum / T.winRateCount) : 'N/A';
  const dash = '<span style="color:#6e7681">—</span>';
  const totalsRow = `
    <tr class="totals-row" style="background:#161b22;font-weight:600;border-top:2px solid #30363d">
      <td style="color:#8b949e;font-size:0.75rem">TOTAL</td>
      <td>${dash}</td>
      <td>${dash}</td>
      <td>${dash}</td>
      <td>${T.hasSigData ? T.sig7d : dash}</td>
      <td class="${pnlClass(T.sigNet)}">${T.hasSigData ? pnlFmt(T.sigNet) : dash}</td>
      <td>${T.hasSigData ? '$' + fmt(T.sigStaked) : dash}</td>
      <td class="${tSigRoi === 'N/A' ? '' : (parseFloat(tSigRoi) >= 0 ? 'pos' : 'neg')}">${T.hasSigData ? tSigRoi : dash}</td>
      <td class="pos">${T.hasSigData ? '$' + fmt(T.sigWon) : dash}</td>
      <td class="neg">${T.hasSigData ? '-$' + fmt(T.sigLost) : dash}</td>
      <td>${T.hasSigData ? '$' + fmt(T.sigOpen) : dash}</td>
      <td>${T.hasSigData ? T.sigTotal : dash}</td>
      <td class="${tAtRoi === 'N/A' ? '' : (parseFloat(tAtRoi) >= 0 ? 'pos' : 'neg')}">${tAtRoi}</td>
      <td>${T.wins30}</td>
      <td>${T.loss30}</td>
      <td class="${pnlClass(T.net30)}">${pnlFmt(T.net30)}</td>
      <td class="${tRoi30 === 'N/A' ? '' : (parseFloat(tRoi30) >= 0 ? 'pos' : 'neg')}">${tRoi30}</td>
      <td>${tWinRate}</td>
      <td>${T.atWins}</td>
      <td>${T.atLoss}</td>
      <td class="${pnlClass(T.atNet)}">${pnlFmt(T.atNet)}</td>
    </tr>`;

  return rows.join('') + totalsRow;
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

function buildPaperTradesPanel(exec) {
  if (!exec) {
    return `<div class="paper-offline">Paper trading offline — executor not running.</div>`;
  }

  const positions = exec.openPositions || [];
  const trades    = (exec.tradeLog || []).slice(0, 20);
  const mode      = exec.botEnabled ? '<span class="badge-live">LIVE</span>' : '<span class="badge-sim">PAPER</span>';

  const openRows = positions.length === 0
    ? '<tr><td colspan="7" class="empty">No open positions</td></tr>'
    : positions.map(p => {
        const age = p.entryTime
          ? Math.round((Date.now() - new Date(p.entryTime)) / 3600000) + 'h ago'
          : '—';
        const srcColor = p.source === 'S_TIER' ? '#ffd700' : p.source === 'TOP5_PNL' ? '#3fb950' : '#a371f7';
        const srcLabel = p.source === 'S_TIER' ? 'S-Tier' : p.source === 'TOP5_PNL' ? 'Top5' : 'Falcon';
        return `<tr>
          <td style="color:${srcColor};font-weight:600;font-size:0.75rem">${srcLabel}</td>
          <td class="mono"><a href="https://polymarket.com/profile/${p.fullAddress || ''}" target="_blank" rel="noopener">${(p.address || '').slice(0,10)}</a></td>
          <td class="mono" style="max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${p.question || ''}">${(p.question || p.conditionId || '').slice(0, 35)}</td>
          <td>$${fmt(p.entryPrice, 3)}</td>
          <td>$${fmt(p.size)}</td>
          <td>${age}</td>
          <td><span style="color:#e3b341">OPEN</span></td>
        </tr>`;
      }).join('');

  const logRows = trades.length === 0
    ? '<tr><td colspan="7" class="empty">No trades yet</td></tr>'
    : trades.map(t => {
        const resColor = t.result === 'WIN' ? '#3fb950' : t.result === 'LOSS' ? '#f85149' : '#8b949e';
        const pnlStr   = t.pnl != null ? (t.pnl >= 0 ? `+$${t.pnl.toFixed(2)}` : `-$${Math.abs(t.pnl).toFixed(2)}`) : '—';
        const srcColor = t.source === 'S_TIER' ? '#ffd700' : t.source === 'TOP5_PNL' ? '#3fb950' : '#a371f7';
        const srcLabel = t.source === 'S_TIER' ? 'S-Tier' : t.source === 'TOP5_PNL' ? 'Top5' : 'Falcon';
        return `<tr>
          <td style="color:${srcColor};font-weight:600;font-size:0.75rem">${srcLabel}</td>
          <td class="mono">${(t.sourceAddress || '').slice(0,10)}</td>
          <td class="mono" style="max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${t.question || ''}">${(t.question || t.conditionId || '').slice(0, 35)}</td>
          <td>$${fmt(t.entryPrice, 3)}</td>
          <td>$${fmt(t.size)}</td>
          <td style="color:${resColor};font-weight:600">${t.result || 'OPEN'}</td>
          <td class="${t.pnl != null ? (t.pnl >= 0 ? 'pos' : 'neg') : ''}">${pnlStr}</td>
        </tr>`;
      }).join('');

  return `
    <div class="paper-panel">
      <div class="paper-header">
        <span class="paper-title">Paper Trades ${mode}</span>
        <span class="paper-meta">${positions.length} open · ${exec.dailyStats?.tradeCount ?? 0} today · Daily PnL: <span class="${pnlClass(exec.dailyStats?.dailyPnl)}">${pnlFmt(exec.dailyStats?.dailyPnl ?? 0)}</span></span>
      </div>
      <div class="paper-cols">
        <div class="paper-col">
          <div class="paper-col-title">Open Positions (${positions.length})</div>
          <div class="table-wrap">
            <table style="min-width:500px">
              <thead><tr><th>Source</th><th>Wallet</th><th>Market</th><th>Entry</th><th>Size</th><th>Age</th><th>Status</th></tr></thead>
              <tbody>${openRows}</tbody>
            </table>
          </div>
        </div>
        <div class="paper-col">
          <div class="paper-col-title">Recent Trades (last ${trades.length})</div>
          <div class="table-wrap">
            <table style="min-width:500px">
              <thead><tr><th>Source</th><th>Wallet</th><th>Market</th><th>Entry</th><th>Size</th><th>Result</th><th>PnL</th></tr></thead>
              <tbody>${logRows}</tbody>
            </table>
          </div>
        </div>
      </div>
    </div>`;
}

function buildCurrentTradersTab(exec, results) {
  if (!exec) {
    return `<div class="exec-offline"><p>Executor is <strong>offline</strong>. No current traders to display.</p></div>`;
  }

  // Build address → scanner wallet data map across all tiers
  const seg2 = results?.segment2 || {};
  const allTierWallets = [
    ...(seg2.tierS || []), ...(seg2.tier1 || []), ...(seg2.tier2 || []),
    ...(seg2.tier3 || []), ...(seg2.tier4 || []),
    ...(results?.tierS || []), ...(results?.tier1 || []),
    ...(results?.tier2 || []), ...(results?.tier3 || []),
  ];
  const scannerMap = {};
  for (const w of allTierWallets) {
    if (w.address) scannerMap[w.address.toLowerCase()] = w;
  }

  const monWallets = exec.monitoredWallets || [];
  const sigPerf = exec.signalPerformance || {};
  const openPositions = exec.openPositions || [];
  const droppedWallets = exec.droppedWallets || [];

  const openByWallet = {};
  for (const p of openPositions) {
    const key = (p.sourceAddress || '').toLowerCase();
    if (!key) continue;
    openByWallet[key] = (openByWallet[key] || 0) + (parseFloat(p.size) || 0);
  }

  if (monWallets.length === 0) {
    return `<div class="exec-offline"><p>No wallets currently being monitored by the executor.</p></div>`;
  }

  const th = (label) => `<th onclick="sortTable(this)" style="cursor:pointer;user-select:none">${label} <span class="sort-arrow"></span></th>`;
  const dv = (v) => v != null && !isNaN(v) ? ` data-val="${v}"` : ' data-val=""';
  const fmtSig = (v) => v == null ? '<span style="color:#6e7681">—</span>' : `$${fmt(v)}`;
  const fmtN   = (v) => v == null ? '<span style="color:#6e7681">—</span>' : v;
  const dash   = '<span style="color:#6e7681">—</span>';

  const rows = monWallets.map((w, idx) => {
    const addrKey = (w.address || '').toLowerCase();
    const profileUrl = `https://polymarket.com/profile/${w.address || ''}`;

    const rankBadge = idx === 0 ? '<span class="rank gold">#1</span>'
      : idx === 1 ? '<span class="rank silver">#2</span>'
      : idx === 2 ? '<span class="rank bronze">#3</span>'
      : `<span class="rank">#${idx + 1}</span>`;

    const isDropped = droppedWallets.map(a => a.toLowerCase()).includes(addrKey);
    const statusBadge = isDropped
      ? '<span style="color:#f85149;font-size:0.75rem;font-weight:600">DROPPED</span>'
      : '<span style="color:#3fb950;font-size:0.75rem;font-weight:600">ACTIVE</span>';

    const catColor = w.source === 'S_TIER' ? '#ffd700' : w.source === 'TOP5_PNL' ? '#3fb950' : '#a371f7';
    const catLabel = w.source === 'S_TIER' ? 'S-Tier' : w.source === 'TOP5_PNL' ? 'Top5PnL' : 'Falcon';

    // All-time sig data from executor
    const sp       = sigPerf[addrKey] || sigPerf[w.address] || null;
    const sigWon   = sp?.dollarsWon  ?? null;
    const sigLost  = sp?.dollarsLost ?? null;
    const sigNet   = (sigWon != null && sigLost != null) ? sigWon - sigLost : null;
    const sigOpen  = openByWallet[addrKey] ?? null;
    const sigStaked= sp?.totalStaked ?? (sigWon != null && sigLost != null ? sigWon + sigLost : null);
    const sigRoi   = roiFmt(sigNet, sigStaked);
    const sig7dCnt = sp?.sigs7d ?? null;

    // Scanner data for 7d / 30d
    const sw = scannerMap[addrKey] || null;

    const net7d    = sw?.pnl7d    ?? null;
    const staked7d = sw?.staked7d ?? sw?.invested7d ?? null;
    const wins7d   = sw?.wins7d   ?? null;
    const loss7d   = sw?.losses7d ?? null;
    const tot7d    = sw?.total7dMarkets ?? null;
    const roi7d    = roiFmt(net7d, staked7d);

    const _total30 = sw?.total30dMarkets ?? null;
    const _wr30    = sw?.winRate30d;
    const wins30   = sw?.wins30d   ?? (_total30 != null && !isNaN(_wr30) ? Math.round(_wr30 * _total30) : null);
    const loss30   = sw?.losses30d ?? (_total30 != null && wins30 != null ? _total30 - wins30 : null);
    const net30    = sw?.pnl30d    ?? null;
    const staked30 = sw?.staked30d ?? sw?.invested30d ?? null;
    const roi30    = roiFmt(net30, staked30);

    const sigRoiClass = sigRoi === 'N/A' ? '' : (parseFloat(sigRoi) >= 0 ? 'pos' : 'neg');
    const roi7dClass  = roi7d  === 'N/A' ? '' : (parseFloat(roi7d)  >= 0 ? 'pos' : 'neg');
    const roi30Class  = roi30  === 'N/A' ? '' : (parseFloat(roi30)  >= 0 ? 'pos' : 'neg');

    return `
      <tr>
        <td${dv(idx + 1)}>${rankBadge}</td>
        <td data-val="${w.address || ''}"><a href="${profileUrl}" target="_blank" rel="noopener" class="mono">${shortAddr(w.address || '')}</a></td>
        <td data-val="${w.source || ''}"><span style="color:${catColor};font-weight:600;font-size:0.78rem">${catLabel}</span></td>
        <td data-val="${isDropped ? 0 : 1}">${statusBadge}</td>
        <td class="${pnlClass(sigNet)}"${dv(sigNet)}>${sigNet != null ? pnlFmt(sigNet) : dash}</td>
        <td class="${sigRoiClass}" data-val="${sigRoi === 'N/A' ? '' : parseFloat(sigRoi)}">${sigRoi}</td>
        <td${dv(sigStaked)}>${fmtSig(sigStaked)}</td>
        <td${dv(sig7dCnt)}>${fmtN(sig7dCnt)}</td>
        <td class="${sigWon != null ? 'pos' : ''}"${dv(sigWon)}>${fmtSig(sigWon)}</td>
        <td class="${sigLost != null ? 'neg' : ''}"${dv(sigLost != null ? -sigLost : null)}>${fmtSig(sigLost != null ? -sigLost : null)}</td>
        <td${dv(sigOpen)}>${fmtSig(sigOpen)}</td>
        <td class="${pnlClass(net7d)}"${dv(net7d)}>${net7d != null ? pnlFmt(net7d) : dash}</td>
        <td class="${roi7dClass}" data-val="${roi7d === 'N/A' ? '' : parseFloat(roi7d)}">${roi7d}</td>
        <td${dv(staked7d)}>${fmtSig(staked7d)}</td>
        <td${dv(tot7d)}>${fmtN(tot7d)}</td>
        <td${dv(wins7d)}>${fmtN(wins7d)}</td>
        <td${dv(loss7d)}>${fmtN(loss7d)}</td>
        <td data-val="">—</td>
        <td class="${pnlClass(net30)}"${dv(net30)}>${net30 != null ? pnlFmt(net30) : dash}</td>
        <td class="${roi30Class}" data-val="${roi30 === 'N/A' ? '' : parseFloat(roi30)}">${roi30}</td>
        <td${dv(staked30)}>${fmtSig(staked30)}</td>
        <td${dv(_total30)}>${fmtN(_total30)}</td>
        <td${dv(wins30)}>${fmtN(wins30)}</td>
        <td${dv(loss30)}>${fmtN(loss30)}</td>
        <td data-val="">—</td>
      </tr>`;
  });

  const tableHeaders = `
    <tr>
      ${th('Rank')}${th('Wallet')}${th('Source')}${th('Status')}
      ${th('Sig Net $')}${th('Sig ROI %')}${th('Sig Staked $')}${th('My 7d Sigs')}${th('Sig Win $')}${th('Sig Loss $')}${th('Sig Open $')}
      ${th('7d Net')}${th('7d ROI %')}${th('7d Staked')}${th('7d Sigs')}${th('7d Win')}${th('7d Loss')}${th('7d Open')}
      ${th('30d Net')}${th('30d ROI %')}${th('30d Staked')}${th('30d Sigs')}${th('30d Win')}${th('30d Loss')}${th('30d Open')}
    </tr>`;

  return `
    <div class="ct-header">
      <span class="ct-title">Current Traders</span>
      <span class="ct-meta">${monWallets.length} wallets monitored · ${openPositions.length} open positions</span>
    </div>
    <div class="table-wrap" style="margin-top:16px">
      <table>
        <thead>${tableHeaders}</thead>
        <tbody>${rows.join('')}</tbody>
      </table>
    </div>`;
}

function buildPage(results, execStatus) {
  const scanTime = results
    ? new Date(results.scanTime).toLocaleString('en-US', { timeZone: 'UTC' }) + ' UTC'
    : 'No scan data';
  const seg2  = results?.segment2 || {};
  const stats = seg2.stats || results?.stats || {};

  const tierSRows  = buildTableRows(seg2.tierS   ?? results?.tierS,   execStatus);
  const tier1Rows  = buildTableRows(seg2.tier1   ?? results?.tier1,   execStatus);
  const tier2Rows  = buildTableRows(seg2.tier2   ?? results?.tier2,   execStatus);
  const tier3Rows  = buildTableRows(seg2.tier3   ?? results?.tier3,   execStatus);
  const multiRows  = buildTableRows(seg2.multiTier ?? results?.multiTier, execStatus);

  const th = (label) => `<th onclick="sortTable(this)" style="cursor:pointer;user-select:none">${label} <span class="sort-arrow"></span></th>`;
  const tableHeaders = `
    <tr>
      ${th('Rank')}${th('Name')}${th('Address')}${th('Status')}
      ${th('My 7d Sigs')}${th('Sig Net $')}${th('Sig Staked $')}${th('Sig ROI %')}
      ${th('Sig Won $')}${th('Sig Loss $')}${th('Sig Open $')}${th('My Total Sigs')}
      ${th('AT ROI')}
      ${th('30d Wins')}${th('30d Loss')}${th('30d Net')}${th('30d ROI')}
      ${th('Win Rate')}${th('AT Wins')}${th('AT Loss')}${th('AT Net')}
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
    /* Paper trades panel */
    .paper-panel { background: #0d1117; border: 1px solid #30363d; border-radius: 8px; padding: 16px; margin-bottom: 28px; }
    .paper-offline { color: #6e7681; font-size: 0.82rem; padding: 12px 0; margin-bottom: 28px; }
    .paper-header { display: flex; align-items: center; gap: 16px; margin-bottom: 14px; flex-wrap: wrap; }
    .paper-title { font-size: 1rem; font-weight: 600; color: #c9d1d9; }
    .paper-meta { font-size: 0.82rem; color: #8b949e; }
    .paper-cols { display: flex; gap: 20px; flex-wrap: wrap; }
    .paper-col { flex: 1; min-width: 300px; }
    .paper-col-title { font-size: 0.75rem; color: #8b949e; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 8px; }
    th:hover { color: #c9d1d9; background: #1c2128; }
    th[data-dir] { color: #58a6ff; }
    .sort-arrow::after { content: '↕'; font-size: 0.65rem; color: #444d56; margin-left: 3px; }
    th[data-dir="asc"]  .sort-arrow::after { content: '↑'; color: #58a6ff; }
    th[data-dir="desc"] .sort-arrow::after { content: '↓'; color: #58a6ff; }
    tr.totals-row td { color: #c9d1d9; }
    /* Current Traders tab */
    .ct-header { display: flex; align-items: center; gap: 16px; margin-bottom: 4px; flex-wrap: wrap; }
    .ct-title { font-size: 1.1rem; font-weight: 700; color: #c9d1d9; }
    .ct-meta { font-size: 0.82rem; color: #8b949e; }
  </style>
</head>
<body>
  <h1>Polymarket Wallet Scanner</h1>
  <div class="subtitle">Scanner last updated: <strong>${scanTime}</strong></div>

  <div class="tabs">
    <button class="tab-btn active" onclick="switchTab('scanner', this)">Scanner</button>
    <button class="tab-btn" onclick="switchTab('execution', this)">Execution</button>
    <button class="tab-btn" onclick="switchTab('current-traders', this)">Current Traders</button>
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

  <!-- PAPER TRADES -->
  ${buildPaperTradesPanel(execStatus)}

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

  <div id="tab-current-traders" class="tab-panel">
    ${buildCurrentTradersTab(execStatus, results)}
  </div>

  <script>
    function switchTab(name, btn) {
      document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      document.getElementById('tab-' + name).classList.add('active');
      btn.classList.add('active');
    }

    function sortTable(th) {
      const table = th.closest('table');
      const tbody = table.querySelector('tbody');
      const colIdx = Array.from(th.parentElement.children).indexOf(th);
      const asc = th.dataset.dir !== 'asc';
      th.parentElement.querySelectorAll('th').forEach(h => delete h.dataset.dir);
      th.dataset.dir = asc ? 'asc' : 'desc';

      const rows = Array.from(tbody.querySelectorAll('tr:not(.totals-row)'));
      rows.sort((a, b) => {
        const av = a.children[colIdx]?.dataset.val ?? '';
        const bv = b.children[colIdx]?.dataset.val ?? '';
        const an = parseFloat(av), bn = parseFloat(bv);
        if (!isNaN(an) && !isNaN(bn)) return asc ? an - bn : bn - an;
        // push blanks to bottom
        if (av === '' && bv !== '') return 1;
        if (bv === '' && av !== '') return -1;
        return asc ? av.localeCompare(bv) : bv.localeCompare(av);
      });

      const totalsRow = tbody.querySelector('.totals-row');
      rows.forEach(r => tbody.appendChild(r));
      if (totalsRow) tbody.appendChild(totalsRow);
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

  // Auto-trigger a fresh scan on startup (i.e. after every deploy).
  // Delay 5s to let PM2 finish restarting other processes first.
  // Kill any stale scanner from a previous deploy before starting the new one.
  setTimeout(() => {
    // Kill any lingering scanner and clear its lock
    try { execSync("pkill -f 'node.*scanner.js'", { stdio: 'ignore' }); } catch (_) {}
    try { fs.unlinkSync('/tmp/polymarket-scanner.lock'); } catch (_) {}
    try {
      const logStream = fs.openSync(LOG_FILE, 'a');
      const child = spawn('node', ['--max-old-space-size=768', path.join(__dirname, 'scanner.js')], {
        detached: true,
        stdio: ['ignore', logStream, logStream],
      });
      child.unref();
      console.log(`Auto-triggered scanner on startup (PID ${child.pid})`);
    } catch (e) {
      console.error('Failed to auto-trigger scanner:', e.message);
    }
  }, 5000);
});
