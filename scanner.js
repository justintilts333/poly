#!/usr/bin/env node
'use strict';

const https = require('https');
const fs = require('fs');
const path = require('path');

const LOG_FILE       = '/var/log/polymarket-scanner.log';
const DATA_FILE      = path.join(__dirname, 'data', 'results.json');
const LOCK_FILE      = '/tmp/polymarket-scanner.lock';
const CHECKPOINT_FILE = path.join(__dirname, 'data', 'checkpoint.json');

// ── Single-instance lock ───────────────────────────────────────────────────────
function acquireLock() {
  try {
    const fd = fs.openSync(LOCK_FILE, 'wx');
    fs.writeSync(fd, String(process.pid));
    fs.closeSync(fd);
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    let stale = true;
    try {
      const raw = fs.readFileSync(LOCK_FILE, 'utf8').trim();
      const pid = parseInt(raw, 10);
      if (Number.isInteger(pid) && pid > 0 && pid !== process.pid) {
        process.kill(pid, 0);
        stale = false;
      }
    } catch (_) {
      if (_.code === 'EPERM') stale = false;
    }
    if (!stale) {
      process.stderr.write(`Scanner already running. Exiting.\n`);
      process.exitCode = 0;
      process.exit();
    }
    fs.unlinkSync(LOCK_FILE);
    const fd = fs.openSync(LOCK_FILE, 'wx');
    fs.writeSync(fd, String(process.pid));
    fs.closeSync(fd);
  }
}
acquireLock();
process.on('exit', () => { try { fs.unlinkSync(LOCK_FILE); } catch (_) {} });
process.on('SIGINT', () => process.exit());
process.on('SIGTERM', () => process.exit());

// ── Logging ────────────────────────────────────────────────────────────────────
function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  process.stdout.write(line);
  try { fs.appendFileSync(LOG_FILE, line); } catch (_) {}
}
function logError(msg, err) {
  const line = `[${new Date().toISOString()}] ERROR: ${msg}${err ? ' | ' + (err.message || err) : ''}\n`;
  process.stderr.write(line);
  try { fs.appendFileSync(LOG_FILE, line); } catch (_) {}
}

// ── HTTP helper ────────────────────────────────────────────────────────────────
function fetchJSON(url, retries = 3, delayMs = 2000) {
  return new Promise((resolve, reject) => {
    const attempt = (n, delay) => {
      const req = https.get(url, {
        headers: {
          'Accept': 'application/json',
          'User-Agent': 'Mozilla/5.0 (compatible; PolymarketScanner/2.0)',
        },
        timeout: 30000,
      }, (res) => {
        if (res.statusCode === 429) {
          const wait = parseInt(res.headers['retry-after'] || '10', 10) * 1000;
          log(`Rate limited (429), waiting ${wait}ms`);
          res.resume();
          setTimeout(() => attempt(n, delay), wait);
          return;
        }
        if (res.statusCode !== 200) {
          res.resume();
          if (n > 0) { setTimeout(() => attempt(n - 1, delay * 2), delay); return; }
          return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
        }
        let data = '';
        res.on('data', c => { data += c; });
        res.on('end', () => {
          try { resolve(JSON.parse(data)); }
          catch (e) { reject(new Error(`JSON parse error: ${e.message}`)); }
        });
      });
      req.on('error', err => {
        if (n > 0) setTimeout(() => attempt(n - 1, delay * 2), delay);
        else reject(err);
      });
      req.on('timeout', () => {
        req.destroy();
        if (n > 0) setTimeout(() => attempt(n - 1, delay * 2), delay);
        else reject(new Error(`Timeout: ${url}`));
      });
    };
    attempt(retries, delayMs);
  });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── Load env vars from .env.sh if not already set ─────────────────────────────
(function loadEnvFile() {
  if (process.env.HEISENBERG_API_KEY) return;
  try {
    const envSh = fs.readFileSync(path.join(__dirname, '.env.sh'), 'utf8');
    const match = envSh.match(/HEISENBERG_API_KEY="([^"]+)"/);
    if (match && match[1]) {
      process.env.HEISENBERG_API_KEY = match[1];
      log('Loaded HEISENBERG_API_KEY from .env.sh');
    } else {
      log('WARNING: HEISENBERG_API_KEY not found in .env.sh');
    }
  } catch (e) {
    log(`WARNING: Could not read .env.sh — ${e.message}`);
  }
})();

// ── API base URLs ──────────────────────────────────────────────────────────────
const DATA_API          = 'https://data-api.polymarket.com';
const GAMMA_API         = 'https://gamma-api.polymarket.com';
const HEISENBERG_HOST   = 'narrative.agent.heisenberg.so';
const HEISENBERG_KEY    = process.env.HEISENBERG_API_KEY || '';

const MIN_MARKET_VOLUME = 50_000; // only consider markets with ≥$50k total volume

// ── Heisenberg agent 574 (market outcome lookup) ───────────────────────────────
const marketOutcomeCache = new Map(); // conditionId → winnerOutcomeIndex (0|1) or undefined
const h574Stats = { attempts: 0, hits: 0, failures: 0, cacheHits: 0, reconnects: 0 };

// ── Direct gamma outcome cache (final fallback for loss detection) ─────────────
const gammaOutcomeCache = new Map(); // conditionId → winnerOutcomeIndex (0|1) or undefined
const gammaOutcomeStats = { fetches: 0, cacheHits: 0, resolved: 0 };
let h574SessionRef = null; // module-level so lookupMarketOutcome can reconnect

// Opens a persistent SSE session to Heisenberg. Returns { call, close } or null on failure.
function openHeisenbergSession() {
  return new Promise((resolve) => {
    if (!HEISENBERG_KEY) {
      log('WARNING: HEISENBERG_API_KEY not set — agent 574 win/loss detection DISABLED');
      return resolve(null);
    }

    let sessionPath = null;
    const pending = new Map();
    let msgId = 0;
    let settled = false;

    function sendMsg(body) {
      return new Promise((res, rej) => {
        const payload = JSON.stringify(body);
        const r = https.request({
          hostname: HEISENBERG_HOST, path: sessionPath, method: 'POST',
          headers: {
            'Authorization': `Bearer ${HEISENBERG_KEY}`,
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(payload),
          },
          timeout: 15000,
        }, (response) => { response.resume(); });
        r.on('error', rej);
        r.write(payload); r.end();
        if (body.id != null) {
          pending.set(body.id, res);
          setTimeout(() => {
            if (pending.has(body.id)) { pending.delete(body.id); rej(new Error(`h574 timeout id=${body.id}`)); }
          }, 45000);
        } else { res(null); }
      });
    }

    async function runHandshake(sseReq) {
      await sendMsg({ jsonrpc: '2.0', id: ++msgId, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'scanner', version: '1.0' } } });
      await sendMsg({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} });
      await sendMsg({ jsonrpc: '2.0', id: ++msgId, method: 'tools/call', params: { name: 'authenticate', arguments: { token: HEISENBERG_KEY } } });
      log('Heisenberg session (agent 574) ready — true win/loss detection enabled');
      settled = true;
      resolve({
        call: async (agentId, params) => {
          const id = ++msgId;
          return sendMsg({
            jsonrpc: '2.0', id, method: 'tools/call',
            params: {
              name: 'perform_parameterized_retrieval',
              arguments: { token: HEISENBERG_KEY, agent_id: agentId, params, formatter_config: { format_type: 'raw' } },
            },
          });
        },
        close: () => { try { sseReq.destroy(); } catch (_) {} },
      });
    }

    const req = https.get({
      hostname: HEISENBERG_HOST, path: '/sse',
      headers: { 'Authorization': `Bearer ${HEISENBERG_KEY}`, 'Accept': 'text/event-stream' },
      timeout: 60000,
    }, (res) => {
      let buf = '', eventType = '';
      res.on('data', chunk => {
        buf += chunk.toString();
        const lines = buf.split('\n'); buf = lines.pop();
        for (const line of lines) {
          if (line.startsWith('event:')) { eventType = line.slice(6).trim(); }
          else if (line.startsWith('data:')) {
            const data = line.slice(5).trim();
            if (eventType === 'endpoint' || data.startsWith('/messages')) {
              sessionPath = data;
              runHandshake(req).catch(err => {
                logError('WARNING: Heisenberg session handshake failed — agent 574 DISABLED', err);
                if (!settled) { settled = true; req.destroy(); resolve(null); }
              });
            } else {
              try {
                const msg = JSON.parse(data);
                if (msg.id != null && pending.has(msg.id)) {
                  const cb = pending.get(msg.id); pending.delete(msg.id); cb(msg);
                }
              } catch (_) {}
            }
            eventType = '';
          }
        }
      });
      res.on('error', err => {
        logError('WARNING: Heisenberg SSE stream error — agent 574 DISABLED', err);
        if (!settled) { settled = true; resolve(null); }
      });
    });
    req.on('error', err => {
      logError('WARNING: Heisenberg connect error — agent 574 DISABLED', err);
      if (!settled) { settled = true; resolve(null); }
    });
    req.on('timeout', () => {
      req.destroy();
      logError('WARNING: Heisenberg SSE timeout — agent 574 DISABLED', null);
      if (!settled) { settled = true; resolve(null); }
    });
  });
}

