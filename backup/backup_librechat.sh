#!/usr/bin/env bash
set -Eeuo pipefail

# ========= CONFIG =========
BACKUP_ROOT="${BACKUP_ROOT:-$HOME/Backups/LibreChatBackups}"
DATE="$(date +%Y-%m-%d_%H-%M-%S)"
RETENTION_DAYS="${RETENTION_DAYS:-90}"

# Docker context (Colima on M1)
DOCKER_CONTEXT="${DOCKER_CONTEXT:-colima-aiarm}"

# Compose project name from your docker-compose.yml: `name: librechat-stack`
PROJECT_NAME="${PROJECT_NAME:-librechat-stack}"

# Volumes to snapshot (compose "keys", without the project prefix)
VOLUMES_DEFAULT="mongo_data meili_data pgdata2 lbc_api_uploads lbc_api_images lbc_app_logs lbc_app_api_logs lbc_app_data"
VOLUMES="${VOLUMES:-$VOLUMES_DEFAULT}"

mkdir -p "$BACKUP_ROOT"

log() { printf '%s %s\n' "$(date '+%Y-%m-%dT%H:%M:%S%z')" "$*"; }

# Ensure we talk to the right daemon
if command -v docker >/dev/null 2>&1; then
  docker context use "$DOCKER_CONTEXT" >/dev/null 2>&1 || true
else
  echo "docker CLI not found"; exit 1
fi

volume_exists() { docker volume inspect "$1" >/dev/null 2>&1; }

resolve_volume() {
  local short="$1"
  local prefixed="${PROJECT_NAME}_${short}"
  if volume_exists "$prefixed"; then
    echo "$prefixed"
  elif volume_exists "$short"; then
    echo "$short"
  else
    echo ""  # not found
  fi
}

backup_volume() {
  local short="$1"
  local vol ; vol="$(resolve_volume "$short")"
  if [[ -z "$vol" ]]; then
    log "SKIP: volume '$short' not found (looked for '${PROJECT_NAME}_$short' and '$short')"
    return 0
  fi
  local outdir="$BACKUP_ROOT/volumes/$short"
  mkdir -p "$outdir"
  log "Backing up volume $short (actual: $vol) -> $outdir/${short}-${DATE}.tar.gz"
  docker run --rm \
    -v "${vol}:/data:ro" \
    -v "${outdir}:/backup" \
    alpine:3 sh -lc 'set -e; cd /data && tar -czf "/backup/'"$short"'-'"$DATE"'.tar.gz" .'
}

prune_old() {
  log "Pruning backups older than ${RETENTION_DAYS} days in $BACKUP_ROOT"
  find "$BACKUP_ROOT/volumes" -type f -name '*.tar.gz' -mtime +"$RETENTION_DAYS" -print -delete || true
}

main() {
  log "Starting LibreChat backup set $DATE"
  for v in $VOLUMES; do
    backup_volume "$v" || log "volume $v backup failed"
  done
  prune_old
  log "Done"
}

main "$@"
