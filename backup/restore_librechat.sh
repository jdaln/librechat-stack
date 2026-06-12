#!/usr/bin/env bash
set -Eeuo pipefail

# ========= CONFIG =========
BACKUP_ROOT="${BACKUP_ROOT:-$HOME/Backups/LibreChatBackups}"
# Exported per-process instead of mutating global `docker context use` state.
export DOCKER_CONTEXT="${DOCKER_CONTEXT:-colima-aiarm}"
PROJECT_NAME="${PROJECT_NAME:-librechat-stack}"
VOLUMES_DEFAULT="mongo_data meili_data pgdata2 lbc_api_uploads lbc_api_images lbc_app_logs lbc_app_api_logs lbc_app_data"
VOLUMES="${VOLUMES:-$VOLUMES_DEFAULT}"
SNAPSHOT="${SNAPSHOT:-}"   # expected format: YYYY-MM-DD_HH-MM-SS
# Repo checkout with docker-compose.yml + .env; needed only to restore
# logical database dumps (mongodump/pg_dumpall), which require a running
# database service. Defaults to the parent of this script's directory.
STACK_DIR="${STACK_DIR:-"$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"}"
MONGO_CONTAINER="${MONGO_CONTAINER:-chat-mongodb}"
PG_CONTAINER="${PG_CONTAINER:-vectordb}"
ASSUME_YES=0
LIST_ONLY=0

log() { printf '%s %s\n' "$(date '+%Y-%m-%dT%H:%M:%S%z')" "$*"; }
die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

usage() {
  cat <<'EOF'
Usage:
  restore_librechat.sh [--snapshot YYYY-MM-DD_HH-MM-SS] [--volumes "v1 v2"] [--yes] [--list]

Options:
  --snapshot <stamp>   Restore a specific snapshot timestamp.
                       If omitted, restores the latest backup per volume.
  --volumes "<list>"   Space-delimited volume keys (defaults to all stack volumes).
  --yes                Skip interactive confirmation.
  --list               Show resolved restore plan and exit.
  -h, --help           Show this help.

Archive types (resolved automatically per volume):
  <vol>-<stamp>.tar.gz                 file-level volume snapshot
  mongo_data-<stamp>.mongodump.archive.gz   logical MongoDB dump (live backup)
  pgdata2-<stamp>.pgdumpall.sql.gz          logical Postgres dump (live backup)

Logical dumps are restored by temporarily starting only the matching database
service from the stack checkout (STACK_DIR), so STACK_DIR must point at the
repo with docker-compose.yml and .env for those.

Environment:
  BACKUP_ROOT, DOCKER_CONTEXT, PROJECT_NAME, VOLUMES, SNAPSHOT, STACK_DIR
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --snapshot)
      [[ $# -ge 2 ]] || die "--snapshot requires a value"
      SNAPSHOT="$2"
      shift 2
      ;;
    --volumes)
      [[ $# -ge 2 ]] || die "--volumes requires a value"
      VOLUMES="$2"
      shift 2
      ;;
    --yes)
      ASSUME_YES=1
      shift
      ;;
    --list)
      LIST_ONLY=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      die "Unknown argument: $1"
      ;;
  esac
done

if ! command -v docker >/dev/null 2>&1; then
  die "docker CLI not found"
fi

volume_exists() { docker volume inspect "$1" >/dev/null 2>&1; }

resolve_volume() {
  local short="$1"
  local prefixed="${PROJECT_NAME}_${short}"
  if volume_exists "${prefixed}"; then
    echo "${prefixed}"
  elif volume_exists "${short}"; then
    echo "${short}"
  else
    echo ""
  fi
}

resolve_archive() {
  local short="$1"
  local dir="${BACKUP_ROOT}/volumes/${short}"
  [[ -d "${dir}" ]] || return 1

  if [[ -n "${SNAPSHOT}" ]]; then
    local candidate
    for candidate in \
      "${dir}/${short}-${SNAPSHOT}.mongodump.archive.gz" \
      "${dir}/${short}-${SNAPSHOT}.pgdumpall.sql.gz" \
      "${dir}/${short}-${SNAPSHOT}.tar.gz"; do
      if [[ -f "${candidate}" ]]; then
        echo "${candidate}"
        return 0
      fi
    done
    return 1
  fi

  # Collect existing candidates first: with pipefail, an `ls` glob with no
  # matches would fail the whole pipeline even when other globs match.
  local candidate
  local -a existing=()
  for candidate in "${dir}/${short}-"*.tar.gz "${dir}/${short}-"*.archive.gz "${dir}/${short}-"*.sql.gz; do
    [[ -f "${candidate}" ]] && existing+=("${candidate}")
  done
  [[ "${#existing[@]}" -gt 0 ]] || return 1
  ls -1t "${existing[@]}" | head -n 1
}

ensure_stack_stopped() {
  local running
  running="$(
    docker ps \
      --filter "label=com.docker.compose.project=${PROJECT_NAME}" \
      --format '{{.Names}}'
  )"
  if [[ -n "${running}" ]]; then
    printf '%s\n' "${running}" | sed 's/^/  - /'
    die "compose project '${PROJECT_NAME}' is running; stop it before restore"
  fi
}

