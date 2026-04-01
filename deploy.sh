#!/bin/bash
# Full VPS setup / redeploy script
# Run on the VPS: bash deploy.sh
set -e

APP_DIR="/opt/polymarket-scanner"
LOG_FILE="/var/log/polymarket-scanner.log"
REPO="https://github.com/justintilts333/poly.git"
BRANCH="claude/polymarket-wallet-scanner-ofqu0"
export HEISENBERG_API_KEY="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ0b2tlbl90eXBlIjoiYWNjZXNzIiwiZXhwIjoxNzgwMjM1MjMxLCJpYXQiOjE3NzUwNTEyMzEsImp0aSI6IjFmNDNkYjc4NmM4NzRmMTVhYzZhYzI5ODRhNDE3MjdmIiwidXNlcl9pZCI6MTI4OSwic2NvcGUiOiJsYXVuY2hwYWQ6YWdlbnQtcmVhZCxyZXRyaWV2ZXI6ZWNoby1nZW5lcmF0aW9uLHJldHJpZXZlcjpmZWF0dXJlLWV4dHJhY3Rpb24sdXNlcjpyZWFkLHJldHJpZXZlcjphZ2VudC1vcHRpb24tcmV0cmlldmFsLGxhdW5jaHBhZDphZ2VudC1jcmVhdGlvbixsYXVuY2hwYWQ6YWdlbnQtdXBkYXRlLHVzZXI6d3JpdGUscmV0cmlldmVyOnNlbWFudGljLXJldHJpZXZhbCxsYXVuY2hwYWQ6ZWNoby1zdHlsZS1jcmVhdGlvbiIsInRva2VuX25hbWUiOiJiYXNlX2xvZ2luIn0.6ZURe-6vlkdzBuGbJrnyx_0GcCbejaGZfcvmTzoMJrw"

echo "=== Polymarket Scanner — First-Time VPS Setup ==="

# --- Node.js 20 ---
if ! command -v node &>/dev/null || [[ $(node -v | cut -c2- | cut -d. -f1) -lt 18 ]]; then
  echo "Installing Node.js 20..."
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi
echo "Node: $(node -v) | npm: $(npm -v)"

# --- git ---
if ! command -v git &>/dev/null; then
  apt-get install -y git
fi

# --- PM2 ---
if ! command -v pm2 &>/dev/null; then
  echo "Installing PM2..."
  npm install -g pm2
fi

# --- Log file ---
touch "$LOG_FILE"
chmod 644 "$LOG_FILE"

# --- Clone or pull repo ---
if [ -d "$APP_DIR/.git" ]; then
  echo "Repo already cloned — pulling latest..."
  cd "$APP_DIR"
  git fetch origin "$BRANCH"
  git reset --hard "origin/$BRANCH"
else
  echo "Cloning repo..."
  git clone --branch "$BRANCH" "$REPO" "$APP_DIR"
  cd "$APP_DIR"
fi

mkdir -p "$APP_DIR/data"

# --- Write env file ---
cat > "$APP_DIR/.env.sh" <<ENVEOF
export HEISENBERG_API_KEY="$HEISENBERG_API_KEY"
ENVEOF
chmod 600 "$APP_DIR/.env.sh"
echo "Env file written to $APP_DIR/.env.sh"

# --- npm install ---
cd "$APP_DIR"
npm install --production
cd "$APP_DIR/mcp-polymarket"
npm install --production 2>/dev/null || true
cd "$APP_DIR"

# --- PM2: dashboard (port 3000) ---
pm2 stop polymarket-scanner 2>/dev/null || true
pm2 delete polymarket-scanner 2>/dev/null || true
pm2 start server.js --name polymarket-scanner --restart-delay=3000 --max-restarts=10
echo "Dashboard started on port 3000"

# --- PM2: MCP server (port 3001) ---
pm2 stop mcp-polymarket 2>/dev/null || true
pm2 delete mcp-polymarket 2>/dev/null || true
HEISENBERG_API_KEY="$HEISENBERG_API_KEY" pm2 start mcp-polymarket/server.js \
  --name mcp-polymarket \
  --restart-delay=3000 --max-restarts=10 \
  --env HEISENBERG_API_KEY="$HEISENBERG_API_KEY"
echo "MCP server started on port 3001"

pm2 save
pm2 startup systemd -u root --hp /root 2>/dev/null | grep "^sudo\|^systemctl" | bash || true

# --- Cron job (daily scanner at 08:00 UTC) ---
CRON_JOB="0 8 * * * . $APP_DIR/.env.sh && cd $APP_DIR && /usr/bin/node scanner.js >> $LOG_FILE 2>&1"
(crontab -l 2>/dev/null | grep -v 'polymarket\|scanner.js'; echo "$CRON_JOB") | crontab -
echo "Cron job set: daily at 08:00 UTC"

# --- Firewall ---
if command -v ufw &>/dev/null; then
  ufw allow 3000/tcp 2>/dev/null || true
fi

# --- Kill any stale scanner processes before starting fresh ---
pkill -f "node.*scanner.js" 2>/dev/null || true
rm -f /tmp/polymarket-scanner.lock
sleep 1

# --- Run initial scan in background ---
echo ""
echo "Starting initial wallet scan in background..."
nohup node "$APP_DIR/scanner.js" >> "$LOG_FILE" 2>&1 &
echo "Scanner PID: $!"

echo ""
echo "====================================================="
echo "  Dashboard:  http://$(curl -s ifconfig.me 2>/dev/null || echo '165.245.189.200'):3000"
echo "  PM2 status: pm2 status"
echo "  Logs:       tail -f $LOG_FILE"
echo "====================================================="
echo "Results will appear once the scan completes (~30-60 min)"
