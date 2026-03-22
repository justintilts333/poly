#!/usr/bin/env node
'use strict';

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');

const LOG_FILE = '/var/log/polymarket-scanner.log';
const DATA_FILE = path.join(__dirname, 'data', 'results.json');

// ── Logging ──────────────────────────────────────────────────────────────────
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

// ── HTTP helper with retry + exponential backoff ──────────────────────────────
function fetchJSON(url, retries = 3, delayMs = 1000) {
  return new Promise((resolve, reject) => {
    const attempt = (n, delay) => {
      const lib = url.startsWith('https') ? https : http;
      const req = lib.get(url, {
        headers: {
          'Accept': 'application/json',
          'User-Agent': 'PolymarketScanner/1.0',
        },
        timeout: 30000,
      }, (res) => {
        if (res.statusCode === 429) {
          const retryAfter = parseInt(res.headers['retry-after'] || '5', 10) * 1000;
          log(`Rate limited on ${url}, waiting ${retryAfter}ms`);
          setTimeout(() => attempt(n, delay), retryAfter);
          return;
        }
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          return fetchJSON(res.headers.location, retries, delayMs).then(resolve).catch(reject);
        }
        if (res.statusCode !== 200) {
          if (n > 0) {
            log(`HTTP ${res.statusCode} for ${url}, retrying in ${delay}ms (${n} left)`);
            setTimeout(() => attempt(n - 1, delay * 2), delay);
            return;
          }
          return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
        }
        let data = '';
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => {
          try { resolve(JSON.parse(data)); }
          catch (e) { reject(new Error(`JSON parse error for ${url}: ${e.message}`)); }
        });
      });
      req.on('error', (err) => {
        if (n > 0) {
          log(`Request error for ${url}: ${err.message}, retrying in ${delay}ms (${n} left)`);
          setTimeout(() => attempt(n - 1, delay * 2), delay);
        } else {
          reject(err);
        }
      });
      req.on('timeout', () => {
        req.destroy();
        if (n > 0) {
          log(`Timeout for ${url}, retrying in ${delay}ms (${n} left)`);
          setTimeout(() => attempt(n - 1, delay * 2), delay);
        } else {
          reject(new Error(`Timeout for ${url}`));
        }
      });
    };
    attempt(retries, delayMs);
  });
}

// ── Sleep ─────────────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ── Polymarket Data API ───────────────────────────────────────────────────────
const DATA_API = 'https://data-api.polymarket.com';
const GAMMA_API = 'https://gamma-api.polymarket.com';

async function fetchLeaderboard(limit = 1000) {
  log(`Fetching top ${limit} wallets from leaderboard...`);
  const wallets = new Set();
  const pageSize = 100;
  let offset = 0;

  while (wallets.size < limit) {
    try {
      const url = `${DATA_API}/leaderboard?limit=${pageSize}&offset=${offset}&window=all`;
      const data = await fetchJSON(url);
      const rows = Array.isArray(data) ? data : (data.data || data.results || []);
      if (!rows.length) break;
      for (const row of rows) {
        const addr = row.address || row.wallet || row.user;
        if (addr) wallets.add(addr.toLowerCase());
      }
      log(`  Leaderboard page offset=${offset}: got ${rows.length} rows, total unique=${wallets.size}`);
      if (rows.length < pageSize) break;
      offset += pageSize;
      if (wallets.size >= limit) break;
      await sleep(300);
    } catch (e) {
      logError(`Leaderboard fetch failed at offset=${offset}`, e);
      break;
    }
  }
  log(`Leaderboard fetch complete: ${wallets.size} wallets`);
  return [...wallets];
}

async function fetchMarketsWithShortResolution(maxDays = 14) {
  log(`Fetching markets with resolution <= ${maxDays} days...`);
  const markets = [];
  const pageSize = 100;
  let offset = 0;
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() + maxDays);

  while (true) {
    try {
      const url = `${GAMMA_API}/markets?limit=${pageSize}&offset=${offset}&active=true&closed=false`;
      const data = await fetchJSON(url);
      const rows = Array.isArray(data) ? data : (data.data || data.markets || []);
      if (!rows.length) break;

      for (const m of rows) {
        const endDate = m.endDate || m.end_date || m.resolutionDate || m.resolution_date;
        if (!endDate) continue;
        const end = new Date(endDate);
        const daysLeft = (end - Date.now()) / 86400000;
        if (daysLeft <= maxDays && daysLeft >= 0) {
          markets.push({
            id: m.conditionId || m.condition_id || m.id,
            slug: m.slug,
            question: m.question,
            endDate,
            category: m.category || m.tags?.[0] || 'Unknown',
          });
        }
      }

      if (rows.length < pageSize) break;
      offset += pageSize;
      await sleep(300);
    } catch (e) {
      logError('Markets fetch failed', e);
      break;
    }
  }
  log(`Found ${markets.length} markets with sub-${maxDays}-day resolution`);
  return markets;
}