stack_compose() {
  [[ -f "${STACK_DIR}/docker-compose.yml" && -f "${STACK_DIR}/.env" ]] \
    || die "STACK_DIR (${STACK_DIR}) must contain docker-compose.yml and .env to restore logical dumps"
  (cd "${STACK_DIR}" && docker compose --env-file .env -f docker-compose.yml -f compose.hardening.yml "$@")
}

wait_container_healthy() {
  local container="$1"
  local attempts="${2:-120}"
  local i health
  for ((i = 1; i <= attempts; i++)); do
    health="$(docker inspect "${container}" --format '{{if .State.Health}}{{.State.Health.Status}}{{end}}' 2>/dev/null || true)"
    [[ "${health}" == "healthy" ]] && return 0
    sleep 2
  done
  die "timed out waiting for ${container} to become healthy"
}

restore_volume_tar() {
  local short="$1" archive="$2"
  local vol archive_dir archive_name

  vol="$(resolve_volume "${short}")"
  [[ -n "${vol}" ]] || die "volume '${short}' not found (looked for '${PROJECT_NAME}_${short}' and '${short}')"
  archive_dir="$(dirname "${archive}")"
  archive_name="$(basename "${archive}")"

  log "Restoring ${short} from ${archive_name}"
  docker run --rm \
    -v "${vol}:/data" \
    -v "${archive_dir}:/backup:ro" \
    alpine:3 sh -lc "set -e; find /data -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +; tar -xzf /backup/${archive_name} -C /data"
}

restore_mongo_dump() {
  local archive="$1"
  log "Restoring MongoDB logical dump $(basename "${archive}") (starting mongodb service)"
  stack_compose up -d mongodb
  wait_container_healthy "${MONGO_CONTAINER}"
  docker exec -i "${MONGO_CONTAINER}" sh -c '
    mongorestore --quiet --drop \
      --username "$(cat /run/secrets/mongo_root_user)" \
      --password "$(cat /run/secrets/mongo_root_password)" \
      --authenticationDatabase admin \
      --archive --gzip
  ' < "${archive}"
  log "Stopping mongodb service after restore"
  stack_compose stop mongodb
}

restore_pg_dump() {
  local archive="$1"
  log "Restoring Postgres logical dump $(basename "${archive}") (starting vectordb service)"
  stack_compose up -d vectordb
  wait_container_healthy "${PG_CONTAINER}"
  gunzip -c "${archive}" | docker exec -i "${PG_CONTAINER}" sh -c 'psql -q -U "$POSTGRES_USER" -d "$POSTGRES_DB"'
  log "Stopping vectordb service after restore"
  stack_compose stop vectordb
}

restore_volume() {
  local short="$1"
  local archive archive_name

  archive="$(resolve_archive "${short}")" || die "no backup archive found for '${short}' (snapshot='${SNAPSHOT:-latest}')"
  archive_name="$(basename "${archive}")"

  printf '%s -> %s\n' "${short}" "${archive_name}"
  if [[ "${LIST_ONLY}" -eq 1 ]]; then
    return 0
  fi

  case "${archive_name}" in
    *.mongodump.archive.gz) restore_mongo_dump "${archive}" ;;
    *.pgdumpall.sql.gz)     restore_pg_dump "${archive}" ;;
    *.tar.gz)               restore_volume_tar "${short}" "${archive}" ;;
    *)                      die "unrecognized archive type: ${archive_name}" ;;
  esac
}

main() {
  local requested_list_only="${LIST_ONLY}"
  [[ -d "${BACKUP_ROOT}" ]] || die "backup root not found: ${BACKUP_ROOT}"
  ensure_stack_stopped

  log "Restore plan (snapshot: ${SNAPSHOT:-latest-per-volume})"
  LIST_ONLY=1
  for v in ${VOLUMES}; do
    restore_volume "${v}"
  done

  if [[ "${requested_list_only}" -eq 1 ]]; then
    log "List-only mode complete"
    return 0
  fi

  if [[ "${ASSUME_YES}" -ne 1 ]]; then
    printf 'Type YES to overwrite the listed volumes: '
    read -r ack
    [[ "${ack}" == "YES" ]] || die "restore cancelled by user"

  fi

  LIST_ONLY=0
  log "Applying restore"
  for v in ${VOLUMES}; do
    restore_volume "${v}"
  done

  log "Restore complete"
}

main "$@"
