#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

COLIMA_PROFILE="${COLIMA_PROFILE:-aiarm}"
COLIMA_VM_TYPE="${COLIMA_VM_TYPE:-vz}"
COLIMA_CPU="${COLIMA_CPU:-4}"
COLIMA_MEMORY="${COLIMA_MEMORY:-8}"
COLIMA_DISK="${COLIMA_DISK:-50}"
DOCKER_CONTEXT_NAME="${DOCKER_CONTEXT_NAME:-colima-${COLIMA_PROFILE}}"
ENABLE_STATIC_PREVIEW="${ENABLE_STATIC_PREVIEW:-0}"
ENABLE_CODE_INTERPRETER="${ENABLE_CODE_INTERPRETER:-0}"
ENABLE_LOCAL_SEARCH="${ENABLE_LOCAL_SEARCH:-0}"
STACK_PROFILE="${STACK_PROFILE:-}"

log() {
  printf '%s %s\n' "$(date '+%Y-%m-%dT%H:%M:%S%z')" "$*"
}

require_bin() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "ERROR: required binary not found: $1" >&2
    exit 1
  fi
}

prepare_code_interpreter() {
  if [[ "${ENABLE_CODE_INTERPRETER}" != "1" ]]; then
    return
  fi

  require_bin git
  "${SCRIPT_DIR}/prepare_code_interpreter_image.sh"
}

prepare_local_search() {
  if [[ "${ENABLE_LOCAL_SEARCH}" != "1" ]]; then
    return
  fi

  require_bin git
  "${SCRIPT_DIR}/prepare_jina_reranker_image.sh"
}

apply_stack_profile() {
  if [[ -z "${STACK_PROFILE}" ]]; then
    return
  fi

  case "${STACK_PROFILE}" in
    local-only)
      ENABLE_STATIC_PREVIEW=0
      ENABLE_CODE_INTERPRETER=0
      ENABLE_LOCAL_SEARCH=0
      ;;
    local-code)
      ENABLE_STATIC_PREVIEW=0
      ENABLE_CODE_INTERPRETER=1
      ENABLE_LOCAL_SEARCH=0
      ;;
    local-search)
      ENABLE_STATIC_PREVIEW=0
      ENABLE_CODE_INTERPRETER=0
      ENABLE_LOCAL_SEARCH=1
      ;;
    local-search-code)
      ENABLE_STATIC_PREVIEW=0
      ENABLE_CODE_INTERPRETER=1
      ENABLE_LOCAL_SEARCH=1
      ;;
    full)
      ENABLE_STATIC_PREVIEW=1
      ENABLE_CODE_INTERPRETER=1
      ENABLE_LOCAL_SEARCH=1
      ;;
    *)
      echo "ERROR: unsupported STACK_PROFILE='${STACK_PROFILE}'" >&2
      echo "Valid profiles: local-only, local-code, local-search, local-search-code, full" >&2
      exit 1
      ;;
  esac
}

docker_compose() {
  if docker compose version >/dev/null 2>&1; then
    docker compose "$@"
    return
  fi

  if command -v docker-compose >/dev/null 2>&1; then
    docker-compose "$@"
    return
  fi

  echo "ERROR: neither 'docker compose' nor 'docker-compose' is available" >&2
  exit 1
}

start_colima() {
  local status
  status="$(colima status -p "${COLIMA_PROFILE}" 2>/dev/null || true)"

  if [[ -z "${status}" ]]; then
    log "Creating Colima profile '${COLIMA_PROFILE}'"
    colima start \
      -p "${COLIMA_PROFILE}" \
      --vm-type="${COLIMA_VM_TYPE}" \
      --cpu "${COLIMA_CPU}" \
      --memory "${COLIMA_MEMORY}" \
      --disk "${COLIMA_DISK}"
    return
  fi

  if [[ "${status}" == *"Running"* ]]; then
    log "Colima profile '${COLIMA_PROFILE}' already running"
    return
  fi

  log "Starting existing Colima profile '${COLIMA_PROFILE}'"
  colima start -p "${COLIMA_PROFILE}"
}

wait_for_docker() {
  local max_attempts=30
  local attempt=1

  while (( attempt <= max_attempts )); do
    if docker info >/dev/null 2>&1; then
      return
    fi
    sleep 2
    attempt=$((attempt + 1))
  done

  echo "ERROR: Docker daemon did not become ready in time" >&2
  exit 1
}

