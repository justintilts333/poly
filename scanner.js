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
    // Lock exists — check if the owning process is still alive
    let stale = true;
    try {
      const raw = fs.readFileSync(LOCK_FILE, 'utf8').trim();
      const pid = parseInt(raw, 10);
      if (Number.isInteger(pid) && pid > 0 && pid !== process.pid) {
        process.kill(pid, 0); // throws if pid is dead
        stale = false;
      }
    } catch (_) { /* ESRCH = dead process, EPERM = alive but no permission */
      if (_.code === 'EPERM') stale = false;
    }
    if (!stale) {
      process.stderr.write(`Scanner already running. Exiting.\n`);
      process.exitCode = 0;
      process.exit();
    }
    // Stale lock — remove and re-acquire
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

// ── HTTP helper ───────────────────────────────────────────────────────────────
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
          if (n > 0) {
            setTimeout(() => attempt(n - 1, delay * 2), delay);
            return;
          }
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

const DATA_API        = 'https://data-api.polymarket.com';
const DATA_API_V1     = 'https://data-api.polymarket.com/v1';
const GAMMA_API       = 'https://gamma-api.polymarket.com';

// ── 1. Leaderboard ────────────────────────────────────────────────────────────
// Endpoint: /v1/leaderboard — max 50 results, no offset pagination support.
// Fetch multiple time windows to maximise wallet coverage.
async function fetchLeaderboard() {
  const wallets = new Set();
  const periods = ['ALL', 'MONTH', 'WEEK'];

  for (const period of periods) {
    try {
      const url = `${DATA_API_V1}/leaderboard?timePeriod=${period}&orderBy=PNL&limit=50`;
      const data = await fetchJSON(url);
      const rows = Array.isArray(data) ? data : (data.data || data.results || []);
      for (const row of rows) {
        const addr = row.proxyWallet || row.address || row.wallet;
        if (addr) wallets.add(addr.toLowerCase());
      }
      log(`  Leaderboard ${period}: ${rows.length} rows, running total=${wallets.size}`);
      await sleep(300);
    } catch (e) {
      logError(`Leaderboard ${period} failed`, e);
    }
  }
  log(`Leaderboard complete: ${wallets.size} wallets`);
  return [...wallets];
}

// ── 2. Short-resolution markets ───────────────────────────────────────────────
// Returns { conditionIds: Set, topMarkets: [{conditionId, volume}] }
// topMarkets is the top N by volume, used to seed wallet discovery.
async function fetchShortResolutionMarketIds(maxDays = 14) {
  log(`Fetching markets resolving within ${maxDays} days...`);
  const conditionIds = new Set();
  const allShortMarkets = []; // [{conditionId, volume}] for holder discovery
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

  // Sort by volume descending, keep top 300 for holder discovery
  allShortMarkets.sort((a, b) => b.volume - a.volume);
  const topMarkets = allShortMarkets.slice(0, 300);

  log(`Found ${conditionIds.size} short-resolution market conditionIds (top ${topMarkets.length} by volume for holder scan)`);
  return { conditionIds, topMarkets };
}

// ── 3. Holders from top markets ───────────────────────────────────────────────
// Fetches top position holders for each of the top markets, returns wallet set
async function fetchMarketHolders(topMarkets) {
  log(`Fetching holders from top ${topMarkets.length} markets...`);
  const wallets = new Set();

  for (let i = 0; i < topMarkets.length; i++) {
    const { conditionId } = topMarkets[i];
    try {
      // /holders returns all position holders for a market; /positions requires a user address
      const url = `${DATA_API}/holders?market=${conditionId}&limit=100`;
      const data = await fetchJSON(url, 2, 1000);
      // Response: [{token, holders: [{proxyWallet, ...}]}, ...]
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
      log(`  Holder scan: ${i + 1}/${topMarkets.length} markets, ${wallets.size} unique wallets so far`);
    }
    await sleep(150);
  }

  log(`Market holder scan complete: ${wallets.size} unique wallets`);
  return wallets;
}

// ── 3. Wallet trade history ───────────────────────────────────────────────────
// Correct endpoint: /activity?user={address}&limit=100&offset=N
// Key fields: price/avgPrice, side, conditionId, timestamp, cashPnl, realizedPnl
async function fetchWalletTrades(address) {
  const trades = [];
  const pageSize = 100;
  let offset = 0;

  while (true) {
    try {
      const url = `${DATA_API}/activity?user=${address}&limit=${pageSize}&offset=${offset}&type=TRADE`; // no /v1
      const data = await fetchJSON(url, 2, 1000);
      const rows = Array.isArray(data) ? data : (data.data || data.activities || []);
      if (!rows.length) break;
      trades.push(...rows);
      if (rows.length < pageSize) break;
      offset += pageSize;
      await sleep(200);
    } catch (e) {
      if (e.message && e.message.includes('HTTP 400')) break; // past end of data
      logError(`Trade fetch failed for ${address}`, e);
      break;
    }
  }
  return trades;
}

