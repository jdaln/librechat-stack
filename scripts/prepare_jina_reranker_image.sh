#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

JINA_RERANKER_GIT_URL="${JINA_RERANKER_GIT_URL:-https://github.com/freshe/librechat-jina-reranker-api.git}"
JINA_RERANKER_GIT_REF="${JINA_RERANKER_GIT_REF:-da638699215fc89814e623b3163f73dab859885c}"  # main
JINA_RERANKER_MODEL_NAME="${JINA_RERANKER_MODEL_NAME:-jinaai/jina-reranker-v1-tiny-en}"
JINA_RERANKER_IMAGE="${JINA_RERANKER_IMAGE:-librechat-jina-reranker:da638699-tiny-en}"
CACHE_ROOT="${JINA_RERANKER_CACHE_ROOT:-${XDG_CACHE_HOME:-${HOME}/.cache}/librechat-stack}"
SOURCE_DIR="${CACHE_ROOT}/librechat-jina-reranker-${JINA_RERANKER_GIT_REF:0:12}-src"
BUILD_DIR="${CACHE_ROOT}/librechat-jina-reranker-${JINA_RERANKER_GIT_REF:0:12}-build"

log() {
  printf '%s %s\n' "$(date '+%Y-%m-%dT%H:%M:%S%z')" "$*"
}

require_bin() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "ERROR: required binary not found: $1" >&2
    exit 1
  fi
}

sync_source() {
  mkdir -p "${CACHE_ROOT}"

  if [[ ! -d "${SOURCE_DIR}/.git" ]]; then
    log "Cloning librechat-jina-reranker-api source"
    git clone "${JINA_RERANKER_GIT_URL}" "${SOURCE_DIR}"
  fi

  log "Fetching librechat-jina-reranker-api ref ${JINA_RERANKER_GIT_REF}"
  git -C "${SOURCE_DIR}" fetch --depth 1 origin "${JINA_RERANKER_GIT_REF}"
  git -C "${SOURCE_DIR}" checkout --force "${JINA_RERANKER_GIT_REF}"
}

prepare_build_dir() {
  mkdir -p "${BUILD_DIR}"
  rsync -a --delete --exclude .git "${SOURCE_DIR}/" "${BUILD_DIR}/"

  # LibreChat's Jina client does not send batch_size, so keep it optional in the
  # upstream compatibility layer before building the image.
  perl -0pi -e 's/batch_size: int/batch_size: int = 8/' "${BUILD_DIR}/models.py"
}

build_image() {
  log "Building ${JINA_RERANKER_IMAGE} with ${JINA_RERANKER_MODEL_NAME}"
  DOCKER_BUILDKIT="${DOCKER_BUILDKIT:-1}" docker build \
    --build-arg MODEL_NAME="${JINA_RERANKER_MODEL_NAME}" \
    -t "${JINA_RERANKER_IMAGE}" \
    "${BUILD_DIR}"
}

main() {
  require_bin docker

  # Fast path: image already available locally
  if docker image inspect "${JINA_RERANKER_IMAGE}" >/dev/null 2>&1; then
    log "Jina reranker image already present: ${JINA_RERANKER_IMAGE}"
    return
  fi

  # Try pulling from a registry (works in CI with GHCR login)
  if docker pull "${JINA_RERANKER_IMAGE}" 2>/dev/null; then
    log "Pulled Jina reranker image: ${JINA_RERANKER_IMAGE}"
    return
  fi

  # Fall back to building from source
  require_bin git
  require_bin rsync
  require_bin perl

  sync_source
  prepare_build_dir
  build_image
}

main "$@"
