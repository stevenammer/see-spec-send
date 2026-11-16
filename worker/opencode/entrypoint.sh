#!/bin/sh
# Runs inside the locked container: no network except the gateway socket, no provider key.
set -eu
export HOME=/tmp/home XDG_CACHE_HOME=/tmp/cache XDG_DATA_HOME=/tmp/data XDG_STATE_HOME=/tmp/state
export OPENCODE_DISABLE_AUTOUPDATE=1 OPENCODE_DISABLE_MODELS_FETCH=1
mkdir -p "$HOME" "$XDG_CACHE_HOME" "$XDG_DATA_HOME" "$XDG_STATE_HOME"
cd /work
git init -q . 2>/dev/null || true
node /forward.mjs &
MODEL=$(node -e "const c=JSON.parse(require('fs').readFileSync('/work/opencode.json','utf8'));console.log(Object.keys(c.provider.sss.models)[0])")
SPEC=$(cat /work/PROMPT.txt)
opencode run -m "sss/$MODEL" "Build the approved spec below as a small static web page. Write every file inside ./bundle/ using relative paths only. Use only .html, .css and .js files. Do not use any external URL, network request, or script from elsewhere. Do not write outside ./bundle/. Stop when the files exist. Approved spec (JSON): $SPEC" || true
node /manifest.mjs
