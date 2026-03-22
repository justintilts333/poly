#!/bin/bash
# Restart scanner + web server. Runs everything in background and exits immediately
# so the calling SSH session can close cleanly.
APP_DIR=/opt/polymarket-scanner
LOG=/var/log/polymarket-scanner.log

echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] Deploy triggered" >> "$LOG"

(
  # Kill existing scanner
  pkill -KILL -f "node.*scanner.js" 2>/dev/null || true
  rm -f /tmp/polymarket-scanner.lock

  # Start scanner (fully detached)
  nohup node "$APP_DIR/scanner.js" </dev/null >> "$LOG" 2>&1 &
  echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] Scanner launched (PID $!)" >> "$LOG"

  # Restart web server
  if pm2 list 2>/dev/null | grep -q polymarket-scanner; then
    pm2 restart polymarket-scanner 2>/dev/null || true
  else
    pm2 start "$APP_DIR/server.js" --name polymarket-scanner \
      --restart-delay=3000 --max-restarts=10 2>/dev/null || true
  fi
  pm2 save 2>/dev/null || true

  echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] Deploy complete" >> "$LOG"
) </dev/null >>"$LOG" 2>&1 &

echo "restart_pid=$!"
exit 0
