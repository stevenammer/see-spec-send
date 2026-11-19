#!/bin/sh
# Read the current quick-tunnel address, save it, print it.
#   tunnel-url.sh [--quiet] [--set-origin ENVFILE]
# Writes ./tunnel-url.txt (override with SSS_URL_FILE). With --set-origin it also rewrites the SSS_ORIGIN= line in
# ENVFILE (normally demo.env) and exits 10 if that changed the value (0 if already current, 1 if no address found).
# Source order: cloudflared's metrics endpoint /quicktunnel (read from inside the shared namespace through the app
# image, because the cloudflared image has no shell or curl), then the last https://<words>.trycloudflare.com log line.
# Only a strict <words>.trycloudflare.com hostname is ever accepted, so nothing else can reach demo.env.
# Test hook: SSS_TUNNEL_SOURCE_CMD replaces the metrics step (a shell command that prints a hostname or URL).
set -u
cd "$(dirname "$0")" || exit 1
OUT="${SSS_URL_FILE:-./tunnel-url.txt}"
QUIET=0; ENVF=""
while [ $# -gt 0 ]; do
  case "$1" in
    --quiet) QUIET=1 ;;
    --set-origin) [ $# -ge 2 ] || { echo "usage: tunnel-url.sh [--quiet] [--set-origin ENVFILE]" >&2; exit 2; }; ENVF="$2"; shift ;;
    *) echo "usage: tunnel-url.sh [--quiet] [--set-origin ENVFILE]" >&2; exit 2 ;;
  esac
  shift
done
CF="docker compose -f compose.quicktunnel.yaml"

normalize() { tail -n 1 | sed 's#^https://##; s#[[:space:]]*$##; s#/*$##' | tr 'A-Z' 'a-z'; }
valid() {
  case "$1" in api.trycloudflare.com|'') return 1 ;; esac
  printf '%s' "$1" | grep -Eq '^[a-z0-9]([a-z0-9-]*[a-z0-9])?\.trycloudflare\.com$'
}
from_metrics() {
  if [ -n "${SSS_TUNNEL_SOURCE_CMD:-}" ]; then sh -c "$SSS_TUNNEL_SOURCE_CMD" 2>/dev/null; return; fi
  id=$($CF ps -q netns 2>/dev/null | head -n 1)
  [ -n "$id" ] || return 0
  docker run --rm --network "container:$id" --read-only --cap-drop ALL --security-opt no-new-privileges \
    --user 1000:1000 --entrypoint node sss-demo:local \
    -e "fetch('http://127.0.0.1:20241/quicktunnel').then(r=>r.json()).then(j=>console.log(String(j.hostname||''))).catch(()=>{})" 2>/dev/null
}
from_logs() {
  [ -z "${SSS_TUNNEL_SOURCE_CMD:-}" ] || return 0
  $CF logs --no-color cloudflared 2>/dev/null \
    | grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com([^a-z0-9.-]|$)' | sed 's#[^a-z0-9]*$##'
}

host=$(from_metrics | normalize)
valid "$host" || host=$(from_logs | normalize)
valid "$host" || { echo "tunnel-url: no quick-tunnel address found (is cloudflared up? see 'docker compose -f compose.quicktunnel.yaml logs cloudflared')" >&2; exit 1; }
url="https://$host"

tmp=$(mktemp "$OUT.XXXXXX") || exit 1
printf '%s\n' "$url" > "$tmp" && chmod 644 "$tmp" && mv "$tmp" "$OUT" || exit 1
[ "$QUIET" = 1 ] || printf '%s\n' "$url"

if [ -n "$ENVF" ]; then
  cur=$(grep '^SSS_ORIGIN=' "$ENVF" 2>/dev/null | tail -n 1 | cut -d= -f2-)
  [ "$cur" = "$url" ] && exit 0
  tmp=$(mktemp "$ENVF.XXXXXX") || exit 1
  { grep -v '^SSS_ORIGIN=' "$ENVF" 2>/dev/null; printf 'SSS_ORIGIN=%s\n' "$url"; } > "$tmp" && mv "$tmp" "$ENVF" || exit 1
  exit 10
fi
exit 0
