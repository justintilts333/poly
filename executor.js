#!/usr/bin/env node
'use strict';

/**
 * Polymarket Copy Trading Executor
 *
 * Reads three wallet categories from data/results.json:
 *   results.segment2.tierS[]       → S_TIER  (winRate ≥ 0.70, resolved ≥ 20)
 *   results.segment2.top5ByPnl[]   → TOP5_PNL (top 5 by overall PnL)
 *   results.segment1.wallets[]     → FALCON   (Heisenberg Elite wallets)
 *
 * Risk limits:
 *   - Max 8 open positions per category (24 total)
 *   - Max 5 new copy trades per day total
 *   - Configurable per-category position sizing
 *
 * Trade detection:
 *   Primary:  WebSocket subscription to CTF Exchange logs via Alchemy
 *   Fallback: Polling data-api /activity every 5 minutes per wallet
 *
 * Status API: http://127.0.0.1:3002/status (read by dashboard)
 */

require('dotenv').config();

const WebSocket = require('ws');
const https     = require('https');
const http      = require('http');
const fs        = require('fs');
const path      = require('path');

// ── Config ─────────────────────────────────────────────────────────────────────
const ALCHEMY_API_KEY        = process.env.ALCHEMY_API_KEY || '';
const BOT_ENABLED            = process.env.BOT_ENABLED === 'true';
const POLYMARKET_PRIVATE_KEY = process.env.POLYMARKET_PRIVATE_KEY || '';

const MAX_TRADES_PER_DAY  = Number(process.env.MAX_TRADES_PER_DAY)  || 5;
const MAX_OPEN_PER_CAT    = Number(process.env.MAX_OPEN_PER_CAT)    || 8;
const MIN_COPY_SIZE       = Number(process.env.MIN_COPY_SIZE)       || 5;   // USDC

const CAT_CFG = {
  S_TIER: {
    label:           'S-Tier',
    maxPositionSize: Number(process.env.MAX_POSITION_SIZE_STIER)   || 50,
    triggerFilter:   trade => trade.price < 0.50, // BUY under $0.50 in short-res markets
  },
  TOP5_PNL: {
    label:           'Top 5 PnL',
    maxPositionSize: Number(process.env.MAX_POSITION_SIZE_TOP5)    || 40,
    triggerFilter:   () => true, // mirror every BUY immediately
  },
  FALCON: {
    label:           'Falcon Elite',
    maxPositionSize: Number(process.env.MAX_POSITION_SIZE_FALCON)  || 30,
    triggerFilter:   trade => trade.price < 0.50,
  },
};

const GLOBAL_DAILY_LOSS_LIMIT = Number(process.env.GLOBAL_DAILY_LOSS_LIMIT) || 500;
const POLL_INTERVAL_MS        = Number(process.env.POLL_INTERVAL_MS)        || 300000; // 5 min
const WALLET_CHECK_COOLDOWN   = 60000; // 60s

const CTF_EXCHANGE = '0x4bfb41d5b3570defd03c39a9a4d8de6bd8b8982e';
const WS_URL       = ALCHEMY_API_KEY
  ? `wss://polygon-mainnet.g.alchemy.com/v2/${ALCHEMY_API_KEY}`
  : '';

const DATA_API    = 'https://data-api.polymarket.com';
const STATUS_PORT = 3002;

const STATE_FILE   = path.join(__dirname, 'data', 'executor-state.json');
const RESULTS_FILE = path.join(__dirname, 'data', 'results.json');