// Look up which outcome won for a given conditionId via agent 574.
// Returns winnerOutcomeIndex (0|1) or undefined (unresolved / API failure).
// Uses module-level h574SessionRef and auto-reconnects on failure.
async function lookupMarketOutcome(cid) {
  if (marketOutcomeCache.has(cid)) { h574Stats.cacheHits++; return marketOutcomeCache.get(cid); }
  if (!h574SessionRef) return undefined;

  h574Stats.attempts++;

  async function doCall() {
    const r = await h574SessionRef.call(574, { condition_id: cid });
    const text = r?.result?.content?.[0]?.text || '';
    const parsed = JSON.parse(text);
    const rows = parsed?.data?.results || (Array.isArray(parsed) ? parsed : [parsed]);
    const row = rows[0];
    if (!row) return undefined;

    const winningOutcome = (row.winning_outcome || '').toLowerCase();
    if (!winningOutcome) return undefined;

    const sideA = (row.side_a_outcome || row.outcome_a || '').toLowerCase();
    const sideB = (row.side_b_outcome || row.outcome_b || '').toLowerCase();
    if (sideA && winningOutcome === sideA) return 0;
    if (sideB && winningOutcome === sideB) return 1;
    if (winningOutcome === 'yes') return 0;
    if (winningOutcome === 'no') return 1;
    return undefined;
  }

  try {
    const result = await doCall();
    if (result !== undefined) h574Stats.hits++;
    marketOutcomeCache.set(cid, result);
    return result;
  } catch (err) {
    // Attempt one reconnect before giving up
    logError(`agent 574 call failed — reconnecting`, err);
    try { h574SessionRef.close(); } catch (_) {}
    h574SessionRef = await openHeisenbergSession();
    h574Stats.reconnects++;
    if (!h574SessionRef) {
      h574Stats.failures++;
      marketOutcomeCache.set(cid, undefined);
      return undefined;
    }
    try {
      const result = await doCall();
      if (result !== undefined) h574Stats.hits++;
      marketOutcomeCache.set(cid, result);
      return result;
    } catch (err2) {
      logError(`agent 574 retry failed for ${cid}`, err2);
      h574Stats.failures++;
      marketOutcomeCache.set(cid, undefined);
      return undefined;
    }
  }
}

// ── Direct gamma API outcome lookup (final fallback, cached) ──────────────────
// Fetches a single market by conditionId, stores the winning outcomeIndex AND
// the endDate so callers can check if it was a short-resolution market.
// Returns 0|1 if resolved, undefined if unresolved/error.
const gammaMeta = new Map(); // conditionId → { endTs, winner }

async function fetchGammaMarketOutcome(cid) {
  if (gammaOutcomeCache.has(cid)) { gammaOutcomeStats.cacheHits++; return gammaOutcomeCache.get(cid); }
  gammaOutcomeStats.fetches++;
  try {
    const data = await fetchJSON(`${GAMMA_API}/markets?conditionId=${cid}&limit=1`, 1, 500);
    const markets = Array.isArray(data) ? data : (data.data || data.markets || []);
    if (!markets.length) { gammaOutcomeCache.set(cid, undefined); return undefined; }
    const m = markets[0];
    const winner = parseWinnerOutcomeIndex(m.outcomePrices);
    const result = winner !== null ? winner : undefined;
    gammaOutcomeCache.set(cid, result);
    const endDate = m.endDate || m.end_date || m.resolutionDate;
    if (endDate) gammaMeta.set(cid, new Date(endDate).getTime());
    if (result !== undefined) gammaOutcomeStats.resolved++;
    return result;
  } catch (_) {
    gammaOutcomeCache.set(cid, undefined);
    return undefined;
  }
}

// Pre-fetch gamma outcomes for all BUY < $0.50 conditionIds not already
// covered by shortConditionIds or REDEEM signals. This symmetrically captures
// silent losses (wallet held losing position to zero) from recently-closed
// short-resolution markets, preventing inflated win rates.
async function prefetchGammaOutcomes(allTrades, shortConditionIds, redeemByKey) {
  const toFetch = new Set();
  for (const t of allTrades) {
    const tType = (t.type || '').toUpperCase();
    const side  = (t.side  || '').toUpperCase();
    if (side !== 'BUY' && tType !== 'BUY') continue;
    if (tType === 'REDEEM' || tType === 'SELL' || tType === 'MERGE') continue;
    const price = parseFloat(t.price ?? t.avgPrice ?? t.avg_price ?? 1);
    if (isNaN(price) || price >= 0.50) continue;
    const cid = (t.conditionId || t.condition_id || '').toLowerCase();
    if (!cid || shortConditionIds.has(cid) || gammaOutcomeCache.has(cid)) continue;
    if (redeemByKey && redeemByKey.has(cid)) continue;
    toFetch.add(cid);
  }
  // Fetch in batches of 5 to balance speed vs rate limiting
  const cids = [...toFetch];
  for (let i = 0; i < cids.length; i += 5) {
    await Promise.all(cids.slice(i, i + 5).map(cid => fetchGammaMarketOutcome(cid)));
  }
}

