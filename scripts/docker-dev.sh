#!/usr/bin/env bash

set -Eeuo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
DOCKER_DIR="$ROOT_DIR/docker"

COMPOSE_FILE="${IMMICH_DOCKER_COMPOSE_FILE:-$DOCKER_DIR/docker-compose.dev.yml}"
ENV_FILE="${IMMICH_DOCKER_ENV_FILE:-$DOCKER_DIR/.env}"
EXAMPLE_ENV_FILE="$DOCKER_DIR/example.env"
RUNTIME_OVERRIDE_FILE="$ROOT_DIR/.local-dev/docker-runtime.override.yml"

DOCKER_BUILDKIT="${IMMICH_DOCKER_BUILDKIT:-1}"
COMPOSE_BAKE_MODE="${IMMICH_DOCKER_COMPOSE_BAKE:-auto}"
DOCKER_RUNTIME_MODE="${IMMICH_DOCKER_RUNTIME:-auto}"

WAIT_FOR_READY="${IMMICH_DOCKER_WAIT:-1}"
WAIT_ATTEMPTS="${IMMICH_DOCKER_WAIT_ATTEMPTS:-360}"
AUTO_DOWN_LOCAL_DEV="${IMMICH_DOCKER_DOWN_LOCAL_DEV:-1}"
AUTO_STOP_HOST_POSTGRES="${IMMICH_DOCKER_STOP_HOST_POSTGRES:-1}"
AUTO_CLEAN_RUNNING_CONFLICTS="${IMMICH_DOCKER_CLEAN_RUNNING_CONFLICTS:-1}"

WEB_URL="http://127.0.0.1:3000"
API_PING_URL="http://127.0.0.1:2283/api/server/ping"
ML_PING_URL="http://127.0.0.1:3003/ping"

CONFLICT_NAMES=(
  immich_init
  immich_server
  immich_web
  immich_machine_learning
  immich_redis
  immich_postgres
)

RESOLVED_RUNTIME=''

log() {
  printf '[docker-dev] %s\n' "$*"
}

die() {
  printf '[docker-dev] ERROR: %s\n' "$*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "Missing required command: $1"
}

run_as_root() {
  if [[ ${EUID} -eq 0 ]]; then
    "$@"
    return
  fi

  if command -v sudo >/dev/null 2>&1; then
    sudo "$@"
    return
  fi

  die 'Root privileges are required for this step.'
}

ensure_prerequisites() {
  require_command docker
  require_command ss
  docker compose version >/dev/null 2>&1 || die 'Docker Compose plugin is not available.'
  docker info >/dev/null 2>&1 || die 'Docker daemon is not reachable.'
  [[ -f "$COMPOSE_FILE" ]] || die "Compose file not found: $COMPOSE_FILE"
  prepare_runtime_override
}

resolve_compose_bake() {
  case "$COMPOSE_BAKE_MODE" in
    true | false)
      printf '%s' "$COMPOSE_BAKE_MODE"
      ;;
    auto)
      if docker buildx version >/dev/null 2>&1; then
        printf 'true'
      else
        printf 'false'
      fi
      ;;
    *)
      die "IMMICH_DOCKER_COMPOSE_BAKE must be one of: auto, true, false"
      ;;
  esac
}

compose() {
  local compose_bake
  compose_bake="$(resolve_compose_bake)"

  local -a compose_files
  compose_files=(-f "$COMPOSE_FILE")
  if [[ -f "$RUNTIME_OVERRIDE_FILE" ]]; then
    compose_files+=(-f "$RUNTIME_OVERRIDE_FILE")
  fi

  COMPOSE_BAKE="$compose_bake" DOCKER_BUILDKIT="$DOCKER_BUILDKIT" docker compose "${compose_files[@]}" "$@"
}

resolve_runtime() {
  if [[ -n "$RESOLVED_RUNTIME" ]]; then
    printf '%s' "$RESOLVED_RUNTIME"
    return
  fi

  case "$DOCKER_RUNTIME_MODE" in
    runc | crun)
      RESOLVED_RUNTIME="$DOCKER_RUNTIME_MODE"
      ;;
    none)
      RESOLVED_RUNTIME=''
      ;;
    auto)
      local default_runtime
      default_runtime="$(docker info --format '{{.DefaultRuntime}}' 2>/dev/null || true)"

      if [[ "$default_runtime" == 'crun' ]]; then
        if docker run --rm --runtime=runc alpine:latest /bin/sh -lc 'true' >/dev/null 2>&1; then
          RESOLVED_RUNTIME='runc'
        else
          RESOLVED_RUNTIME=''
        fi
      else
        RESOLVED_RUNTIME=''
      fi
      ;;
    *)
      die "IMMICH_DOCKER_RUNTIME must be one of: auto, runc, crun, none"
      ;;
  esac

  printf '%s' "$RESOLVED_RUNTIME"
}

