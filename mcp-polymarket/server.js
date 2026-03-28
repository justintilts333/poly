#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import https from 'https';
import express from 'express';

const PORT = process.env.MCP_PORT || 3001;

const DATA_API        = 'https://data-api.polymarket.com';
const GAMMA_API       = 'https://gamma-api.polymarket.com';
const LEADERBOARD_API = 'https://leaderboard-api.polymarket.com';

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
    req.on('timeout', () => { req.destroy(); reject(new Error(`Timeout fetching ${url}`)); });
  });
}

function createMcpServer() {
  const server = new Server(
    { name: 'mcp-polymarket', version: '1.0.0' },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
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
        description: 'Fetch current positions for a wallet. Returns per-market positions with cashPnl, realizedPnl, avgPrice, curPrice, conditionId, outcomeIndex.',
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
        description: 'Fetch markets from Polymarket. Filter by active/closed, supports pagination.',
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
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    try {
      if (name === 'get_activity') {
        const { status, body } = await fetchJSON(
          `${DATA_API}/activity?user=${args.address}&limit=${args.limit ?? 20}&offset=${args.offset ?? 0}&sortBy=TIMESTAMP&ascending=false`
        );
        return { content: [{ type: 'text', text: JSON.stringify({ status, data: body }, null, 2) }] };

      } else if (name === 'get_positions') {
        const { status, body } = await fetchJSON(
          `${DATA_API}/positions?user=${args.address}&limit=${args.limit ?? 50}`
        );
        return { content: [{ type: 'text', text: JSON.stringify({ status, data: body }, null, 2) }] };

      } else if (name === 'get_markets') {
        const { status, body } = await fetchJSON(
          `${GAMMA_API}/markets?limit=${args.limit ?? 10}&offset=${args.offset ?? 0}&active=${args.active ?? true}&closed=${args.closed ?? false}`
        );
        return { content: [{ type: 'text', text: JSON.stringify({ status, data: body }, null, 2) }] };

      } else if (name === 'get_leaderboard') {
        const { status, body } = await fetchJSON(
          `${LEADERBOARD_API}/l/rankings?window=${args.window ?? '1w'}&limit=${args.limit ?? 10}&offset=${args.offset ?? 0}`
        );
        return { content: [{ type: 'text', text: JSON.stringify({ status, data: body }, null, 2) }] };

      } else if (name === 'get_logs') {
        const { execSync } = await import('child_process');
        const output = execSync(`tail -n ${args.lines ?? 100} /var/log/polymarket-scanner.log 2>/dev/null || echo "Log file not found"`, { encoding: 'utf8' });
        return { content: [{ type: 'text', text: output }] };

      } else if (name === 'trigger_scan') {
        const { spawn } = await import('child_process');
        const child = spawn('node', ['/opt/polymarket-scanner/scanner.js'], {
          detached: true, stdio: 'ignore',
        });
        child.unref();
        return { content: [{ type: 'text', text: `Scanner triggered. PID: ${child.pid}` }] };

      } else {
        throw new Error(`Unknown tool: ${name}`);
      }
    } catch (err) {
      return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
    }
  });

  return server;
}

// ── HTTP server using StreamableHTTP transport ─────────────────────────────────
const app = express();
app.use(express.json());

app.post('/mcp', async (req, res) => {
  const server = createMcpServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdHeader: 'mcp-session-id' });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

app.get('/health', (req, res) => res.json({ status: 'ok', time: new Date().toISOString() }));

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Polymarket MCP server (HTTP) running at http://0.0.0.0:${PORT}/mcp`);
});
