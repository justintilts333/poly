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
const DATA_API        = 'https://data-api.polymarket.com';
const GAMMA_API       = 'https://gamma-api.polymarket.com';
const LEADERBOARD_API = 'https://leaderboard-api.polymarket.com';

// ── STEP 0: Wallet discovery via leaderboard ──────────────────────────────────
// Fetches multiple windows (all, 1m, 1w) to gather a broad candidate set.
async function fetchLeaderboardCandidates() {
  log('Fetching leaderboard candidates...');
  const wallets = new Set();
  const windows = ['all', '1m', '1w'];
  const limit = 100;

  for (const window of windows) {
    let offset = 0;
    let pages = 0;
    while (pages < 20) { // cap at 2000 per window
      try {
        const url = `${LEADERBOARD_API}/l/rankings?window=${window}&limit=${limit}&offset=${offset}`;
        const data = await fetchJSON(url, 3, 2000);
        const rows = Array.isArray(data) ? data : (data.data || data.rankings || data.results || []);
        if (!rows.length) break;

        if (offset === 0) {
          log(`  [DEBUG] leaderboard window=${window} keys: ${Object.keys(rows[0] || {}).join(',')}`);
        }

        for (const row of rows) {
          const addr = row.proxyWallet ?? row.proxy_wallet ?? row.wallet ?? row.address ?? row.user;
          if (addr && typeof addr === 'string') wallets.add(addr.toLowerCase());
        }
        log(`  Leaderboard window=${window} offset=${offset}: ${rows.length} rows → ${wallets.size} total`);
        if (rows.length < limit) break;
        offset += limit;
        pages++;
        await sleep(300);
      } catch (e) {
        logError(`Leaderboard window=${window} offset=${offset}`, e);
        break;
      }
    }
    await sleep(500);
  }

  log(`Leaderboard candidates: ${wallets.size} wallets`);
  return [...wallets];
}

// ── STEP 0b: Short-resolution markets ─────────────────────────────────────────
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

// ── STEP 0c: Market holders ────────────────────────────────────────────────────
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

// ── Trade history via data-api ─────────────────────────────────────────────────
// Fetches all trade activity for a wallet. Returns raw trade rows.
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
      }

      trades.push(...rows);
      if (rows.length < limit) break;
      offset += limit;
      await sleep(200);
    } catch (e) {
      // Non-fatal: return whatever we have
      break;
    }
  }

  return trades;
}

// ── STEP 1: Bot filter ─────────────────────────────────────────────────────────
// Discard wallets that look like bots.
// Criteria (applied to raw all-trades list before any other filtering):
//   a) Total raw trades > 2000 (thousands of micro-trades)
//   b) All trade sizes suspiciously uniform (stdev < 1% of mean on usdcSize)
function isBotWallet(allTrades) {
  if (allTrades.length > 2000) return true;

  // Check trade size uniformity on available trades
  const sizes = allTrades
    .map(t => parseFloat(t.usdcSize ?? t.amount ?? t.size ?? 0))
    .filter(s => s > 0);

  if (sizes.length >= 10) {
    const mean = sizes.reduce((a, b) => a + b, 0) / sizes.length;
    const variance = sizes.reduce((a, v) => a + Math.pow(v - mean, 2), 0) / sizes.length;
    const stdev = Math.sqrt(variance);
    if (mean > 0 && stdev / mean < 0.01) return true; // <1% coefficient of variation
  }

  return false;
}

// ── STEP 2: Activity filter ────────────────────────────────────────────────────
// Returns the most recent trade timestamp in ms, or 0 if no trades.
function getLastTradeTs(allTrades) {
  let latest = 0;
  for (const t of allTrades) {
    let ts = t.timestamp ?? t.createdAt ?? t.created_at ?? t.time ?? 0;
    if (typeof ts === 'string') ts = new Date(ts).getTime() || 0;
    if (typeof ts === 'number' && ts < 1e12) ts *= 1000; // seconds → ms
    if (ts > latest) latest = ts;
  }
  return latest;
}

