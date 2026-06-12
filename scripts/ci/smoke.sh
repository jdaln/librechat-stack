#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "${ROOT_DIR}"

INGRESS_URL="${INGRESS_URL:-http://127.0.0.1:3081}"
ARTIFACTS_DIR="${CI_ARTIFACTS_DIR:-ci_artifacts}"
SMOKE_CLEAN_VOLUMES="${SMOKE_CLEAN_VOLUMES:-0}"
SMOKE_LOCK_DIR="${SMOKE_LOCK_DIR:-/tmp/librechat-stack-smoke.lock}"
LOCK_HELD=0
# Overall budget for the run. Individual waits are generous, but their sum must
# stay inside the CI job timeout with room for the cleanup trap to collect
# diagnostics - a run that GitHub kills uploads no artifacts at all.
SMOKE_TOTAL_DEADLINE="${SMOKE_TOTAL_DEADLINE:-2100}"

deadline_check() {
  if (( SECONDS > SMOKE_TOTAL_DEADLINE )); then
    echo "Smoke run exceeded SMOKE_TOTAL_DEADLINE (${SMOKE_TOTAL_DEADLINE}s); failing fast so diagnostics can be collected" >&2
    return 1
  fi
  return 0
}

compose_files=(
  -f docker-compose.yml
  -f compose.hardening.yml
  -f optional/code-interpreter/compose.yml
  -f optional/local-search/compose.yml
  -f optional/static-preview/compose.yml
)

stack_container_names=(
  LibreChat
  api-proxy
  caddy-static-proxy
  chat-meilisearch
  chat-mongodb
  code-interpreter-api
  code-interpreter-minio
  code-interpreter-minio-init
  code-interpreter-proxy
  code-interpreter-redis
  egress-proxy
  firecrawl-api
  firecrawl-playwright
  firecrawl-postgres
  firecrawl-rabbitmq
  firecrawl-redis
  jina-reranker
  mongo-init
  rag_api
  sandpack-bundler
  sandpack-static
  searxng
  searxng-auth-proxy
  searxng-valkey
  vectordb
)

stack_network_names=(
  librechat-stack_api_frontend
  librechat-stack_code_gateway
  librechat-stack_code_interpreter
  librechat-stack_ingress
  librechat-stack_lan
  librechat-stack_sandpack_frontend
  librechat-stack_search
  librechat-stack_search_egress
  librechat-stack_search_gateway
  librechat-stack_searx_internal
  librechat-stack_static_preview_net
  librechat-stack_wan
)

