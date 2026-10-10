#!/usr/bin/env bash
# Runs the daemon as a systemd user service: it starts at boot (with lingering enabled), restarts
# if it stops, and gets your login shell's environment, where agent API keys usually live.
#
#   scripts/install-service.sh [path/to/.env]     install or update, then (re)start
#   scripts/install-service.sh --remove           stop and remove
#
# The .env defaults to ~/.config/remote-agent-hub/.env. Logs: journalctl --user -u remote-agent-hub -f
set -euo pipefail

NAME=remote-agent-hub
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
UNIT="$UNIT_DIR/$NAME.service"

if [ "${1:-}" = "--remove" ]; then
  systemctl --user disable --now "$NAME" 2>/dev/null || true
  rm -f "$UNIT"
  systemctl --user daemon-reload
  echo "Removed $UNIT"
  exit 0
fi

REPO="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="$(realpath "${1:-$HOME/.config/remote-agent-hub/.env}")"
[ -f "$ENV_FILE" ] || { echo "No such .env: $ENV_FILE" >&2; exit 1; }
[ -d "$REPO/packages/daemon/dist" ] || { echo "Build first: (cd $REPO && npm install && npm run build)" >&2; exit 1; }
SHELL_BIN="${SHELL:-/bin/bash}"

mkdir -p "$UNIT_DIR"
cat > "$UNIT" <<UNIT
[Unit]
Description=Remote Agent Hub
After=network-online.target
Wants=network-online.target
# Keep retrying: at boot the VPN address the daemon binds to may not exist yet.
StartLimitIntervalSec=0

[Service]
Type=simple
WorkingDirectory=$REPO
Environment=RAH_ENV_FILE=$ENV_FILE
# An interactive login shell, so the agents get the API keys and PATH set in your shell profile.
ExecStart=$SHELL_BIN -lic 'exec npm start -w @rah/daemon'
Restart=always
RestartSec=5
# The daemon cancels running turns on SIGTERM; give it a moment to do so.
TimeoutStopSec=10

[Install]
WantedBy=default.target
UNIT

systemctl --user daemon-reload
systemctl --user enable "$NAME" >/dev/null
systemctl --user restart "$NAME"
echo "Installed $UNIT and started it."
PORT="$(sed -n 's/^RAH_PORT=//p' "$ENV_FILE" | tail -1)"
PORT="${PORT:-8787}"
OTHER="$(ss -ltnp 2>/dev/null | grep ":$PORT " | sed -nE 's/.*pid=([0-9]+).*/\1/p' | head -1)"
if [ -n "$OTHER" ] && [ "$OTHER" != "$(systemctl --user show -p MainPID --value "$NAME")" ]; then
  echo "Port $PORT is held by another process (PID $OTHER), probably a daemon you started by hand."
  echo "Stop it (kill $OTHER); the service retries every 5 seconds and takes over."
fi
if [ "$(loginctl show-user "$USER" -p Linger --value 2>/dev/null)" != "yes" ]; then
  echo "To start it at boot without logging in, run once: loginctl enable-linger $USER"
fi
echo "Status: systemctl --user status $NAME    Logs: journalctl --user -u $NAME -f"