// ── STEP 3: Trade-level filter ─────────────────────────────────────────────────
// Keep only: BUY side, price < $0.50, conditionId in short-resolution set.
function filterQualifyingTrades(allTrades, shortConditionIds) {
  return allTrades.filter(t => {
    const side = (t.side ?? t.trade_side ?? t.type ?? '').toUpperCase();
    if (side !== 'BUY') return false;
    const price = parseFloat(t.price ?? t.avgPrice ?? t.avg_price ?? 1);
    if (isNaN(price) || price >= 0.50) return false;
    const cid = (t.conditionId ?? t.condition_id ?? t.market ?? t.marketId ?? '').toLowerCase();
    // If shortConditionIds is empty (markets API failed) allow all
    if (shortConditionIds.size > 0 && !shortConditionIds.has(cid)) return false;
    return true;
  });
}

// ── STEP 4: Metric calculation ─────────────────────────────────────────────────
// All metrics computed on the qualifying subset.
function calcMetrics(qualifyingTrades, allTrades) {
  if (!qualifyingTrades.length) return null;

  const now = Date.now();
  const cutoff7d  = now - 7  * 86400000;
  const cutoff30d = now - 30 * 86400000;

  let wins = 0, losses = 0;
  let wins7d = 0, total7d = 0;
  let wins30d = 0, total30d = 0;
  let totalEntryPrice = 0;
  let totalPnl = 0;
  const lastTradeTsAll = getLastTradeTs(allTrades);

  for (const t of qualifyingTrades) {
    const cashPnl = parseFloat(t.cashPnl ?? t.cash_pnl ?? t.pnl ?? t.realized_pnl ?? 'NaN');
    const price = parseFloat(t.price ?? t.avgPrice ?? t.avg_price ?? 0);

    let ts = t.timestamp ?? t.createdAt ?? t.created_at ?? t.time ?? 0;
    if (typeof ts === 'string') ts = new Date(ts).getTime() || 0;
    if (typeof ts === 'number' && ts < 1e12) ts *= 1000;

    if (!isNaN(price)) totalEntryPrice += price;

    if (!isNaN(cashPnl)) {
      totalPnl += cashPnl;
      if (cashPnl > 0) wins++;
      else if (cashPnl < 0) losses++;

      if (ts >= cutoff7d) {
        total7d++;
        if (cashPnl > 0) wins7d++;
      }
      if (ts >= cutoff30d) {
        total30d++;
        if (cashPnl > 0) wins30d++;
      }
    }
  }

  const totalResolved = wins + losses;
  const winRate     = totalResolved > 0 ? wins / totalResolved : NaN;
  const winRate7d   = total7d  > 0 ? wins7d  / total7d  : NaN;
  const winRate30d  = total30d > 0 ? wins30d / total30d : NaN;
  const avgEntryPrice = qualifyingTrades.length > 0 ? totalEntryPrice / qualifyingTrades.length : 0;

  return {
    qualifyingCount: qualifyingTrades.length,
    resolvedCount: totalResolved,
    wins, losses,
    winRate, winRate7d, winRate30d,
    totalPnl,
    avgEntryPrice,
    lastTradeTs: lastTradeTsAll,
    lastTradeDate: lastTradeTsAll ? new Date(lastTradeTsAll).toISOString().split('T')[0] : null,
    total7d, total30d,
  };
}

// ── STEP 4: Tier assignment ────────────────────────────────────────────────────
function assignTiers(m) {
  const tiers = [];
  if (!m || isNaN(m.winRate) || m.totalPnl <= 0) return tiers;
  if (m.qualifyingCount >= 30 && m.winRate >= 0.60) tiers.push(1);
  if (m.qualifyingCount >= 20 && m.winRate >= 0.55) tiers.push(2);
  if (m.qualifyingCount >= 15 && m.winRate >= 0.50) tiers.push(3);
  return tiers;
}

// ── STEP 5: Scoring ────────────────────────────────────────────────────────────
// Weighted win rate: 7d (50%) > 30d (30%) > all-time (20%)
// + small bonus for lower avg entry price (lower price = more upside on wins)
function computeScore(m) {
  const wr7d  = isNaN(m.winRate7d)  ? (isNaN(m.winRate30d) ? m.winRate : m.winRate30d) : m.winRate7d;
  const wr30d = isNaN(m.winRate30d) ? m.winRate : m.winRate30d;
  const wrAll = isNaN(m.winRate)    ? 0 : m.winRate;

  const wrScore = (wr7d * 0.5) + (wr30d * 0.3) + (wrAll * 0.2);

  // Bonus: lower avg entry price → higher bonus (max +0.10 at price ≈ $0.01)
  const priceBonus = m.avgEntryPrice > 0
    ? Math.max(0, (0.50 - m.avgEntryPrice) / 0.50) * 0.10
    : 0;

  return wrScore + priceBonus;
}