// ── Segment 1: Heisenberg Falcon leaderboard (agent 584) ──────────────────────
function fetchHeisenbergLeaderboard() {
  return new Promise((resolve) => {
    if (!HEISENBERG_KEY) {
      log('HEISENBERG_API_KEY not set — skipping Segment 1');
      return resolve([]);
    }
    log('Fetching Heisenberg Falcon leaderboard (agent 584)...');

    let sessionPath = null;
    const pending   = new Map();
    let msgId       = 0;

    function sendMsg(body) {
      return new Promise((res, rej) => {
        const payload = JSON.stringify(body);
        const r = https.request({
          hostname: HEISENBERG_HOST, path: sessionPath, method: 'POST',
          headers: {
            'Authorization': `Bearer ${HEISENBERG_KEY}`,
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(payload),
          },
          timeout: 15000,
        }, (response) => { response.resume(); });
        r.on('error', rej);
        r.write(payload); r.end();
        if (body.id != null) {
          pending.set(body.id, res);
          setTimeout(() => {
            if (pending.has(body.id)) { pending.delete(body.id); rej(new Error(`timeout id=${body.id}`)); }
          }, 30000);
        } else { res(null); }
      });
    }

    async function runProtocol(sseReq) {
      await sendMsg({ jsonrpc: '2.0', id: ++msgId, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'scanner', version: '1.0' } } });
      await sendMsg({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} });
      await sendMsg({ jsonrpc: '2.0', id: ++msgId, method: 'tools/call', params: { name: 'authenticate', arguments: { token: HEISENBERG_KEY } } });

      const r = await sendMsg({
        jsonrpc: '2.0', id: ++msgId, method: 'tools/call',
        params: {
          name: 'perform_parameterized_retrieval',
          arguments: {
            token: HEISENBERG_KEY,
            agent_id: 584,
            params: { wallet_address: 'ALL' },
            pagination: { limit: 200, offset: 0 },
            formatter_config: { format_type: 'raw' },
          },
        },
      });

      sseReq.destroy();

      const text = r?.result?.content?.[0]?.text || '';
      const parsed = JSON.parse(text);
      const rows   = parsed?.data?.results || [];
      log(`Heisenberg Segment 1: ${rows.length} wallets`);
      return rows.map(w => ({
        address:         (w.wallet || '').toLowerCase(),
        hScore:          parseFloat(w.h_score        || 0),
        tier:            w.tier                      || '',
        leaderboardRank: w.leaderboard_rank          || null,
        winRate15d:      parseFloat(w.win_rate_pct_15d || 0) / 100,
        totalPnl15d:     parseFloat(w.total_pnl_15d  || 0),
        roi15d:          parseFloat(w.roi_pct_15d    || 0) / 100,
        sharpe15d:       parseFloat(w.sharpe_ratio_15d || 0),
        trades15d:       parseInt(w.total_trades_15d || 0),
        markets15d:      parseInt(w.markets_traded_15d || 0),
        trajectory:      w.trajectory                || '',
      }));
    }

    const req = https.get({
      hostname: HEISENBERG_HOST, path: '/sse',
      headers: { 'Authorization': `Bearer ${HEISENBERG_KEY}`, 'Accept': 'text/event-stream' },
      timeout: 60000,
    }, (res) => {
      let buf = '', eventType = '';
      res.on('data', chunk => {
        buf += chunk.toString();
        const lines = buf.split('\n'); buf = lines.pop();
        for (const line of lines) {
          if (line.startsWith('event:')) { eventType = line.slice(6).trim(); }
          else if (line.startsWith('data:')) {
            const data = line.slice(5).trim();
            if (eventType === 'endpoint' || data.startsWith('/messages')) {
              sessionPath = data;
              runProtocol(req).then(resolve).catch(err => {
                logError('Heisenberg protocol error', err);
                req.destroy();
                resolve([]);
              });
            } else {
              try {
                const msg = JSON.parse(data);
                if (msg.id != null && pending.has(msg.id)) {
                  const cb = pending.get(msg.id); pending.delete(msg.id); cb(msg);
                }
              } catch (_) {}
            }
            eventType = '';
          }
        }
      });
      res.on('error', err => { logError('Heisenberg SSE stream error', err); resolve([]); });
    });
    req.on('error',   err => { logError('Heisenberg connect error', err);   resolve([]); });
    req.on('timeout', ()  => { req.destroy(); logError('Heisenberg SSE timeout', null); resolve([]); });
  });
}

// ── Short-resolution markets ───────────────────────────────────────────────────
// Returns outcomePrices index (0=YES, 1=NO) that won, or null if not yet resolved.
function parseWinnerOutcomeIndex(outcomePrices) {
  if (!outcomePrices) return null;
  try {
    const prices = typeof outcomePrices === 'string' ? JSON.parse(outcomePrices) : outcomePrices;
    for (let i = 0; i < prices.length; i++) {
      if (parseFloat(prices[i]) >= 0.99) return i;
    }
  } catch (_) {}
  return null;
}

async function fetchShortResolutionMarkets(maxDays = 14) {
  log(`Fetching markets resolving within ${maxDays} days...`);
  const conditionIds    = new Set();
  const resolvedMarketMap = new Map(); // conditionId → winnerOutcomeIndex
  const allMarkets      = [];
  const pageSize        = 500;
  const now             = Date.now();
  const deadlineCutoff  = now + maxDays * 86400000;
  const closedLookback  = now - 90 * 86400000; // closed in the last 90 days (wider window catches historical losses)

  // --- Pass 1: active upcoming markets (hard cap: 60 pages / 30,000 rows) ---
  const MAX_ACTIVE_PAGES = 60;
  let offset = 0;
  while (offset < MAX_ACTIVE_PAGES * pageSize) {
    try {
      const url = `${GAMMA_API}/markets?limit=${pageSize}&offset=${offset}&active=true&closed=false`;
      const data = await fetchJSON(url);
      const rows = Array.isArray(data) ? data : (data.data || data.markets || []);
      if (!rows.length) break;

      let added = 0, tooSmall = 0;
      for (const m of rows) {
        const endDate = m.endDate || m.end_date || m.resolutionDate;
        if (!endDate) continue;
        const endTs = new Date(endDate).getTime();
        if (endTs > now && endTs <= deadlineCutoff) {
          const cid = (m.conditionId || m.condition_id || '').toLowerCase();
          if (!cid) continue;
          const vol = parseFloat(m.volume || m.volumeNum || m.volume24hr || 0);
          if (vol < MIN_MARKET_VOLUME) { tooSmall++; continue; }
          conditionIds.add(cid);
          allMarkets.push({ conditionId: cid, endTs, volume: vol });
          // Store endTs so calcMetrics can distinguish open vs. expired markets
          if (!gammaMeta.has(cid)) gammaMeta.set(cid, endTs);
          added++;
        }
      }
      log(`  Active markets offset=${offset}: ${rows.length} rows, ${added} qualifying (≥$${(MIN_MARKET_VOLUME/1000).toFixed(0)}k), ${tooSmall} too small, total=${conditionIds.size}`);
      if (rows.length < pageSize) break;
      offset += pageSize;
      await sleep(200);
    } catch (e) {
      logError('Active markets fetch failed', e);
      break;
    }
  }

  // --- Pass 2: recently-closed markets (hard cap: 60 pages / 30,000 rows) ---
  // These give us TRUE LOSS detection: wallet bought the losing outcome.
  // Note: gamma API does NOT sort closed markets by end_date, so we must paginate
  // all pages — cannot early-exit based on "too old" count.
  // gamma does NOT sort closed markets by end_date — recent markets are scattered
  // across all pages. Must scan all 60 pages; no consecutive-empty early exit.
  const MAX_CLOSED_PAGES = 60;
  let closedOffset = 0;
  while (closedOffset < MAX_CLOSED_PAGES * pageSize) {
    try {
      const url = `${GAMMA_API}/markets?limit=${pageSize}&offset=${closedOffset}&closed=true`;
      const data = await fetchJSON(url);
      const rows = Array.isArray(data) ? data : (data.data || data.markets || []);
      if (!rows.length) break;

      let added = 0, tooOld = 0, tooSmall = 0;
      for (const m of rows) {
        const endDate = m.endDate || m.end_date || m.resolutionDate;
        if (!endDate) continue;
        const endTs = new Date(endDate).getTime();

        if (endTs < closedLookback) { tooOld++; continue; }

        const cid = (m.conditionId || m.condition_id || '').toLowerCase();
        if (!cid) continue;

        const vol = parseFloat(m.volume || m.volumeNum || m.volume24hr || 0);
        if (vol < MIN_MARKET_VOLUME) { tooSmall++; continue; }

        conditionIds.add(cid);
        allMarkets.push({ conditionId: cid, endTs, volume: vol });
        added++;

        const winner = parseWinnerOutcomeIndex(m.outcomePrices);
        if (winner !== null) resolvedMarketMap.set(cid, winner);
        // Pre-populate gammaOutcomeCache and gammaMeta so filterQualifyingTrades path 4
        // can catch losses (hold-to-zero) in historical closed markets without relying on
        // order-dependent lazy fetches. This makes win/loss detection symmetric.
        if (!gammaOutcomeCache.has(cid)) {
          gammaOutcomeCache.set(cid, winner !== null ? winner : undefined);
          gammaMeta.set(cid, endTs);
        }
      }

      log(`  Closed markets offset=${closedOffset}: ${rows.length} rows, ${added} qualifying, ${tooOld} old, ${tooSmall} too small, resolvedMap=${resolvedMarketMap.size}`);

      if (rows.length < pageSize) break; // end of data
      closedOffset += pageSize;
      await sleep(200);
    } catch (e) {
      logError('Closed markets fetch failed', e);
      break;
    }
  }

  allMarkets.sort((a, b) => b.volume - a.volume);
  const topMarkets = allMarkets.slice(0, 300);
  log(`Markets: ${conditionIds.size} conditionIds (${resolvedMarketMap.size} resolved with known winner, top ${topMarkets.length} by volume)`);
  return { conditionIds, topMarkets, resolvedMarketMap };
}

