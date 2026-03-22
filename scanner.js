#!/usr/bin/env node
'use strict';

const https = require('https');
const fs = require('fs');
const path = require('path');

const LOG_FILE = '/var/log/polymarket-scanner.log';
const DATA_FILE = path.join(__dirname, 'data', 'results.json');
const LOCK_FILE = '/tmp/polymarket-scanner.lock';

// ── Single-instance lock (atomic: wx flag fails if file exists) ───────────────
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

// ── Logging ───────────────────────────────────────────────────────────────────
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

// ── HTTP helpers ──────────────────────────────────────────────────────────────
function fetchJSON(url, retries = 3, delayMs = 2000) {
  return new Promise((resolve, reject) => {
    const attempt = (n, delay) => {
      const req = https.get(url, {
        headers: {
          'Accept': 'application/json',
          'User-Agent': 'Mozilla/5.0 (compatible; PolymarketScanner/1.0)',
        },
        timeout: 30000,
      }, (res) => {
        if (res.statusCode === 429) {
          const wait = parseInt(res.headers['retry-after'] || '10', 10) * 1000;
          log(`Rate limited, waiting ${wait}ms`);
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
      req.on('error', err => { if (n > 0) setTimeout(() => attempt(n - 1, delay * 2), delay); else reject(err); });
      req.on('timeout', () => { req.destroy(); if (n > 0) setTimeout(() => attempt(n - 1, delay * 2), delay); else reject(new Error(`Timeout: ${url}`)); });
    };
    attempt(retries, delayMs);
  });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── Falcon SSE ─────────────────────────────────────────────────────────────────
// All Falcon calls go to POST /sse, switching agent_id for different datasets.
// The server responds with Server-Sent Events (text/event-stream).
// Format: lines of "data: <json>" separated by blank lines.
// We collect all events and return the parsed array.

const FALCON_SSE   = 'https://narrative.agent.heisenberg.so/sse';
const FALCON_TOKEN = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ0b2tlbl90eXBlIjoiYWNjZXNzIiwiZXhwIjoxNzc5MzgyNTE2LCJpYXQiOjE3NzQxOTg1MTYsImp0aSI6ImY0MzVmZTYxZTYxODQxMWE5YWMxYTNkZDI4NzRlNGM1IiwidXNlcl9pZCI6Njk4LCJzY29wZSI6ImxhdW5jaHBhZDphZ2VudC1yZWFkLHJldHJpZXZlcjplY2hvLWdlbmVyYXRpb24scmV0cmlldmVyOmZlYXR1cmUtZXh0cmFjdGlvbix1c2VyOnJlYWQscmV0cmlldmVyOmFnZW50LW9wdGlvbi1yZXRyaWV2YWwsbGF1bmNocGFkOmFnZW50LWNyZWF0aW9uLGxhdW5jaHBhZDphZ2VudC11cGRhdGUsdXNlcjp3cml0ZSxyZXRyaWV2ZXI6c2VtYW50aWMtcmV0cmlldmFsLGxhdW5jaHBhZDplY2hvLXN0eWxlLWNyZWF0aW9uIiwidG9rZW5fbmFtZSI6ImJhc2VfbG9naW4ifQ.D9ykx0Zi01rdR4noo7gq85GXR0Qfp-Qp0Mgw3eCYFFY';

// Calls the Falcon SSE endpoint and returns an array of parsed event objects.
// SSE is a GET-based protocol; params are sent as a JSON query string.
// Falls back to POST if the GET returns 405 (discovery on first call).
let _falconMethod = 'GET'; // updated at runtime if 405

function callFalconSSE(agentId, params, pagination, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    const bodyObj = {
      agent_id: agentId,
      params,
      formatter_config: { format_type: 'raw' },
    };
    if (pagination) bodyObj.pagination = pagination;

    const attempt = (method) => {
      let path, bodyStr;
      const hdrs = {
        'Authorization': `Bearer ${FALCON_TOKEN}`,
        'Accept': 'text/event-stream',
        'Cache-Control': 'no-cache',
      };

      if (method === 'GET') {
        // Encode the full request body as a JSON query param
        path = '/sse?body=' + encodeURIComponent(JSON.stringify(bodyObj));
      } else {
        bodyStr = JSON.stringify(bodyObj);
        hdrs['Content-Type'] = 'application/json';
        hdrs['Content-Length'] = Buffer.byteLength(bodyStr);
        path = '/sse';
      }

    const req = https.request({
      hostname: 'narrative.agent.heisenberg.so',
        path, method, headers: hdrs,
      timeout: timeoutMs,
    }, (res) => {
        // If GET returns 405, flip to POST for this and all future calls
        if (res.statusCode === 405 && method === 'GET') {
          res.resume();
          _falconMethod = 'POST';
          return attempt('POST');
        }
        // If POST returns 405, try GET
        if (res.statusCode === 405 && method === 'POST') {
          res.resume();
          _falconMethod = 'GET';
          return attempt('GET');
        }
      if (res.statusCode !== 200) {
        let errBody = '';
        res.on('data', c => { errBody += c; });
        res.on('end', () => reject(new Error(`Falcon HTTP ${res.statusCode}: ${errBody.slice(0, 300)}`)));
        return;
      }

      const allEvents = [];
      let buf = '';
      let curType = null;
      let curDataLines = [];

      const flushEvent = () => {
        if (!curDataLines.length) return;
        const joined = curDataLines.join('\n').trim();
        curType = null;
        curDataLines = [];
        if (!joined || joined === '[DONE]') return;
        try { allEvents.push(JSON.parse(joined)); }
        catch (_) { allEvents.push(joined); }
      };

      res.on('data', chunk => {
        buf += chunk.toString();
        const lines = buf.split('\n');
        buf = lines.pop(); // keep incomplete trailing line
        for (const line of lines) {
          const trimmed = line.replace(/\r$/, '');
          if (trimmed === '') {
            flushEvent();
          } else if (trimmed.startsWith('event:')) {
            curType = trimmed.slice(6).trim(); // eslint-disable-line no-unused-vars
          } else if (trimmed.startsWith('data:')) {
            curDataLines.push(trimmed.slice(5).trim());
          }
          // ignore id:, retry:, comment lines
        }
      });

      res.on('end', () => {
        if (buf.trim()) curDataLines.push(buf.trim());
        flushEvent();
        resolve(allEvents);
      });
    });

      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error(`SSE timeout agent=${agentId}`)); });
      if (bodyStr) req.write(bodyStr);
      req.end();
    }; // end attempt

    attempt(_falconMethod);
  });
}

