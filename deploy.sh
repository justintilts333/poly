#!/bin/bash
set -e

APP_DIR="/opt/polymarket-scanner"
LOG_FILE="/var/log/polymarket-scanner.log"

echo "=== Polymarket Scanner Deployment ==="

# --- Node.js ---
if ! command -v node &>/dev/null || [[ $(node -v | cut -c2- | cut -d. -f1) -lt 18 ]]; then
  echo "Installing Node.js 20 LTS..."
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi
echo "Node: $(node -v) | npm: $(npm -v)"

# --- PM2 ---
if ! command -v pm2 &>/dev/null; then
  echo "Installing PM2..."
  npm install -g pm2
fi

# --- App directory ---
mkdir -p "$APP_DIR/data"
cp -r /tmp/poly-deploy/* "$APP_DIR/"

# --- Log file ---
touch "$LOG_FILE"
chmod 644 "$LOG_FILE"

# --- npm install ---
cd "$APP_DIR"
npm install --production

# --- PM2 ---
pm2 stop polymarket-scanner 2>/dev/null || true
pm2 delete polymarket-scanner 2>/dev/null || true
pm2 start server.js --name polymarket-scanner --restart-delay=3000 --max-restarts=10
pm2 save
pm2 startup systemd -u root --hp /root | tail -1 | bash || true

echo "Web server started on port 3000"

# --- Cron job ---
CRON_JOB="0 8 * * * cd $APP_DIR && /usr/bin/node scanner.js >> $LOG_FILE 2>&1"
(crontab -l 2>/dev/null | grep -v 'polymarket\|scanner.js'; echo "$CRON_JOB") | crontab -
echo "Cron job set: daily at 08:00 UTC"

# --- Firewall ---
if command -v ufw &>/dev/null; then
  ufw allow 3000/tcp || true
fi

# --- Run scanner immediately ---
echo "Running initial scan (this may take a while)..."
node scanner.js >> "$LOG_FILE" 2>&1 &
SCAN_PID=$!
echo "Scanner running in background (PID $SCAN_PID)"
echo "Tail logs: tail -f $LOG_FILE"
echo ""
echo "=== Dashboard will be available at http://165.245.189.200:3000 ==="
echo "=== (Results appear once the background scan completes) ==="