// ── Logging ────────────────────────────────────────────────────────────────────
const LOG_FILE = '/var/log/polymarket-scanner.log';
function log(msg) {
  const line = `[${new Date().toISOString()}] [EXECUTOR] ${msg}\n`;
  process.stdout.write(line);
  try { fs.appendFileSync(LOG_FILE, line); } catch (_) {}
}
function logError(msg, err) {
  const line = `[${new Date().toISOString()}] [EXECUTOR] ERROR: ${msg}${err ? ' | ' + (err.message || err) : ''}\n`;
  process.stderr.write(line);
  try { fs.appendFileSync(LOG_FILE, line); } catch (_) {}
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

function todayUTC() {
  return new Date().toISOString().split('T')[0];
}

// ── HTTP helper ────────────────────────────────────────────────────────────────
function fetchJSON(url, retries = 2, delayMs = 1500) {
  return new Promise((resolve, reject) => {
    const attempt = (n, delay) => {
      const req = https.get(url, {
        headers: { 'Accept': 'application/json', 'User-Agent': 'PolymarketExecutor/1.0' },
        timeout: 20000,
      }, (res) => {
        if (res.statusCode === 429) {
          const wait = parseInt(res.headers['retry-after'] || '10', 10) * 1000;
          res.resume();
          return setTimeout(() => attempt(n, delay), wait);
        }
        if (res.statusCode !== 200) {
          res.resume();
          if (n > 0) return setTimeout(() => attempt(n - 1, delay * 2), delay);
          return reject(new Error(`HTTP ${res.statusCode}`));
        }
        let data = '';
        res.on('data', c => { data += c; });
        res.on('end', () => {
          try { resolve(JSON.parse(data)); }
          catch (e) { reject(new Error('JSON parse error')); }
        });
      });
      req.on('error', err => n > 0 ? setTimeout(() => attempt(n - 1, delay * 2), delay) : reject(err));
      req.on('timeout', () => {
        req.destroy();
        if (n > 0) setTimeout(() => attempt(n - 1, delay * 2), delay);
        else reject(new Error('Timeout: ' + url));
      });
    };
    attempt(retries, delayMs);
  });
}

// ── State ──────────────────────────────────────────────────────────────────────
let state = null;

function defaultState() {
  return {
    startedAt:    new Date().toISOString(),
    botEnabled:   BOT_ENABLED,
    wsConnected:  false,
    wsSubscribed: false,
    dailyStats: {
      date:       todayUTC(),
      tradeCount: 0,
      dailyPnl:   0,
    },
    openPositions:    [],  // { id, address, source, conditionId, outcomeIndex, size, entryPrice, entryTime, question }
    tradeLog:         [],  // last 50 trades
    buckets: {
      S_TIER:   { walletsMonitored: 0, tradesDetected: 0, tradesMirrored: 0, openCount: 0 },
      TOP5_PNL: { walletsMonitored: 0, tradesDetected: 0, tradesMirrored: 0, openCount: 0 },
      FALCON:   { walletsMonitored: 0, tradesDetected: 0, tradesMirrored: 0, openCount: 0 },
    },
    monitoredWallets:  [],  // { address, source, score, winRate, overallPnl, lastSeen }
    lastWalletCheck:   {},  // address → timestamp ms
    signalPerformance: {},  // fullAddress → { resolved, dollarsWon, dollarsLost }
    droppedWallets:    [],  // full addresses dropped mid-cycle (excluded until next re-seed)
  };
}

function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
      if (raw.dailyStats?.date !== todayUTC()) {
        raw.dailyStats = defaultState().dailyStats;
      }
      const def = defaultState();
      return {
        ...def,
        ...raw,
        buckets:           { ...def.buckets, ...(raw.buckets || {}) },
        signalPerformance: raw.signalPerformance || {},
        droppedWallets:    raw.droppedWallets    || [],
      };
    }
  } catch (_) {}
  return defaultState();
}

