#!/usr/bin/env bash
set -Eeuo pipefail

# ========= CONFIG =========
BACKUP_ROOT="${BACKUP_ROOT:-$HOME/Backups/LibreChatBackups}"
DATE="$(date +%Y-%m-%d_%H-%M-%S)"
RETENTION_DAYS="${RETENTION_DAYS:-90}"

# Docker context (Colima on M1). Exported per-process instead of mutating the
# global `docker context use` state: this script runs unattended from a
# LaunchAgent and must not silently switch the context for other shells.
export DOCKER_CONTEXT="${DOCKER_CONTEXT:-colima-aiarm}"

# Compose project name from your docker-compose.yml: `name: librechat-stack`
PROJECT_NAME="${PROJECT_NAME:-librechat-stack}"

# Volumes to snapshot (compose "keys", without the project prefix).
# mongo_data and pgdata2 are handled specially: live databases are dumped
# logically (mongodump/pg_dumpall) because tarring a running WiredTiger or
# Postgres data directory produces snapshots that may not restore.
VOLUMES_DEFAULT="mongo_data meili_data pgdata2 lbc_api_uploads lbc_api_images lbc_app_logs lbc_app_api_logs lbc_app_data"
VOLUMES="${VOLUMES:-$VOLUMES_DEFAULT}"

MONGO_CONTAINER="${MONGO_CONTAINER:-chat-mongodb}"
PG_CONTAINER="${PG_CONTAINER:-vectordb}"

mkdir -p "$BACKUP_ROOT"

log() { printf '%s %s\n' "$(date '+%Y-%m-%dT%H:%M:%S%z')" "$*"; }

if ! command -v docker >/dev/null 2>&1; then
  echo "docker CLI not found"; exit 1
fi

volume_exists() { docker volume inspect "$1" >/dev/null 2>&1; }
container_running() { [[ "$(docker inspect -f '{{.State.Running}}' "$1" 2>/dev/null)" == "true" ]]; }

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

checksum_artifact() {
  local file="$1"
  (cd "$(dirname "$file")" && shasum -a 256 "$(basename "$file")" > "$(basename "$file").sha256")
}

verify_gzip() {
  local file="$1"
  if ! gzip -t "$file" 2>/dev/null; then
    log "ERROR: integrity check failed for $file"
    rm -f "$file"
    return 1
  fi
  checksum_artifact "$file"
}

verify_tar() {
  local file="$1"
  if ! tar -tzf "$file" >/dev/null 2>&1; then
    log "ERROR: integrity check failed for $file"
    rm -f "$file"
    return 1
  fi
  checksum_artifact "$file"
}

backup_volume_tar() {
  local short="$1"
  local vol ; vol="$(resolve_volume "$short")"
  if [[ -z "$vol" ]]; then
    log "SKIP: volume '$short' not found (looked for '${PROJECT_NAME}_$short' and '$short')"
    return 0
  fi
  local outdir="$BACKUP_ROOT/volumes/$short"
  mkdir -p "$outdir"
  local outfile="$outdir/${short}-${DATE}.tar.gz"
  log "Backing up volume $short (actual: $vol) -> $outfile"
  docker run --rm \
    -v "${vol}:/data:ro" \
    -v "${outdir}:/backup" \
    alpine:3 sh -lc 'set -e; cd /data && tar -czf "/backup/'"$short"'-'"$DATE"'.tar.gz" .'
  verify_tar "$outfile"
}

backup_mongo() {
  local outdir="$BACKUP_ROOT/volumes/mongo_data"
  mkdir -p "$outdir"

  if container_running "$MONGO_CONTAINER"; then
    # Live database: a consistent logical dump via mongodump. Root credentials
    # come from the container's own secret files.
    local outfile="$outdir/mongo_data-${DATE}.mongodump.archive.gz"
    log "Backing up MongoDB (live, mongodump) -> $outfile"
    docker exec "$MONGO_CONTAINER" sh -c '
      mongodump --quiet \
        --username "$(cat /run/secrets/mongo_root_user)" \
        --password "$(cat /run/secrets/mongo_root_password)" \
        --authenticationDatabase admin \
        --archive --gzip
    ' > "$outfile"
    verify_gzip "$outfile"
  else
    # Stack stopped: a cold file-level tar is consistent.
    log "MongoDB container not running; taking cold volume tar"
    backup_volume_tar mongo_data
  fi
}

backup_postgres() {
  local outdir="$BACKUP_ROOT/volumes/pgdata2"
  mkdir -p "$outdir"

  if container_running "$PG_CONTAINER"; then
    local outfile="$outdir/pgdata2-${DATE}.pgdumpall.sql.gz"
    log "Backing up Postgres (live, pg_dumpall) -> $outfile"
    docker exec "$PG_CONTAINER" sh -c 'pg_dumpall -U "$POSTGRES_USER" --clean --if-exists' \
      | gzip > "$outfile"
    verify_gzip "$outfile"
  else
    log "Postgres container not running; taking cold volume tar"
    backup_volume_tar pgdata2
  fi
}

prune_old() {
  local prune_dir="$BACKUP_ROOT/volumes"
  mkdir -p "$prune_dir"
  log "Pruning backups older than ${RETENTION_DAYS} days in $BACKUP_ROOT"
  find "$prune_dir" -type f \( -name '*.tar.gz' -o -name '*.archive.gz' -o -name '*.sql.gz' -o -name '*.sha256' \) \
    -mtime +"$RETENTION_DAYS" -print -delete || true
}

main() {
  log "Starting LibreChat backup set $DATE"
  local failures=0
  for v in $VOLUMES; do
    case "$v" in
      mongo_data) backup_mongo || { log "ERROR: mongo backup failed"; failures=$((failures+1)); } ;;
      pgdata2)    backup_postgres || { log "ERROR: postgres backup failed"; failures=$((failures+1)); } ;;
      *)          backup_volume_tar "$v" || { log "ERROR: volume $v backup failed"; failures=$((failures+1)); } ;;
    esac
  done
  prune_old
  if [[ "$failures" -gt 0 ]]; then
    log "Done with ${failures} failure(s)"
    exit 1
  fi
  log "Done"
}

main "$@"
