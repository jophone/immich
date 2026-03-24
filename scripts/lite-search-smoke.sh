#!/usr/bin/env bash

set -Eeuo pipefail

API_URL="${IMMICH_API_URL:-http://127.0.0.1:2283/api}"
EMAIL="${IMMICH_SMOKE_EMAIL:-}"
PASSWORD="${IMMICH_SMOKE_PASSWORD:-}"
IMAGE_PATH="${IMMICH_SMOKE_IMAGE:-}"
QUERY="${IMMICH_SMOKE_QUERY:-}"
TIMEOUT_SECONDS="${IMMICH_SMOKE_TIMEOUT:-180}"
POLL_INTERVAL_SECONDS="${IMMICH_SMOKE_INTERVAL:-2}"

log() {
  printf '[lite-smoke] %s\n' "$*"
}

die() {
  printf '[lite-smoke] ERROR: %s\n' "$*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "Missing required command: $1"
}

usage() {
  cat <<'EOF'
Usage:
  bash scripts/lite-search-smoke.sh [options]

Options:
  --api-url URL        Immich API base URL (default: http://127.0.0.1:2283/api)
  --email EMAIL        Admin/user email (or set IMMICH_SMOKE_EMAIL)
  --password PASS      Password (or set IMMICH_SMOKE_PASSWORD)
  --image PATH         Local image path to upload
  --query TEXT         Query text for /search/lite (default: use top predicted category)
  --timeout SEC        Max seconds to wait for categories (default: 180)
  --interval SEC       Poll interval seconds (default: 2)
  -h, --help           Show this help

Examples:
  bash scripts/lite-search-smoke.sh \
    --email admin@immich.cloud \
    --password password

  bash scripts/lite-search-smoke.sh \
    --email 1714797574@qq.com \
    --password TempPass123 \
    --image /tmp/nature.jpg
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --api-url)
      API_URL="$2"
      shift 2
      ;;
    --email)
      EMAIL="$2"
      shift 2
      ;;
    --password)
      PASSWORD="$2"
      shift 2
      ;;
    --image)
      IMAGE_PATH="$2"
      shift 2
      ;;
    --query)
      QUERY="$2"
      shift 2
      ;;
    --timeout)
      TIMEOUT_SECONDS="$2"
      shift 2
      ;;
    --interval)
      POLL_INTERVAL_SECONDS="$2"
      shift 2
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      die "Unknown argument: $1"
      ;;
  esac
done

require_command curl
require_command node

[[ -n "$EMAIL" ]] || die 'Missing email. Use --email or IMMICH_SMOKE_EMAIL'
[[ -n "$PASSWORD" ]] || die 'Missing password. Use --password or IMMICH_SMOKE_PASSWORD'

if [[ -z "$IMAGE_PATH" ]]; then
  IMAGE_PATH="$(mktemp /tmp/immich-lite-smoke-image-XXXXXX.jpg)"
  log 'No --image provided; downloading a known public test image'
  curl -fsSL -o "$IMAGE_PATH" \
    'https://raw.githubusercontent.com/immich-app/test-assets/main/albums/nature/tanners_ridge.jpg' || \
    die 'Failed to download sample image. Provide --image /path/to/image.jpg'
fi

[[ -f "$IMAGE_PATH" ]] || die "Image not found: $IMAGE_PATH"

TMP_DIR="$(mktemp -d /tmp/immich-lite-smoke-XXXXXX)"
trap 'rm -rf "$TMP_DIR"' EXIT

LOGIN_JSON="$TMP_DIR/login.json"
UPLOAD_JSON="$TMP_DIR/upload.json"
CATEGORY_JSON="$TMP_DIR/categories.json"
SEARCH_JSON="$TMP_DIR/search.json"

log "Logging in as ${EMAIL}"
LOGIN_PAYLOAD="$(node -e 'const [email,password]=process.argv.slice(1); process.stdout.write(JSON.stringify({email,password}));' "$EMAIL" "$PASSWORD")"
curl -fsS -X POST "$API_URL/auth/login" \
  -H 'Content-Type: application/json' \
  -d "$LOGIN_PAYLOAD" >"$LOGIN_JSON" || die 'Login failed'

ACCESS_TOKEN="$(node -e 'const fs=require("fs"); const d=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); process.stdout.write(d.accessToken||"");' "$LOGIN_JSON")"
[[ -n "$ACCESS_TOKEN" ]] || die 'Login succeeded but accessToken is missing'