function saveState() {
  try {
    const dataDir = path.join(__dirname, 'data');
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch (e) {
    logError('saveState failed', e);
  }
}

// ── Wallet loading ─────────────────────────────────────────────────────────────
function loadMonitoredWallets() {
  if (!fs.existsSync(RESULTS_FILE)) {
    log('No results.json — no wallets to monitor');
    return { byAddress: new Map(), all: [] };
  }

  let results;
  try {
    results = JSON.parse(fs.readFileSync(RESULTS_FILE, 'utf8'));
  } catch (e) {
    logError('Failed to parse results.json', e);
    return { byAddress: new Map(), all: [] };
  }

  const byAddress = new Map();
  const seen = new Set();

  const add = (wallets, source) => {
    for (const w of (wallets || [])) {
      if (!w.address) continue;
      const addr = w.address.toLowerCase();
      if (seen.has(addr)) continue; // first match wins (S_TIER > TOP5_PNL > FALCON)
      seen.add(addr);
      byAddress.set(addr, {
        address:    addr,
        source,
        score:      w.score      ?? w.hScore     ?? null,
        winRate:    w.winRate    ?? w.winRate15d  ?? null,
        overallPnl: w.overallPnl ?? w.totalPnl15d ?? null,
        trajectory: w.trajectory ?? null,
        lastSeen:   null,
      });
    }
  };

  // S_TIER and TOP5_PNL from segment2 (scanner output)
  add(results.segment2?.tierS,       'S_TIER');
  add(results.segment2?.top5ByPnl,   'TOP5_PNL');
  // FALCON from segment1 (Heisenberg data)
  add(results.segment1?.wallets,     'FALCON');

  const all = [...byAddress.values()];

  const countS  = all.filter(w => w.source === 'S_TIER').length;
  const countT  = all.filter(w => w.source === 'TOP5_PNL').length;
  const countF  = all.filter(w => w.source === 'FALCON').length;
  log(`Loaded ${all.length} wallets: S_TIER=${countS} TOP5_PNL=${countT} FALCON=${countF}`);

  return { byAddress, all };
}

// ── Risk checks ────────────────────────────────────────────────────────────────
function checkRisk(source, size) {
  const cfg = CAT_CFG[source];
  if (!cfg) return { ok: false, reason: `Unknown source: ${source}` };

  // Global daily loss
  if (state.dailyStats.dailyPnl < -GLOBAL_DAILY_LOSS_LIMIT) {
    return { ok: false, reason: `Global daily loss limit (${GLOBAL_DAILY_LOSS_LIMIT} USDC) reached` };
  }

  // Daily trade count
  if (state.dailyStats.tradeCount >= MAX_TRADES_PER_DAY) {
    return { ok: false, reason: `Daily trade limit (${MAX_TRADES_PER_DAY}) reached` };
  }

  // Per-category open positions
  const catOpen = (state.openPositions || []).filter(p => p.source === source).length;
  if (catOpen >= MAX_OPEN_PER_CAT) {
    return { ok: false, reason: `${source} max open positions (${MAX_OPEN_PER_CAT}) reached` };
  }

  // Cap size to category max
  const cappedSize = Math.min(size, cfg.maxPositionSize);
  if (cappedSize < MIN_COPY_SIZE) {
    return { ok: false, reason: `Capped size ${cappedSize} USDC below minimum (${MIN_COPY_SIZE} USDC)` };
  }

  return { ok: true, cappedSize };
}

// ── Mirror a trade ─────────────────────────────────────────────────────────────
async function mirrorTrade({ sourceAddress, source, conditionId, outcomeIndex, entryPrice, sourceSize, question }) {
  const risk = checkRisk(source, sourceSize);
  if (!risk.ok) {
    log(`SKIP [${source}] ${sourceAddress.slice(0, 8)}: ${risk.reason}`);
    return;
  }

  const size = Math.round(risk.cappedSize * 100) / 100;
  const tradeEntry = {
    id:            `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    time:          new Date().toISOString(),
    sourceAddress: sourceAddress.slice(0, 8) + '…' + sourceAddress.slice(-4),
    source,
    conditionId,
    outcomeIndex,
    entryPrice,
    size,
    question,
    status:        BOT_ENABLED ? 'LIVE' : 'SIM',
    result:        'OPEN',
  };

  if (!BOT_ENABLED) {
    log(`[SIM] BUY source=${source} wallet=${sourceAddress.slice(0,8)} market="${question?.slice(0,40)}" price=${entryPrice} size=${size} USDC`);
  } else {
    log(`[LIVE] Executing BUY source=${source} price=${entryPrice} size=${size} USDC`);
    // Live execution via Polymarket CLOB requires private key
    // To enable: set POLYMARKET_PRIVATE_KEY in .env and wire up @polymarket/clob-client
    log(`[LIVE] Private key present: ${!!POLYMARKET_PRIVATE_KEY} — execution stub only`);
  }

  const posEntry = {
    id:          tradeEntry.id,
    address:     tradeEntry.sourceAddress,  // truncated display label
    fullAddress: sourceAddress,             // full address — needed for resolution API calls
    source,
    conditionId,
    outcomeIndex,
    size,
    entryPrice,
    entryTime: tradeEntry.time,
    question,
  };

  state.openPositions.push(posEntry);
  state.tradeLog.unshift(tradeEntry);
  if (state.tradeLog.length > 50) state.tradeLog.length = 50;

  state.dailyStats.tradeCount++;
  if (state.buckets[source]) {
    state.buckets[source].tradesMirrored++;
    state.buckets[source].tradesDetected++;
    state.buckets[source].openCount = state.openPositions.filter(p => p.source === source).length;
  }

  saveState();
}

// ── Source wallet positions (for signal resolution) ────────────────────────────
// Returns Map of "conditionId:outcomeIndex" → curPrice
async function fetchSourcePositions(address) {
  const posMap = new Map();
  try {
    const data = await fetchJSON(`${DATA_API}/positions?user=${address}&limit=500`);
    const rows = Array.isArray(data) ? data : (data.data || data.positions || []);
    for (const p of rows) {
      const cid = (p.conditionId || p.condition_id || '').toLowerCase();
      const oi  = parseInt(p.outcomeIndex ?? -1);
      if (!cid || oi < 0) continue;
      posMap.set(`${cid}:${oi}`, parseFloat(p.curPrice ?? -1));
    }
  } catch (_) {}
  return posMap;
}

// ── Mid-cycle drop check ───────────────────────────────────────────────────────
// Called after each signal resolves for a given source wallet.
// Removes the wallet from active monitoring when live signal P&L turns negative.
function checkMidCycleDrop(address, monitoredMap) {
  const perf = state.signalPerformance[address];
  if (!perf || perf.resolved < 5) return;
  if (perf.dollarsLost <= perf.dollarsWon) return;

  const threshold = perf.resolved >= 10 ? '10+' : '5+';
  log(
    `DROP [mid_cycle] ${address.slice(0, 10)} | reason=mid_cycle_negative_signal_performance` +
    ` | threshold=${threshold} resolved=${perf.resolved}` +
    ` | won=$${perf.dollarsWon.toFixed(2)} lost=$${perf.dollarsLost.toFixed(2)}`
  );

  state.droppedWallets.push(address);
  monitoredMap.delete(address);
  monitoredAddressSet.delete(address);
  state.monitoredWallets = state.monitoredWallets.filter(w => w.address !== address);
  saveState();
}

// ── Open position resolution ───────────────────────────────────────────────────
// Periodically fetches source wallet positions to detect market resolution.
// curPrice ≥ 0.95 → WIN (token worth ~$1), curPrice < 0.05 → LOSS (token worthless).
// Updates signalPerformance per wallet and fires checkMidCycleDrop after each resolve.
async function resolveOpenPositions(monitoredMap) {
  if (!state.openPositions?.length) return;

  // Group by source wallet (fullAddress stored at copy time)
  const byWallet = new Map();
  for (const pos of state.openPositions) {
    if (!pos.fullAddress) continue;
    if (!byWallet.has(pos.fullAddress)) byWallet.set(pos.fullAddress, []);
    byWallet.get(pos.fullAddress).push(pos);
  }
  if (!byWallet.size) return;

  log(`Resolving open positions: ${state.openPositions.length} positions across ${byWallet.size} wallets`);

  const resolvedIds = new Set();

  for (const [walletAddr, positions] of byWallet) {
    const sourcePos = await fetchSourcePositions(walletAddr);
    await sleep(300);

    for (const pos of positions) {
      const key      = `${pos.conditionId}:${pos.outcomeIndex}`;
      const curPrice = sourcePos.get(key);
      if (curPrice === undefined || curPrice < 0) continue; // not found or API gap

      const isWin  = curPrice >= 0.95;
      const isLoss = curPrice < 0.05;
      if (!isWin && !isLoss) continue; // still live

      resolvedIds.add(pos.id);

      // P&L on our mirrored position: win = profit only; loss = full stake
      const dollarsWon  = isWin  ? +(pos.size * (1 / Math.max(pos.entryPrice, 0.001) - 1)).toFixed(2) : 0;
      const dollarsLost = isLoss ? pos.size : 0;

      // Update trade log entry
      const logEntry = state.tradeLog.find(t => t.id === pos.id);
      if (logEntry) {
        logEntry.result     = isWin ? 'WIN' : 'LOSS';
        logEntry.resolvedAt = new Date().toISOString();
        logEntry.pnl        = isWin ? dollarsWon : -dollarsLost;
      }

      log(
        `RESOLVED [${pos.source}] ${walletAddr.slice(0, 10)}` +
        ` market=${pos.conditionId.slice(0, 10)} outcome=${isWin ? 'WIN' : 'LOSS'}` +
        ` won=$${dollarsWon.toFixed(2)} lost=$${dollarsLost.toFixed(2)}`
      );

      // Per-wallet signal performance
      if (!state.signalPerformance[walletAddr]) {
        state.signalPerformance[walletAddr] = { resolved: 0, dollarsWon: 0, dollarsLost: 0 };
      }
      const perf = state.signalPerformance[walletAddr];
      perf.resolved++;
      perf.dollarsWon  += dollarsWon;
      perf.dollarsLost += dollarsLost;

      checkMidCycleDrop(walletAddr, monitoredMap);
    }
  }

  if (resolvedIds.size > 0) {
    state.openPositions = state.openPositions.filter(p => !resolvedIds.has(p.id));
    for (const cat of ['S_TIER', 'TOP5_PNL', 'FALCON']) {
      if (state.buckets[cat]) {
        state.buckets[cat].openCount = state.openPositions.filter(p => p.source === cat).length;
      }
    }
    log(`Closed ${resolvedIds.size} positions, ${state.openPositions.length} remaining open`);
    saveState();
  }
}

// ── Activity check per wallet ──────────────────────────────────────────────────
const knownLatestTs = new Map(); // address → last trade ts seen

async function checkWallet(address, info) {
  if (state.droppedWallets.includes(address)) return; // mid-cycle drop applied
  try {
    const url = `${DATA_API}/activity?user=${address}&limit=20&sortBy=TIMESTAMP&ascending=false`;
    const data = await fetchJSON(url, 2, 2000);
    const rows = Array.isArray(data) ? data : (data.data || data.activity || []);
    if (!rows.length) return;

    const prevLatest = knownLatestTs.get(address) || 0;
    let newLatest = prevLatest;

    for (const row of rows) {
      let ts = row.timestamp ?? 0;
      if (typeof ts === 'number' && ts > 0 && ts < 1e12) ts *= 1000;
      if (ts <= prevLatest) continue;
      if (ts > newLatest) newLatest = ts;

      // Must be a BUY
      const tType = (row.type || '').toUpperCase();
      const side  = (row.side  || '').toUpperCase();
      if (side !== 'BUY' && tType !== 'BUY') continue;
      if (tType === 'REDEEM' || tType === 'SELL') continue;

      const price    = parseFloat(row.price ?? row.avgPrice ?? 1);
      const usdcSize = parseFloat(row.usdcSize ?? 0);
      if (isNaN(price) || usdcSize <= 0) continue;

      // Apply per-category trigger filter
      const catFilter = CAT_CFG[info.source]?.triggerFilter;
      if (catFilter && !catFilter({ price, usdcSize, row })) continue;

      if (state.buckets[info.source]) {
        state.buckets[info.source].tradesDetected++;
      }

      await mirrorTrade({
        sourceAddress: address,
        source:        info.source,
        conditionId:   (row.conditionId || '').toLowerCase(),
        outcomeIndex:  row.outcomeIndex ?? 0,
        entryPrice:    price,
        sourceSize:    usdcSize,
        question:      row.title || row.question || '',
      });
    }

    if (newLatest > prevLatest) {
      knownLatestTs.set(address, newLatest);
      info.lastSeen = new Date(newLatest).toISOString();
      // Update monitoredWallets entry
      const mw = state.monitoredWallets.find(w => w.address === address);
      if (mw) mw.lastSeen = info.lastSeen;
    }

    state.lastWalletCheck[address] = Date.now();
  } catch (e) {
    logError(`checkWallet ${address}`, e);
  }
}

// ── WebSocket: CTF Exchange log subscription ───────────────────────────────────
let ws = null;
let wsReconnectDelay = 2000;
let monitoredAddressSet = new Set();

function topicToAddress(topic) {
  if (!topic || topic.length < 42) return null;
  return '0x' + topic.slice(-40).toLowerCase();
}

function connectWebSocket(monitoredMap) {
  if (!WS_URL) {
    log('No ALCHEMY_API_KEY — WebSocket disabled, polling only');
    return;
  }

  ws = new WebSocket(WS_URL);

  ws.on('open', () => {
    log('WebSocket connected to Alchemy');
    state.wsConnected  = true;
    wsReconnectDelay = 2000;

    ws.send(JSON.stringify({
      jsonrpc: '2.0',
      id:      1,
      method:  'eth_subscribe',
      params:  ['logs', { address: CTF_EXCHANGE }],
    }));
  });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch (_) { return; }

    if (msg.id === 1 && msg.result) {
      state.wsSubscribed = true;
      log(`WebSocket subscribed to CTF Exchange logs (id: ${msg.result})`);
      return;
    }

    if (msg.method === 'eth_subscription' && msg.params?.result) {
      const topics = msg.params.result.topics || [];
      for (const topic of topics) {
        const addr = topicToAddress(topic);
        if (!addr || !monitoredAddressSet.has(addr)) continue;

        const now = Date.now();
        if ((state.lastWalletCheck[addr] || 0) + WALLET_CHECK_COOLDOWN > now) continue;

        state.lastWalletCheck[addr] = now;
        const info = monitoredMap.get(addr);
        if (info) {
          log(`WS: ${addr.slice(0,10)} detected in CTF log → checking activity`);
          checkWallet(addr, info).catch(e => logError('WS-triggered check', e));
        }
        break;
      }
    }
  });

  ws.on('error', err => logError('WebSocket error', err));

  ws.on('close', () => {
    state.wsConnected  = false;
    state.wsSubscribed = false;
    log(`WebSocket closed — reconnecting in ${wsReconnectDelay}ms`);
    setTimeout(() => {
      wsReconnectDelay = Math.min(wsReconnectDelay * 2, 60000);
      connectWebSocket(monitoredMap);
    }, wsReconnectDelay);
  });
}

// ── Poll loop ──────────────────────────────────────────────────────────────────
async function pollCycle(monitoredMap) {
  const now = Date.now();
  let checked = 0;
  for (const [addr, info] of monitoredMap) {
    if ((state.lastWalletCheck[addr] || 0) + POLL_INTERVAL_MS > now) continue;
    await checkWallet(addr, info);
    checked++;
    await sleep(250);
  }
  if (checked > 0) log(`Poll: checked ${checked}/${monitoredMap.size} wallets`);
}

// ── Status HTTP server (localhost:3002) ────────────────────────────────────────
function startStatusServer() {
  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/status') {
      res.setHeader('Content-Type', 'application/json');
      // Omit lastWalletCheck (large map, not needed in UI)
      const { lastWalletCheck, ...out } = state; // eslint-disable-line no-unused-vars
      res.end(JSON.stringify(out));
      return;
    }
    if (req.method === 'GET' && req.url === '/health') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ ok: true, time: new Date().toISOString() }));
      return;
    }
    res.writeHead(404);
    res.end('Not found');
  });

  server.listen(STATUS_PORT, '127.0.0.1', () => {
    log(`Status API → http://127.0.0.1:${STATUS_PORT}/status`);
  });

  server.on('error', e => logError('Status server', e));
}

