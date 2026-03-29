#!/bin/bash
# Run this from your LOCAL machine (not the VPS)
# Usage: bash remote-deploy.sh

set -e

VPS="165.245.189.200"
PASS="JTilton12369JT"
REMOTE_USER="root"
LOCAL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "=== Deploying Polymarket Scanner to $VPS ==="

# Check for sshpass
if ! command -v sshpass &>/dev/null; then
  echo "Installing sshpass..."
  if [[ "$OSTYPE" == "darwin"* ]]; then
    brew install sshpass 2>/dev/null || {
      echo "Please install sshpass: brew install sshpass"
      exit 1
    }
  else
    sudo apt-get install -y sshpass 2>/dev/null || sudo yum install -y sshpass 2>/dev/null
  fi
fi

SSH_OPTS="-o StrictHostKeyChecking=no -o ConnectTimeout=15"

echo "Pushing latest commits to git..."
cd "$LOCAL_DIR"
git push origin HEAD 2>/dev/null || echo "(git push skipped or already up to date)"

echo "Pulling latest on VPS and redeploying..."
sshpass -p "$PASS" ssh $SSH_OPTS "${REMOTE_USER}@${VPS}" \
  "cd /opt/polymarket-scanner && git fetch origin claude/polymarket-wallet-scanner-ofqu0 && git reset --hard origin/claude/polymarket-wallet-scanner-ofqu0 && bash deploy.sh"

echo ""
echo "===================================================="
echo "  Dashboard: http://${VPS}:3000"
echo "  Logs:      ssh root@${VPS} 'tail -f /var/log/polymarket-scanner.log'"
echo "===================================================="