read_env_var() {
  local key="$1"
  awk -F= -v k="${key}" '
    $1 == k {
      sub(/^[^=]*=/, "");
      sub(/[[:space:]]+#.*$/, "");
      gsub(/^[[:space:]]+|[[:space:]]+$/, "");
      print;
      exit;
    }
  ' "${ROOT_DIR}/.env"
}

prepare_runtime_secrets() {
  local env_file="${ROOT_DIR}/.env"
  local secrets_dir="${ROOT_DIR}/secrets"

  if [[ ! -f "${env_file}" ]]; then
    echo "Missing ${env_file}" >&2
    exit 1
  fi

  mkdir -p "${secrets_dir}"
  chmod u+w "${secrets_dir}"/runtime-mongo-*.txt 2>/dev/null || true
  printf '%s' "$(read_env_var MONGO_ROOT_USER)" > "${secrets_dir}/runtime-mongo-root-user.txt"
  printf '%s' "$(read_env_var MONGO_ROOT_PASSWORD)" > "${secrets_dir}/runtime-mongo-root-password.txt"
  printf '%s' "$(read_env_var MONGO_APP_USER)" > "${secrets_dir}/runtime-mongo-app-user.txt"
  printf '%s' "$(read_env_var MONGO_APP_PASSWORD)" > "${secrets_dir}/runtime-mongo-app-password.txt"
  # Containers never read these host-side files: populate_stack_secrets_volume.sh
  # docker-cp's them into the secrets volume and chmods the in-volume copies for
  # the in-container users. Owner-only is enough (and safer) on the host.
  chmod 400 "${secrets_dir}/runtime-mongo-root-user.txt" \
            "${secrets_dir}/runtime-mongo-root-password.txt" \
            "${secrets_dir}/runtime-mongo-app-user.txt" \
            "${secrets_dir}/runtime-mongo-app-password.txt" || true
}

prepare_code_interpreter_image() {
  local image git_url git_ref
  image="$(read_env_var CODE_INTERPRETER_IMAGE)"
  image="${image:-librecodeinterpreter:170194f}"

  if docker image inspect "${image}" >/dev/null 2>&1; then
    log "Code interpreter image already present: ${image}"
    return
  fi

  # Remote images are pulled by Compose. Local tags need the helper build.
  if [[ "${image}" == */* ]]; then
    log "Code interpreter image will be pulled by Compose: ${image}"
    return
  fi

  git_url="$(read_env_var CODE_INTERPRETER_GIT_URL)"
  git_ref="$(read_env_var CODE_INTERPRETER_GIT_REF)"
  log "Preparing local code interpreter image: ${image}"
  CODE_INTERPRETER_IMAGE="${image}" \
    CODE_INTERPRETER_GIT_URL="${git_url:-https://github.com/usnavy13/LibreCodeInterpreter.git}" \
    CODE_INTERPRETER_GIT_REF="${git_ref:-170194fa8e2f5bfb396b76e35d12ce88597a7c47}" \
    ./scripts/prepare_code_interpreter_image.sh
}

prepare_static_preview_image() {
  log "Preparing static preview image"
  compose \
    --env-file .env \
    -f docker-compose.yml \
    -f compose.hardening.yml \
    -f optional/static-preview/compose.yml \
    build static_preview
}

prepare_jina_reranker_runtime_image() {
  log "Preparing Jina reranker runtime image"
  compose \
    --env-file .env \
    -f docker-compose.yml \
    -f compose.hardening.yml \
    -f optional/local-search/compose.yml \
    build jina-reranker
}

compose() {
  if docker compose version >/dev/null 2>&1; then
    docker compose "$@"
  else
    docker-compose "$@"
  fi
}

run_with_timeout() {
  local timeout_seconds="$1"
  shift

  python3 -c '
import subprocess
import sys

timeout = float(sys.argv[1])
args = sys.argv[2:]

try:
    completed = subprocess.run(args, timeout=timeout)
except subprocess.TimeoutExpired:
    sys.exit(124)

sys.exit(completed.returncode)
' "${timeout_seconds}" "$@"
}

start_container() {
  local container="$1"
  local attempts="${SMOKE_DOCKER_START_ATTEMPTS:-4}"
  local delay="${SMOKE_DOCKER_START_RETRY_DELAY:-15}"
  local i rc

  for ((i = 1; i <= attempts; i++)); do
    if run_with_timeout "${SMOKE_DOCKER_START_TIMEOUT:-300}" docker start "${container}"; then
      return 0
    else
      rc="$?"
    fi

    if docker inspect "${container}" --format '{{.State.Running}}' 2>/dev/null | grep -qx true; then
      return 0
    fi

    if ((i < attempts)); then
      log "docker start ${container} failed on attempt ${i}/${attempts}; retrying in ${delay}s"
      sleep "${delay}"
    fi
  done

  return "${rc}"
}

compose_with_optional_timeout() {
  local timeout_seconds="$1"
  shift

  if docker compose version >/dev/null 2>&1; then
    run_with_timeout "${timeout_seconds}" docker compose "$@"
  else
    run_with_timeout "${timeout_seconds}" docker-compose "$@"
  fi
}

compose_with_retry() {
  local timeout_seconds="$1"
  shift
  local attempts="${SMOKE_COMPOSE_ATTEMPTS:-3}"
  local delay="${SMOKE_COMPOSE_RETRY_DELAY:-20}"
  local i rc

  for ((i = 1; i <= attempts; i++)); do
    if compose_with_optional_timeout "${timeout_seconds}" "$@"; then
      return 0
    else
      rc="$?"
    fi

    if ((i < attempts)); then
      log "compose command failed on attempt ${i}/${attempts}; retrying in ${delay}s"
      sleep "${delay}"
    fi
  done

  return "${rc}"
}

log() {
  printf '%s %s\n' "$(date '+%Y-%m-%dT%H:%M:%S%z')" "$*"
}

acquire_lock() {
  if mkdir "${SMOKE_LOCK_DIR}" 2>/dev/null; then
    printf '%s' "$$" >"${SMOKE_LOCK_DIR}/pid"
    LOCK_HELD=1
    return
  fi

  # A SIGKILL/reboot can leave the lock behind; treat it as stale when the
  # recorded holder is no longer running.
  local holder
  holder="$(cat "${SMOKE_LOCK_DIR}/pid" 2>/dev/null || true)"
  if [[ -n "${holder}" ]] && kill -0 "${holder}" 2>/dev/null; then
    echo "Another smoke run is already active (pid ${holder}, ${SMOKE_LOCK_DIR}); refusing to race the same compose project." >&2
    exit 75
  fi

  echo "Removing stale smoke lock ${SMOKE_LOCK_DIR} (holder ${holder:-unknown} is not running)" >&2
  rm -rf "${SMOKE_LOCK_DIR}"
  if ! mkdir "${SMOKE_LOCK_DIR}" 2>/dev/null; then
    echo "Failed to acquire smoke lock after clearing a stale one (${SMOKE_LOCK_DIR})" >&2
    exit 75
  fi
  printf '%s' "$$" >"${SMOKE_LOCK_DIR}/pid"
  LOCK_HELD=1
}

release_lock() {
  if [[ "${LOCK_HELD}" == "1" ]]; then
    rm -rf "${SMOKE_LOCK_DIR}" 2>/dev/null || true
    LOCK_HELD=0
  fi
}

compose_down() {
  local -a down_args
  down_args=(
    --env-file .env
    "${compose_files[@]}"
    down
    --remove-orphans
  )
  if [[ "${SMOKE_CLEAN_VOLUMES}" == "1" ]]; then
    down_args+=(-v)
  fi
  compose_with_optional_timeout "${SMOKE_COMPOSE_DOWN_TIMEOUT:-240}" "${down_args[@]}"
}

force_remove_stack_resources() {
  docker rm -f "${stack_container_names[@]}" >/dev/null 2>&1 || true

  local network
  for network in "${stack_network_names[@]}"; do
    docker network rm "${network}" >/dev/null 2>&1 || true
  done
}

wait_stack_resources_removed() {
  local attempts="${1:-60}"
  local containers networks found i name

  for ((i = 1; i <= attempts; i++)); do
    containers="$(docker ps -a --format '{{.Names}}' 2>/dev/null || true)"
    networks="$(docker network ls --format '{{.Name}}' 2>/dev/null || true)"
    found=""

    for name in "${stack_container_names[@]}"; do
      if grep -qxF "${name}" <<<"${containers}"; then
        found+="${name} "
      fi
    done
    for name in "${stack_network_names[@]}"; do
      if grep -qxF "${name}" <<<"${networks}"; then
        found+="${name} "
      fi
    done

    if [[ -z "${found}" ]]; then
      return 0
    fi

    sleep 2
  done

  echo "Timed out waiting for stack resources to be removed: ${found}" >&2
  return 1
}

wait_http() {
  local url="$1"
  local attempts="${2:-300}"
  local container_path static_path i

  for ((i = 1; i <= attempts; i++)); do
    deadline_check || return 1
    if run_with_timeout "${SMOKE_HTTP_PROBE_TIMEOUT:-20}" curl -fsS "$url" >/dev/null 2>&1; then
      return 0
    fi
    container_path="${url#"${INGRESS_URL}"}"
    if [[ "${container_path}" != "${url}" ]] && run_with_timeout "${SMOKE_HTTP_PROBE_TIMEOUT:-20}" docker exec api-proxy curl -fsS "http://127.0.0.1${container_path}" >/dev/null 2>&1; then
      return 0
    fi
    static_path="${url#http://127.0.0.1:4324}"
    if [[ "${static_path}" != "${url}" ]]; then
      static_path="${static_path:-/}"
      if run_with_timeout "${SMOKE_HTTP_PROBE_TIMEOUT:-20}" docker exec caddy-static-proxy wget -qO- -T "${SMOKE_HTTP_PROBE_TIMEOUT:-20}" "http://127.0.0.1${static_path}" >/dev/null 2>&1; then
        return 0
      fi
    fi
    sleep 2
  done

  echo "Timed out waiting for ${url}" >&2
  return 1
}

http_url_origin() {
  local url="$1"
  local rest authority

  if [[ "${url}" != http://* ]]; then
    echo "Only http:// internal URLs are supported: ${url}" >&2
    return 1
  fi

  rest="${url#http://}"
  authority="${rest%%/*}"
  printf 'http://%s\n' "${authority}"
}

wait_internal_http() {
  local url="$1"
  local attempts="${2:-60}"
  local probe_timeout="${SMOKE_INTERNAL_HTTP_PROBE_TIMEOUT:-90}"
  local i

  if [[ "${url}" != http://* ]]; then
    echo "Only http:// internal URLs are supported: ${url}" >&2
    return 1
  fi

  for ((i = 1; i <= attempts; i++)); do
    deadline_check || return 1
    if run_with_timeout "${probe_timeout}" docker exec \
      -e HTTP_PROXY= \
      -e HTTPS_PROXY= \
      -e http_proxy= \
      -e https_proxy= \
      LibreChat curl -fsS --max-time "${probe_timeout}" "${url}" >/dev/null; then
      return 0
    fi
    sleep 2
  done

  echo "Timed out waiting for internal ${url}" >&2
  return 1
}

wait_container_success() {
  local container="$1"
  local attempts="${2:-120}"
  local i status exit_code

  for ((i = 1; i <= attempts; i++)); do
    deadline_check || return 1
    if read -r status exit_code < <(docker inspect "${container}" --format '{{.State.Status}} {{.State.ExitCode}}' 2>/dev/null); then
      if [[ "${status}" == "exited" ]]; then
        if [[ "${exit_code}" == "0" ]]; then
          return 0
        fi
        run_with_timeout "${SMOKE_DOCKER_LOG_TIMEOUT:-45}" docker logs "${container}" >&2 || true
        echo "${container} exited with ${exit_code}" >&2
        return 1
      fi
      if [[ "${status}" == "dead" ]]; then
        run_with_timeout "${SMOKE_DOCKER_LOG_TIMEOUT:-45}" docker logs "${container}" >&2 || true
        echo "${container} is dead" >&2
        return 1
      fi
    fi
    sleep 2
  done

  run_with_timeout "${SMOKE_DOCKER_LOG_TIMEOUT:-45}" docker logs "${container}" >&2 || true
  echo "Timed out waiting for ${container} to exit successfully" >&2
  return 1
}

wait_container_healthy() {
  local container="$1"
  local attempts="${2:-120}"
  local i status exit_code restarts health

  for ((i = 1; i <= attempts; i++)); do
    deadline_check || return 1
    if read -r status exit_code restarts health < <(docker inspect "${container}" --format '{{.State.Status}} {{.State.ExitCode}} {{.RestartCount}} {{if .State.Health}}{{.State.Health.Status}}{{end}}' 2>/dev/null); then
      if [[ "${health}" == "healthy" ]]; then
        return 0
      fi
      # Fail fast on crash loops instead of burning the whole wait budget.
      if [[ "${restarts:-0}" -ge "${SMOKE_MAX_CONTAINER_RESTARTS:-3}" ]]; then
        run_with_timeout "${SMOKE_DOCKER_LOG_TIMEOUT:-45}" docker logs "${container}" >&2 || true
        echo "${container} is restart-looping (${restarts} restarts, status=${status}, exit=${exit_code}); giving up early" >&2
        return 1
      fi
    fi
    sleep 2
  done

  docker inspect "${container}" --format '{{json .State.Health}}' >&2 || true
  docker inspect "${container}" --format 'status={{.State.Status}} exit={{.State.ExitCode}} restarting={{.State.Restarting}} oom={{.State.OOMKilled}} error={{.State.Error}}' >&2 || true
  run_with_timeout "${SMOKE_DOCKER_LOG_TIMEOUT:-45}" docker logs "${container}" >&2 || true
  echo "Timed out waiting for ${container} to become healthy" >&2
  return 1
}

cleanup() {
  local exit_code="${1:-1}"

  if [[ "${LOCK_HELD}" != "1" ]]; then
    exit "${exit_code}"
  fi

  if [[ "${exit_code}" -ne 0 ]]; then
    mkdir -p "${ARTIFACTS_DIR}"
    log "Smoke failed; collecting diagnostics into ${ARTIFACTS_DIR}"

    {
      printf 'smoke_exit_code=%s\n' "${exit_code}"
      date -u '+timestamp_utc=%Y-%m-%dT%H:%M:%SZ'
    } >"${ARTIFACTS_DIR}/metadata.txt"

    compose_with_optional_timeout "${SMOKE_COMPOSE_PS_TIMEOUT:-60}" \
      --env-file .env \
      "${compose_files[@]}" \
      ps >"${ARTIFACTS_DIR}/compose-ps.txt" 2>&1 || true

    compose_with_optional_timeout "${SMOKE_COMPOSE_LOG_TIMEOUT:-180}" \
      --env-file .env \
      "${compose_files[@]}" \
      logs --no-color >"${ARTIFACTS_DIR}/compose-logs.txt" 2>&1 || true

    run_with_timeout "${SMOKE_DOCKER_PS_TIMEOUT:-60}" docker ps -a >"${ARTIFACTS_DIR}/docker-ps-a.txt" 2>&1 || true
  fi

  compose_down || true
  force_remove_stack_resources
  wait_stack_resources_removed 60 || true
  release_lock

  exit "${exit_code}"
}

trap 'cleanup $?' EXIT
acquire_lock

log "Validating compose configuration"
prepare_runtime_secrets
compose \
  --env-file .env \
  "${compose_files[@]}" \
  config -q
compose --env-file .env -f docker-compose.yml -f compose.hardening.yml config -q
compose --env-file .env -f docker-compose.yml -f compose.hardening.yml -f optional/code-interpreter/compose.yml config -q
compose --env-file .env -f docker-compose.yml -f compose.hardening.yml -f optional/local-search/compose.yml config -q
compose --env-file .env -f docker-compose.yml -f compose.hardening.yml -f optional/static-preview/compose.yml config -q

log "Preparing local optional images"
prepare_code_interpreter_image
./scripts/prepare_jina_reranker_image.sh
prepare_jina_reranker_runtime_image
prepare_static_preview_image

log "Ensuring clean compose state"
compose_down || true
force_remove_stack_resources
wait_stack_resources_removed 60

log "Populating stack secrets/config volume"
./scripts/populate_stack_secrets_volume.sh

log "Starting MongoDB bootstrap services"
compose \
  --env-file .env \
  "${compose_files[@]}" \
  up -d mongodb
wait_container_healthy chat-mongodb 120

compose \
  --env-file .env \
  "${compose_files[@]}" \
  up -d mongo-init
wait_container_success mongo-init

log "Starting hardened core services"
compose_with_retry "${SMOKE_COMPOSE_UP_TIMEOUT:-1800}" \
  --env-file .env \
  "${compose_files[@]}" \
  up -d --no-deps --no-start \
  egress-proxy \
  meilisearch \
  vectordb \
  rag_api \
  api \
  api-proxy
start_container egress-proxy
start_container chat-meilisearch
start_container vectordb
wait_container_healthy vectordb 300
start_container rag_api
wait_container_healthy rag_api 600

start_container LibreChat
start_container api-proxy

log "Waiting for LibreChat ingress"
wait_http "${INGRESS_URL}/login" "${SMOKE_LIBRECHAT_INGRESS_ATTEMPTS:-120}"

log "Starting Sandpack and static preview services"
compose_with_retry "${SMOKE_COMPOSE_UP_TIMEOUT:-1800}" \
  --env-file .env \
  "${compose_files[@]}" \
  up -d --no-deps --no-start sandpack static_preview caddy
start_container sandpack-bundler
start_container sandpack-static
start_container caddy-static-proxy
wait_container_healthy sandpack-bundler 120
wait_container_healthy sandpack-static 300

log "Waiting for static preview ingress"
wait_http "http://127.0.0.1:4324/"

log "Starting optional code interpreter services"
compose \
  --env-file .env \
  "${compose_files[@]}" \
  up -d code-interpreter-redis
wait_container_healthy code-interpreter-redis 120

compose \
  --env-file .env \
  "${compose_files[@]}" \
  up -d code-interpreter-minio
wait_container_healthy code-interpreter-minio 120

compose \
  --env-file .env \
  "${compose_files[@]}" \
  up -d code-interpreter-minio-init
wait_container_success code-interpreter-minio-init 120

compose \
  --env-file .env \
  "${compose_files[@]}" \
  up -d --no-deps code-interpreter-api
wait_container_healthy code-interpreter-api 240

compose_with_retry "${SMOKE_COMPOSE_UP_TIMEOUT:-1800}" \
  --env-file .env \
  "${compose_files[@]}" \
  up -d --no-deps --no-start code-interpreter-proxy
start_container code-interpreter-proxy
wait_container_healthy code-interpreter-proxy 120

log "Starting optional search services"
compose \
  --env-file .env \
  "${compose_files[@]}" \
  up -d searxng-valkey
wait_container_healthy searxng-valkey 120

compose_with_retry "${SMOKE_COMPOSE_UP_TIMEOUT:-1800}" \
  --env-file .env \
  "${compose_files[@]}" \
  up -d --no-deps --no-start searxng
start_container searxng
compose_with_retry "${SMOKE_COMPOSE_UP_TIMEOUT:-1800}" \
  --env-file .env \
  "${compose_files[@]}" \
  up -d --no-deps --no-start searxng-auth
start_container searxng-auth-proxy

compose \
  --env-file .env \
  "${compose_files[@]}" \
  up -d firecrawl-redis
wait_container_healthy firecrawl-redis 120

compose \
  --env-file .env \
  "${compose_files[@]}" \
  up -d firecrawl-rabbitmq
wait_container_healthy firecrawl-rabbitmq 180

compose \
  --env-file .env \
  "${compose_files[@]}" \
  up -d firecrawl-postgres
wait_container_healthy firecrawl-postgres 180

compose \
  --env-file .env \
  "${compose_files[@]}" \
  up -d firecrawl-playwright
wait_container_healthy firecrawl-playwright 240

compose_with_retry "${SMOKE_COMPOSE_UP_TIMEOUT:-1800}" \
  --env-file .env \
  "${compose_files[@]}" \
  up -d --no-deps --no-start firecrawl-api
start_container firecrawl-api

compose_with_retry "${SMOKE_COMPOSE_UP_TIMEOUT:-1800}" \
  --env-file .env \
  "${compose_files[@]}" \
  up -d --no-deps --no-start jina-reranker
start_container jina-reranker
wait_internal_http "http://jina-reranker:8000/health" 240
wait_container_healthy firecrawl-api 3600

log "Checking ingress exposure model"
if docker port LibreChat 3080 >/dev/null 2>&1; then
  echo "LibreChat container unexpectedly exposes host port 3080" >&2
  exit 1
fi
if ! docker port api-proxy 80/tcp | grep -q '127.0.0.1:3081'; then
  echo "api-proxy is missing host bind 127.0.0.1:3081->80" >&2
  exit 1
fi
if ! docker port api-proxy 81/tcp | grep -q '127.0.0.1:80'; then
  echo "api-proxy is missing host bind 127.0.0.1:80->81 for sandpack ingress" >&2
  exit 1
fi
if ! docker port caddy-static-proxy 80/tcp | grep -q '127.0.0.1:4324'; then
  echo "caddy-static-proxy is missing host bind 127.0.0.1:4324->80 for static preview" >&2
  exit 1
fi
api_proxy_compose_block="$(
  compose \
    --env-file .env \
    "${compose_files[@]}" \
    config | awk '
      /^  api-proxy:$/ { in_block=1; print; next }
      /^  [^ ]/ && in_block { exit }
      in_block { print }
    '
)"
if grep -q '^    environment:' <<<"${api_proxy_compose_block}"; then
  echo "api-proxy should not have explicit environment proxy wiring in compose config" >&2
  exit 1
fi
api_proxy_networks="$(docker inspect api-proxy --format '{{json .NetworkSettings.Networks}}')"
if grep -q '"librechat-stack_wan"' <<<"${api_proxy_networks}"; then
  echo "api-proxy should not be attached to librechat-stack_wan" >&2
  exit 1
fi
if grep -q '"librechat-stack_lan"' <<<"${api_proxy_networks}"; then
  echo "api-proxy should not be attached to librechat-stack_lan" >&2
  exit 1
fi
if ! grep -q '"librechat-stack_ingress"' <<<"${api_proxy_networks}"; then
  echo "api-proxy should be attached to librechat-stack_ingress" >&2
  exit 1
fi
if ! grep -q '"librechat-stack_api_frontend"' <<<"${api_proxy_networks}"; then
  echo "api-proxy should be attached to librechat-stack_api_frontend" >&2
  exit 1
fi
if ! grep -q '"librechat-stack_sandpack_frontend"' <<<"${api_proxy_networks}"; then
  echo "api-proxy should be attached to librechat-stack_sandpack_frontend" >&2
  exit 1
fi
ingress_options="$(docker network inspect librechat-stack_ingress --format '{{json .Options}}')"
if ! grep -q '"com.docker.network.bridge.enable_ip_masquerade":"false"' <<<"${ingress_options}"; then
  echo "ingress network should have IP masquerading disabled: ${ingress_options}" >&2
  exit 1
fi
for frontend_network in librechat-stack_api_frontend librechat-stack_sandpack_frontend; do
  frontend_internal="$(docker network inspect "${frontend_network}" --format '{{.Internal}}')"
  if [[ "${frontend_internal}" != "true" ]]; then
    echo "${frontend_network} should be internal" >&2
    exit 1
  fi
done
wan_containers="$(
  docker network inspect librechat-stack_wan \
    --format '{{range .Containers}}{{println .Name}}{{end}}' | tr -d '\r' | awk 'NF { print $1 }' | sort | paste -sd ' ' -
)"
if [[ "${wan_containers}" != "egress-proxy" ]]; then
  echo "Only egress-proxy should be attached to librechat-stack_wan; found: ${wan_containers}" >&2
  exit 1
fi
if docker port sandpack-bundler 80/tcp >/dev/null 2>&1; then
  echo "sandpack-bundler should not expose host port 80 directly" >&2
  exit 1
fi
sandpack_networks="$(docker inspect sandpack-bundler --format '{{json .NetworkSettings.Networks}}')"
if grep -q '"librechat-stack_wan"' <<<"${sandpack_networks}"; then
  echo "sandpack-bundler should not be attached to librechat-stack_wan" >&2
  exit 1
fi
if grep -q '"librechat-stack_lan"' <<<"${sandpack_networks}"; then
  echo "sandpack-bundler should not be attached to librechat-stack_lan" >&2
  exit 1
fi
if grep -q '"librechat-stack_api_frontend"' <<<"${sandpack_networks}"; then
  echo "sandpack-bundler should not be attached to librechat-stack_api_frontend" >&2
  exit 1
fi
if ! grep -q '"librechat-stack_sandpack_frontend"' <<<"${sandpack_networks}"; then
  echo "sandpack-bundler should be attached to librechat-stack_sandpack_frontend" >&2
  exit 1
fi
if docker port sandpack-static 4324/tcp >/dev/null 2>&1; then
  echo "sandpack-static should not expose host port 4324 directly" >&2
  exit 1
fi
static_preview_internal="$(docker network inspect librechat-stack_static_preview_net --format '{{.Internal}}')"
if [[ "${static_preview_internal}" != "true" ]]; then
  echo "static_preview_net should be internal" >&2
  exit 1
fi
static_networks="$(docker inspect sandpack-static --format '{{json .NetworkSettings.Networks}}')"
if ! grep -q '"librechat-stack_static_preview_net"' <<<"${static_networks}"; then
  echo "sandpack-static should be attached to librechat-stack_static_preview_net" >&2
  exit 1
fi
for forbidden_network in librechat-stack_wan librechat-stack_lan librechat-stack_ingress librechat-stack_api_frontend librechat-stack_sandpack_frontend; do
  if grep -q "\"${forbidden_network}\"" <<<"${static_networks}"; then
    echo "sandpack-static should not be attached to ${forbidden_network}" >&2
    exit 1
  fi
done
caddy_static_networks="$(docker inspect caddy-static-proxy --format '{{json .NetworkSettings.Networks}}')"
for required_network in librechat-stack_ingress librechat-stack_static_preview_net; do
  if ! grep -q "\"${required_network}\"" <<<"${caddy_static_networks}"; then
    echo "caddy-static-proxy should be attached to ${required_network}" >&2
    exit 1
  fi
done
for forbidden_network in librechat-stack_wan librechat-stack_lan librechat-stack_api_frontend librechat-stack_sandpack_frontend; do
  if grep -q "\"${forbidden_network}\"" <<<"${caddy_static_networks}"; then
    echo "caddy-static-proxy should not be attached to ${forbidden_network}" >&2
    exit 1
  fi
done
api_networks="$(docker inspect LibreChat --format '{{json .NetworkSettings.Networks}}')"
if ! grep -q '"librechat-stack_api_frontend"' <<<"${api_networks}"; then
  echo "LibreChat should be attached to librechat-stack_api_frontend" >&2
  exit 1
fi
if grep -q '"librechat-stack_sandpack_frontend"' <<<"${api_networks}"; then
  echo "LibreChat should not be attached to librechat-stack_sandpack_frontend" >&2
  exit 1
fi
if docker port jina-reranker 8000/tcp >/dev/null 2>&1; then
  echo "jina-reranker should not expose host port 8000 directly" >&2
  exit 1
fi

log "Checking Mongo credential handling"
mongo_env="$(docker inspect chat-mongodb --format '{{json .Config.Env}}')"
if ! grep -q 'MONGO_INITDB_ROOT_USERNAME_FILE=' <<<"${mongo_env}"; then
  echo "MongoDB is missing *_FILE root credential env vars" >&2
  exit 1
fi
if grep -q 'MONGO_INITDB_ROOT_USERNAME=' <<<"${mongo_env}" || grep -q 'MONGO_INITDB_ROOT_PASSWORD=' <<<"${mongo_env}"; then
  echo "MongoDB still has plaintext root credential env vars" >&2
  exit 1
fi

mongo_init_env="$(docker inspect mongo-init --format '{{json .Config.Env}}')"
if grep -q 'MONGO_ROOT_PASSWORD=' <<<"${mongo_init_env}" || grep -q 'MONGO_APP_PASSWORD=' <<<"${mongo_init_env}"; then
  echo "mongo-init still has plaintext credential env vars" >&2
  exit 1
fi

log "Checking local-search and interpreter secret hygiene"
api_env="$(docker inspect LibreChat --format '{{json .Config.Env}}')"
if grep -q 'SEARXNG_API_KEY=' <<<"${api_env}"; then
  if grep -q 'SEARXNG_API_KEY=$' <<<"${api_env}" || \
     grep -q 'SEARXNG_API_KEY=24389_CHANGE_ME' <<<"${api_env}" || \
     grep -q 'SEARXNG_API_KEY=change-me-searxng-api-key' <<<"${api_env}"; then
    echo "SEARXNG_API_KEY is unset or placeholder in LibreChat env" >&2
    exit 1
  fi
fi

code_env="$(docker inspect code-interpreter-api --format '{{json .Config.Env}}')"
if grep -q 'MINIO_ACCESS_KEY=minioadmin' <<<"${code_env}" || grep -q 'MINIO_SECRET_KEY=minioadmin' <<<"${code_env}"; then
  echo "Code interpreter is using insecure default MinIO credentials" >&2
  exit 1
fi

log "Checking egress proxy image pin"
egress_image="$(docker inspect egress-proxy --format '{{.Config.Image}}')"
if [[ "${egress_image}" == "librechat-stack/egress-proxy-runtime:local" ]]; then
  egress_base_image="$(docker inspect egress-proxy --format '{{index .Config.Labels "org.opencontainers.image.base.name"}}')"
  if [[ "${egress_base_image}" != *"@sha256:"* ]]; then
    echo "egress-proxy base image is not digest-pinned: ${egress_base_image}" >&2
    exit 1
  fi
elif [[ "${egress_image}" != *"@sha256:"* ]]; then
  echo "egress-proxy image is not digest-pinned: ${egress_image}" >&2
  exit 1
fi

log "Checking RAG image source and pin"
rag_image="$(docker inspect rag_api --format '{{.Config.Image}}')"
if [[ "${rag_image}" != registry.librechat.ai/danny-avila/librechat-rag-api-dev-lite:* ]] || [[ "${rag_image}" != *"@sha256:"* ]]; then
  echo "Unexpected rag_api image, expected registry.librechat.ai digest pin: ${rag_image}" >&2
  exit 1
fi

log "Checking code interpreter image pin"
ci_image="$(docker inspect code-interpreter-api --format '{{.Config.Image}}')"
if [[ "${ci_image}" == */* && "${ci_image}" != *"@sha256:"* ]]; then
  echo "code-interpreter-api uses a remote image that is not digest-pinned: ${ci_image}" >&2
  exit 1
fi

log "Checking seccomp/apparmor posture"
for container in \
  LibreChat api-proxy egress-proxy sandpack-bundler rag_api chat-mongodb chat-meilisearch vectordb \
  searxng searxng-auth-proxy searxng-valkey firecrawl-api firecrawl-playwright firecrawl-redis firecrawl-rabbitmq firecrawl-postgres \
  jina-reranker code-interpreter-api code-interpreter-proxy code-interpreter-redis code-interpreter-minio \
  sandpack-static caddy-static-proxy; do
  secopts="$(docker inspect "${container}" --format '{{json .HostConfig.SecurityOpt}}')"
  if grep -q 'seccomp=unconfined' <<<"${secopts}"; then
    echo "${container} has seccomp=unconfined" >&2
    exit 1
  fi
  if [[ "${container}" != "code-interpreter-api" ]] && grep -q 'apparmor:unconfined' <<<"${secopts}"; then
    echo "${container} unexpectedly has apparmor:unconfined" >&2
    exit 1
  fi
done

log "Checking code interpreter capability set"
ci_cap_add="$(docker inspect code-interpreter-api --format '{{json .HostConfig.CapAdd}}')"
if ! grep -Eq '^\["(CAP_)?SYS_ADMIN"\]$' <<<"${ci_cap_add}"; then
  echo "Unexpected code-interpreter-api CapAdd: ${ci_cap_add}" >&2
  exit 1
fi

log "Checking code interpreter network isolation"
code_network_internal="$(docker network inspect librechat-stack_code_interpreter --format '{{.Internal}}')"
if [[ "${code_network_internal}" != "true" ]]; then
  echo "code_interpreter network should be internal" >&2
  exit 1
fi
code_gateway_internal="$(docker network inspect librechat-stack_code_gateway --format '{{.Internal}}')"
if [[ "${code_gateway_internal}" != "true" ]]; then
  echo "code_gateway network should be internal" >&2
  exit 1
fi
ci_networks="$(docker inspect code-interpreter-api --format '{{json .NetworkSettings.Networks}}')"
for forbidden_network in librechat-stack_lan librechat-stack_wan librechat-stack_ingress librechat-stack_api_frontend librechat-stack_sandpack_frontend librechat-stack_code_gateway librechat-stack_search librechat-stack_search_gateway librechat-stack_search_egress; do
  if grep -q "\"${forbidden_network}\"" <<<"${ci_networks}"; then
    echo "code-interpreter-api should not be attached to ${forbidden_network}" >&2
    exit 1
  fi
done
if ! grep -q '"librechat-stack_code_interpreter"' <<<"${ci_networks}"; then
  echo "code-interpreter-api should be attached to librechat-stack_code_interpreter" >&2
  exit 1
fi
ci_proxy_networks="$(docker inspect code-interpreter-proxy --format '{{json .NetworkSettings.Networks}}')"
for required_network in librechat-stack_code_gateway librechat-stack_ingress librechat-stack_code_interpreter; do
  if ! grep -q "\"${required_network}\"" <<<"${ci_proxy_networks}"; then
    echo "code-interpreter-proxy should be attached to ${required_network}" >&2
    exit 1
  fi
done
for forbidden_network in librechat-stack_lan librechat-stack_wan librechat-stack_api_frontend librechat-stack_sandpack_frontend librechat-stack_search librechat-stack_search_gateway librechat-stack_search_egress; do
  if grep -q "\"${forbidden_network}\"" <<<"${ci_proxy_networks}"; then
    echo "code-interpreter-proxy should not be attached to ${forbidden_network}" >&2
    exit 1
  fi
done

log "Waiting for code interpreter health endpoint inside the stack"
for attempt in $(seq 1 60); do
  if run_with_timeout "${SMOKE_INTERNAL_HTTP_PROBE_TIMEOUT:-90}" docker exec \
    -e HTTP_PROXY= \
    -e HTTPS_PROXY= \
    -e http_proxy= \
    -e https_proxy= \
    LibreChat sh -ec 'curl -fsS --max-time 30 -H "x-api-key: ${LIBRECHAT_CODE_API_KEY}" "${LIBRECHAT_CODE_BASEURL%/}/health" >/dev/null'
  then
    break
  fi
  sleep 2
  if [[ "${attempt}" == "60" ]]; then
    echo "Timed out waiting for internal code interpreter health endpoint" >&2
    exit 1
  fi
done

log "Checking code interpreter cannot reach stack egress/data services directly"
set +e
ci_isolation_result="$(
  docker exec -i code-interpreter-api python3 - <<'EOF' 2>&1
import socket

targets = [
    ("egress-proxy", 3128),
    ("mongodb", 27017),
    ("api", 3080),
    ("93.184.216.34", 80),
]

results = {}
for host, port in targets:
    sock = socket.socket()
    sock.settimeout(3)
    try:
        sock.connect((host, port))
        results[f"{host}:{port}"] = "connected"
    except Exception as exc:
        results[f"{host}:{port}"] = type(exc).__name__
    finally:
        sock.close()

print(results)
if any(value == "connected" for value in results.values()):
    raise SystemExit(1)
EOF
)"
ci_isolation_rc=$?
set -e
printf '%s\n' "${ci_isolation_result}"
if [[ "${ci_isolation_rc}" -ne 0 ]]; then
  echo "Code interpreter direct network isolation check failed" >&2
  exit 1
fi

log "Waiting for SearXNG and Jina reranker inside the stack"
jina_api_url="$(read_env_var JINA_API_URL)"
jina_api_url="${jina_api_url:-http://jina-reranker:8000/librechat/v1/rerank}"
jina_health_url="$(http_url_origin "${jina_api_url}")/health"
wait_internal_http "${jina_health_url}"

log "Checking local search network isolation"
search_gateway_internal="$(docker network inspect librechat-stack_search_gateway --format '{{.Internal}}')"
if [[ "${search_gateway_internal}" != "true" ]]; then
  echo "search_gateway network should be internal" >&2
  exit 1
fi
api_networks="$(docker inspect LibreChat --format '{{json .NetworkSettings.Networks}}')"
if ! grep -q '"librechat-stack_search_gateway"' <<<"${api_networks}"; then
  echo "LibreChat should be attached to librechat-stack_search_gateway" >&2
  exit 1
fi
if grep -q '"librechat-stack_search"' <<<"${api_networks}"; then
  echo "LibreChat should not be attached to firecrawl backing network librechat-stack_search" >&2
  exit 1
fi
jina_networks="$(docker inspect jina-reranker --format '{{json .NetworkSettings.Networks}}')"
if ! grep -q '"librechat-stack_search_gateway"' <<<"${jina_networks}"; then
  echo "jina-reranker should be attached to librechat-stack_search_gateway" >&2
  exit 1
fi
for forbidden_network in librechat-stack_search librechat-stack_search_egress librechat-stack_wan librechat-stack_ingress librechat-stack_lan; do
  if grep -q "\"${forbidden_network}\"" <<<"${jina_networks}"; then
    echo "jina-reranker should not be attached to ${forbidden_network}" >&2
    exit 1
  fi
done
firecrawl_api_networks="$(docker inspect firecrawl-api --format '{{json .NetworkSettings.Networks}}')"
for required_network in librechat-stack_search_gateway librechat-stack_search librechat-stack_search_egress; do
  if ! grep -q "\"${required_network}\"" <<<"${firecrawl_api_networks}"; then
    echo "firecrawl-api should be attached to ${required_network}" >&2
    exit 1
  fi
done
for backing_container in firecrawl-redis firecrawl-rabbitmq firecrawl-postgres firecrawl-playwright; do
  backing_networks="$(docker inspect "${backing_container}" --format '{{json .NetworkSettings.Networks}}')"
  if grep -q '"librechat-stack_search_gateway"' <<<"${backing_networks}"; then
    echo "${backing_container} should not be attached to librechat-stack_search_gateway" >&2
    exit 1
  fi
  for forbidden_network in librechat-stack_wan librechat-stack_lan librechat-stack_ingress librechat-stack_api_frontend librechat-stack_sandpack_frontend; do
    if grep -q "\"${forbidden_network}\"" <<<"${backing_networks}"; then
      echo "${backing_container} should not be attached to ${forbidden_network}" >&2
      exit 1
    fi
  done
done
searx_auth_networks="$(docker inspect searxng-auth-proxy --format '{{json .NetworkSettings.Networks}}')"
for required_network in librechat-stack_search_gateway librechat-stack_searx_internal; do
  if ! grep -q "\"${required_network}\"" <<<"${searx_auth_networks}"; then
    echo "searxng-auth-proxy should be attached to ${required_network}" >&2
    exit 1
  fi
done

log "Checking SearX auth proxy enforcement"
searx_auth_ok=false
for attempt in $(seq 1 30); do
  set +e
  searx_auth_result="$(
    run_with_timeout "${SMOKE_SEARX_AUTH_PROBE_TIMEOUT:-90}" docker exec \
      -e HTTP_PROXY= \
      -e HTTPS_PROXY= \
      -e http_proxy= \
      -e https_proxy= \
      LibreChat sh -ec '
        base="${SEARXNG_INSTANCE_URL:-http://searxng-auth:8080}"
        denied="$(curl -sS -o /dev/null -w "%{http_code}" --max-time 60 "${base%/}/")"
        allowed="$(curl -sS -o /dev/null -w "%{http_code}" --max-time 60 -H "X-API-Key: ${SEARXNG_API_KEY}" "${base%/}/")"
        ok=false
        [ "${denied}" = "401" ] && [ "${allowed}" = "200" ] && ok=true
        printf "{\"denied\":%s,\"allowed\":%s,\"ok\":%s}\n" "${denied:-0}" "${allowed:-0}" "${ok}"
        [ "${ok}" = "true" ]
      ' 2>&1
  )"
  searx_auth_rc=$?
  set -e
  printf '%s\n' "${searx_auth_result}"
  if [[ "${searx_auth_rc}" -eq 0 ]] && grep -q '"ok":true' <<<"${searx_auth_result}"; then
    searx_auth_ok=true
    break
  fi
  sleep 2