// Extract the row array (or single object) from the collected SSE events.
// The Falcon API may send data across one or many events in various envelope shapes.
// We search from last to first since the final event is most likely the complete result.
function sseExtract(events) {
  if (!events || !events.length) return null;

  // Log the raw shape on the first call so we can verify field names
  // (this log line will appear once per agent_id per run in the VPS log)
  const last = events[events.length - 1];

  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i];
    if (!ev || typeof ev !== 'object') continue;

    // Direct array
    if (Array.isArray(ev)) return ev;

    // Common envelope keys
    const rows = ev.rows ?? ev.data ?? ev.results ?? ev.traders ?? ev.wallets ?? ev.trades;
    if (Array.isArray(rows)) return rows;

    // Single-object wallet response (Wallet 360)
    if (
      typeof ev.win_rate === 'number' || typeof ev.winRate === 'number' ||
      typeof ev.total_pnl === 'number' || typeof ev.pnl === 'number' ||
      ev.wallet_address || ev.proxyWallet || ev.proxy_wallet
    ) return ev;

    // Nested result
    const inner = ev.result ?? ev.content ?? ev.payload;
    if (inner && typeof inner === 'object') return inner;
  }

  // Last resort: return the last event as-is
  return last ?? null;
}

// ── Constants ─────────────────────────────────────────────────────────────────
const DATA_API   = 'https://data-api.polymarket.com';
const GAMMA_API  = 'https://gamma-api.polymarket.com';

