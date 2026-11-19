#!/bin/sh
# Control script for the hosted demo. Run it from anywhere; it works on this folder's compose.yaml.
#   demo.sh build                 build the image (add PLATFORM=linux/arm64 to cross-build; needs buildx)
#   demo.sh init                  first install only: create and seed the database
#   demo.sh up                    start app, worker and tunnel
#   demo.sh reset [--force]       daily reset (guards are in reset.js); stops the stack only if the guards pass
#   demo.sh invite NAME [leader]  one-time invite for a named reviewer, valid 24h (the daily reset deletes unredeemed ones)
#   demo.sh kill set|clear|status the kill switch (stops runs, refuses new spend)
#   demo.sh down                  stop everything (data volume kept)
#   demo.sh tool ARGS...          one-off `node ARGS` in the locked-down tools container
# Quick-tunnel mode (free path): put SSS_MODE=quicktunnel in demo.env. Then compose.quicktunnel.yaml is used, `up` starts
# the tunnel first and the app with the tunnel's address as its origin, `reset` leaves the tunnel running (so the
# address does not change), and these exist too:
#   demo.sh url                   print the current tunnel address (also saved to tunnel-url.txt)
#   demo.sh sync-origin           if the address changed, write it to demo.env and restart app+worker with it
# COMPOSE_EXTRA="-f compose.local.yaml" and SERVICES="app worker" are for the local rehearsal described in docs/HOSTED_DEMO.md.
set -u
cd "$(dirname "$0")" || exit 1
QT=0
[ -f demo.env ] && grep -q '^SSS_MODE=quicktunnel[[:space:]]*$' demo.env && QT=1
if [ "$QT" = 1 ]; then
  COMPOSE_EXTRA="${COMPOSE_EXTRA:--f compose.quicktunnel.yaml}"
  # Never stop the tunnel on reset: a restarted quick tunnel gets a new address and every sent link would break.
  RESET_SERVICES="${SERVICES:-app worker}"
  # Reset and sync-origin must not overlap.
  if [ -z "${SSS_DEMO_LOCKED:-}" ] && command -v flock >/dev/null 2>&1; then
    case "${1:-}" in up|reset|sync-origin) SSS_DEMO_LOCKED=1 exec flock .demo.lock "$PWD/$(basename "$0")" "$@" ;; esac
  fi
else
  RESET_SERVICES="${SERVICES:-}"
fi
C="docker compose ${COMPOSE_EXTRA:--f compose.yaml}"
[ -f demo.env ] && C="docker compose --env-file demo.env ${COMPOSE_EXTRA:--f compose.yaml}"
SERVICES="${SERVICES:-}"
tool() { $C run --rm --no-deps -T tools "$@"; }

# Quick tunnel: wait for the address, record it in demo.env, then (re)start app and worker. Compose recreates the
# app only when its command (the origin) changed. The tunnel container is never touched here.
qt_sync() {
  ./tunnel-url.sh --quiet --set-origin demo.env; rc=$?
  case $rc in
    0) return 0 ;;
    10) echo "tunnel address changed: $(cat tunnel-url.txt); restarting app with the new origin" >&2
        docker compose --env-file demo.env ${COMPOSE_EXTRA:--f compose.quicktunnel.yaml} up -d --no-deps app worker ;;
    *) return "$rc" ;;
  esac
}

case "${1:-}" in
  build)
    if [ -n "${PLATFORM:-}" ]; then docker buildx build --platform "$PLATFORM" --load -t sss-demo:local -f ../../Dockerfile ../..
    else $C build app; fi ;;
  init) tool deploy/hosted-demo/reset.js --init ;;
  up)
    if [ "$QT" = 1 ]; then
      $C up -d netns cloudflared || exit 1
      i=0; until ./tunnel-url.sh --quiet >/dev/null 2>&1; do
        i=$((i + 1)); [ "$i" -le 30 ] || { echo "no tunnel address after 60s; see: $C logs cloudflared" >&2; exit 1; }
        sleep 2
      done
      qt_sync || exit $?
      $C up -d app worker      # no-op when qt_sync already started them with the right origin
      echo "demo address: $(cat tunnel-url.txt)"
    else $C up -d $SERVICES; fi ;;
  down) $C down ;;
  url) [ "$QT" = 1 ] || { echo "not in quick-tunnel mode (SSS_MODE=quicktunnel in demo.env)" >&2; exit 2; }; ./tunnel-url.sh ;;
  sync-origin) [ "$QT" = 1 ] || { echo "not in quick-tunnel mode (SSS_MODE=quicktunnel in demo.env)" >&2; exit 2; }; qt_sync ;;
  tool) shift; tool "$@" ;;
  reset)
    shift
    # Guards first, with the app still up: a refusal costs no downtime.
    tool deploy/hosted-demo/reset.js --check "$@" || exit $?
    $C stop $RESET_SERVICES
    tool deploy/hosted-demo/reset.js "$@"; status=$?
    $C up -d $RESET_SERVICES                # always bring the stack back, whatever the reset said
    exit $status ;;
  invite)
    [ -n "${2:-}" ] || { echo "usage: demo.sh invite NAME [leader]" >&2; exit 2; }
    tool cli.js invite create --role "${3:-member}" --for "$2" --expires 24h ;;
  kill)
    case "${2:-}" in set|clear|status) tool cli.js kill "$2" ;; *) echo "usage: demo.sh kill set|clear|status" >&2; exit 2 ;; esac ;;
  *) sed -n '2,16p' "$0"; exit 2 ;;
esac