// ── Main scan ──────────────────────────────────────────────────────────────────
async function runScan() {
  log('=== Polymarket Wallet Scanner v2 (direct data-api, no Falcon) starting ===');

  // Phase 1: Discover candidate wallets + market structure in parallel
  const [leaderboardWallets, { conditionIds: shortConditionIds, topMarkets }] = await Promise.all([
    fetchLeaderboardCandidates(),
    fetchShortResolutionMarkets(14),
  ]);

  // Supplement with holders from top-volume short-resolution markets
  const holderWallets = await fetchMarketHolders(topMarkets);

  const walletSet = new Set([...leaderboardWallets, ...holderWallets]);
  const allWallets = [...walletSet];
  log(`Total candidates: ${allWallets.length} (${leaderboardWallets.length} leaderboard + ${holderWallets.size} holders)`);

  const tier1 = [], tier2 = [], tier3 = [];
  const seen = new Map();
  let processed = 0;
  let skippedBot = 0, skippedActivity = 0, skippedNoTrades = 0, skippedNoTier = 0;

  const now = Date.now();
  const cutoff7d  = now - 7  * 86400000;
  const cutoff30d = now - 30 * 86400000;

  for (const address of allWallets) {
    processed++;
    if (processed % 50 === 0) {
      log(`Progress: ${processed}/${allWallets.length} | T1=${tier1.length} T2=${tier2.length} T3=${tier3.length} | bot=${skippedBot} inactive=${skippedActivity} notrades=${skippedNoTrades} notier=${skippedNoTier}`);
    }

    try {
      // Fetch raw trade history
      const allTrades = await fetchWalletTrades(address, 1000);

      if (!allTrades.length) { skippedNoTrades++; continue; }

      // STEP 1 — Bot filter
      if (isBotWallet(allTrades)) { skippedBot++; continue; }

      // STEP 2 — Activity filter (last 7d + last 30d)
      const lastTs = getLastTradeTs(allTrades);
      if (lastTs < cutoff7d)  { skippedActivity++; continue; }  // must have traded in last 7 days
      if (lastTs < cutoff30d) { skippedActivity++; continue; }  // belt-and-suspenders

      // STEP 3 — Filter to qualifying trades
      const qualifying = filterQualifyingTrades(allTrades, shortConditionIds);
      if (!qualifying.length) { skippedNoTrades++; continue; }

      // STEP 4 — Compute metrics on qualifying trades
      const m = calcMetrics(qualifying, allTrades);
      if (!m) { skippedNoTrades++; continue; }

      const tiers = assignTiers(m);
      if (!tiers.length) { skippedNoTier++; continue; }

      // STEP 5 — Score
      const score = computeScore(m);

      const record = {
        address,
        totalQualifying: m.qualifyingCount,
        wins: m.wins,
        losses: m.losses,
        winRate: m.winRate,
        winRate7d: m.winRate7d,
        winRate30d: m.winRate30d,
        avgEntryPrice: m.avgEntryPrice,
        overallPnl: m.totalPnl,
        lastTradeDate: m.lastTradeDate,
        tiers,
        score,
        // Extra detail for dashboard
        total7dTrades: m.total7d,
        total30dTrades: m.total30d,
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

  // Sort each tier by score descending
  const sortFn = (a, b) => b.score - a.score;
  [tier1, tier2, tier3, multiTier].forEach(a => a.sort(sortFn));

  const results = {
    scanTime: new Date().toISOString(),
    tier1, tier2, tier3, multiTier,
    stats: {
      walletsScanned: allWallets.length,
      walletsProcessed: processed,
      skippedBot,
      skippedActivity,
      skippedNoTrades,
      skippedNoTier,
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
  log(`    Skipped: bot=${skippedBot} inactive=${skippedActivity} noTrades=${skippedNoTrades} noTier=${skippedNoTier}`);
  return results;
}

runScan().catch(e => {
  logError('Fatal scanner error', e);
  process.exit(1);
});