// ── 1. Falcon wallet discovery (agents 584 + 579) ────────────────────────────
// Agent 584 = Falcon Score Leaderboard (primary)
// Agent 579 = Official Leaderboard (secondary)
// Target: 2000+ high-quality trader wallets as evaluation candidates.
async function fetchFalconCandidates() {
  log('Fetching Falcon candidate wallets (agent 584 primary, 579 secondary)...');
  const wallets = new Set();
  const PAGE = 100;

  for (const agentId of [584, 579]) {
    let offset = 0;
    let debugLogged = false;
    while (true) {
      try {
        const events = await callFalconSSE(
          agentId,
          { wallet_address: 'ALL' },
          { limit: PAGE, offset },
          45000
        );
        const rows = sseExtract(events);

        // Log raw shape once per agent for field-name visibility
        if (!debugLogged) {
          debugLogged = true;
          const sample = Array.isArray(rows) ? rows[0] : rows;
          log(`  [DEBUG] agent=${agentId} response keys: ${sample ? Object.keys(sample).join(',') : 'null'} | events=${events.length}`);
        }

        if (!Array.isArray(rows) || !rows.length) break;

        for (const row of rows) {
          const addr =
            row.proxyWallet ?? row.proxy_wallet ?? row.wallet ??
            row.wallet_address ?? row.address ?? row.user;
          if (addr && typeof addr === 'string') wallets.add(addr.toLowerCase());
        }
        log(`  agent=${agentId} offset=${offset}: ${rows.length} rows → ${wallets.size} wallets`);
        if (rows.length < PAGE) break;
        offset += PAGE;
        await sleep(400);
      } catch (e) {
        logError(`Falcon candidates agent=${agentId} offset=${offset}`, e);
        break;
      }
    }
    log(`  After agent ${agentId}: ${wallets.size} wallets`);
    await sleep(800);
  }

  log(`Falcon candidates complete: ${wallets.size} wallets`);
  return [...wallets];
}

// ── 2. Short-resolution markets ───────────────────────────────────────────────
async function fetchShortResolutionMarketIds(maxDays = 14) {
  log(`Fetching markets resolving within ${maxDays} days...`);
  const conditionIds = new Set();
  const allShortMarkets = [];
  const pageSize = 500;
  let offset = 0;
  const deadlineCutoff = Date.now() + maxDays * 86400000;

  while (true) {
    try {
      const url = `${GAMMA_API}/markets?limit=${pageSize}&offset=${offset}&active=true&closed=false`;
      const data = await fetchJSON(url);
      const rows = Array.isArray(data) ? data : (data.data || data.markets || []);
      if (!rows.length) break;

      let added = 0;
      for (const m of rows) {
        const endDate = m.endDate || m.end_date || m.resolutionDate;
        if (!endDate) continue;
        const endTs = new Date(endDate).getTime();
        if (endTs > Date.now() && endTs <= deadlineCutoff) {
          const cid = m.conditionId || m.condition_id;
          if (cid) {
            conditionIds.add(cid.toLowerCase());
            const vol = parseFloat(m.volume || m.volumeNum || m.volume24hr || 0);
            allShortMarkets.push({ conditionId: cid.toLowerCase(), volume: vol });
            added++;
          }
        }
      }
      log(`  Markets offset=${offset}: ${rows.length} rows, ${added} short-res, total=${conditionIds.size}`);
      if (rows.length < pageSize) break;
      offset += pageSize;
      await sleep(400);
    } catch (e) {
      logError('Markets fetch failed', e);
      break;
    }
  }

  allShortMarkets.sort((a, b) => b.volume - a.volume);
  const topMarkets = allShortMarkets.slice(0, 300);
  log(`Found ${conditionIds.size} short-resolution conditionIds (top ${topMarkets.length} by volume)`);
  return { conditionIds, topMarkets };
}

// ── 3. Holders from top markets ───────────────────────────────────────────────
async function fetchMarketHolders(topMarkets) {
  log(`Fetching holders from top ${topMarkets.length} markets...`);
  const wallets = new Set();

  for (let i = 0; i < topMarkets.length; i++) {
    const { conditionId } = topMarkets[i];
    try {
      const url = `${DATA_API}/holders?market=${conditionId}&limit=100`;
      const data = await fetchJSON(url, 2, 1000);
      const groups = Array.isArray(data) ? data : [];
      for (const group of groups) {
        for (const h of (group.holders || [])) {
          if (h.proxyWallet) wallets.add(h.proxyWallet.toLowerCase());
        }
      }
    } catch (e) {
      if (i === 0) logError(`Holders fetch (market ${conditionId})`, e);
    }
    if ((i + 1) % 50 === 0) {
      log(`  Holder scan: ${i + 1}/${topMarkets.length} markets, ${wallets.size} wallets`);
    }
    await sleep(150);
  }

  log(`Market holder scan complete: ${wallets.size} wallets`);
  return wallets;
}

// ── 4. Wallet 360 evaluation (agent 581) ──────────────────────────────────────
// Returns normalised metrics or null if the response is unusable.
let wallet360FieldsLogged = false;