// ── Market traders — paginate all buyers ──────────────────────────────────────
// Paginate ALL buyers from qualifying markets. Return every unique wallet for
// full evaluation — no prescore cut, no good wallets filtered prematurely.
async function fetchMarketTraders(topMarkets) {
  const useH556 = !!h574SessionRef;
  log(`Collecting underdog buyers from ${topMarkets.length} markets via ${useH556 ? 'agent 556' : 'holders fallback'}...`);
  const wallets = new Set();

  for (let i = 0; i < topMarkets.length; i++) {
    const { conditionId } = topMarkets[i];

    if (useH556) {
      // Agent 556: fetch BUY trades for this market, filter price < 0.50
      try {
        const r = await h574SessionRef.call(556, { condition_id: conditionId, side: 'BUY' });
        const text = r?.result?.content?.[0]?.text || '{}';
        const parsed = JSON.parse(text);
        if (parsed?.error) {
          log(`  agent 556 error for ${conditionId.slice(0, 10)}: ${parsed.error}`);
        } else {
          const rows = parsed?.data?.results || [];
          for (const t of rows) {
            if (parseFloat(t.price) < 0.50) {
              const addr = (t.proxy_wallet || t.proxyWallet || '').toLowerCase();
              if (addr) wallets.add(addr);
            }
          }
        }
      } catch (err) {
        log(`  agent 556 threw for ${conditionId.slice(0, 10)}: ${err.message}`);
      }
      await sleep(300);
    } else {
      // Fallback: holders endpoint (no price filter, broader pool)
      try {
        const url = `${DATA_API}/holders?market=${conditionId}&limit=500`;
        const data = await fetchJSON(url, 2, 1000);
        const groups = Array.isArray(data) ? data : [];
        for (const g of groups) {
          for (const h of (g.holders || [])) {
            const addr = (h.proxyWallet || h.proxy_wallet || '').toLowerCase();
            if (addr) wallets.add(addr);
          }
        }
      } catch (_) {}
      await sleep(120);
    }

    if ((i + 1) % 50 === 0) {
      log(`  Buyer scan: ${i + 1}/${topMarkets.length} markets, ${wallets.size} unique wallets`);
    }
  }

  log(`Buyer scan complete: ${wallets.size} unique wallets${useH556 ? ' (confirmed BUY <$0.50)' : ' (holders fallback)'}`);
  return wallets;
}

// ── Wallet positions (cashPnl / realizedPnl) ──────────────────────────────────
async function fetchWalletPositions(address) {
  const posMap = new Map(); // conditionId → { cashPnl, realizedPnl } (aggregated across outcomes)
  try {
    const url = `${DATA_API}/positions?user=${address}&limit=500`;
    const data = await fetchJSON(url, 2, 1500);
    const rows = Array.isArray(data) ? data : (data.data || data.positions || []);
    for (const p of rows) {
      const cid = (p.conditionId || p.condition_id || '').toLowerCase();
      if (!cid) continue;
      const cashPnl     = parseFloat(p.cashPnl     ?? 0);
      const realizedPnl = parseFloat(p.realizedPnl ?? 0);
      const existing    = posMap.get(cid);
      posMap.set(cid, {
        cashPnl:     (existing?.cashPnl     ?? 0) + cashPnl,
        realizedPnl: (existing?.realizedPnl ?? 0) + realizedPnl,
      });
    }
  } catch (_) {}
  return posMap;
}

// ── Wallet trade history ───────────────────────────────────────────────────────
let activityFieldsLogged = false;

async function fetchWalletTrades(address, maxTrades = 1000) {
  const trades = [];
  const limit = 500;
  let offset = 0;

  while (trades.length < maxTrades) {
    try {
      const url = `${DATA_API}/activity?user=${address}&limit=${limit}&offset=${offset}&sortBy=TIMESTAMP&ascending=false`;
      const data = await fetchJSON(url, 2, 1500);
      const rows = Array.isArray(data) ? data : (data.data || data.activity || data.trades || []);
      if (!rows.length) break;

      if (!activityFieldsLogged && rows.length > 0) {
        activityFieldsLogged = true;
        log(`  [DEBUG] activity field names: ${Object.keys(rows[0]).join(', ')}`);
        log(`  [DEBUG] activity type values sample: ${rows.slice(0,5).map(r=>r.type).join(',')}`);
      }

      trades.push(...rows);
      if (rows.length < limit) break;
      offset += limit;
      await sleep(200);
    } catch (_) {
      break;
    }
  }

  return trades;
}

// ── STEP 1: Bot filter ─────────────────────────────────────────────────────────
function isBotWallet(allTrades) {
  if (allTrades.length > 2000) return true;

  const sizes = allTrades
    .map(t => parseFloat(t.usdcSize ?? t.amount ?? 0))
    .filter(s => s > 0);

  if (sizes.length >= 10) {
    const mean = sizes.reduce((a, b) => a + b, 0) / sizes.length;
    if (mean > 0) {
      const variance = sizes.reduce((a, v) => a + Math.pow(v - mean, 2), 0) / sizes.length;
      const stdev = Math.sqrt(variance);
      if (stdev / mean < 0.01) return true;
    }
  }

  return false;
}