done
if [[ "${searx_auth_ok}" != true ]]; then
  echo "SearX auth proxy enforcement check failed" >&2
  exit 1
fi

log "Waiting for Firecrawl API inside the stack"
wait_internal_http "${FIRECRAWL_API_URL:-http://firecrawl-api:3002}"

log "Checking allowlisted egress policy"
# The deny half only needs Squid's ACL evaluation, so it is a hard assertion.
# The allow half depends on opencode.ai being reachable from CI; retry it and
# degrade to a warning when the upstream is unavailable (Squid 403 still fails).
egress_allowed_ok=false
egress_blocked_ok=false
for attempt in $(seq 1 "${SMOKE_EGRESS_POLICY_ATTEMPTS:-6}"); do
  set +e
  egress_result="$(
    run_with_timeout "${SMOKE_INTERNAL_HTTP_PROBE_TIMEOUT:-90}" docker exec LibreChat sh -ec '
      connect_status() {
        local host="$1" status
        status="$(printf "CONNECT %s:443 HTTP/1.1\r\nHost: %s:443\r\n\r\n" "${host}" "${host}" | nc -w 20 egress-proxy 3128 | sed -n "1p")"
        printf "%s\n" "${status}"
      }

      allowed="$(connect_status opencode.ai)"
      blocked="$(connect_status example.com)"
      printf "{\"allowed\":\"%s\",\"blocked\":\"%s\"}\n" "${allowed}" "${blocked}"
    ' 2>&1
  )"
  egress_rc=$?
  set -e
  printf '%s\n' "${egress_result}"

  if [[ "${egress_rc}" -eq 0 ]]; then
    if grep -Eq '"blocked":"HTTP/[^"]* 200 ' <<<"${egress_result}"; then
      echo "Egress proxy allowed CONNECT to example.com; the allowlist is not enforced" >&2
      exit 1
    fi
    if grep -Eq '"blocked":"HTTP/[^"]* 403' <<<"${egress_result}"; then
      egress_blocked_ok=true
    fi
    if grep -Eq '"allowed":"HTTP/[^"]* 403' <<<"${egress_result}"; then
      echo "Egress proxy denied CONNECT to allowlisted opencode.ai; allowlist is misconfigured" >&2
      exit 1
    fi
    if grep -Eq '"allowed":"HTTP/[^"]* 200 ' <<<"${egress_result}"; then
      egress_allowed_ok=true
    fi
    if [[ "${egress_blocked_ok}" == true && "${egress_allowed_ok}" == true ]]; then
      break
    fi
  fi
  sleep 5
