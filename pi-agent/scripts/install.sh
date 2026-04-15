#!/usr/bin/env bash
# Install the timedox-agent as a systemd service on a Raspberry Pi.
#
# Run this on the Pi, AFTER copying the agent code to /home/admin/timedox-agent
# and filling in /home/admin/timedox-agent/.env with the branch-specific values.
#
# Typical deployment flow from the Mac:
#   rsync -av --exclude node_modules --exclude state.json \
#     gan-halomot/pi-agent/ admin@gan-pi-1.local:/home/admin/timedox-agent/
#   ssh admin@gan-pi-1.local "cd timedox-agent && npm ci --omit=dev && bash scripts/install.sh"

set -euo pipefail

AGENT_DIR="/home/admin/timedox-agent"
SERVICE_SRC="$AGENT_DIR/systemd/timedox-agent.service"
SERVICE_DST="/etc/systemd/system/timedox-agent.service"

echo "==> Checking prerequisites"
if [ ! -d "$AGENT_DIR" ]; then
  echo "ERROR: $AGENT_DIR does not exist. Copy the agent code there first." >&2
  exit 1
fi
if [ ! -f "$AGENT_DIR/.env" ]; then
  echo "ERROR: $AGENT_DIR/.env is missing. Copy .env.example and fill it in." >&2
  exit 1
fi
if [ ! -f "$SERVICE_SRC" ]; then
  echo "ERROR: systemd unit not found at $SERVICE_SRC" >&2
  exit 1
fi
if ! command -v node >/dev/null 2>&1; then
  echo "ERROR: node is not installed. Install Node.js 18+ first." >&2
  exit 1
fi

echo "==> Node version: $(node --version)"

echo "==> Installing npm dependencies"
cd "$AGENT_DIR"
npm ci --omit=dev || npm install --omit=dev

echo "==> Running one-shot smoke test (node agent.js --once)"
if node agent.js --once; then
  echo "    smoke test passed"
else
  echo "    smoke test FAILED — review the output above before continuing." >&2
  exit 1
fi

echo "==> Installing systemd unit"
sudo cp "$SERVICE_SRC" "$SERVICE_DST"
sudo systemctl daemon-reload
sudo systemctl enable timedox-agent.service
sudo systemctl restart timedox-agent.service

echo "==> Service status:"
sudo systemctl status timedox-agent.service --no-pager || true

cat <<EOF

Done. Useful commands:
  sudo systemctl status  timedox-agent
  sudo systemctl restart timedox-agent
  sudo journalctl -u timedox-agent -f       # live logs
  sudo journalctl -u timedox-agent --since "10 min ago"
EOF