DEVICE_ASSET_ID="lite-smoke-$(date +%s)-$RANDOM"
log "Uploading image: $IMAGE_PATH"
curl -fsS -X POST "$API_URL/assets" \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H 'Accept: application/json' \
  -F "assetData=@$IMAGE_PATH" \
  -F "deviceAssetId=$DEVICE_ASSET_ID" \
  -F 'deviceId=edge-smoke' \
  -F 'fileCreatedAt=2025-01-01T00:00:00.000Z' \
  -F 'fileModifiedAt=2025-01-01T00:00:00.000Z' \
  -F 'isFavorite=false' \
  -F 'isArchived=false' \
  -F 'isVisible=true' \
  -F 'duration=0:00:00.000000' >"$UPLOAD_JSON" || die 'Upload failed'

IFS=$'\t' read -r ASSET_ID UPLOAD_STATUS < <(node -e '
const fs=require("fs");
const d=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
process.stdout.write(`${d.id||""}\t${d.status||""}\n`);
' "$UPLOAD_JSON")

[[ -n "$ASSET_ID" ]] || die 'Upload response did not include asset id'
log "Upload status: ${UPLOAD_STATUS:-unknown}, assetId: $ASSET_ID"

log 'Polling categories until classification finishes'
MAX_ATTEMPTS=$(( TIMEOUT_SECONDS / POLL_INTERVAL_SECONDS ))
(( MAX_ATTEMPTS > 0 )) || die '--timeout must be greater than --interval'

CATEGORY_COUNT=0
TOP_CATEGORY=''

for ((i = 1; i <= MAX_ATTEMPTS; i++)); do
  curl -fsS "$API_URL/categories/asset/$ASSET_ID" \
    -H "Authorization: Bearer $ACCESS_TOKEN" >"$CATEGORY_JSON" || true

  IFS=$'\t' read -r CATEGORY_COUNT TOP_CATEGORY < <(node -e '
const fs=require("fs");
let d=[];
try { d=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); } catch {}
const arr=Array.isArray(d)?d:[];
const top=arr[0]?.categoryName || "";
process.stdout.write(`${arr.length}\t${top}\n`);
' "$CATEGORY_JSON")

if (( CATEGORY_COUNT > 0 )); then
    log "Classification ready after ${i} attempts (categories=$CATEGORY_COUNT, top=$TOP_CATEGORY)"
    break
  fi

  if (( i % 5 == 0 )); then
    log "Waiting... attempt=$i/${MAX_ATTEMPTS}"
  fi
  sleep "$POLL_INTERVAL_SECONDS"
done

if (( CATEGORY_COUNT == 0 )); then
  die "No categories generated within ${TIMEOUT_SECONDS}s for asset ${ASSET_ID}"
fi

if [[ -z "$QUERY" ]]; then
  QUERY="$TOP_CATEGORY"
fi
[[ -n "$QUERY" ]] || die 'Query is empty; use --query explicitly'

SEARCH_PAYLOAD="$(node -e 'const [query]=process.argv.slice(1); process.stdout.write(JSON.stringify({query,size:20}));' "$QUERY")"
log "Searching /search/lite with query: $QUERY"
curl -fsS -X POST "$API_URL/search/lite" \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H 'Content-Type: application/json' \
  -d "$SEARCH_PAYLOAD" >"$SEARCH_JSON" || die 'Lite search request failed'

IFS=$'\t' read -r RESULT_COUNT TARGET_PRESENT TOP_ID < <(node -e '
const fs=require("fs");
const d=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
const assetId=process.argv[2];
const items=d?.assets?.items || [];
const ids=items.map((x) => x.id);
process.stdout.write(`${ids.length}\t${ids.includes(assetId)}\t${ids[0]||""}\n`);
' "$SEARCH_JSON" "$ASSET_ID")

log "Search returned ${RESULT_COUNT} results; top id: ${TOP_ID:-none}"

if [[ "$TARGET_PRESENT" != 'true' ]]; then
  die "Uploaded asset ${ASSET_ID} not found in lite search results for query '${QUERY}'"
fi

log 'PASS: lite-search smoke succeeded'
log "assetId=$ASSET_ID"
log "query=$QUERY"