done
if [[ "${egress_blocked_ok}" != true ]]; then
  echo "Egress proxy never returned 403 for a disallowed domain (proxy unreachable or misconfigured)" >&2
  exit 1
fi
if [[ "${egress_allowed_ok}" != true ]]; then
  echo "Warning: allowlisted CONNECT to opencode.ai did not succeed after retries (likely external availability); deny policy was verified." >&2
fi

log "Checking local-search proxy blocks private destinations"
set +e
private_block_result="$(
  run_with_timeout "${SMOKE_INTERNAL_HTTP_PROBE_TIMEOUT:-90}" docker exec firecrawl-api bash -ec '
    connect_status() {
      local host="$1" status
      exec 3<>/dev/tcp/egress-proxy/3128
      printf "CONNECT %s:443 HTTP/1.1\r\nHost: %s:443\r\n\r\n" "${host}" "${host}" >&3
      IFS= read -r status <&3
      exec 3<&-
      exec 3>&-
      printf "%s\n" "${status}"
    }

    localhost="$(connect_status 127.0.0.1)"
    link_local="$(connect_status 169.254.169.254)"
    ok=false
    [[ "${localhost}" != *" 200 "* && "${link_local}" != *" 200 "* ]] && ok=true
    printf "{\"ok\":%s,\"localhost\":\"%s\",\"linkLocal\":\"%s\"}\n" "${ok}" "${localhost}" "${link_local}"
    [[ "${ok}" == "true" ]]
  ' 2>&1
)"
private_block_rc=$?
set -e
printf '%s\n' "${private_block_result}"
if [[ "${private_block_rc}" -ne 0 ]]; then
  echo "Local-search private-destination proxy block check failed" >&2
  exit 1