prepare_runtime_override() {
  local runtime
  runtime="$(resolve_runtime)"

  if [[ -z "$runtime" ]]; then
    rm -f "$RUNTIME_OVERRIDE_FILE"
    return
  fi

  mkdir -p "$(dirname "$RUNTIME_OVERRIDE_FILE")"

  cat >"$RUNTIME_OVERRIDE_FILE" <<EOF
services:
  immich-init:
    runtime: ${runtime}
  immich-server:
    runtime: ${runtime}
  immich-web:
    runtime: ${runtime}
  immich-machine-learning:
    runtime: ${runtime}
  redis:
    runtime: ${runtime}
  database:
    runtime: ${runtime}
EOF

  log "Using Docker runtime override: ${runtime}"
}

container_id_by_name() {
  local name="$1"
  docker ps -aq --filter "name=^${name}$" | head -n 1
}

container_state() {
  local id="$1"
  docker inspect -f '{{.State.Status}}' "$id" 2>/dev/null || true
}

cleanup_conflicts() {
  local remove_running="${1:-0}"
  local name=''

  for name in "${CONFLICT_NAMES[@]}"; do
    local id
    id="$(container_id_by_name "$name")"
    [[ -z "$id" ]] && continue

    local state
    state="$(container_state "$id")"

    if [[ "$state" == 'running' && "$remove_running" != '1' ]]; then
      continue
    fi

    log "Removing conflicting container ${name} (${state:-unknown})"
    docker rm -f "$id" >/dev/null
  done
}

running_conflicts() {
  local conflicts=()
  local name=''

  for name in "${CONFLICT_NAMES[@]}"; do
    local id
    id="$(container_id_by_name "$name")"
    [[ -z "$id" ]] && continue

    local state
    state="$(container_state "$id")"
    if [[ "$state" == 'running' ]]; then
      conflicts+=("$name")
    fi
  done

  printf '%s\n' "${conflicts[@]}"
}

ensure_no_running_conflicts() {
  local conflicts
  conflicts="$(running_conflicts | sed '/^$/d' || true)"
  if [[ -z "$conflicts" ]]; then
    return
  fi

  die "Found running containers that conflict with this stack: ${conflicts//$'\n'/, }. Run './scripts/docker-dev.sh cleanup-conflicts --all' first."
}

port_in_use() {
  local port="$1"
  ss -H -ltn "( sport = :${port} )" 2>/dev/null | grep -q .
}

listener_pids_for_port() {
  local port="$1"
  ss -H -ltnp "( sport = :${port} )" 2>/dev/null | grep -o 'pid=[0-9]\+' | cut -d= -f2 | sort -u
}

stop_port_listeners() {
  local port="$1"
  local pids=''

  pids="$(listener_pids_for_port "$port" || true)"
  [[ -z "$pids" ]] && return

  while IFS= read -r pid; do
    [[ -z "$pid" ]] && continue
    kill "$pid" 2>/dev/null || true
  done <<<"$pids"

  sleep 1

  pids="$(listener_pids_for_port "$port" || true)"
  [[ -z "$pids" ]] && return

  while IFS= read -r pid; do
    [[ -z "$pid" ]] && continue
    kill -9 "$pid" 2>/dev/null || true
  done <<<"$pids"
}

describe_port_conflict() {
  local port="$1"
  ss -ltnp "( sport = :${port} )" 2>/dev/null || true
}

stop_local_dev_if_needed() {
  if [[ "$AUTO_DOWN_LOCAL_DEV" != '1' ]]; then
    return
  fi

  local local_script="$ROOT_DIR/scripts/local-dev.sh"
  if [[ -x "$local_script" ]]; then
    log 'Stopping local non-Docker services to free web/api/ml ports'
    "$local_script" down >/dev/null 2>&1 || true
  fi
}

