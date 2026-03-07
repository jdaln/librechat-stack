#!/usr/bin/env bash
set -Eeuo pipefail

# ========= CONFIG =========
BACKUP_ROOT="${BACKUP_ROOT:-$HOME/Backups/LibreChatBackups}"
DOCKER_CONTEXT="${DOCKER_CONTEXT:-colima-aiarm}"
PROJECT_NAME="${PROJECT_NAME:-librechat-stack}"
VOLUMES_DEFAULT="mongo_data meili_data pgdata2 lbc_api_uploads lbc_api_images lbc_app_logs lbc_app_api_logs lbc_app_data"
VOLUMES="${VOLUMES:-$VOLUMES_DEFAULT}"
SNAPSHOT="${SNAPSHOT:-}"   # expected format: YYYY-MM-DD_HH-MM-SS
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

Environment:
  BACKUP_ROOT, DOCKER_CONTEXT, PROJECT_NAME, VOLUMES, SNAPSHOT
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
docker context use "${DOCKER_CONTEXT}" >/dev/null 2>&1 || true

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
    local explicit="${dir}/${short}-${SNAPSHOT}.tar.gz"
    [[ -f "${explicit}" ]] || return 1
    echo "${explicit}"
    return 0
  fi

  ls -1t "${dir}/${short}-"*.tar.gz 2>/dev/null | head -n 1
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

restore_volume() {
  local short="$1"
  local vol archive archive_dir archive_name

  vol="$(resolve_volume "${short}")"
  [[ -n "${vol}" ]] || die "volume '${short}' not found (looked for '${PROJECT_NAME}_${short}' and '${short}')"

  archive="$(resolve_archive "${short}")" || die "no backup archive found for '${short}' (snapshot='${SNAPSHOT:-latest}')"
  archive_dir="$(dirname "${archive}")"
  archive_name="$(basename "${archive}")"

  printf '%s -> %s (%s)\n' "${short}" "${vol}" "${archive_name}"
  if [[ "${LIST_ONLY}" -eq 1 ]]; then
    return 0
  fi

  log "Restoring ${short} from ${archive_name}"
  docker run --rm \
    -v "${vol}:/data" \
    -v "${archive_dir}:/backup:ro" \
    alpine:3 sh -lc "set -e; find /data -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +; tar -xzf /backup/${archive_name} -C /data"
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
