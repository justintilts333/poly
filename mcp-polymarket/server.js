'use strict';

const https   = require('https');
const http    = require('http');
const express = require('express');
const { execSync, spawn } = require('child_process');

const PORT = process.env.MCP_PORT || 3001;

const DATA_API        = 'https://data-api.polymarket.com';
const GAMMA_API       = 'https://gamma-api.polymarket.com';
const LEADERBOARD_API = 'https://leaderboard-api.polymarket.com';

// ── HTTP helper ────────────────────────────────────────────────────────────────
function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: { 'Accept': 'application/json', 'User-Agent': 'MCP-Polymarket/1.0' },
      timeout: 30000,
    }, (res) => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch (e) { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout: ' + url)); });
  });
}

// ── Tool definitions ───────────────────────────────────────────────────────────
const TOOLS = [
  {
    name: 'get_activity',
    description: 'Fetch trade activity for a wallet. Returns BUY/SELL/REDEEM events with fields: type, side, timestamp, conditionId, outcomeIndex, price, usdcSize, size.',
    inputSchema: {
      type: 'object',
      properties: {
        address: { type: 'string', description: 'Wallet proxy address' },
        limit:   { type: 'number', description: 'Max records (default 20)' },
        offset:  { type: 'number', description: 'Pagination offset (default 0)' },
      },
      required: ['address'],
    },
  },
  {
    name: 'get_positions',
    description: 'Fetch current positions for a wallet with cashPnl, realizedPnl, avgPrice, curPrice, conditionId, outcomeIndex.',
    inputSchema: {
      type: 'object',
      properties: {
        address: { type: 'string', description: 'Wallet proxy address' },
        limit:   { type: 'number', description: 'Max records (default 50)' },
      },
      required: ['address'],
    },
  },
  {
    name: 'get_markets',
    description: 'Fetch markets from Polymarket gamma-api.',
    inputSchema: {
      type: 'object',
      properties: {
        limit:  { type: 'number', description: 'Max records (default 10)' },
        offset: { type: 'number', description: 'Pagination offset (default 0)' },
        active: { type: 'boolean', description: 'Filter active markets (default true)' },
        closed: { type: 'boolean', description: 'Filter closed markets (default false)' },
      },
    },
  },
  {
    name: 'get_leaderboard',
    description: 'Fetch top traders from Polymarket leaderboard.',
    inputSchema: {
      type: 'object',
      properties: {
        window: { type: 'string', description: 'Time window: all, 1m, 1w (default 1w)' },
        limit:  { type: 'number', description: 'Max records (default 10)' },
        offset: { type: 'number', description: 'Pagination offset (default 0)' },
      },
    },
  },
  {
    name: 'get_logs',
    description: 'Fetch the last N lines from the scanner log file on the VPS.',
    inputSchema: {
      type: 'object',
      properties: {
        lines: { type: 'number', description: 'Number of lines to return (default 100)' },
      },
    },
  },
  {
    name: 'trigger_scan',
    description: 'Trigger a fresh wallet scan on the VPS in the background.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'get_results',
    description: 'Return the latest scan results: Segment 1 (Heisenberg Falcon leaderboard wallets) and Segment 2 (own-criteria tier wallets). Pass segment="1" or "2" to filter, or omit for summary.',
    inputSchema: {
      type: 'object',
      properties: {
        segment: { type: 'string', description: 'Which segment to return: "1", "2", or "all" (default "all")' },
        limit:   { type: 'number', description: 'Max wallets to return per tier (default 20)' },
      },
    },
  },
];