stop_host_postgres_if_needed() {
  if [[ "$AUTO_STOP_HOST_POSTGRES" != '1' ]]; then
    return
  fi

  if command -v systemctl >/dev/null 2>&1; then
    log 'Stopping host PostgreSQL service to free port 5432 for Docker'
    run_as_root systemctl stop postgresql >/dev/null 2>&1 || true
  fi

  if port_in_use 5432 && command -v service >/dev/null 2>&1; then
    run_as_root service postgresql stop >/dev/null 2>&1 || true
  fi

  if port_in_use 5432 && command -v pg_lsclusters >/dev/null 2>&1 && command -v pg_ctlcluster >/dev/null 2>&1; then
    while IFS= read -r line; do
      [[ -z "$line" ]] && continue
      local version
      local cluster
      local status
      version="$(awk '{print $1}' <<<"$line")"
      cluster="$(awk '{print $2}' <<<"$line")"
      status="$(awk '{print $4}' <<<"$line")"

      if [[ "$status" == 'online' ]]; then
        run_as_root pg_ctlcluster "$version" "$cluster" stop >/dev/null 2>&1 || true
      fi
    done < <(pg_lsclusters --no-header 2>/dev/null || true)
  fi

  if port_in_use 5432; then
    log 'PostgreSQL still listening on 5432; stopping listener PIDs'
    stop_port_listeners 5432
  fi
}

