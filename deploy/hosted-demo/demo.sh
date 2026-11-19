#!/bin/sh
# Control script for the hosted demo. Run it from anywhere; it works on this folder's compose.yaml.
#   demo.sh build                 build the image (add PLATFORM=linux/arm64 to cross-build; needs buildx)
#   demo.sh init                  first install only: create and seed the database
#   demo.sh up                    start app, worker and tunnel
#   demo.sh reset [--force]       daily reset (guards are in reset.js); stops the stack only if the guards pass
#   demo.sh invite NAME [leader]  one-time invite for a named reviewer, valid 24h (the daily reset deletes unredeemed ones)
#   demo.sh kill set|clear|status the kill switch (stops runs, refuses new spend)
#   demo.sh down                  stop everything (data volume kept)
# COMPOSE_EXTRA="-f compose.local.yaml" and SERVICES="app worker" are for the local rehearsal described in docs/HOSTED_DEMO.md.
set -u
cd "$(dirname "$0")" || exit 1
C="docker compose ${COMPOSE_EXTRA:--f compose.yaml}"
[ -f demo.env ] && C="docker compose --env-file demo.env ${COMPOSE_EXTRA:--f compose.yaml}"
SERVICES="${SERVICES:-}"
tool() { $C run --rm --no-deps -T tools "$@"; }

case "${1:-}" in
  build)
    if [ -n "${PLATFORM:-}" ]; then docker buildx build --platform "$PLATFORM" --load -t sss-demo:local -f ../../Dockerfile ../..
    else $C build app; fi ;;
  init) tool deploy/hosted-demo/reset.js --init ;;
  up) $C up -d $SERVICES ;;
  down) $C down ;;
  reset)
    shift
    # Guards first, with the app still up: a refusal costs no downtime.
    tool deploy/hosted-demo/reset.js --check "$@" || exit $?
    $C stop $SERVICES
    tool deploy/hosted-demo/reset.js "$@"; status=$?
    $C up -d $SERVICES                      # always bring the stack back, whatever the reset said
    exit $status ;;
  invite)
    [ -n "${2:-}" ] || { echo "usage: demo.sh invite NAME [leader]" >&2; exit 2; }
    tool cli.js invite create --role "${3:-member}" --for "$2" --expires 24h ;;
  kill)
    case "${2:-}" in set|clear|status) tool cli.js kill "$2" ;; *) echo "usage: demo.sh kill set|clear|status" >&2; exit 2 ;; esac ;;
  *) sed -n '2,10p' "$0"; exit 2 ;;
esac