fi
grep -q '"ok":true' <<<"${private_block_result}"

log "Checking Playwright DNS resolver stays behind egress proxy"
set +e
playwright_dns_result="$(
  docker exec -i firecrawl-playwright node - <<'EOF' 2>&1
const dns = require('node:dns/promises');

(async () => {
  const external = await dns.lookup('example.com');
  const proxy = await dns.lookup('egress-proxy');
  const ok = Boolean(external.address) && proxy.address === '172.31.33.2';
  console.log(JSON.stringify({ externalFamily: external.family, proxy: proxy.address, ok }));
  if (!ok) {
    process.exit(1);
  }
})().catch((error) => {
  console.error(error.stack || String(error));
  process.exit(1);
});
EOF
)"
playwright_dns_rc=$?
set -e
printf '%s\n' "${playwright_dns_result}"
if [[ "${playwright_dns_rc}" -ne 0 ]]; then
  echo "Playwright DNS resolver check failed" >&2
  exit 1
fi
grep -q '"ok":true' <<<"${playwright_dns_result}"

log "Checking proxy-mediated OpenCode reachability from LibreChat"
models_ok=false
for attempt in $(seq 1 6); do
  set +e
  models_result="$(
    run_with_timeout "${SMOKE_EXTERNAL_HTTP_PROBE_TIMEOUT:-30}" docker exec LibreChat sh -ec '
      status="$(printf "CONNECT opencode.ai:443 HTTP/1.1\r\nHost: opencode.ai:443\r\n\r\n" | nc -w 20 egress-proxy 3128 | sed -n "1p")"
      printf "STATUS %s\n" "${status}"
      case "${status}" in *" 200 "*) exit 0 ;; *) exit 1 ;; esac
    ' 2>&1
  )"
  models_rc=$?
  set -e
  printf '%s\n' "${models_result}"
  if [[ "${models_rc}" -eq 0 ]] && grep -Eq '^STATUS HTTP/.* 200 ' <<<"${models_result}"; then
    models_ok=true
    break
  fi
  sleep 5