async function fetchActiveTraders(marketConditionIds) {
  const wallets = new Set();
  log(`Fetching active traders from ${marketConditionIds.length} short-resolution markets...`);

  // Sample up to 50 markets to avoid too many requests
  const sample = marketConditionIds.slice(0, 50);
  for (const conditionId of sample) {
    try {
      const url = `${DATA_API}/activity?market=${conditionId}&limit=100`;
      const data = await fetchJSON(url);
      const rows = Array.isArray(data) ? data : (data.data || data.activities || []);
      for (const row of rows) {
        const addr = row.user || row.address || row.maker || row.taker;
        if (addr) wallets.add(addr.toLowerCase());
      }
      await sleep(200);
    } catch (e) {
      // skip silently
    }
  }
  log(`Found ${wallets.size} active traders from short-resolution markets`);
  return [...wallets];
}

// ── Trade history for a single wallet ────────────────────────────────────────
async function fetchWalletTrades(address) {
  const trades = [];
  const pageSize = 100;
  let offset = 0;

  while (true) {
    try {
      const url = `${DATA_API}/activity?user=${address}&limit=${pageSize}&offset=${offset}`;
      const data = await fetchJSON(url);
      const rows = Array.isArray(data) ? data : (data.data || data.activities || []);
      if (!rows.length) break;
      trades.push(...rows);
      if (rows.length < pageSize) break;
      offset += pageSize;
      await sleep(150);
    } catch (e) {
      logError(`Failed to fetch trades for ${address}`, e);
      break;
    }
  }
  return trades;
}

// ── Parse and evaluate a wallet ───────────────────────────────────────────────
function parsePrice(p) {
  if (p === null || p === undefined) return null;
  const n = parseFloat(p);
  return isNaN(n) ? null : n;
}

function evaluateWallet(address, trades, shortResolutionMarketIds) {
  // Normalise market ids to a set of lowercase strings
  const shortIds = new Set(shortResolutionMarketIds.map(id => String(id).toLowerCase()));

  // Filter to qualifying trades: entry price < $0.50 AND short-resolution market
  const now = Date.now();
  const thirtyDaysAgo = now - 30 * 86400000;

  const qualifying = trades.filter(t => {
    const price = parsePrice(t.price || t.usdcSize || t.outcomePrice);
    const marketId = String(t.market || t.conditionId || t.condition_id || '').toLowerCase();
    const isShort = shortIds.size === 0 || shortIds.has(marketId); // if no ids, include all
    return price !== null && price < 0.50 && isShort;
  });

  if (!qualifying.length) return null;

  // Last active
  const timestamps = trades.map(t => {
    const ts = t.timestamp || t.createdAt || t.created_at || t.time;
    return ts ? new Date(ts).getTime() : 0;
  }).filter(Boolean);
  const lastActiveTs = timestamps.length ? Math.max(...timestamps) : 0;
  const lastActiveDate = lastActiveTs ? new Date(lastActiveTs).toISOString().split('T')[0] : 'Unknown';
  const activeRecently = lastActiveTs >= thirtyDaysAgo;

  if (!activeRecently) return null;

  // Win/loss on qualifying trades
  let wins = 0;
  let losses = 0;
  let totalPnl = 0;
  let totalEntryPrice = 0;
  const categories = {};

  for (const t of qualifying) {
    // outcome: 1 = win, 0 = loss; or check resolvedOutcome/side
    const outcome = t.outcome ?? t.resolvedOutcome ?? t.profit;
    const pnl = parsePrice(t.profit || t.pnl || t.realizedPnl);
    const price = parsePrice(t.price || t.outcomePrice);
    const category = t.category || t.marketCategory || 'Unknown';

    if (pnl !== null) totalPnl += pnl;

    if (price !== null) totalEntryPrice += price;

    if (outcome === 1 || outcome === true || outcome === 'yes' || (pnl !== null && pnl > 0)) {
      wins++;
    } else if (outcome === 0 || outcome === false || outcome === 'no' || (pnl !== null && pnl < 0)) {
      losses++;
    }

    categories[category] = (categories[category] || 0) + 1;
  }

  // Overall PnL from all trades
  let overallPnl = 0;
  for (const t of trades) {
    const pnl = parsePrice(t.profit || t.pnl || t.realizedPnl);
    if (pnl !== null) overallPnl += pnl;
  }

  const totalQualifying = qualifying.length;
  const resolvedQualifying = wins + losses;
  const winRate = resolvedQualifying > 0 ? wins / resolvedQualifying : 0;
  const avgEntryPrice = totalQualifying > 0 ? totalEntryPrice / totalQualifying : 0;

  // Top categories
  const topCategories = Object.entries(categories)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([cat]) => cat)
    .join(', ');

  return {
    address,
    totalQualifying,
    wins,
    losses,
    winRate,
    avgEntryPrice,
    overallPnl,
    topCategories,
    lastActiveDate,
    activeRecently,
  };
}