// ── Main ───────────────────────────────────────────────────────────────────────
async function main() {
  log(`=== Polymarket Executor starting ===`);
  log(`  BOT_ENABLED=${BOT_ENABLED} | ALCHEMY_WS=${!!WS_URL} | MAX_TRADES_DAY=${MAX_TRADES_PER_DAY}`);

  state = loadState();
  state.startedAt = new Date().toISOString();
  state.botEnabled = BOT_ENABLED;

  if (state.dailyStats.date !== todayUTC()) {
    log('New day — resetting daily stats');
    state.dailyStats = defaultState().dailyStats;
  }

  const { byAddress: monitoredMap, all: walletList } = loadMonitoredWallets();
  monitoredAddressSet = new Set(monitoredMap.keys());

  state.monitoredWallets = walletList.map(w => ({
    address:    w.address,
    source:     w.source,
    score:      w.score,
    winRate:    w.winRate,
    overallPnl: w.overallPnl,
    trajectory: w.trajectory,
    lastSeen:   w.lastSeen,
  }));

  for (const cat of ['S_TIER', 'TOP5_PNL', 'FALCON']) {
    state.buckets[cat] = state.buckets[cat] || { walletsMonitored: 0, tradesDetected: 0, tradesMirrored: 0, openCount: 0 };
    state.buckets[cat].walletsMonitored = walletList.filter(w => w.source === cat).length;
    state.buckets[cat].openCount = (state.openPositions || []).filter(p => p.source === cat).length;
  }

  saveState();
  startStatusServer();

  if (walletList.length === 0) {
    log('WARNING: No wallets loaded. Run scanner and Falcon fetcher first.');
  }

  connectWebSocket(monitoredMap);

  // Poll loop — resolves open positions every ~10 minutes (every 20 ticks × 30s)
  let resolveTick = 0;
  while (true) {
    try { await pollCycle(monitoredMap); } catch (e) { logError('Poll cycle', e); }
    resolveTick++;
    if (resolveTick % 20 === 0) {
      try { await resolveOpenPositions(monitoredMap); } catch (e) { logError('resolveOpenPositions', e); }
    }
    await sleep(30000);
  }
}

main().catch(e => {
  logError('Fatal', e);
  process.exit(1);
});