// ── STEP 2: Last trade timestamp ───────────────────────────────────────────────
function getLastTradeTs(allTrades) {
  let latest = 0;
  for (const t of allTrades) {
    let ts = t.timestamp ?? t.createdAt ?? t.created_at ?? 0;
    if (typeof ts === 'string') ts = new Date(ts).getTime() || 0;
    if (typeof ts === 'number' && ts > 0 && ts < 1e12) ts *= 1000;
    if (ts > latest) latest = ts;
  }
  return latest;
}

// ── Win detection: build REDEEM map ───────────────────────────────────────────
// The data-api activity endpoint does NOT include cashPnl.
// Instead, a "REDEEM" event means the market resolved in the user's favour for
// that conditionId + outcomeIndex pair.  We use that as our win signal.
//
// redeemByKey:   Map<"conditionId:outcomeIndex" -> redeemTimestamp>
// resolvedCids:  Set<conditionId> — any conditionId that has ANY redeem
//                (meaning the market is resolved, whichever side won)
function buildRedeemInfo(allTrades) {
  const redeemByKey  = new Map(); // conditionId → redeemTimestamp
  const resolvedCids = new Set();
  const sellsByMarket = new Map(); // conditionId → [sellPrice, ...] — for profitable-exit detection

  for (const t of allTrades) {
    const tType = (t.type || '').toUpperCase();
    const cid   = (t.conditionId || t.condition_id || '').toLowerCase();
    if (!cid) continue;

    if (tType === 'REDEEM' || tType === 'REDEMPTION') {
      // outcomeIndex is always 999 in REDEEM events — key by conditionId only
      let ts = t.timestamp ?? 0;
      if (typeof ts === 'number' && ts > 0 && ts < 1e12) ts *= 1000;
      if (!redeemByKey.has(cid) || ts > redeemByKey.get(cid)) {
        redeemByKey.set(cid, ts || Date.now());
      }
      resolvedCids.add(cid);
    } else if ((t.side || '').toUpperCase() === 'SELL') {
      // Track all sell prices per market for profitable-exit win detection
      const price = parseFloat(t.price ?? t.avgPrice ?? 0);
      if (price > 0) {
        if (!sellsByMarket.has(cid)) sellsByMarket.set(cid, { prices: [], earliestTs: 0 });
        const entry = sellsByMarket.get(cid);
        entry.prices.push(price);
        let ts = t.timestamp ?? 0;
        if (typeof ts === 'number' && ts > 0 && ts < 1e12) ts *= 1000;
        if (ts > 0 && (entry.earliestTs === 0 || ts < entry.earliestTs)) entry.earliestTs = ts;
      }
    }
  }

  return { redeemByKey, resolvedCids, sellsByMarket };
}

// ── STEP 3: Qualifying trades filter ──────────────────────────────────────────
// Keep BUY trades where:
//   a) price < $0.50
//   b) market is "short-resolution" — any of:
//      i.   conditionId is in our upcoming <14d set (will resolve soon)
//      ii.  there is a REDEEM within 14 days of the BUY (already resolved — wallet won)
//      iii. wallet sold below their buy price within 14 days (already resolved — wallet lost)
//      iv.  gamma confirmed resolved AND endDate within 14 days of the BUY
//
// Paths ii and iii are symmetric: ii catches wins, iii catches losses.
// Without iii, loss-exit markets are invisible and win rates are inflated.
function filterQualifyingTrades(allTrades, shortConditionIds, redeemByKey, sellsByMarket) {
  // Build per-conditionId: { avgBuyPrice, firstBuyTs } for loss-exit check
  const buysByMarket = new Map();
  for (const t of allTrades) {
    const tType = (t.type || '').toUpperCase();
    const side  = (t.side  || '').toUpperCase();
    if (side !== 'BUY' && tType !== 'BUY') continue;
    if (tType === 'REDEEM' || tType === 'SELL' || tType === 'MERGE') continue;
    const price = parseFloat(t.price ?? t.avgPrice ?? t.avg_price ?? 1);
    if (isNaN(price) || price >= 0.50) continue;
    const cid = (t.conditionId || t.condition_id || '').toLowerCase();
    if (!cid) continue;
    let ts = t.timestamp ?? 0;
    if (typeof ts === 'string') ts = new Date(ts).getTime() || 0;
    if (typeof ts === 'number' && ts > 0 && ts < 1e12) ts *= 1000;
    const existing = buysByMarket.get(cid);
    if (!existing) {
      buysByMarket.set(cid, { prices: [price], firstBuyTs: ts });
    } else {
      existing.prices.push(price);
      if (ts > 0 && (existing.firstBuyTs === 0 || ts < existing.firstBuyTs)) existing.firstBuyTs = ts;
    }
  }

  return allTrades.filter(t => {
    // Must be a BUY
    const tType = (t.type || '').toUpperCase();
    const side  = (t.side  || '').toUpperCase();
    if (side !== 'BUY' && tType !== 'BUY') return false;
    if (tType === 'REDEEM' || tType === 'SELL' || tType === 'MERGE') return false;

    // Price < $0.50
    const price = parseFloat(t.price ?? t.avgPrice ?? t.avg_price ?? 1);
    if (isNaN(price) || price >= 0.50) return false;

    const cid = (t.conditionId || t.condition_id || '').toLowerCase();

    let buyTs = t.timestamp ?? 0;
    if (typeof buyTs === 'string') buyTs = new Date(buyTs).getTime() || 0;
    if (typeof buyTs === 'number' && buyTs > 0 && buyTs < 1e12) buyTs *= 1000;

    // Primary: in our pre-fetched short-resolution market set — confirm endTs - buyTs ≤ 14d
    // so an old buy in a market that happens to expire soon doesn't incorrectly qualify.
    if (shortConditionIds.size > 0 && shortConditionIds.has(cid)) {
      const endTs = gammaMeta.get(cid);
      // If we have the end date, enforce the 14-day window from buy time
      if (endTs && buyTs > 0) {
        if (endTs - buyTs <= 14 * 86400000 && endTs >= buyTs) return true;
      } else {
        return true; // no end date in meta — pass through, calcMetrics will verify
      }
    }

    // Secondary: wallet has a REDEEM within 14 days of the BUY (win path)
    if (redeemByKey && redeemByKey.has(cid)) {
      const redeemTs = redeemByKey.get(cid);
      if (buyTs > 0 && redeemTs > buyTs && redeemTs - buyTs <= 14 * 86400000) return true;
    }

    // Tertiary (loss-exit): wallet sold this market below their avg buy price within 14 days.
    // This is the symmetric loss path to the REDEEM win path above.
    // A sell below buy price confirms the market resolved against the wallet (or they cut losses).
    if (sellsByMarket && sellsByMarket.has(cid)) {
      const mktBuys = buysByMarket.get(cid);
      const sellEntry = sellsByMarket.get(cid);
      if (mktBuys && sellEntry) {
        const avgBuy  = mktBuys.prices.reduce((a, b) => a + b, 0) / mktBuys.prices.length;
        const prices  = sellEntry.prices || sellEntry;
        const maxSell = Math.max(...prices);
        // Sell clearly below avg buy price (not just tiny noise) = confirmed loss exit
        if (maxSell < avgBuy * 0.75) {
          // Check: sell occurred within 14 days of first buy (confirms short-resolution)
          const firstBuyTs  = mktBuys.firstBuyTs || buyTs;
          const earliestSellTs = sellEntry.earliestTs || 0;
          if (firstBuyTs > 0 && earliestSellTs > 0 && earliestSellTs - firstBuyTs <= 14 * 86400000) return true;
        }
      }
    }

    // Quaternary: gamma confirmed this market resolved AND it was short-resolution
    if (gammaOutcomeCache.has(cid) && gammaOutcomeCache.get(cid) !== undefined) {
      const endTs = gammaMeta.get(cid);
      if (endTs) {
        if (buyTs > 0 && endTs - buyTs <= 14 * 86400000 && endTs >= buyTs) return true;
      }
    }

    return false;
  });
}

