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

echo "Copying files to VPS..."
sshpass -p "$PASS" scp $SSH_OPTS -r \
  "$LOCAL_DIR/scanner.js" \
  "$LOCAL_DIR/server.js" \
  "$LOCAL_DIR/package.json" \
  "$LOCAL_DIR/deploy.sh" \
  "${REMOTE_USER}@${VPS}:/tmp/"

echo "Creating deploy bundle on VPS..."
sshpass -p "$PASS" ssh $SSH_OPTS "${REMOTE_USER}@${VPS}" \
  "mkdir -p /tmp/poly-deploy && mv /tmp/scanner.js /tmp/server.js /tmp/package.json /tmp/deploy.sh /tmp/poly-deploy/"

echo "Running deploy script on VPS..."
sshpass -p "$PASS" ssh $SSH_OPTS "${REMOTE_USER}@${VPS}" \
  "bash /tmp/poly-deploy/deploy.sh"

echo ""
echo "===================================================="
echo "  Dashboard: http://${VPS}:3000"
echo "  Logs:      ssh root@${VPS} 'tail -f /var/log/polymarket-scanner.log'"
echo "===================================================="