function parseWallet360(raw) {
  if (!raw || typeof raw !== 'object') return null;

  // Log field names once so we know the exact shape
  if (!wallet360FieldsLogged) {
    wallet360FieldsLogged = true;
    log(`  [DEBUG] Wallet360 field names: ${Object.keys(raw).join(', ')}`);
  }

  const get = (...keys) => {
    for (const k of keys) if (raw[k] !== undefined && raw[k] !== null) return raw[k];
    return undefined;
  };

  const winRateRaw = parseFloat(get('win_rate', 'winRate', 'win_pct', 'wins_pct') ?? 'NaN');
  // Some APIs return win rate as 0–100 rather than 0–1
  const winRate = winRateRaw > 1 ? winRateRaw / 100 : winRateRaw;

  const tradeCount = parseInt(
    get('total_trades', 'trade_count', 'tradeCount', 'num_trades', 'trades') ?? '0',
    10
  );

  const pnl = parseFloat(get('total_pnl', 'pnl', 'net_pnl', 'realized_pnl', 'profit_loss') ?? 'NaN');

  const lastActiveRaw = get(
    'last_active', 'lastActive', 'last_trade_date', 'last_trade',
    'last_activity', 'lastTrade', 'last_traded'
  );
  let lastActiveTs = 0;
  if (lastActiveRaw) {
    if (typeof lastActiveRaw === 'number') {
      lastActiveTs = lastActiveRaw > 1e10 ? lastActiveRaw : lastActiveRaw * 1000;
    } else {
      lastActiveTs = new Date(lastActiveRaw).getTime() || 0;
    }
  }

  return { winRate, tradeCount, pnl, lastActiveTs, raw };
}

function assignTiers(winRate, tradeCount, pnl, lastActiveTs) {
  const tiers = [];
  if (isNaN(pnl) || pnl <= 0) return tiers;
  const thirtyDaysAgo = Date.now() - 30 * 86400000;
  if (lastActiveTs < thirtyDaysAgo) return tiers;
  if (tradeCount >= 30 && winRate >= 0.60) tiers.push(1);
  if (tradeCount >= 20 && winRate >= 0.55) tiers.push(2);
  if (tradeCount >= 15 && winRate >= 0.50) tiers.push(3);
  return tiers;
}

// ── 5. Trade verification (agent 556) ─────────────────────────────────────────
// For tier-passing wallets: confirm they have BUY trades with price < $0.50
// in sub-14-day resolution markets.
let trades556FieldsLogged = false;

function parseFalconTrades(raw) {
  if (!raw) return [];
  const rows = Array.isArray(raw)
    ? raw
    : (raw.trades ?? raw.data ?? raw.rows ?? raw.results ?? []);
  if (!Array.isArray(rows)) return [];

  if (!trades556FieldsLogged && rows.length > 0) {
    trades556FieldsLogged = true;
    log(`  [DEBUG] agent556 trade field names: ${Object.keys(rows[0]).join(', ')}`);
  }
  return rows;
}

