#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

CODE_INTERPRETER_GIT_URL="${CODE_INTERPRETER_GIT_URL:-https://github.com/usnavy13/LibreCodeInterpreter.git}"
CODE_INTERPRETER_GIT_REF="${CODE_INTERPRETER_GIT_REF:-0dc767a13f5c1c15db7c5d780765bb00c4593989}"  # main — v1.2.0
CODE_INTERPRETER_IMAGE="${CODE_INTERPRETER_IMAGE:-librecodeinterpreter:0dc767a}"
CACHE_ROOT="${CODE_INTERPRETER_CACHE_ROOT:-${XDG_CACHE_HOME:-${HOME}/.cache}/librechat-stack}"
SOURCE_DIR="${CACHE_ROOT}/LibreCodeInterpreter-${CODE_INTERPRETER_GIT_REF:0:12}-src"
BUILD_DIR="${CACHE_ROOT}/LibreCodeInterpreter-${CODE_INTERPRETER_GIT_REF:0:12}-build"

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
    log "Cloning LibreCodeInterpreter source"
    git clone "${CODE_INTERPRETER_GIT_URL}" "${SOURCE_DIR}"
  fi

  log "Fetching LibreCodeInterpreter ref ${CODE_INTERPRETER_GIT_REF}"
  git -C "${SOURCE_DIR}" fetch --depth 1 origin "${CODE_INTERPRETER_GIT_REF}"
  git -C "${SOURCE_DIR}" checkout --force "${CODE_INTERPRETER_GIT_REF}"
}

prepare_build_dir() {
  mkdir -p "${BUILD_DIR}"
  rsync -a --delete --exclude .git "${SOURCE_DIR}/" "${BUILD_DIR}/"

  if ! docker buildx version >/dev/null 2>&1; then
    log "buildx not available; stripping BuildKit cache mounts from upstream Dockerfile"
    perl -0pi -e 's/^RUN\s+--mount=type=cache,target=[^[:space:]\\\\]+\s+/RUN /mg' "${BUILD_DIR}/Dockerfile"
  fi
}

build_image() {
  if docker image inspect "${CODE_INTERPRETER_IMAGE}" >/dev/null 2>&1; then
    log "Code interpreter image already present: ${CODE_INTERPRETER_IMAGE}"
    return
  fi

  log "Building ${CODE_INTERPRETER_IMAGE}"
  if docker buildx version >/dev/null 2>&1; then
    DOCKER_BUILDKIT="${DOCKER_BUILDKIT:-1}" docker build -t "${CODE_INTERPRETER_IMAGE}" "${BUILD_DIR}"
  else
    docker build -t "${CODE_INTERPRETER_IMAGE}" "${BUILD_DIR}"
  fi
}

main() {
  require_bin docker
  require_bin git
  require_bin rsync
  require_bin perl

  sync_source
  prepare_build_dir
  build_image
}

main "$@"
