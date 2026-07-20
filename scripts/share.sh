#!/usr/bin/env bash
# Expose the read-only server on :8787 through a disposable public tunnel.
#
#   bash scripts/share.sh            # localtunnel, fixed name (default)
#   bash scripts/share.sh pinggy     # pinggy, much faster, rotating name
#
# Neither provider is good. Measured on this machine:
#
#                throughput   session      name
#   localtunnel   ~1 Mbps     ~4 min       fixed, if the subdomain is free
#   pinggy        ~29 Mbps    60 min       rotates on every reconnect
#
# That is the whole trade: localtunnel keeps a link you have already sent
# working, pinggy makes songs load in ~1.4s instead of ~30s. localtunnel has
# also been seen returning 408 with an empty body while nominally connected.
#
# Both expose the host's public IP — localtunnel on its interstitial, pinggy
# inside the hostname. Cloudflare quick tunnels never routed from here at all;
# see CLAUDE.md before spending time on them again.

PROVIDER="${1:-localtunnel}"
PORT=8787

SUB=tap-tap-avihay
WANT="https://$SUB.loca.lt"
# The localtunnel server holds a subdomain for a while after a drop, and the
# client silently accepts a random one instead of failing. Retry rather than
# serve on a name nobody has — but never stay down for it forever.
MAX_TRIES=8

run_pinggy() {
  while true; do
    echo "[CONNECT $(date +%H:%M:%S)]"
    # -4 matters: over IPv6 pinggy builds the hostname from the full IPv6
    # address, which is unwieldier and more identifying than the IPv4 that is
    # exposed anyway.
    ssh -4 -p 443 \
      -o StrictHostKeyChecking=no \
      -o UserKnownHostsFile=/dev/null \
      -o ExitOnForwardFailure=yes \
      -o ServerAliveInterval=30 \
      -o ServerAliveCountMax=3 \
      -R "0:localhost:$PORT" a.pinggy.io 2>&1 |
      while IFS= read -r line; do
        case "$line" in
          https://*pinggy*) echo "[URL $(date +%H:%M:%S) $line]" ;;
        esac
      done
    echo "[DOWN $(date +%H:%M:%S)]"
    sleep 5
  done
}

run_localtunnel() {
  local attempt=0
  while true; do
    local log
    log=$(mktemp)

    # Past MAX_TRIES, stop asking for the subdomain — asking and being refused
    # is precisely what keeps us offline.
    if [ "$attempt" -lt "$MAX_TRIES" ]; then
      npx --yes localtunnel --port "$PORT" --subdomain "$SUB" > "$log" 2>&1 &
    else
      npx --yes localtunnel --port "$PORT" > "$log" 2>&1 &
    fi
    local pid=$!

    local url=""
    for _ in $(seq 1 25); do
      url=$(grep -oE "https://[a-z0-9-]+\.loca\.lt" "$log" 2>/dev/null | head -1)
      [ -n "$url" ] && break
      kill -0 "$pid" 2>/dev/null || break
      sleep 1
    done

    if [ -z "$url" ]; then
      echo "[FAIL $(date +%H:%M:%S) no url]"
      kill "$pid" 2>/dev/null
      wait "$pid" 2>/dev/null
      attempt=$((attempt + 1))
    elif [ "$url" = "$WANT" ]; then
      echo "[UP $(date +%H:%M:%S) $url]"
      attempt=0
      wait "$pid"
      echo "[DOWN $(date +%H:%M:%S)]"
    elif [ "$attempt" -ge "$MAX_TRIES" ]; then
      echo "[UP-FALLBACK $(date +%H:%M:%S) $url  <-- fixed name unavailable, share THIS]"
      attempt=0
      wait "$pid"
      echo "[DOWN $(date +%H:%M:%S)]"
    else
      echo "[RETRY $(date +%H:%M:%S) wanted $WANT, got $url]"
      kill "$pid" 2>/dev/null
      wait "$pid" 2>/dev/null
      attempt=$((attempt + 1))
    fi

    rm -f "$log"
    sleep 5
  done
}

case "$PROVIDER" in
  pinggy) run_pinggy ;;
  localtunnel) run_localtunnel ;;
  *) echo "unknown provider: $PROVIDER (use localtunnel or pinggy)" >&2; exit 1 ;;
esac
