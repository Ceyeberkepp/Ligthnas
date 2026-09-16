#!/usr/bin/env sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
PROJECT_DIR=$(dirname "$SCRIPT_DIR")

cd "$PROJECT_DIR"
export NAS_HOST="${NAS_HOST:-0.0.0.0}"
export NAS_PORT="${NAS_PORT:-3080}"
exec node src/server.mjs
