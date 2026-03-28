#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import https from 'https';

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
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

const server = new Server(
  { name: 'mcp-polymarket', version: '1.0.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'get_activity',
      description: 'Fetch trade activity for a wallet from Polymarket data-api. Returns BUY/SELL/REDEEM events with fields: type, side, timestamp, conditionId, outcomeIndex, price, usdcSize, size.',
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
      description: 'Fetch markets from Polymarket gamma-api. Filter by active/closed status, supports pagination.',
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
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    let url;

    if (name === 'get_activity') {
      const limit  = args.limit  ?? 20;
      const offset = args.offset ?? 0;
      url = `${DATA_API}/activity?user=${args.address}&limit=${limit}&offset=${offset}&sortBy=TIMESTAMP&ascending=false`;
    } else if (name === 'get_positions') {
      const limit = args.limit ?? 50;
      url = `${DATA_API}/positions?user=${args.address}&limit=${limit}`;
    } else if (name === 'get_markets') {
      const limit  = args.limit  ?? 10;
      const offset = args.offset ?? 0;
      const active = args.active ?? true;
      const closed = args.closed ?? false;
      url = `${GAMMA_API}/markets?limit=${limit}&offset=${offset}&active=${active}&closed=${closed}`;
    } else if (name === 'get_leaderboard') {
      const window = args.window ?? '1w';
      const limit  = args.limit  ?? 10;
      const offset = args.offset ?? 0;
      url = `${LEADERBOARD_API}/l/rankings?window=${window}&limit=${limit}&offset=${offset}`;
    } else {
      throw new Error(`Unknown tool: ${name}`);
    }

    const { status, body } = await fetchJSON(url);
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({ status, url, data: body }, null, 2),
      }],
    };
  } catch (err) {
    return {
      content: [{ type: 'text', text: `Error: ${err.message}` }],
      isError: true,
    };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
