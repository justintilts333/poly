#!/usr/bin/env node
'use strict';

const https = require('https');
const fs = require('fs');
const path = require('path');

const LOG_FILE = '/var/log/polymarket-scanner.log';
const DATA_FILE = path.join(__dirname, 'data', 'results.json');
const LOCK_FILE = '/tmp/polymarket-scanner.lock';

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

// ── API base URLs ──────────────────────────────────────────────────────────────
const DATA_API          = 'https://data-api.polymarket.com';
const GAMMA_API         = 'https://gamma-api.polymarket.com';
const HEISENBERG_HOST   = 'narrative.agent.heisenberg.so';
const HEISENBERG_KEY    = process.env.HEISENBERG_API_KEY || '';

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
async function fetchShortResolutionMarkets(maxDays = 14) {
  log(`Fetching markets resolving within ${maxDays} days...`);
  const conditionIds = new Set();
  const allMarkets = [];
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
            allMarkets.push({ conditionId: cid.toLowerCase(), endTs, volume: vol });
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

  allMarkets.sort((a, b) => b.volume - a.volume);
  const topMarkets = allMarkets.slice(0, 300);
  log(`Short-resolution markets: ${conditionIds.size} conditionIds (top ${topMarkets.length} by volume)`);
  return { conditionIds, topMarkets };
}

// ── Market holders ─────────────────────────────────────────────────────────────
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

  log(`Market holder scan: ${wallets.size} wallets`);
  return wallets;
}

