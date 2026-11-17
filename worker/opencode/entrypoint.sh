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
PROMPT="Build the approved spec below as a small static web page. The directory ./bundle/ already exists. Create every file in it with the write tool, never the edit tool, using relative paths only: an index.html plus the .css and .js files it needs. Link them with a link element (rel stylesheet) and a script element with a src attribute and nothing between its tags. Put all behavior in the .js file with addEventListener, never in inline script or on-attributes. The page is checked by a strict validator and thrown away if it breaks the rules below, even if it works. HTML elements allowed: html head meta title style body main header footer section article div span p h1 h2 h3 h4 h5 h6 ul ol li dl dt dd table thead tbody tfoot tr th td strong em b i small br hr code pre blockquote figure figcaption, plus these controls: textarea input button label select option canvas. Never use form, fieldset, legend, a, img, svg, video, iframe or any other element. Attributes allowed on any element: class id style lang charset name content colspan rowspan scope. Extra attributes allowed only on controls: type value placeholder rows cols maxlength for disabled checked min max step width height. Never use aria-, data-, title, alt, role, href or src (except on the script and link elements for your own files). No attribute value may contain a colon, an ampersand or a backslash. Use no URL anywhere and no double slash in any file, so no slash-slash comments. Never use fetch, XMLHttpRequest, WebSocket, eval, new Function, import(, document.cookie or window.open. Saving in localStorage is fine. Do not write outside ./bundle/. Stop when the files exist. Approved spec (JSON): $SPEC"
opencode run -m "sss/$MODEL" "$PROMPT" || true
node /manifest.mjs
