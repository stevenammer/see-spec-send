#!/bin/sh
# Nightly mutation run. Exports the newest pushed code to a throwaway directory (your working tree is never touched),
# runs the scoped mutants for the newest modules plus one rotating tenth of the long campaign, and writes a dated log.
# A lock stops two runs overlapping; everything runs at low priority so the machine stays usable.
#
#   Install:  cp scripts/nightly-mutants.sh ~/.local/bin/sss-nightly-mutants && chmod +x ~/.local/bin/sss-nightly-mutants
#   Cron:     30 2 * * * $HOME/.local/bin/sss-nightly-mutants
#   Where:    ~/.local/state/see-spec-send/mutation/  (YYYY-MM-DD.log, latest.txt, survivors.txt)
# Environment overrides: SSS_REPO (a git checkout to export from), SSS_MUTATION_STATE, SSS_MUTATION_SHARDS, SSS_NODE_BIN,
# and for a quick dry run SSS_MUTATION_NEW_ARGS / SSS_MUTATION_OLD_ARGS (extra arguments, for example `--only fork:`).
set -eu
STATE="${SSS_MUTATION_STATE:-$HOME/.local/state/see-spec-send/mutation}"
REPO="${SSS_REPO:-$HOME/worktrees/sss-release-20261115}"
SHARDS="${SSS_MUTATION_SHARDS:-10}"
NODE_BIN="${SSS_NODE_BIN:-$HOME/.nvm/versions/node/v22.23.4/bin}"
mkdir -p "$STATE"
exec 9>"$STATE/lock"
flock -n 9 || { echo "another mutation run is active"; exit 0; }
DAY="$(date +%Y-%m-%d)"; LOG="$STATE/$DAY.log"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
PATH="$NODE_BIN:$PATH"; export PATH
git -C "$REPO" fetch -q origin main
COMMIT="$(git -C "$REPO" rev-parse origin/main)"
git -C "$REPO" archive origin/main | tar -x -C "$TMP"
cd "$TMP"
K=$(( $(date +%j | sed 's/^0*//') % SHARDS ))
{
  echo "mutation run $DAY commit $COMMIT shard $K/$SHARDS node $(node -v)"
  echo "== scoped mutants (newest modules) =="
  nice -n 15 node scripts/mutate-new.mjs ${SSS_MUTATION_NEW_ARGS:-} || true
  echo "== long campaign, shard $K/$SHARDS =="
  nice -n 15 node scripts/mutate-check.mjs --shard "$K/$SHARDS" ${SSS_MUTATION_OLD_ARGS:-} || true
  echo "finished $(date +%H:%M:%S)"
} > "$LOG" 2>&1
SURV="$(grep -c '^SURVIVED' "$LOG" || true)"; KILL="$(grep -c '^KILLED' "$LOG" || true)"
echo "$DAY commit ${COMMIT%${COMMIT#????????}} shard $K/$SHARDS killed=$KILL survived=$SURV" > "$STATE/latest.txt"
grep '^SURVIVED' "$LOG" | sed "s/^/$DAY /" >> "$STATE/survivors.txt" || true