// ── STEP 4: Metrics on qualifying trades (deduplicated per market) ────────────
// Each conditionId counts as one win or one loss, regardless of how many
// individual BUY trades the wallet placed on that market.
async function calcMetrics(qualifyingTrades, allTrades, redeemByKey, resolvedCids, posMap, resolvedMarketMap, sellsByMarket) {
  if (!qualifyingTrades.length) return null;

  const now       = Date.now();
  const cutoff7d  = now - 7  * 86400000;
  const cutoff30d = now - 30 * 86400000;

  // Group qualifying trades by conditionId — one win/loss decision per market
  const byMarket = new Map();
  for (const t of qualifyingTrades) {
    const cid = (t.conditionId || '').toLowerCase();
    if (!byMarket.has(cid)) byMarket.set(cid, []);
    byMarket.get(cid).push(t);
  }

  let wins = 0, losses = 0;
  let wins7d = 0, total7d = 0;
  let wins30d = 0, total30d = 0;
  let totalEntryPrice = 0, totalTradeCount = 0;
  let totalPnl = 0;
  let pnl30d = 0;
  let invested30d = 0;
  let totalReturnMultiple = 0;
  let totalInvested = 0;
  let openMarkets = 0;      // qualifying markets still open (excluded from win/loss)
  let lastResortLosses = 0; // losses assigned by last resort: expired/unknown end date + no profit

  for (const [cid, trades] of byMarket) {
    const posData   = posMap ? posMap.get(cid) : null;
    const hasPosWin = posData && posData.realizedPnl > 0; // realizedPnl only — cashPnl is unrealized (open position)
    const redeemTs  = redeemByKey.get(cid);

    // Exit detection via SELL events: compare sell prices to avg buy price
    const avgBuyPrice  = trades.reduce((s, t) => s + parseFloat(t.price ?? 0), 0) / trades.length;
    const sellEntry    = sellsByMarket ? sellsByMarket.get(cid) : null;
    const sellPrices   = sellEntry ? (sellEntry.prices || sellEntry) : []; // support old and new shape
    const profitableExit = sellPrices.some(p => p > avgBuyPrice);
    const lossExit       = sellPrices.length > 0 && Math.max(...sellPrices) < avgBuyPrice;

    let isWin  = hasPosWin || !!redeemTs || profitableExit;
    let isLoss = !isWin && lossExit; // sold at a loss and never redeemed → confirmed loss

    if (!isWin && !isLoss) {
      // Try gamma resolvedMarketMap first (no API call, fast)
      const gammaWinner = resolvedMarketMap ? resolvedMarketMap.get(cid) : undefined;
      let winnerOutcomeIndex = gammaWinner !== undefined
        ? gammaWinner
        : await lookupMarketOutcome(cid); // agent 574 fallback (auto-reconnects)
      // Final fallback: direct gamma API fetch — catches losses where wallet held
      // losing position to zero without selling or REDEEMing (silent losses).
      // Cached per conditionId so each market is only fetched once per scan.
      if (winnerOutcomeIndex === undefined) {
        winnerOutcomeIndex = await fetchGammaMarketOutcome(cid);
      }

      if (winnerOutcomeIndex !== undefined) {
        // Find the wallet's dominant outcomeIndex across qualifying trades in this market
        const outcomeCounts = {};
        for (const t of trades) {
          const oi = t.outcomeIndex ?? 0;
          outcomeCounts[oi] = (outcomeCounts[oi] || 0) + 1;
        }
        const walletOI = parseInt(Object.entries(outcomeCounts).sort((a, b) => b[1] - a[1])[0][0]);
        if (walletOI === winnerOutcomeIndex) isWin = true;
        else isLoss = true;
      } else {
        // No resolution data from any source.
        // Only skip if we can positively confirm the market is still open (endTs in future).
        // Otherwise: no profit signal (no REDEEM, no positive PnL) = loss.
        // Treating "unknown" as "open" would systematically exclude potential losses and
        // inflate win rates — the wallet would only look bad when wins self-report via REDEEM.
        const marketEndTs = gammaMeta.get(cid);
        const marketStillOpen = marketEndTs !== undefined && marketEndTs > now;
        if (marketStillOpen) {
          openMarkets++;
        } else {
          isLoss = true; // expired or end date unknown + no profit signal = loss
          lastResortLosses++;
        }
      }
    }

    if (!isWin && !isLoss) continue; // open or truly unresolvable — excluded from win/loss

    // Use latest trade timestamp in this market for time-window bucketing
    let marketTs = 0;
    for (const t of trades) {
      let ts = t.timestamp ?? 0;
      if (typeof ts === 'number' && ts > 0 && ts < 1e12) ts *= 1000;
      if (ts > marketTs) marketTs = ts;
    }

    // Accumulate entry price and invested capital across all trades in market
    for (const t of trades) {
      const price = parseFloat(t.price ?? t.avgPrice ?? t.avg_price ?? 0);
      if (!isNaN(price) && price > 0) { totalEntryPrice += price; totalTradeCount++; }
      totalInvested += parseFloat(t.usdcSize ?? 0);
    }

    const mktInvested = trades.reduce((s, t) => s + parseFloat(t.usdcSize ?? 0), 0);

    if (isWin) {
      wins++;
      let mktPnl = 0;
      if (posData && posData.realizedPnl !== 0) {
        mktPnl = posData.realizedPnl;
      } else {
        for (const t of trades) {
          const usdcSize = parseFloat(t.usdcSize ?? 0);
          const shares   = parseFloat(t.size ?? 0);
          const price    = parseFloat(t.price ?? 0);
          mktPnl += shares > 0 ? shares - usdcSize : usdcSize * (1 / Math.max(price, 0.001) - 1);
        }
      }
      totalPnl += mktPnl;
      if (marketTs >= cutoff30d) { pnl30d += mktPnl; invested30d += mktInvested; }
      const avgPrice = trades.reduce((s, t) => s + parseFloat(t.price ?? 0), 0) / trades.length;
      if (avgPrice > 0 && avgPrice < 1) totalReturnMultiple += 1 / avgPrice;
    } else {
      losses++;
      totalPnl -= mktInvested;
      if (marketTs >= cutoff30d) { pnl30d -= mktInvested; invested30d += mktInvested; }
    }

    if (marketTs >= cutoff7d)  { total7d++;  if (isWin) wins7d++;  }
    if (marketTs >= cutoff30d) { total30d++; if (isWin) wins30d++; }
  }

  const totalResolved = wins + losses;
  if (totalResolved === 0) return null;

  const winRate           = wins / totalResolved;
  const winRate7d         = total7d  > 0 ? wins7d  / total7d  : NaN;
  const winRate30d        = total30d > 0 ? wins30d / total30d : NaN;
  const avgEntryPrice     = totalTradeCount > 0 ? totalEntryPrice / totalTradeCount : 0;
  const avgReturnMultiple = wins > 0 ? totalReturnMultiple / wins : 0;
  const lastTradeTs       = getLastTradeTs(allTrades);
  const roi               = totalInvested > 0 ? totalPnl / totalInvested : 0;

  return {
    qualifyingCount:  qualifyingTrades.length,
    distinctMarkets:  byMarket.size,
    resolvedCount:    totalResolved,      // distinct markets resolved
    wins, losses,
    winRate, winRate7d, winRate30d,
    totalPnl,
    pnl30d,
    invested30d,
    totalInvested,
    roi,
    avgEntryPrice,
    avgReturnMultiple,
    lastTradeTs,
    lastTradeDate: lastTradeTs ? new Date(lastTradeTs).toISOString().split('T')[0] : null,
    total7d, total30d,
    openMarkets,       // qualifying markets still open (excluded from win/loss counts)
    lastResortLosses,  // losses inferred by expiry/no-profit rule (no explicit resolution data)
  };
}

