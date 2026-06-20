#!/usr/bin/env bash
#
# Tear down the running stack without losing any persistent data.
#
# By default this runs `docker compose down` (containers + networks removed,
# named volumes preserved). To temporarily pause without removing containers,
# use `--pause` (or `STOP_MODE=pause`).
#
# What's preserved either way:
#   * mongo_data            chat history, users, agents
#   * pgdata2               rag_api vector store
#   * meili_data            conversation full-text search indexes
#   * lbc_api_uploads       files uploaded through the LibreChat UI
#   * lbc_api_images        generated images
#   * lbc_app_data          app state
#   * code_interpreter_*    sandbox / minio / redis state for executed code
#   * firecrawl_postgres_data, firecrawl_redis_data, searxng_*
#   * jina_reranker_model_cache (no re-download on next start)
#   * stack_secrets         runtime secrets (re-populated from .env on start)
#
# What's removed (recreated cleanly on next start):
#   * containers, ephemeral state (tmpfs mounts)
#   * Docker networks
#
# By default this ALSO stops the Colima VM so the host reclaims RAM/CPU.
# Pass `--keep-colima` (or `STOP_COLIMA=0`) if you'll restart within
# minutes and want to skip the VM bring-up on the next start.
#
# The `--remove-volumes` / `-v` flag is intentionally NOT supported here.
# To wipe data, use `docker volume rm` explicitly — that signals "I really
# mean it" louder than a CLI flag.

set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

COLIMA_PROFILE="${COLIMA_PROFILE:-aiarm}"
DOCKER_CONTEXT_NAME="${DOCKER_CONTEXT_NAME:-colima-${COLIMA_PROFILE}}"
STOP_MODE="${STOP_MODE:-down}"           # `down` (default) | `pause`
STOP_COLIMA="${STOP_COLIMA:-1}"          # default: also stop the VM (free RAM)
REMOVE_ORPHANS="${REMOVE_ORPHANS:-1}"

usage() {
  cat <<USAGE
Usage: ${0##*/} [--pause | --down] [--keep-colima] [--keep-orphans]

  --pause          Pause containers (docker compose stop). Fast restart,
                   keeps containers and their tmpfs state. Implies
                   --keep-colima.
  --down           Default. Remove containers + networks (docker compose
                   down) AND stop the Colima VM. Frees host RAM/CPU
                   completely. Volumes are preserved.
  --keep-colima    Do not stop the Colima VM. Use this if you'll restart
                   within minutes — skips the VM bring-up next time
                   (saves ~10-20s on the subsequent start) but keeps the
                   VM's allocated RAM resident on the host.
  --keep-orphans   Do not pass --remove-orphans to compose down. Only
                   useful if you have manually-created sibling containers
                   you don't want touched.
  -h, --help       Show this help.

Environment overrides:
  COLIMA_PROFILE         (default: aiarm)
  DOCKER_CONTEXT_NAME    (default: colima-\${COLIMA_PROFILE})
  STOP_MODE              down | pause
  STOP_COLIMA            0 | 1   (default: 1, stops the VM)
  REMOVE_ORPHANS         0 | 1

To wipe all data (DESTRUCTIVE — do this only if you mean to start fresh):
  docker volume rm \$(docker volume ls -q --filter name=librechat-stack_)
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --pause)        STOP_MODE=pause; STOP_COLIMA=0 ;;
    --down)         STOP_MODE=down ;;
    --keep-colima)  STOP_COLIMA=0 ;;
    --stop-colima)  STOP_COLIMA=1 ;;  # accepted for back-compat; now the default
    --keep-orphans) REMOVE_ORPHANS=0 ;;
    -h|--help)      usage; exit 0 ;;
    *)              echo "ERROR: unknown argument: $1" >&2; usage >&2; exit 1 ;;
  esac
  shift
done

log() {
  printf '%s %s\n' "$(date '+%Y-%m-%dT%H:%M:%S%z')" "$*"
}

require_bin() {
  command -v "$1" >/dev/null 2>&1 \
    || { echo "ERROR: required binary not found: $1" >&2; exit 1; }
}

docker_compose() {
  if docker compose version >/dev/null 2>&1; then
    docker compose "$@"; return
  fi
  if command -v docker-compose >/dev/null 2>&1; then
    docker-compose "$@"; return
  fi
  echo "ERROR: neither 'docker compose' nor 'docker-compose' is available" >&2
  exit 1
}

main() {
  require_bin docker

  # Switch to the right Docker context if Colima is up. We don't *require*
  # Colima to be running — if it's already stopped, the down is a no-op.
  if command -v colima >/dev/null 2>&1 \
       && colima status -p "${COLIMA_PROFILE}" >/dev/null 2>&1; then
    log "Switching Docker context to '${DOCKER_CONTEXT_NAME}'"
    docker context use "${DOCKER_CONTEXT_NAME}" >/dev/null
  else
    log "Colima profile '${COLIMA_PROFILE}' isn't running — nothing to tear down"
    exit 0
  fi

  # Pass every overlay's compose file regardless of what was started with.
  # `docker compose down` ignores services that aren't running, so the
  # result is the same as if the user re-passed their original flags.
  # This avoids requiring the user to remember the STACK_PROFILE they used.
  local -a compose_files=(
    -f "${PROJECT_ROOT}/docker-compose.yml"
    -f "${PROJECT_ROOT}/compose.hardening.yml"
    -f "${PROJECT_ROOT}/optional/static-preview/compose.yml"
    -f "${PROJECT_ROOT}/optional/code-interpreter/compose.yml"
    -f "${PROJECT_ROOT}/optional/local-search/compose.yml"
    -f "${PROJECT_ROOT}/optional/embeddings/compose.yml"
    -f "${PROJECT_ROOT}/optional/ollama/compose.yml"
  )

  local -a extra_flags=()
  [[ "${REMOVE_ORPHANS}" == "1" ]] && extra_flags+=(--remove-orphans)

  case "${STOP_MODE}" in
    pause)
      log "Pausing the stack (docker compose stop). Containers stay around; volumes preserved."
      (cd "${PROJECT_ROOT}" && docker_compose --env-file .env "${compose_files[@]}" stop)
      ;;
    down)
      log "Tearing down the stack (docker compose down). Containers + networks removed; volumes preserved."
      (cd "${PROJECT_ROOT}" && docker_compose --env-file .env "${compose_files[@]}" down "${extra_flags[@]}")
      ;;
    *)
      echo "ERROR: unsupported STOP_MODE='${STOP_MODE}' (expected: down | pause)" >&2
      exit 1
      ;;
  esac

  log "Done. Persistent volumes left intact:"
  docker volume ls --filter name=librechat-stack_ --format '  {{.Name}}' | sort | head -20

  if [[ "${STOP_COLIMA}" == "1" ]]; then
    require_bin colima
    log "Stopping Colima profile '${COLIMA_PROFILE}' to release host RAM/CPU"
    colima stop -p "${COLIMA_PROFILE}"
  else
    log "Colima VM left running (next start_stack.sh will be ~10-20s faster)."
    log "  To stop the VM too: colima stop -p ${COLIMA_PROFILE}"
  fi
}

main "$@"
