#!/bin/sh
# Runs the install/crash/backup/restore drill in a throwaway container from the pinned node image.
# Usage: scripts/drill.sh   (needs docker; touches nothing outside the container and a temporary volume)
set -eu
cd "$(dirname "$0")/.."
IMAGE="$(cat worker/builder-image.digest)"
docker run --rm --user 1000:1000 -e DRILL_DATA=/tmp/drill -v "$PWD":/app:ro -w /app "$IMAGE" node scripts/drill.mjs