function assignTiers(wallet) {
  const tiers = [];
  const { totalQualifying, winRate, overallPnl, activeRecently } = wallet;
  if (!activeRecently || overallPnl <= 0) return tiers;

  if (totalQualifying >= 30 && winRate >= 0.60) tiers.push(1);
  if (totalQualifying >= 20 && winRate >= 0.55) tiers.push(2);
  if (totalQualifying >= 15 && winRate >= 0.50) tiers.push(3);
  return tiers;
}

// ── Main scan ─────────────────────────────────────────────────────────────────
async function runScan() {
  log('=== Polymarket Wallet Scanner starting ===');

  const [leaderboardWallets, shortMarkets] = await Promise.all([
    fetchLeaderboard(1000),
    fetchMarketsWithShortResolution(14),
  ]);

  const shortMarketIds = shortMarkets.map(m => m.id).filter(Boolean);
  const activeTraders = await fetchActiveTraders(shortMarketIds);

  // Combine and deduplicate
  const allWallets = [...new Set([...leaderboardWallets, ...activeTraders])];
  log(`Total unique wallets to evaluate: ${allWallets.length}`);

  const tier1 = [], tier2 = [], tier3 = [];
  const seen = new Map();

  let processed = 0;
  for (const address of allWallets) {
    processed++;
    if (processed % 50 === 0) log(`Progress: ${processed}/${allWallets.length}`);

    try {
      const trades = await fetchWalletTrades(address);
      if (!trades.length) continue;

      const stats = evaluateWallet(address, trades, shortMarketIds);
      if (!stats) continue;

      const tiers = assignTiers(stats);
      if (!tiers.length) continue;

      const record = { ...stats, tiers };
      seen.set(address, record);

      if (tiers.includes(1)) tier1.push(record);
      if (tiers.includes(2)) tier2.push(record);
      if (tiers.includes(3)) tier3.push(record);

      await sleep(200);
    } catch (e) {
      logError(`Failed to evaluate ${address}`, e);
    }
  }

  // Multi-tier wallets (appear in 2+ tiers)
  const multiTier = [...seen.values()].filter(w => w.tiers.length >= 2);

  // Sort each tier by win rate desc
  const sortFn = (a, b) => b.winRate - a.winRate || b.totalQualifying - a.totalQualifying;
  tier1.sort(sortFn);
  tier2.sort(sortFn);
  tier3.sort(sortFn);
  multiTier.sort(sortFn);

  const results = {
    scanTime: new Date().toISOString(),
    tier1,
    tier2,
    tier3,
    multiTier,
    stats: {
      walletsScanned: allWallets.length,
      tier1Count: tier1.length,
      tier2Count: tier2.length,
      tier3Count: tier3.length,
      multiTierCount: multiTier.length,
    },
  };

  // Ensure data directory exists
  const dataDir = path.join(__dirname, 'data');
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify(results, null, 2));

  log(`=== Scan complete. T1=${tier1.length} T2=${tier2.length} T3=${tier3.length} Multi=${multiTier.length} ===`);
  return results;
}

runScan().catch(e => {
  logError('Fatal error in scanner', e);
  process.exit(1);
});
