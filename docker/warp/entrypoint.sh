#!/bin/bash
# Starts WARP in proxy mode (only a local SOCKS5 port, no tunnel for the container's own traffic) and
# opens it to the network on port 1080. The registration lives on the volume, so a restart keeps it.
set -euo pipefail
WARP_PORT=40000

warp-svc --accept-tos &
svc=$!

i=0
until warp-cli --accept-tos status >/dev/null 2>&1; do
  i=$((i + 1))
  if [ "$i" -gt 60 ] || ! kill -0 "$svc" 2>/dev/null; then
    echo "warp-svc did not start" >&2
    exit 1
  fi
  sleep 1
done

# A free WARP registration, made once; the volume keeps it.
warp-cli --accept-tos registration show >/dev/null 2>&1 || warp-cli --accept-tos registration new
warp-cli --accept-tos mode proxy
warp-cli --accept-tos proxy port "$WARP_PORT"
warp-cli --accept-tos connect

socat "TCP-LISTEN:1080,fork,reuseaddr" "TCP:127.0.0.1:$WARP_PORT" &
fwd=$!

# Either one ending ends the container, so Docker starts both again.
wait -n "$svc" "$fwd"
exit 1
