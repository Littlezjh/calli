#!/usr/bin/env bash
# A throwaway hub for trying the UI by hand, open from a browser: the e2e harness's daemon
# (fake agents, own port, data dir and workdir; never the real hub), bound to every interface
# so another computer or a phone on the same network can open it.
#
#   scripts/demo.sh              build if needed, start, print the URL and token
#   scripts/demo.sh --no-build   start without checking the build
#   scripts/demo.sh stop         stop it and clean up its temp dirs
#
# It runs in the background and outlives this terminal; the log holds everything it printed.
# The token is the fixed e2e one and the agents are fakes, so nothing real is exposed.
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd -P)"
PIDFILE="${TMPDIR:-/tmp}/calli-demo.pid"
LOG="${TMPDIR:-/tmp}/calli-demo.log"

# The pidfile's process is still a demo instance, not a recycled PID.
mine() {
  local pid="$1"
  kill -0 "$pid" 2>/dev/null || return 1
  if [ -r "/proc/$pid/cmdline" ]; then
    tr '\0' ' ' < "/proc/$pid/cmdline" | grep -q dev-instance.mjs
  else
    [ ! -e /proc ]  # No /proc to look into (macOS); kill -0 is all we have.
  fi
}

running() {
  [ -f "$PIDFILE" ] || return 1
  local pid
  pid="$(cat "$PIDFILE" 2>/dev/null || true)"
  [ -n "$pid" ] && mine "$pid"
}

stop() {
  if running; then
    local pid
    pid="$(cat "$PIDFILE")"
    kill "$pid"
    for _ in $(seq 1 50); do
      kill -0 "$pid" 2>/dev/null || break
      sleep 0.2
    done
    rm -f "$PIDFILE"
    echo "Stopped $pid and cleaned up its temp dirs."
  else
    rm -f "$PIDFILE"
    echo "Not running."
  fi
}

case "${1:-}" in
  stop) stop; exit 0 ;;
esac

BUILD=1
for arg in "$@"; do
  case "$arg" in
    --no-build) BUILD=0 ;;
    *) echo "Unknown option: $arg" >&2; exit 2 ;;
  esac
done

if running; then
  echo "Already running: PID $(cat "$PIDFILE"), details in $LOG (stop with: scripts/demo.sh stop)"
  exit 0
fi
rm -f "$PIDFILE"

if [ "$BUILD" = 1 ]; then
  for artifact in daemon/dist/index.js web/dist/index.html; do
    if [ ! -f "$REPO/packages/$artifact" ]; then
      echo "Missing packages/$artifact; building."
      (cd "$REPO" && npm run build >/dev/null)
      break
    fi
  done
fi

echo "Starting the demo hub; the log is $LOG."
node "$REPO/packages/e2e/dev-instance.mjs" --host 0.0.0.0 >"$LOG" 2>&1 &
pid=$!
echo "$pid" > "$PIDFILE"

# Hold off on the URL until the smoke test inside has passed, or the process has died.
ok=0
for _ in $(seq 1 150); do
  if grep -q "Smoke test passed" "$LOG"; then ok=1; break; fi
  if ! kill -0 "$pid" 2>/dev/null; then break; fi
  sleep 0.4
done
if [ "$ok" != 1 ]; then
  rm -f "$PIDFILE"
  echo "The demo hub did not come up:" >&2
  cat "$LOG" >&2
  exit 1
fi
sed -n '/Smoke test passed/,$p' "$LOG"
echo "Stop it with: scripts/demo.sh stop"