// ── Tier assignment ────────────────────────────────────────────────────────────
// Criteria: resolvedCount (volume), winRate, AND minimum overall PnL.
// PnL gate ensures we only rank wallets with meaningful real profit, not just
// a high win rate on micro-bets that add up to nothing.
function assignTiers(m) {
  const tiers = [];
  if (!m || m.totalPnl <= 0) return tiers;
  const n   = m.resolvedCount;
  const pnl = m.totalPnl;
  if (n >= 20 && m.winRate >= 0.70 && pnl >= 1000) tiers.push('S');
  if (n >= 25 && m.winRate >= 0.60 && pnl >=  500) tiers.push(1);
  if (n >= 20 && m.winRate >= 0.55 && pnl >=  200) tiers.push(2);
  if (n >= 15 && m.winRate >= 0.50 && pnl >=  100) tiers.push(3);
  if (n >= 10 && m.winRate >= 0.50 && pnl >     0) tiers.push(4);
  return tiers;
}

// ── Score ──────────────────────────────────────────────────────────────────────
// Bayesian-adjusted win rate × log(sample size) × return bonus + PnL bonus.
// Prevents small-sample 100% wallets from outranking large-sample 95% wallets.
function computeScore(m) {
  const n = m.resolvedCount;

  // Bayesian win rate: prior of 1 win + 1 loss (50% baseline), shrinks extreme WRs
  const bayesWR = (m.wins + 1) / (n + 2);

  // Sample size weight on log10 scale: 10 markets → 1.0, 100 → 2.0, 1000 → 3.0
  const sampleWeight = Math.log10(n + 1);

  // Return multiple bonus: (avgReturnMultiple - 1) / 9, capped at 1.0
  // Buying at $0.10 (10x return) → 1.0 bonus; $0.50 (2x return) → 0.11 bonus
  const returnBonus = m.avgReturnMultiple > 1
    ? Math.min((m.avgReturnMultiple - 1) / 9, 1)
    : 0;

  // PnL bonus: soft-capped via tanh; $50k → ~0.10, $500k → ~0.27, $5M → ~0.30
  const pnlBonus = Math.tanh(Math.max(m.totalPnl, 0) / 100000) * 0.3;

  return parseFloat((bayesWR * sampleWeight * (1 + returnBonus) + pnlBonus).toFixed(4));
}

// ── Checkpoint helpers ─────────────────────────────────────────────────────────
function saveCheckpoint(data) {
  const tmp = CHECKPOINT_FILE + '.tmp';
  try {
    fs.writeFileSync(tmp, JSON.stringify(data));
    fs.renameSync(tmp, CHECKPOINT_FILE);
  } catch (e) { logError('Failed to save checkpoint', e); }
}

function loadCheckpoint() {
  try { return JSON.parse(fs.readFileSync(CHECKPOINT_FILE, 'utf8')); }
  catch (_) { return null; }
}

function clearCheckpoint() {
  try { fs.unlinkSync(CHECKPOINT_FILE); } catch (_) {}
}