function buildRecord(address, m360, trades, shortConditionIds, tiers) {
  const qualifying = trades.filter(t => {
    const side = (t.side ?? t.trade_side ?? t.type ?? '').toUpperCase();
    if (side !== 'BUY') return false;
    const price = parseFloat(t.price ?? t.avg_price ?? t.avgPrice ?? 1);
    if (isNaN(price) || price >= 0.50) return false;
    const cid = (t.conditionId ?? t.condition_id ?? t.market ?? t.market_id ?? '').toLowerCase();
    return shortConditionIds.size === 0 || shortConditionIds.has(cid);
  });

  let wins = 0, losses = 0, totalEntryPrice = 0;
  const categories = {};
  for (const t of qualifying) {
    const pnl = parseFloat(t.cashPnl ?? t.cash_pnl ?? t.pnl ?? t.realized_pnl ?? 'NaN');
    const price = parseFloat(t.price ?? t.avg_price ?? t.avgPrice ?? 0);
    totalEntryPrice += isNaN(price) ? 0 : price;
    if (!isNaN(pnl) && pnl > 0) wins++;
    else if (!isNaN(pnl) && pnl < 0) losses++;
    const cat = t.category ?? t.market_category ?? t.event_category ?? t.eventCategory ?? 'Unknown';
    categories[cat] = (categories[cat] || 0) + 1;
  }

  const avgEntryPrice = qualifying.length ? totalEntryPrice / qualifying.length : 0;
  const topCategories = Object.entries(categories)
    .sort((a, b) => b[1] - a[1]).slice(0, 3).map(([c]) => c).join(', ') || 'Unknown';
  const lastActiveDate = m360.lastActiveTs
    ? new Date(m360.lastActiveTs).toISOString().split('T')[0]
    : null;

  return {
    address,
    totalQualifying: qualifying.length || m360.tradeCount,
    wins,
    losses,
    winRate: isNaN(m360.winRate) ? 0 : m360.winRate,
    avgEntryPrice,
    overallPnl: isNaN(m360.pnl) ? 0 : m360.pnl,
    topCategories,
    lastActiveDate,
    tiers,
    // Wallet 360 enrichment fields (surfaced in dashboard)
    w360TradeCount: m360.tradeCount,
    w360WinRate: m360.winRate,
    w360Pnl: m360.pnl,
  };
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function runScan() {
  log('=== Polymarket Wallet Scanner starting ===');

  // Discovery: Falcon candidates (584+579) + market structure in parallel
  const [falconWallets, { conditionIds: shortConditionIds, topMarkets }] = await Promise.all([
    fetchFalconCandidates(),
    fetchShortResolutionMarketIds(14),
  ]);

  // Supplement with holders from top-volume markets
  const holderWallets = await fetchMarketHolders(topMarkets);

  const walletSet = new Set([...falconWallets, ...holderWallets]);
  const allWallets = [...walletSet];
  log(`Total candidates: ${allWallets.length} (${falconWallets.length} falcon + ${holderWallets.size} holders)`);

  const tier1 = [], tier2 = [], tier3 = [];
  const seen = new Map();
  let processed = 0;
  let skippedMetrics = 0;
  let skippedTrades = 0;

  for (const address of allWallets) {
    processed++;
    if (processed % 100 === 0) {
      log(`Progress: ${processed}/${allWallets.length} | T1=${tier1.length} T2=${tier2.length} T3=${tier3.length} (skip-metrics=${skippedMetrics} skip-trades=${skippedTrades})`);
    }

    try {
      // ── Step 2: Wallet 360 (agent 581) — metrics + tier pre-filter ──────────
      const events581 = await callFalconSSE(581, { wallet_address: address }, null, 45000);
      const raw581 = sseExtract(events581);
      if (!raw581) { skippedMetrics++; continue; }

      const m360 = parseWallet360(raw581);
      if (!m360) { skippedMetrics++; continue; }

      const tiers = assignTiers(m360.winRate, m360.tradeCount, m360.pnl, m360.lastActiveTs);
      if (!tiers.length) { skippedMetrics++; continue; }

      // ── Step 3: Trade verification (agent 556) — price < $0.50 + sub-14d ───
      const events556 = await callFalconSSE(556, { wallet_address: address }, null, 45000);
      const raw556 = sseExtract(events556);
      const trades = parseFalconTrades(raw556);

      const qualifying = trades.filter(t => {
        const side = (t.side ?? t.trade_side ?? t.type ?? '').toUpperCase();
        const price = parseFloat(t.price ?? t.avg_price ?? t.avgPrice ?? 1);
        const cid = (t.conditionId ?? t.condition_id ?? t.market ?? t.market_id ?? '').toLowerCase();
        return side === 'BUY' && !isNaN(price) && price < 0.50 &&
          (shortConditionIds.size === 0 || shortConditionIds.has(cid));
      });

      if (!qualifying.length) { skippedTrades++; continue; }

      const record = buildRecord(address, m360, trades, shortConditionIds, tiers);
      seen.set(address, record);
      if (tiers.includes(1)) tier1.push(record);
      if (tiers.includes(2)) tier2.push(record);
      if (tiers.includes(3)) tier3.push(record);

    } catch (e) {
      logError(`Evaluate ${address}`, e);
    }

    await sleep(300);
  }

  const multiTier = [...seen.values()].filter(w => w.tiers.length >= 2);
  const sortFn = (a, b) => b.winRate - a.winRate || b.totalQualifying - a.totalQualifying;
  [tier1, tier2, tier3, multiTier].forEach(a => a.sort(sortFn));

  const results = {
    scanTime: new Date().toISOString(),
    tier1, tier2, tier3, multiTier,
    stats: {
      walletsScanned: allWallets.length,
      walletsEvaluated: processed,
      skippedMetrics,
      skippedTrades,
      tier1Count: tier1.length,
      tier2Count: tier2.length,
      tier3Count: tier3.length,
      multiTierCount: multiTier.length,
    },
  };

  const dataDir = path.join(__dirname, 'data');
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify(results, null, 2));

  log(`=== Scan complete: T1=${tier1.length} T2=${tier2.length} T3=${tier3.length} Multi=${multiTier.length} ===`);
  return results;
}

runScan().catch(e => {
  logError('Fatal scanner error', e);
  process.exit(1);
});
