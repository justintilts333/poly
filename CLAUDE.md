# Polymarket Wallet Scanner — Claude Context

## What This Is
A tool that scans Polymarket wallets to find skilled traders making underdog bets
(entry price < $0.50) on short-resolution markets (resolves within 14 days).
Output is a tiered leaderboard of the best wallets to copy-trade.

## Architecture

```
Local CLI (you/me editing)
  → git push
  → GitHub Actions (.github/workflows/deploy.yml)
  → SSH into VPS
  → PM2 restarts scanner + dashboard
```

**VPS:** `165.245.189.200` (DigitalOcean)
**App dir on VPS:** `/opt/polymarket-scanner`
**Dashboard:** `http://165.245.189.200:3000`
**Logs:** `/var/log/polymarket-scanner.log`
**PM2 processes:** `polymarket-scanner` (dashboard), `polymarket-mcp` (ignore — unused now)

**Branch:** `claude/polymarket-wallet-scanner-ofqu0`
Always develop and push to this branch. Actions auto-deploys on push.

## MCP Tools (available in local CLI sessions)

### Polymarket (VPS proxy at `http://165.245.189.200:3001/mcp`)
- `get_activity(address, limit, offset)` — wallet trade history
- `get_positions(address, limit)` — wallet positions with cashPnl, realizedPnl
- `get_markets(limit, offset, active, closed)` — market listings
- `get_leaderboard(window, limit, offset)` — top traders (windows: all, 1m, 1w)
- `get_logs(lines)` — tail the VPS scanner log
- `trigger_scan()` — kick off a fresh scan on the VPS

### Heisenberg / Falcon API (`https://narrative.agent.heisenberg.so/sse`)
Agent-based API — one endpoint, switch data source by agent_id.
API key stored in `.env` as `FALCON_API_TOKEN`.
Key agents:
- **584** — Falcon Score Leaderboard (trader quality ranking, better than native leaderboard)
- **581** — Wallet 360 (60+ performance, behavior, and risk metrics per wallet)
- **556** — Polymarket Trades (historical trades by wallet)
- **569** — Polymarket PnL (realized PnL time series by wallet)
- **579** — Polymarket Leaderboard (official PnL leaderboard)

## Scanner Logic (scanner.js)

### Wallet Discovery (2 sources)
1. **Leaderboard** — top wallets across `all`, `1m`, `1w` windows
2. **Market holders** — holders of top 300 short-resolution markets by volume

### Per-Wallet Pipeline
1. **Bot filter** — skip if >2000 trades or suspiciously uniform trade sizes
2. **Activity filter** — last trade within 7 days AND 30 days
3. **Qualifying trades** — BUY only, price < $0.50, market resolves within 14 days
4. **Win detection** — `cashPnl > 0` or `realizedPnl > 0` from `/positions` API, fallback to REDEEM event
5. **Metrics** — win rate overall, 7d, 30d; PnL; avg return multiple
6. **Tier assignment** — based on resolved trade count and win rate (see below)
7. **Score** — weighted win rate + price ratio bonus

### Tier Thresholds
| Tier | Min resolved trades | Min win rate | Requirement |
|------|---------------------|--------------|-------------|
| 1    | 30+                 | 60%          | Positive PnL |
| 2    | 20+                 | 55%          | Positive PnL |
| 3    | 15+                 | 50%          | Positive PnL |

### Score Formula
`(winRate7d × 0.5) + (winRate30d × 0.3) + (winRateAll × 0.2) + priceRatioBonus`

Price ratio bonus: avg return multiple (1/entryPrice for wins) normalized to 0–0.15.
Buying at $0.10 and winning = 10x return = max bonus.

### Output
`data/results.json` — tier1, tier2, tier3, multiTier arrays sorted by score.
Dashboard at port 3000 reads this file on each page load.

## Key Files
- `scanner.js` — main scanner logic
- `server.js` — Express dashboard (port 3000) + `/api/logs` + `/api/scan/trigger`
- `mcp-polymarket/server.js` — MCP server (CommonJS, raw JSON-RPC, runs on VPS port 3001)
- `.mcp.json` — points Claude Code at the VPS MCP server
- `.github/workflows/deploy.yml` — auto-deploy on push to `claude/**` branches
- `deploy.sh` — first-time VPS setup script

## Deployment
Push to branch → Actions deploys automatically (~30s).
GitHub secrets required: `VPS_HOST`, `VPS_USER`, `VPS_SSH_KEY`.

## Current Status (as of last session)
Scanner logic fully matches spec. Key recent changes:
- Win detection uses `cashPnl`/`realizedPnl` from `/positions` API (not just REDEEM events)
- 30-day active wallet filter added
- Scoring uses entry price vs resolution price ratio (avg return multiple)
- MCP server deployed on VPS for live API access

## Next Up
1. **Revisit wallet sourcing** — current sources are leaderboard + market holders.
   Question: are we finding the right wallets? Are there better sources?
2. **Run a live scan** and validate results against real data via MCP tools
3. **Telegram notifications** — alert when scanner finds new top wallets

## Working Style
- I push code, Actions deploys to VPS
- Use `get_logs` to check scanner output after deploys
- Use `trigger_scan` to kick off fresh scans
- Always push to `claude/polymarket-wallet-scanner-ofqu0`
