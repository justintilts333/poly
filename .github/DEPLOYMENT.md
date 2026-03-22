# Deployment

Auto-deploy is configured via `.github/workflows/deploy.yml`.

Every push to `claude/polymarket-wallet-scanner-ofqu0` triggers:
1. SSH into VPS at 165.245.189.200
2. `git pull` latest code
3. `npm install --production`
4. `pm2 restart polymarket-scanner`
5. Health-check against `/health` endpoint

## Secrets configured
- `VPS_SSH_KEY` — ED25519 private key (claude-code)
- `VPS_HOST` — 165.245.189.200
- `VPS_USER` — root

## Manual first-time VPS setup
```bash
bash <(curl -fsSL https://raw.githubusercontent.com/justintilts333/poly/claude%2Fpolymarket-wallet-scanner-ofqu0/deploy.sh)
```