ensure_ports_available() {
  stop_local_dev_if_needed
  stop_host_postgres_if_needed

  local required_ports=(3000 2283 3003 5432)
  local port=''
  local conflicts=()

  for port in "${required_ports[@]}"; do
    if port_in_use "$port"; then
      conflicts+=("$port")
    fi
  done

  if [[ ${#conflicts[@]} -eq 0 ]]; then
    return
  fi

  local details=''
  for port in "${conflicts[@]}"; do
    details+=$'\n'
    details+="--- port ${port} ---"
    details+=$'\n'
    details+="$(describe_port_conflict "$port")"
  done

  die "Required host ports are in use: ${conflicts[*]}.${details}
Please stop those processes or set IMMICH_DOCKER_DOWN_LOCAL_DEV=1 / IMMICH_DOCKER_STOP_HOST_POSTGRES=1."
}

read_env_value() {
  local key="$1"
  awk -F'=' -v key="$key" '
    $0 !~ /^\s*#/ && $1 == key {
      val = substr($0, index($0, "=") + 1)
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", val)
      print val
      exit
    }
  ' "$ENV_FILE"
}

strip_quotes() {
  local value="$1"
  if [[ "$value" =~ ^\".*\"$ ]]; then
    value="${value:1:-1}"
  fi
  if [[ "$value" =~ ^\'.*\'$ ]]; then
    value="${value:1:-1}"
  fi
  printf '%s' "$value"
}

resolve_env_path() {
  local raw="$1"
  local value
  value="$(strip_quotes "$raw")"

  if [[ -z "$value" ]]; then
    return
  fi

  if [[ "$value" = /* ]]; then
    printf '%s' "$value"
    return
  fi

  value="${value#./}"
  printf '%s/%s' "$DOCKER_DIR" "$value"
}

ensure_env_file() {
  if [[ -f "$ENV_FILE" ]]; then
    return
  fi

  [[ -f "$EXAMPLE_ENV_FILE" ]] || die "Missing template env file: $EXAMPLE_ENV_FILE"
  cp "$EXAMPLE_ENV_FILE" "$ENV_FILE"
  log "Created $ENV_FILE from template"
}

ensure_volume_directories() {
  local upload_location
  local db_data_location
  local upload_path
  local db_path

  upload_location="$(read_env_value 'UPLOAD_LOCATION' || true)"
  db_data_location="$(read_env_value 'DB_DATA_LOCATION' || true)"

  upload_path="$(resolve_env_path "$upload_location")"
  db_path="$(resolve_env_path "$db_data_location")"

  if [[ -n "$upload_path" ]]; then
    mkdir -p "$upload_path"
  fi

  if [[ -n "$db_path" ]]; then
    mkdir -p "$db_path"
  fi

  if [[ -n "$upload_path" ]]; then
    mkdir -p "$upload_path/postgres"
  fi
}

wait_for_http() {
  local name="$1"
  local url="$2"
  local expected="$3"
  local attempts="$4"
  local response=''

  for ((i = 1; i <= attempts; i++)); do
    response="$(curl -fsS --max-time 5 "$url" 2>/dev/null || true)"
    if [[ -n "$response" && "$response" == *"$expected"* ]]; then
      log "${name} is ready (${url})"
      return 0
    fi
    sleep 1
  done

  log "${name} readiness check timed out (${url})"
  return 1
}

stack_status() {
  compose ps

  local web='down'
  local api='down'
  local ml='down'

  if curl -fsS --max-time 5 "$WEB_URL" >/dev/null 2>&1; then
    web='up'
  fi
  if curl -fsS --max-time 5 "$API_PING_URL" | grep -q 'pong' 2>/dev/null; then
    api='up'
  fi
  if curl -fsS --max-time 5 "$ML_PING_URL" | grep -q 'pong' 2>/dev/null; then
    ml='up'
  fi

  log "Web: ${web} (${WEB_URL})"
  log "API: ${api} (${API_PING_URL})"
  log "ML: ${ml} (${ML_PING_URL})"
}

up() {
  ensure_prerequisites
  ensure_env_file
  ensure_volume_directories
  cleanup_conflicts 0
  if [[ "$AUTO_CLEAN_RUNNING_CONFLICTS" == '1' ]]; then
    cleanup_conflicts 1
  fi
  ensure_no_running_conflicts
  ensure_ports_available

  log 'Starting Docker services (detached)'
  compose up -d --remove-orphans "$@"

  if [[ "$WAIT_FOR_READY" == '1' ]]; then
    wait_for_http 'Machine-learning' "$ML_PING_URL" 'pong' "$WAIT_ATTEMPTS" || true
    wait_for_http 'API' "$API_PING_URL" 'pong' "$WAIT_ATTEMPTS" || true
    wait_for_http 'Web' "$WEB_URL/api/server/ping" 'pong' "$WAIT_ATTEMPTS" || true
  fi

  stack_status
}

up_build() {
  ensure_prerequisites
  ensure_env_file
  ensure_volume_directories
  cleanup_conflicts 0
  if [[ "$AUTO_CLEAN_RUNNING_CONFLICTS" == '1' ]]; then
    cleanup_conflicts 1
  fi
  ensure_no_running_conflicts
  ensure_ports_available

  log 'Starting Docker services with rebuild (detached)'
  compose up -d --build -V --remove-orphans

  if [[ "$WAIT_FOR_READY" == '1' ]]; then
    wait_for_http 'Machine-learning' "$ML_PING_URL" 'pong' "$WAIT_ATTEMPTS" || true
    wait_for_http 'API' "$API_PING_URL" 'pong' "$WAIT_ATTEMPTS" || true
    wait_for_http 'Web' "$WEB_URL/api/server/ping" 'pong' "$WAIT_ATTEMPTS" || true
  fi

  stack_status
}

down() {
  ensure_prerequisites
  log 'Stopping Docker services'
  compose down --remove-orphans
}

restart() {
  down
  up
}

cleanup_conflicts_cmd() {
  ensure_prerequisites
  local remove_running='0'
  if [[ "${1:-}" == '--all' ]]; then
    remove_running='1'
  fi
  cleanup_conflicts "$remove_running"
  log 'Conflict cleanup complete.'
}

logs() {
  ensure_prerequisites
  local service="${1:-}"
  if [[ -n "$service" ]]; then
    compose logs -f "$service"
  else
    compose logs -f
  fi
}

usage() {
  cat <<EOF
Usage: ./scripts/docker-dev.sh [up|up-build|down|restart|status|logs [service]|cleanup-conflicts [--all]]

Commands:
  up         Start Docker dev stack in detached mode.
  up-build   Start Docker dev stack and force image rebuild.
  down       Stop Docker dev stack.
  restart    Restart Docker dev stack.
  status     Show compose/container and endpoint status.
  logs       Follow compose logs (optionally for one service).
  cleanup-conflicts         Remove stale conflicting containers.
  cleanup-conflicts --all   Remove all conflicting containers, including running ones.

Environment:
  IMMICH_DOCKER_COMPOSE_FILE   Compose file path (default: docker/docker-compose.dev.yml)
  IMMICH_DOCKER_ENV_FILE       Env file path (default: docker/.env)
  IMMICH_DOCKER_BUILDKIT       BuildKit toggle (default: 1)
  IMMICH_DOCKER_COMPOSE_BAKE   auto|true|false (default: auto)
  IMMICH_DOCKER_RUNTIME        auto|runc|crun|none (default: auto)
  IMMICH_DOCKER_WAIT           Wait for readiness: 1|0 (default: 1)
  IMMICH_DOCKER_WAIT_ATTEMPTS  Readiness wait loops (default: 360)
  IMMICH_DOCKER_DOWN_LOCAL_DEV Auto-stop local-dev services before Docker up: 1|0 (default: 1)
  IMMICH_DOCKER_STOP_HOST_POSTGRES Auto-stop host postgresql service before Docker up: 1|0 (default: 1)
  IMMICH_DOCKER_CLEAN_RUNNING_CONFLICTS Auto-remove running conflicting immich_* containers: 1|0 (default: 1)
EOF
}

case "${1:-up}" in
  up)
    up
    ;;
  up-build)
    up_build
    ;;
  down)
    down
    ;;
  restart)
    restart
    ;;
  status)
    ensure_prerequisites
    stack_status
    ;;
  logs)
    shift
    logs "$@"
    ;;
  cleanup-conflicts)
    shift
    cleanup_conflicts_cmd "$@"
    ;;
  -h | --help | help)
    usage
    ;;
  *)
    usage
    exit 1
    ;;
esac
