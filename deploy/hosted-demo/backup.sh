#!/bin/sh
# Nightly backup of the demo database to a second directory, then prune. Uses the app's own backup command
# (SQLite VACUUM INTO: one consistent read transaction, safe while the app runs; verified; a manifest is written),
# never a raw file copy. Environment: SSS_BACKUP_DIR (host directory, default ./backups, must be owned by uid 1000),
# SSS_BACKUP_KEEP (copies to keep, default 7).
# Test hooks: SSS_BACKUP_TOOL replaces `./demo.sh tool`, SSS_BACKUP_CLI the cli path, SSS_BACKUP_MOUNT the directory as the tool sees it.
set -eu
cd "$(dirname "$0")"
DIR="${SSS_BACKUP_DIR:-./backups}"; KEEP="${SSS_BACKUP_KEEP:-7}"
MOUNT="${SSS_BACKUP_MOUNT:-/backup}"
TOOL="${SSS_BACKUP_TOOL:-./demo.sh tool}"; CLI="${SSS_BACKUP_CLI:-cli.js}"
case "$KEEP" in ''|*[!0-9]*|0) echo "SSS_BACKUP_KEEP must be a positive whole number" >&2; exit 2 ;; esac
mkdir -p "$DIR"
name="sss-$(date -u +%Y%m%dT%H%M%SZ).sqlite"
# shellcheck disable=SC2086
$TOOL "$CLI" backup --to "$MOUNT/$name"
# shellcheck disable=SC2086
$TOOL "$CLI" backup verify --from "$MOUNT/$name"
# shellcheck disable=SC2086
$TOOL "$CLI" backup prune --dir "$MOUNT" --keep "$KEEP"