// ── Main ───────────────────────────────────────────────────────────────────────
async function runScan() {
  log('=== Polymarket Wallet Scanner v3 (two-segment) ===');

  // ── Resume from checkpoint if available ──────────────────────────────────────
  const ckpt = loadCheckpoint();
  let segment1, shortConditionIds, resolvedMarketMap, allWallets, startIndex;
  let tierS, tier1, tier2, tier3, tier4, seen;
  let processed, skippedBot, skippedActivity, skippedNoTrades,
      skippedNoQualifying, skippedNoResolved, skippedNoTier;

  if (ckpt) {
    log(`Resuming from checkpoint: wallet ${ckpt.startIndex}/${ckpt.wallets.length} (${ckpt.wallets.length - ckpt.startIndex} remaining)`);
    segment1          = ckpt.segment1;
    shortConditionIds = new Set(ckpt.shortConditionIds);
    resolvedMarketMap = new Map(ckpt.resolvedMarketMap);
    allWallets        = ckpt.wallets;
    startIndex        = ckpt.startIndex;
    tierS             = ckpt.tierS;
    tier1             = ckpt.tier1;
    tier2             = ckpt.tier2;
    tier3             = ckpt.tier3;
    tier4             = ckpt.tier4 || [];
    seen              = new Map(ckpt.seen);
    ({ processed, skippedBot, skippedActivity, skippedNoTrades,
       skippedNoQualifying, skippedNoResolved, skippedNoTier } = ckpt.stats);
    // Restore agent 574 cache
    for (const [k, v] of (ckpt.marketOutcomeCache || [])) marketOutcomeCache.set(k, v);
  } else {
    // ── Full setup ─────────────────────────────────────────────────────────────
    // Segment 1 (Heisenberg agent 584) and market data fetched in parallel.
    // Agent 574 session opens AFTER agent 584 closes — one SSE session per key.
    const [seg1, markets] = await Promise.all([
      fetchHeisenbergLeaderboard(),
      fetchShortResolutionMarkets(14),
    ]);
    segment1          = seg1;
    shortConditionIds = markets.conditionIds;
    resolvedMarketMap = markets.resolvedMarketMap;

    // Open Heisenberg session after leaderboard (agent 584) closes its session.
    // Same session is used for agent 556 (wallet sourcing) and agent 574 (win detection).
    h574SessionRef = await openHeisenbergSession();
    if (!h574SessionRef) {
      log('WARNING: Heisenberg session unavailable — using holders fallback for wallet sourcing, win detection DISABLED');
    }

    const holderWallets = await fetchMarketTraders(markets.topMarkets);
    allWallets  = [...holderWallets];
    startIndex  = 0;
    tierS = []; tier1 = []; tier2 = []; tier3 = []; tier4 = [];
    seen  = new Map();
    processed = 0; skippedBot = 0; skippedActivity = 0; skippedNoTrades = 0;
    skippedNoQualifying = 0; skippedNoResolved = 0; skippedNoTier = 0;
    log(`Segment 2 candidates: ${allWallets.length} (prescored market traders)`);
  }

  const now       = Date.now();
  const cutoff7d  = now - 7  * 86400000;
  const cutoff30d = now - 30 * 86400000;

  for (let i = startIndex; i < allWallets.length; i++) {
    const address = allWallets[i];
    processed++;
    if (processed % 50 === 0) {
      const lrTotal = [...seen.values()].reduce((s, r) => s + (r.lastResortLosses || 0), 0);
      log(`Progress: ${processed}/${allWallets.length} | S=${tierS.length} T1=${tier1.length} T2=${tier2.length} T3=${tier3.length} T4=${tier4.length} | bot=${skippedBot} inactive=${skippedActivity} noQual=${skippedNoQualifying} noResolved=${skippedNoResolved} noTier=${skippedNoTier} | lastResort=${lrTotal}`);
    }

    // Save checkpoint every 200 wallets
    if (processed % 200 === 0) {
      saveCheckpoint({
        startIndex:        i + 1,
        wallets:           allWallets,
        segment1,
        shortConditionIds: [...shortConditionIds],
        resolvedMarketMap: [...resolvedMarketMap],
        tierS, tier1, tier2, tier3, tier4,
        seen:              [...seen],
        stats:             { processed, skippedBot, skippedActivity, skippedNoTrades, skippedNoQualifying, skippedNoResolved, skippedNoTier },
        marketOutcomeCache: [...marketOutcomeCache],
      });
    }

    try {
      // Fetch trades and positions in parallel
      const [allTrades, posMap] = await Promise.all([
        fetchWalletTrades(address, 1000),
        fetchWalletPositions(address),
      ]);

      if (!allTrades.length) { skippedNoTrades++; continue; }

      // STEP 1: bot filter
      if (isBotWallet(allTrades)) { skippedBot++; continue; }

      // STEP 2: activity filter — last trade within 7 days AND within 30 days
      const lastTs = getLastTradeTs(allTrades);
      if (lastTs < cutoff7d)  { skippedActivity++; continue; }
      if (lastTs < cutoff30d) { skippedActivity++; continue; } // explicit 30d check

      // Build REDEEM info as fallback for positions not in /positions response
      const { redeemByKey, resolvedCids, sellsByMarket } = buildRedeemInfo(allTrades);

      // Pre-fetch gamma outcomes for all BUY < $0.50 conditionIds not in
      // shortConditionIds or REDEEM set — catches silent losses in closed markets
      await prefetchGammaOutcomes(allTrades, shortConditionIds, redeemByKey);

      // STEP 3: qualifying trades — most recent 30 only (newest-first order preserved)
      const allQualifying = filterQualifyingTrades(allTrades, shortConditionIds, redeemByKey, sellsByMarket);
      if (!allQualifying.length) { skippedNoQualifying++; continue; }
      const qualifying = allQualifying.slice(0, 30);

      // STEP 4: metrics (uses posMap + gamma resolvedMarketMap + agent 574 for true win/loss)
      const m = await calcMetrics(qualifying, allTrades, redeemByKey, resolvedCids, posMap, resolvedMarketMap, sellsByMarket);
      if (!m) { skippedNoResolved++; continue; }

      const tiers = assignTiers(m);
      if (!tiers.length) { skippedNoTier++; continue; }

      // STEP 5: score
      const score = computeScore(m);

      const record = {
        address,
        totalQualifyingTrades: m.qualifyingCount,
        distinctMarkets:       m.distinctMarkets,
        resolvedMarkets:       m.resolvedCount,
        wins:                  m.wins,
        losses:                m.losses,
        winRate:               m.winRate,
        winRate7d:             m.winRate7d,
        winRate30d:            m.winRate30d,
        avgEntryPrice:         m.avgEntryPrice,
        avgReturnMultiple:     m.avgReturnMultiple,
        overallPnl:            m.totalPnl,
        pnl30d:                m.pnl30d,
        invested30d:           m.invested30d,
        totalInvested:         m.totalInvested,
        roi:                   m.roi,
        openMarkets:           m.openMarkets,
        lastResortLosses:      m.lastResortLosses,
        lastTradeDate:         m.lastTradeDate,
        tiers,
        score,
        total7dMarkets:        m.total7d,
        total30dMarkets:       m.total30d,
      };

      seen.set(address, record);
      if (tiers.includes('S')) tierS.push(record);
      if (tiers.includes(1))   tier1.push(record);
      if (tiers.includes(2))   tier2.push(record);
      if (tiers.includes(3))   tier3.push(record);
      if (tiers.includes(4))   tier4.push(record);

    } catch (e) {
      logError(`Evaluate ${address}`, e);
    }

    await sleep(250);
  } // end wallet loop

  clearCheckpoint();

  // Close agent 574 session and log stats
  if (h574SessionRef) {
    try { h574SessionRef.close(); } catch (_) {}
    h574SessionRef = null;
  }
  const h574Total = h574Stats.attempts;
  const h574FailRate = h574Total > 0 ? (h574Stats.failures / h574Total * 100).toFixed(1) : '0.0';
  log(`Agent 574 stats: attempts=${h574Total} hits=${h574Stats.hits} failures=${h574Stats.failures} reconnects=${h574Stats.reconnects} cacheHits=${h574Stats.cacheHits} (${h574FailRate}% failure rate)`);
  log(`Gamma outcome cache: ${gammaOutcomeStats.fetches} fetches, ${gammaOutcomeStats.cacheHits} cache hits, ${gammaOutcomeStats.resolved} resolved`);
  if (h574Total > 0 && h574Stats.failures / h574Total > 0.10) {
    log(`WARNING: agent 574 failure rate ${h574FailRate}% exceeds 10% — win/loss detection may be inaccurate`);
  }

  const multiTier = [...seen.values()].filter(w => w.tiers.length >= 2);
  const top5ByPnl = [...seen.values()]
    .sort((a, b) => b.overallPnl - a.overallPnl)
    .slice(0, 5);
  const sortFn = (a, b) => b.score - a.score;
  [tierS, tier1, tier2, tier3, tier4, multiTier].forEach(a => a.sort(sortFn));

  // Segment 1: sort Falcon wallets by hScore descending
  segment1.sort((a, b) => b.hScore - a.hScore);

  const results = {
    scanTime: new Date().toISOString(),
    segment1: {
      source:      'Heisenberg Falcon Leaderboard (agent 584)',
      wallets:     segment1,
      count:       segment1.length,
    },
    segment2: {
      source:      'Prescored market traders — own criteria (BUY <$0.50, 14d resolution window, ≥$50k market)',
      top5ByPnl,
      tierS, tier1, tier2, tier3, tier4, multiTier,
      stats: {
        candidates:          allWallets.length,
        processed,
        skippedBot,
        skippedActivity,
        skippedNoTrades,
        skippedNoQualifying,
        skippedNoResolved,
        skippedNoTier,
        tierSCount:     tierS.length,
        tier1Count:     tier1.length,
        tier2Count:     tier2.length,
        tier3Count:     tier3.length,
        tier4Count:     tier4.length,
        multiTierCount: multiTier.length,
      },
    },
  };

  const dataDir = path.join(__dirname, 'data');
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify(results, null, 2));

  log(`=== Scan complete ===`);
  log(`  Segment 1 (Falcon): ${segment1.length} wallets`);
  log(`  Segment 2 (own criteria): S=${tierS.length} T1=${tier1.length} T2=${tier2.length} T3=${tier3.length} T4=${tier4.length} Multi=${multiTier.length}`);
  log(`  Segment 2 skipped: bot=${skippedBot} inactive=${skippedActivity} noTrades=${skippedNoTrades} noQual=${skippedNoQualifying} noResolved=${skippedNoResolved} noTier=${skippedNoTier}`);
  return results;
}

runScan().catch(e => {
  logError('Fatal scanner error', e);
  process.exit(1);
});