compose_up() {
  if [[ ! -f "${PROJECT_ROOT}/.env" ]]; then
    echo "ERROR: ${PROJECT_ROOT}/.env not found. Run: cp template_dot_env .env" >&2
    exit 1
  fi

  local -a compose_files
  compose_files=(-f docker-compose.yml -f compose.hardening.yml)
  if [[ "${ENABLE_STATIC_PREVIEW}" == "1" ]]; then
    compose_files+=(-f optional/static-preview/compose.yml)
  fi
  if [[ "${ENABLE_CODE_INTERPRETER}" == "1" ]]; then
    compose_files+=(-f optional/code-interpreter/compose.yml)
  fi
  if [[ "${ENABLE_LOCAL_SEARCH}" == "1" ]]; then
    compose_files+=(-f optional/local-search/compose.yml)
  fi

  (
    cd "${PROJECT_ROOT}"
    if [[ "${ENABLE_CODE_INTERPRETER}" == "1" || "${ENABLE_LOCAL_SEARCH}" == "1" ]]; then
      export DOCKER_BUILDKIT="${DOCKER_BUILDKIT:-1}"
      export COMPOSE_DOCKER_CLI_BUILD="${COMPOSE_DOCKER_CLI_BUILD:-1}"
    fi
    log "Starting Docker Compose services"
    docker_compose --env-file .env "${compose_files[@]}" up -d
    docker_compose --env-file .env "${compose_files[@]}" ps
  )
}

ensure_secret_permissions() {
  if [[ ! -f "${PROJECT_ROOT}/.env" ]]; then
    echo "ERROR: ${PROJECT_ROOT}/.env not found. Run: cp template_dot_env .env" >&2
    exit 1
  fi

  local -r secrets_dir="${PROJECT_ROOT}/secrets"
  local gcp_sa="${PROJECT_ROOT}/secrets/gcp-sa.json"
  local env_file="${PROJECT_ROOT}/.env"

  read_env_var() {
    local key="$1"
    awk -F= -v k="${key}" '$1 == k { sub(/^[^=]*=/, ""); print; exit }' "${env_file}"
  }

  mkdir -p "${secrets_dir}"

  local mongo_root_user mongo_root_password mongo_app_user mongo_app_password
  mongo_root_user="$(read_env_var MONGO_ROOT_USER)"
  mongo_root_password="$(read_env_var MONGO_ROOT_PASSWORD)"
  mongo_app_user="$(read_env_var MONGO_APP_USER)"
  mongo_app_password="$(read_env_var MONGO_APP_PASSWORD)"

  if [[ -z "${mongo_root_user}" || -z "${mongo_root_password}" || -z "${mongo_app_user}" || -z "${mongo_app_password}" ]]; then
    echo "ERROR: missing one or more Mongo credentials in .env (MONGO_ROOT_USER, MONGO_ROOT_PASSWORD, MONGO_APP_USER, MONGO_APP_PASSWORD)" >&2
    exit 1
  fi

  printf '%s' "${mongo_root_user}" > "${secrets_dir}/runtime-mongo-root-user.txt"
  printf '%s' "${mongo_root_password}" > "${secrets_dir}/runtime-mongo-root-password.txt"
  printf '%s' "${mongo_app_user}" > "${secrets_dir}/runtime-mongo-app-user.txt"
  printf '%s' "${mongo_app_password}" > "${secrets_dir}/runtime-mongo-app-password.txt"

  chmod 600 "${secrets_dir}/runtime-mongo-root-user.txt" \
            "${secrets_dir}/runtime-mongo-root-password.txt" \
            "${secrets_dir}/runtime-mongo-app-user.txt" \
            "${secrets_dir}/runtime-mongo-app-password.txt" || true

  if [[ -f "${gcp_sa}" ]]; then
    chmod 600 "${gcp_sa}" || true
  fi
}

main() {
  require_bin colima
  require_bin docker

  apply_stack_profile
  start_colima

  log "Switching Docker context to '${DOCKER_CONTEXT_NAME}'"
  docker context use "${DOCKER_CONTEXT_NAME}" >/dev/null

  log "Waiting for Docker daemon"
  wait_for_docker

  prepare_code_interpreter
  prepare_local_search
  ensure_secret_permissions

  log "Resolved stack profile: ${STACK_PROFILE:-manual-flags} (static_preview=${ENABLE_STATIC_PREVIEW}, code_interpreter=${ENABLE_CODE_INTERPRETER}, local_search=${ENABLE_LOCAL_SEARCH})"
  compose_up
  log "LibreChat stack is up"
}

main "$@"
