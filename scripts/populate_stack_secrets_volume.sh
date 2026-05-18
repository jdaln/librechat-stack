#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

ENV_FILE="${PROJECT_ROOT}/.env"
SECRETS_DIR="${PROJECT_ROOT}/secrets"
VOLUME_NAME="${STACK_SECRETS_VOLUME:-librechat-stack_stack_secrets}"
INIT_CONTAINER="${STACK_SECRETS_INIT_CONTAINER:-librechat-stack-secrets-init}"
HELPER_IMAGE="${STACK_SECRETS_HELPER_IMAGE:-ubuntu:24.04}"

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
  ' "${ENV_FILE}"
}

write_runtime_secret() {
  local key="$1"
  local path="$2"
  local value

  value="$(read_env_var "${key}")"
  if [[ -z "${value}" ]]; then
    echo "ERROR: missing ${key} in ${ENV_FILE}" >&2
    exit 1
  fi

  printf '%s' "${value}" > "${path}"
}

copy_required() {
  local source="$1"
  local target="$2"

  if [[ ! -f "${source}" ]]; then
    echo "ERROR: required stack secret/config file is missing: ${source}" >&2
    exit 1
  fi

  docker cp "${source}" "${INIT_CONTAINER}:/run/secrets/${target}"
}

cleanup() {
  local id

  for _ in $(seq 1 10); do
    id="$(docker ps -aq --filter "name=^/${INIT_CONTAINER}$" | head -n 1)"
    if [[ -z "${id}" ]]; then
      return 0
    fi
    docker rm -f "${id}" >/dev/null 2>&1 || true
    sleep 1
  done

  id="$(docker ps -aq --filter "name=^/${INIT_CONTAINER}$" | head -n 1)"
  if [[ -n "${id}" ]]; then
    echo "ERROR: unable to remove stale ${INIT_CONTAINER} helper container (${id})" >&2
    docker inspect "${id}" --format 'status={{.State.Status}} pid={{.State.Pid}} oom={{.State.OOMKilled}} error={{.State.Error}}' >&2 || true
    return 1
  fi
}

main() {
  if [[ ! -f "${ENV_FILE}" ]]; then
    echo "ERROR: ${ENV_FILE} not found. Run: cp template_dot_env .env" >&2
    exit 1
  fi

  mkdir -p "${SECRETS_DIR}"
  chmod u+w "${SECRETS_DIR}"/runtime-mongo-*.txt 2>/dev/null || true
  write_runtime_secret MONGO_ROOT_USER "${SECRETS_DIR}/runtime-mongo-root-user.txt"
  write_runtime_secret MONGO_ROOT_PASSWORD "${SECRETS_DIR}/runtime-mongo-root-password.txt"
  write_runtime_secret MONGO_APP_USER "${SECRETS_DIR}/runtime-mongo-app-user.txt"
  write_runtime_secret MONGO_APP_PASSWORD "${SECRETS_DIR}/runtime-mongo-app-password.txt"
  chmod 444 "${SECRETS_DIR}"/runtime-mongo-*.txt || true

  docker volume create "${VOLUME_NAME}" >/dev/null
  cleanup
  trap 'cleanup || true' EXIT

  docker create --name "${INIT_CONTAINER}" -v "${VOLUME_NAME}:/run/secrets" "${HELPER_IMAGE}" sleep 3600 >/dev/null
  docker start "${INIT_CONTAINER}" >/dev/null
  if [[ "$(docker inspect -f '{{.State.Running}}' "${INIT_CONTAINER}")" != "true" ]]; then
    docker logs "${INIT_CONTAINER}" >&2 || true
    echo "ERROR: stack secrets init container exited before files could be copied" >&2
    exit 1
  fi
  docker exec "${INIT_CONTAINER}" sh -lc 'rm -rf /run/secrets/*'

  copy_required "${PROJECT_ROOT}/librechat.yaml" librechat_yaml
  copy_required "${PROJECT_ROOT}/optional/api-proxy/Caddyfile" api_proxy_caddyfile
  copy_required "${PROJECT_ROOT}/optional/egress-proxy/squid.conf" squid_conf
  copy_required "${PROJECT_ROOT}/optional/egress-proxy/allowed_domains.txt" squid_allowlist
  copy_required "${PROJECT_ROOT}/optional/egress-proxy/undici-proxy-bootstrap.cjs" undici_proxy_bootstrap.cjs
  copy_required "${PROJECT_ROOT}/optional/local-search/searxng/auth-proxy.Caddyfile" searxng_auth_caddyfile
  copy_required "${PROJECT_ROOT}/optional/static-preview/Caddyfile" static_preview_caddyfile
  copy_required "${SECRETS_DIR}/runtime-mongo-root-user.txt" mongo_root_user
  copy_required "${SECRETS_DIR}/runtime-mongo-root-password.txt" mongo_root_password
  copy_required "${SECRETS_DIR}/runtime-mongo-app-user.txt" mongo_app_user
  copy_required "${SECRETS_DIR}/runtime-mongo-app-password.txt" mongo_app_password

  if [[ -f "${SECRETS_DIR}/gcp-sa.json" ]]; then
    docker cp "${SECRETS_DIR}/gcp-sa.json" "${INIT_CONTAINER}:/run/secrets/gcp_sa"
  else
    docker exec "${INIT_CONTAINER}" sh -lc "printf '{}' > /run/secrets/gcp_sa"
  fi

  docker exec "${INIT_CONTAINER}" sh -lc 'chmod 444 /run/secrets/*'
}

main "$@"