// ── Tool execution ─────────────────────────────────────────────────────────────
async function callTool(name, args) {
  if (name === 'get_activity') {
    const r = await fetchJSON(`${DATA_API}/activity?user=${args.address}&limit=${args.limit || 20}&offset=${args.offset || 0}&sortBy=TIMESTAMP&ascending=false`);
    return JSON.stringify(r, null, 2);
  }
  if (name === 'get_positions') {
    const r = await fetchJSON(`${DATA_API}/positions?user=${args.address}&limit=${args.limit || 50}`);
    return JSON.stringify(r, null, 2);
  }
  if (name === 'get_markets') {
    const r = await fetchJSON(`${GAMMA_API}/markets?limit=${args.limit || 10}&offset=${args.offset || 0}&active=${args.active !== false}&closed=${args.closed || false}`);
    return JSON.stringify(r, null, 2);
  }
  if (name === 'get_leaderboard') {
    const r = await fetchJSON(`${LEADERBOARD_API}/l/rankings?window=${args.window || '1w'}&limit=${args.limit || 10}&offset=${args.offset || 0}`);
    return JSON.stringify(r, null, 2);
  }
  if (name === 'get_logs') {
    const lines = Math.min(args.lines || 100, 2000);
    return execSync(`tail -n ${lines} /var/log/polymarket-scanner.log 2>/dev/null || echo "Log not found"`, { encoding: 'utf8' });
  }
  if (name === 'trigger_scan') {
    // Kill any stale scanner process first
    try { require('child_process').execSync("pkill -f 'node.*scanner.js' 2>/dev/null || true"); } catch (_) {}
    const child = spawn('node', ['--max-old-space-size=256', '/opt/polymarket-scanner/scanner.js'], {
      detached: true,
      stdio: ['ignore', require('fs').openSync('/var/log/polymarket-scanner.log', 'a'), require('fs').openSync('/var/log/polymarket-scanner.log', 'a')],
      env: { ...process.env },
    });
    child.unref();
    return `Scanner triggered. PID: ${child.pid}`;
  }
  if (name === 'get_results') {
    const dataFile = '/opt/polymarket-scanner/data/results.json';
    let raw;
    try { raw = require('fs').readFileSync(dataFile, 'utf8'); }
    catch (_) { return JSON.stringify({ error: 'No results file found. Run trigger_scan first.' }); }
    const results = JSON.parse(raw);
    const seg  = (args.segment || 'all').toString();
    const lim  = Math.min(args.limit || 20, 200);

    if (seg === '1') {
      return JSON.stringify({
        scanTime: results.scanTime,
        segment1: { ...results.segment1, wallets: (results.segment1?.wallets || []).slice(0, lim) },
      }, null, 2);
    }
    if (seg === '2') {
      const s2 = results.segment2 || {};
      return JSON.stringify({
        scanTime: results.scanTime,
        segment2: {
          source:     s2.source,
          stats:      s2.stats,
          top5ByPnl:  (s2.top5ByPnl  || []).slice(0, lim),
          tierS:      (s2.tierS      || []).slice(0, lim),
          tier1:      (s2.tier1      || []).slice(0, lim),
          tier2:      (s2.tier2      || []).slice(0, lim),
          tier3:      (s2.tier3      || []).slice(0, lim),
          multiTier:  (s2.multiTier  || []).slice(0, lim),
        },
      }, null, 2);
    }
    // Summary for both
    const s1 = results.segment1 || {};
    const s2 = results.segment2 || {};
    return JSON.stringify({
      scanTime: results.scanTime,
      segment1: { count: s1.count, topWallets: (s1.wallets || []).slice(0, lim) },
      segment2: {
        stats:      s2.stats,
        top5ByPnl:  (s2.top5ByPnl  || []).slice(0, lim),
        tierS:      (s2.tierS      || []).slice(0, lim),
        tier1:      (s2.tier1      || []).slice(0, lim),
        tier2:      (s2.tier2      || []).slice(0, lim),
        tier3:      (s2.tier3      || []).slice(0, lim),
        multiTier:  (s2.multiTier  || []).slice(0, lim),
      },
    }, null, 2);
  }
  throw new Error(`Unknown tool: ${name}`);
}

// ── MCP JSON-RPC handler ───────────────────────────────────────────────────────
async function handleMCP(body) {
  const { method, params, id } = body;

  if (method === 'initialize') {
    return { jsonrpc: '2.0', id, result: {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'mcp-polymarket', version: '1.0.0' },
    }};
  }
  if (method === 'notifications/initialized') {
    return null; // notification, no response
  }
  if (method === 'tools/list') {
    return { jsonrpc: '2.0', id, result: { tools: TOOLS } };
  }
  if (method === 'tools/call') {
    try {
      const text = await callTool(params.name, params.arguments || {});
      return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }] } };
    } catch (err) {
      return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true } };
    }
  }
  return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } };
}

// ── Express server ─────────────────────────────────────────────────────────────
const app = express();
app.use(express.json());

app.post('/mcp', async (req, res) => {
  try {
    const response = await handleMCP(req.body);
    if (response === null) return res.status(204).end();
    res.json(response);
  } catch (err) {
    res.status(500).json({ jsonrpc: '2.0', id: req.body.id, error: { code: -32000, message: err.message } });
  }
});

app.get('/health', (req, res) => res.json({ status: 'ok', time: new Date().toISOString() }));

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Polymarket MCP server running at http://0.0.0.0:${PORT}/mcp`);
});

process.on('uncaughtException', (err) => { console.error('Uncaught:', err); });
process.on('unhandledRejection', (err) => { console.error('Unhandled:', err); });
