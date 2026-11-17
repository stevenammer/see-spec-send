#!/bin/sh
# Runs inside the locked container: no network except the gateway socket, no provider key.
set -eu
export HOME=/tmp/home XDG_CACHE_HOME=/tmp/cache XDG_CONFIG_HOME=/tmp/config XDG_DATA_HOME=/tmp/data XDG_STATE_HOME=/tmp/state
export DISABLE_AUTOUPDATER=1 DISABLE_TELEMETRY=1 DISABLE_ERROR_REPORTING=1 DISABLE_BUG_COMMAND=1 CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 CLAUDE_CODE_DISABLE_TERMINAL_TITLE=1
mkdir -p "$HOME" "$XDG_CACHE_HOME" "$XDG_CONFIG_HOME" "$XDG_DATA_HOME" "$XDG_STATE_HOME"
cd /work
git init -q . 2>/dev/null || true
node /forward.mjs &
# The host writes the model name (the label the gateway prices) into this file, the same one the OpenCode profile reads.
MODEL=$(node -e "const c=JSON.parse(require('fs').readFileSync('/work/opencode.json','utf8'));console.log(Object.keys(c.provider.sss.models)[0])")
export ANTHROPIC_BASE_URL=http://127.0.0.1:8787 ANTHROPIC_API_KEY="$SSS_GATEWAY_TOKEN"
export ANTHROPIC_MODEL="$MODEL" ANTHROPIC_SMALL_FAST_MODEL="$MODEL" ANTHROPIC_DEFAULT_HAIKU_MODEL="$MODEL" ANTHROPIC_DEFAULT_SONNET_MODEL="$MODEL" ANTHROPIC_DEFAULT_OPUS_MODEL="$MODEL"
SPEC=$(cat /work/PROMPT.txt)
PROMPT="Build the approved spec below as a small static web page. The directory ./bundle/ already exists. Create every file in it with the write tool, never the edit tool, using relative paths only: an index.html plus the .css and .js files it needs. Link them with a link element (rel stylesheet) and a script element with a src attribute and nothing between its tags. Put all behavior in the .js file with addEventListener, never in inline script or on-attributes. The page is checked by a strict validator and thrown away if it breaks the rules below, even if it works. HTML elements allowed: html head meta title style body main header footer section article div span p h1 h2 h3 h4 h5 h6 ul ol li dl dt dd table thead tbody tfoot tr th td strong em b i small br hr code pre blockquote figure figcaption, plus these controls and structure: textarea input button label select option canvas form fieldset legend. A form may have no action, method or target attribute, so never rely on it submitting: handle button clicks in the .js file. Never use a, img, svg, video, iframe or any other element. Attributes allowed on any element: class id style lang charset name content colspan rowspan scope. Extra attributes allowed only on controls: type value placeholder rows cols maxlength for disabled checked min max step width height. Never use aria-, data-, title, alt, role, href or src (except on the script and link elements for your own files). No attribute value may contain a colon, an ampersand or a backslash. Use no URL anywhere and no double slash in any file, so no slash-slash comments. Never use fetch, XMLHttpRequest, WebSocket, eval, new Function, import(, document.cookie or window.open. Saving in localStorage is fine. Do not write outside ./bundle/. Stop when the files exist. Approved spec (JSON): $SPEC"
# A second pass after the host refused the first attempt: say why, and ask for an in-place fix.
if [ -s /work/REPAIR.txt ]; then
  PROMPT="Your earlier files in ./bundle/ were refused by the validator. Reason: $(cat /work/REPAIR.txt). Fix the files in ./bundle/ so they follow every rule below, using the write tool to rewrite any file that needs it, then stop. $PROMPT"
fi
claude -p "$PROMPT" --allowedTools Write Edit MultiEdit Read Glob Grep --disallowedTools Bash WebFetch WebSearch Task --permission-mode acceptEdits --no-session-persistence --output-format text || true
node /manifest.mjs