done
if [[ "${models_ok}" != true ]]; then
  echo "Warning: OpenCode model list was unreachable after retries; continuing CI checks." >&2
fi

log "Checking code interpreter execution from LibreChat container"
set +e
exec_result="$(
  run_with_timeout "${SMOKE_CODE_EXEC_PROBE_TIMEOUT:-300}" docker exec \
    -e HTTP_PROXY= \
    -e HTTPS_PROXY= \
    -e http_proxy= \
    -e https_proxy= \
    LibreChat sh -ec '
      body="{\"lang\":\"py\",\"code\":\"print(2+2)\",\"entity_id\":\"ci-smoke\",\"user_id\":\"ci-smoke\"}"
      response="$(curl -sS --max-time "${SMOKE_CODE_EXEC_PROBE_TIMEOUT:-300}" -w "\nSTATUS %{http_code}\n" \
        -H "content-type: application/json" \
        -H "x-api-key: ${LIBRECHAT_CODE_API_KEY}" \
        --data "${body}" \
        "${LIBRECHAT_CODE_BASEURL%/}/exec")"
      printf "%s\n" "${response}"
      printf "%s\n" "${response}" | grep -q "^STATUS 200$"
    ' 2>&1
)"
exec_rc=$?
set -e
printf '%s\n' "${exec_result}"
if [[ "${exec_rc}" -ne 0 ]]; then
  echo "Code interpreter execution probe failed" >&2
  exit 1
fi
grep -q '^STATUS 200$' <<<"${exec_result}"
grep -q '"stdout":"4\\n"' <<<"${exec_result}"

log "Checking local search stack"
./scripts/smoke_local_search.sh

log "Smoke checks passed"
