#!/usr/bin/env bash
# hbook — start a fresh server on a port, run a command against it, tear down.
# Usage: scripts/run-with-server.sh <port> <command...>
set -u
PORT="${1:-3100}"
shift

cd "$(dirname "$0")/.."

# sandbox may preset a bogus DATABASE_URL (e.g. file:…) — force a sane default
case "${DATABASE_URL:-}" in
  postgresql://*|postgres://*) ;;
  *) export DATABASE_URL="postgresql://hbook:hbook@127.0.0.1:5433/hbook?connection_limit=10" ;;
esac
export HBOOK_SETUP_TOKEN="${HBOOK_SETUP_TOKEN:-e2e-setup-token-0123456789abcdef}"
export PORT
export RATE_LIMIT_MAX="${RATE_LIMIT_MAX:-1500}"
export AUTH_FAIL_LIMIT="${AUTH_FAIL_LIMIT:-30}"
export HBOOK_WEBHOOK_ALLOW_INSECURE_HTTP="${HBOOK_WEBHOOK_ALLOW_INSECURE_HTTP:-1}"
export HBOOK_WEBHOOK_ALLOW_PRIVATE_IPS="${HBOOK_WEBHOOK_ALLOW_PRIVATE_IPS:-1}"
export WEBHOOK_TICK_MS="${WEBHOOK_TICK_MS:-300}"
# stable dev encryption key for webhook secrets (set explicitly in production)
export HBOOK_WEBHOOK_ENC_KEY="${HBOOK_WEBHOOK_ENC_KEY:-dev-enc-key-0123456789abcdef}"
export NODE_ENV="${NODE_ENV:-development}"

node dist/server.js > "/tmp/hbook-server-$PORT.log" 2>&1 &
SERVER_PID=$!
trap 'kill -TERM $SERVER_PID 2>/dev/null; wait $SERVER_PID 2>/dev/null' EXIT

for i in $(seq 1 50); do
  if curl -sf -m 1 "http://127.0.0.1:$PORT/health" > /dev/null 2>&1; then
    break
  fi
  if ! kill -0 $SERVER_PID 2>/dev/null; then
    echo "[run-with-server] server died at startup:" >&2
    tail -20 "/tmp/hbook-server-$PORT.log" >&2
    exit 3
  fi
  sleep 0.3
done

"$@"
EXIT=$?
exit $EXIT
