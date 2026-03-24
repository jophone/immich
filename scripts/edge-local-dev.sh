#!/usr/bin/env bash
# Edge device local development startup — disables CLIP, enables face/OCR/classification + lite search
set -Eeuo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
export IMMICH_CONFIG_FILE="${IMMICH_CONFIG_FILE:-$ROOT_DIR/docker/immich-edge.config.yml}"

exec "$ROOT_DIR/scripts/local-dev.sh" "$@"