// ── Wallet positions (cashPnl / realizedPnl) ──────────────────────────────────
async function fetchWalletPositions(address) {
  const posMap = new Map(); // "conditionId:outcomeIndex" → { cashPnl, realizedPnl }
  try {
    const url = `${DATA_API}/positions?user=${address}&limit=500`;
    const data = await fetchJSON(url, 2, 1500);
    const rows = Array.isArray(data) ? data : (data.data || data.positions || []);
    for (const p of rows) {
      const cid = (p.conditionId || p.condition_id || '').toLowerCase();
      if (!cid) continue;
      const key = `${cid}:${p.outcomeIndex ?? ''}`;
      posMap.set(key, {
        cashPnl:     parseFloat(p.cashPnl     ?? 0),
        realizedPnl: parseFloat(p.realizedPnl ?? 0),
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
  const redeemByKey  = new Map();
  const resolvedCids = new Set();

  for (const t of allTrades) {
    const tType = (t.type || '').toUpperCase();
    if (tType !== 'REDEEM' && tType !== 'REDEMPTION') continue;

    const cid = (t.conditionId || t.condition_id || '').toLowerCase();
    if (!cid) continue;

    // outcomeIndex is always 999 in REDEEM events — key by conditionId only
    let ts = t.timestamp ?? 0;
    if (typeof ts === 'number' && ts > 0 && ts < 1e12) ts *= 1000;

    if (!redeemByKey.has(cid) || ts > redeemByKey.get(cid)) {
      redeemByKey.set(cid, ts || Date.now());
    }
    resolvedCids.add(cid);
  }

  return { redeemByKey, resolvedCids };
}

// ── STEP 3: Qualifying trades filter ──────────────────────────────────────────
// Keep BUY trades where:
//   a) price < $0.50
//   b) market is "short-resolution" — either:
//      i.  conditionId is in our upcoming <14d set (will resolve soon), OR
//      ii. there is a REDEEM within 14 days of the BUY (already resolved quickly)
function filterQualifyingTrades(allTrades, shortConditionIds, redeemByKey) {
  const maxResolutionMs = 14 * 86400000;

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
    const key = `${cid}:${t.outcomeIndex ?? ''}`;

    // Short-resolution check
    let buyTs = t.timestamp ?? 0;
    if (typeof buyTs === 'number' && buyTs > 0 && buyTs < 1e12) buyTs *= 1000;

    const inUpcomingShortMarket = shortConditionIds.size > 0 && shortConditionIds.has(cid);

    const redeemTs = redeemByKey.get(cid);
    const resolvedQuickly = redeemTs &&
      (redeemTs - buyTs) >= 0 &&
      (redeemTs - buyTs) <= maxResolutionMs;

    return inUpcomingShortMarket || resolvedQuickly;
  });
}

// ── STEP 4: Metrics on qualifying trades ──────────────────────────────────────
// posMap: Map<"conditionId:outcomeIndex" → { cashPnl, realizedPnl }>
function calcMetrics(qualifyingTrades, allTrades, redeemByKey, resolvedCids, posMap) {
  if (!qualifyingTrades.length) return null;

  const now       = Date.now();
  const cutoff7d  = now - 7  * 86400000;
  const cutoff30d = now - 30 * 86400000;

  let wins = 0, losses = 0;
  let wins7d = 0, total7d = 0;
  let wins30d = 0, total30d = 0;
  let totalEntryPrice = 0;
  let totalPnl = 0;
  let totalReturnMultiple = 0; // sum of (1/entryPrice) for wins → entry vs resolution ratio

  for (const t of qualifyingTrades) {
    const cid   = (t.conditionId || '').toLowerCase();
    const key   = `${cid}:${t.outcomeIndex ?? ''}`;
    const price = parseFloat(t.price ?? t.avgPrice ?? t.avg_price ?? 0);
    const usdcSize = parseFloat(t.usdcSize ?? 0);
    const shares   = parseFloat(t.size ?? 0);

    let ts = t.timestamp ?? 0;
    if (typeof ts === 'number' && ts > 0 && ts < 1e12) ts *= 1000;

    if (!isNaN(price)) totalEntryPrice += price;

    // Win detection: prefer cashPnl/realizedPnl from /positions, fall back to REDEEM event
    const posData   = posMap ? posMap.get(key) : null;
    const hasPosWin = posData && (posData.cashPnl > 0 || posData.realizedPnl > 0);
    const redeemTs  = redeemByKey.get(cid);
    const isWin     = hasPosWin || !!redeemTs;

    // Loss: market confirmed resolved but no positive PnL signal
    const marketResolved = resolvedCids.has(cid) ||
      (posData && (posData.cashPnl !== 0 || posData.realizedPnl !== 0));
    const isLoss = !isWin && marketResolved;

    if (!isWin && !isLoss) continue; // unresolved — skip for win rate

    if (isWin) {
      wins++;
      // PnL: shares × $1 payout minus cost; fallback to position realizedPnl if available
      if (posData && posData.realizedPnl !== 0) {
        totalPnl += posData.realizedPnl;
      } else {
        totalPnl += shares > 0 ? shares - usdcSize : usdcSize * (1 / Math.max(price, 0.001) - 1);
      }
      // Return multiple: resolution price ($1) / entry price
      if (price > 0 && price < 1) totalReturnMultiple += 1 / price;
    } else {
      losses++;
      totalPnl -= usdcSize > 0 ? usdcSize : price;
    }

    if (ts >= cutoff7d)  { total7d++;  if (isWin) wins7d++;  }
    if (ts >= cutoff30d) { total30d++; if (isWin) wins30d++; }
  }

  const totalResolved = wins + losses;
  if (totalResolved === 0) return null;

  const winRate    = wins / totalResolved;
  const winRate7d  = total7d  > 0 ? wins7d  / total7d  : NaN;
  const winRate30d = total30d > 0 ? wins30d / total30d : NaN;
  const avgEntryPrice    = qualifyingTrades.length > 0 ? totalEntryPrice / qualifyingTrades.length : 0;
  const avgReturnMultiple = wins > 0 ? totalReturnMultiple / wins : 0;
  const lastTradeTs      = getLastTradeTs(allTrades);

  return {
    qualifyingCount: qualifyingTrades.length,
    resolvedCount:   totalResolved,
    wins, losses,
    winRate, winRate7d, winRate30d,
    totalPnl,
    avgEntryPrice,
    avgReturnMultiple,
    lastTradeTs,
    lastTradeDate: lastTradeTs ? new Date(lastTradeTs).toISOString().split('T')[0] : null,
    total7d, total30d,
  };
}

// ── Tier assignment ────────────────────────────────────────────────────────────
function assignTiers(m) {
  const tiers = [];
  if (!m || m.totalPnl <= 0) return tiers;
  // Use resolvedCount (not qualifyingCount) for tier thresholds
  const n = m.resolvedCount;
  if (n >= 30 && m.winRate >= 0.60) tiers.push(1);
  if (n >= 20 && m.winRate >= 0.55) tiers.push(2);
  if (n >= 15 && m.winRate >= 0.50) tiers.push(3);
  return tiers;
}

// ── Score ──────────────────────────────────────────────────────────────────────
function computeScore(m) {
  const wr7d  = isNaN(m.winRate7d)  ? (isNaN(m.winRate30d) ? m.winRate : m.winRate30d) : m.winRate7d;
  const wr30d = isNaN(m.winRate30d) ? m.winRate : m.winRate30d;
  const wrAll = m.winRate;

  const wrScore = (wr7d * 0.5) + (wr30d * 0.3) + (wrAll * 0.2);

  // Price ratio bonus: avg return multiple (entry price vs $1.00 resolution price).
  // Buying at $0.10 and winning = 10x; cap normalisation at 10x → up to 0.15 bonus.
  const priceRatioBonus = m.avgReturnMultiple > 0
    ? Math.min(m.avgReturnMultiple / 10, 1) * 0.15
    : 0;

  return wrScore + priceRatioBonus;
}

// ── Main ───────────────────────────────────────────────────────────────────────
async function runScan() {
  log('=== Polymarket Wallet Scanner v3 (two-segment) ===');

  // Segment 1 (Heisenberg) and market data fetched in parallel
  const [segment1, { conditionIds: shortConditionIds, topMarkets }] = await Promise.all([
    fetchHeisenbergLeaderboard(),
    fetchShortResolutionMarkets(14),
  ]);

  const holderWallets = await fetchMarketHolders(topMarkets);

  // Segment 2 candidates: market holders only
  const allWallets = [...holderWallets];
  log(`Segment 2 candidates: ${allWallets.length} (market holders)`);

  const tier1 = [], tier2 = [], tier3 = [];
  const seen  = new Map();
  let processed = 0;
  let skippedBot = 0, skippedActivity = 0, skippedNoTrades = 0,
      skippedNoQualifying = 0, skippedNoResolved = 0, skippedNoTier = 0;

  const now       = Date.now();
  const cutoff7d  = now - 7  * 86400000;
  const cutoff30d = now - 30 * 86400000;

  for (const address of allWallets) {
    processed++;
    if (processed % 50 === 0) {
      log(`Progress: ${processed}/${allWallets.length} | T1=${tier1.length} T2=${tier2.length} T3=${tier3.length} | bot=${skippedBot} inactive=${skippedActivity} noTrades=${skippedNoTrades} noQual=${skippedNoQualifying} noResolved=${skippedNoResolved} noTier=${skippedNoTier}`);
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
      const { redeemByKey, resolvedCids } = buildRedeemInfo(allTrades);

      // STEP 3: qualifying trades
      const qualifying = filterQualifyingTrades(allTrades, shortConditionIds, redeemByKey);
      if (!qualifying.length) { skippedNoQualifying++; continue; }

      // STEP 4: metrics (uses posMap cashPnl/realizedPnl for win detection)
      const m = calcMetrics(qualifying, allTrades, redeemByKey, resolvedCids, posMap);
      if (!m) { skippedNoResolved++; continue; }

      const tiers = assignTiers(m);
      if (!tiers.length) { skippedNoTier++; continue; }

      // STEP 5: score
      const score = computeScore(m);

      const record = {
        address,
        totalQualifying:    m.qualifyingCount,
        resolvedCount:      m.resolvedCount,
        wins:               m.wins,
        losses:             m.losses,
        winRate:            m.winRate,
        winRate7d:          m.winRate7d,
        winRate30d:         m.winRate30d,
        avgEntryPrice:      m.avgEntryPrice,
        avgReturnMultiple:  m.avgReturnMultiple,
        overallPnl:         m.totalPnl,
        lastTradeDate:      m.lastTradeDate,
        tiers,
        score,
        total7dTrades:      m.total7d,
        total30dTrades:     m.total30d,
      };

      seen.set(address, record);
      if (tiers.includes(1)) tier1.push(record);
      if (tiers.includes(2)) tier2.push(record);
      if (tiers.includes(3)) tier3.push(record);

    } catch (e) {
      logError(`Evaluate ${address}`, e);
    }

    await sleep(250);
  }

  const multiTier = [...seen.values()].filter(w => w.tiers.length >= 2);
  const sortFn = (a, b) => b.score - a.score;
  [tier1, tier2, tier3, multiTier].forEach(a => a.sort(sortFn));

  const results = {
    scanTime: new Date().toISOString(),
    segment1: {
      source:      'Heisenberg Falcon Leaderboard (agent 584)',
      wallets:     segment1,
      count:       segment1.length,
    },
    segment2: {
      source:      'Market holders — own criteria (BUY <$0.50, 14d resolution window)',
      tier1, tier2, tier3, multiTier,
      stats: {
        candidates:          allWallets.length,
        processed,
        skippedBot,
        skippedActivity,
        skippedNoTrades,
        skippedNoQualifying,
        skippedNoResolved,
        skippedNoTier,
        tier1Count:     tier1.length,
        tier2Count:     tier2.length,
        tier3Count:     tier3.length,
        multiTierCount: multiTier.length,
      },
    },
  };

  const dataDir = path.join(__dirname, 'data');
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify(results, null, 2));

  log(`=== Scan complete ===`);
  log(`  Segment 1 (Falcon): ${segment1.length} wallets`);
  log(`  Segment 2 (own criteria): T1=${tier1.length} T2=${tier2.length} T3=${tier3.length} Multi=${multiTier.length}`);
  log(`  Segment 2 skipped: bot=${skippedBot} inactive=${skippedActivity} noTrades=${skippedNoTrades} noQual=${skippedNoQualifying} noResolved=${skippedNoResolved} noTier=${skippedNoTier}`);
  return results;
}

runScan().catch(e => {
  logError('Fatal scanner error', e);
  process.exit(1);
});