// ── 4. Evaluate a wallet ──────────────────────────────────────────────────────
function evaluateWallet(address, trades, shortConditionIds) {
  const thirtyDaysAgo = Date.now() - 30 * 86400000;

  // Only BUY-side trades with price < 0.50 in short-resolution markets
  const qualifying = trades.filter(t => {
    if (t.side !== 'BUY') return false;
    const price = parseFloat(t.price ?? t.avgPrice ?? 1);
    if (isNaN(price) || price >= 0.50) return false;
    const cid = (t.conditionId || t.condition_id || '').toLowerCase();
    return shortConditionIds.size === 0 || shortConditionIds.has(cid);
  });

  if (!qualifying.length) return null;

  // Must have been active in last 30 days
  const allTimestamps = trades.map(t => {
    const ts = t.timestamp;
    return typeof ts === 'number' ? (ts > 1e10 ? ts : ts * 1000) : 0;
  }).filter(Boolean);
  const lastActiveTs = allTimestamps.length ? Math.max(...allTimestamps) : 0;
  if (lastActiveTs < thirtyDaysAgo) return null;
  const lastActiveDate = new Date(lastActiveTs).toISOString().split('T')[0];

  // Win/loss: use cashPnl on qualifying trades (positive = win, negative = loss)
  // Only count as resolved if cashPnl is non-zero
  let wins = 0, losses = 0, totalEntryPrice = 0;
  const categories = {};

  for (const t of qualifying) {
    const pnl = parseFloat(t.cashPnl ?? t.realizedPnl ?? 'NaN');
    const price = parseFloat(t.price ?? t.avgPrice ?? 0);
    totalEntryPrice += isNaN(price) ? 0 : price;

    if (!isNaN(pnl) && pnl > 0) wins++;
    else if (!isNaN(pnl) && pnl < 0) losses++;
    // pnl === 0 or NaN → unresolved, skip from win rate

    const cat = t.category || t.eventCategory || t.marketCategory || 'Unknown';
    categories[cat] = (categories[cat] || 0) + 1;
  }

  // Overall PnL across ALL trades
  let overallPnl = 0;
  for (const t of trades) {
    const pnl = parseFloat(t.cashPnl ?? t.realizedPnl ?? 'NaN');
    if (!isNaN(pnl)) overallPnl += pnl;
  }

  const resolved = wins + losses;
  const winRate = resolved > 0 ? wins / resolved : 0;
  const avgEntryPrice = qualifying.length ? totalEntryPrice / qualifying.length : 0;
  const topCategories = Object.entries(categories)
    .sort((a, b) => b[1] - a[1]).slice(0, 3).map(([c]) => c).join(', ') || 'Unknown';

  return {
    address,
    totalQualifying: qualifying.length,
    wins,
    losses,
    winRate,
    avgEntryPrice,
    overallPnl,
    topCategories,
    lastActiveDate,
  };
}

function assignTiers(w) {
  const tiers = [];
  if (w.overallPnl <= 0) return tiers;
  if (w.totalQualifying >= 30 && w.winRate >= 0.60) tiers.push(1);
  if (w.totalQualifying >= 20 && w.winRate >= 0.55) tiers.push(2);
  if (w.totalQualifying >= 15 && w.winRate >= 0.50) tiers.push(3);
  return tiers;
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function runScan() {
  log('=== Polymarket Wallet Scanner starting ===');

  // Run leaderboard + market fetches in parallel
  const [leaderboardWallets, { conditionIds: shortConditionIds, topMarkets }] = await Promise.all([
    fetchLeaderboard(),
    fetchShortResolutionMarketIds(14),
  ]);

  // Expand wallet pool with holders from top markets by volume
  const holderWallets = await fetchMarketHolders(topMarkets);

  // Union all sources, deduplicated
  const walletSet = new Set([...leaderboardWallets, ...holderWallets]);
  const allWallets = [...walletSet];
  log(`Total wallets to evaluate: ${allWallets.length} (${leaderboardWallets.length} leaderboard + ${holderWallets.size} from markets, deduplicated)`);

  const tier1 = [], tier2 = [], tier3 = [];
  const seen = new Map();
  let processed = 0;

  for (const address of allWallets) {
    processed++;
    if (processed % 50 === 0) {
      log(`Progress: ${processed}/${allWallets.length} | T1=${tier1.length} T2=${tier2.length} T3=${tier3.length}`);
    }

    try {
      const trades = await fetchWalletTrades(address);
      if (!trades.length) continue;

      const stats = evaluateWallet(address, trades, shortConditionIds);
      if (!stats) continue;

      const tiers = assignTiers(stats);
      if (!tiers.length) continue;

      const record = { ...stats, tiers };
      seen.set(address, record);
      if (tiers.includes(1)) tier1.push(record);
      if (tiers.includes(2)) tier2.push(record);
      if (tiers.includes(3)) tier3.push(record);
    } catch (e) {
      logError(`Failed to evaluate ${address}`, e);
    }

    await sleep(250);
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
