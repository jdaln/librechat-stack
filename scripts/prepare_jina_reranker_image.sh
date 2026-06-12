#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

JINA_RERANKER_GIT_URL="${JINA_RERANKER_GIT_URL:-https://github.com/freshe/librechat-jina-reranker-api.git}"
JINA_RERANKER_GIT_REF="${JINA_RERANKER_GIT_REF:-da638699215fc89814e623b3163f73dab859885c}"
JINA_RERANKER_MODEL_NAME="${JINA_RERANKER_MODEL_NAME:-jinaai/jina-reranker-v1-tiny-en}"
JINA_RERANKER_IMAGE="${JINA_RERANKER_IMAGE:-librechat-jina-reranker:da638699-tiny-en}"
CACHE_ROOT="${JINA_RERANKER_CACHE_ROOT:-${HOME}/Library/Caches/librechat-stack}"
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
  perl -0pi -e 's/batch_size: int(?! =)/batch_size: int = 8/' "${BUILD_DIR}/models.py"
  if ! grep -q 'batch_size: int = 8' "${BUILD_DIR}/models.py"; then
    echo "ERROR: batch_size compatibility patch no longer applies to models.py; upstream layout changed - review the patch before bumping JINA_RERANKER_GIT_REF" >&2
    exit 1
  fi

  # Preload the model files without instantiating onnxruntime during the image
  # build. TextCrossEncoder initialization can crash under Linux ARM builders
  # even though the downloaded model runs correctly at container runtime.
  awk '
    /^RUN python -c "from fastembed\.rerank\.cross_encoder/ {
      print "RUN python -c '\''from huggingface_hub import snapshot_download; import os; snapshot_download(repo_id=os.getenv(\"MODEL_NAME\"), cache_dir=os.getenv(\"CACHE_DIR\"), allow_patterns=[\"config.json\",\"tokenizer.json\",\"tokenizer_config.json\",\"special_tokens_map.json\",\"preprocessor_config.json\",\"onnx/model.onnx\"])'\''"
      next
    }
    { print }
  ' "${BUILD_DIR}/Dockerfile" > "${BUILD_DIR}/Dockerfile.tmp"
  mv "${BUILD_DIR}/Dockerfile.tmp" "${BUILD_DIR}/Dockerfile"
  if ! grep -q 'snapshot_download' "${BUILD_DIR}/Dockerfile"; then
    echo "ERROR: model preload rewrite no longer applies to the upstream Dockerfile; review the awk patch before bumping JINA_RERANKER_GIT_REF" >&2
    exit 1
  fi
}

build_image() {
  if docker image inspect "${JINA_RERANKER_IMAGE}" >/dev/null 2>&1; then
    log "Jina reranker image already present: ${JINA_RERANKER_IMAGE}"
    return
  fi

  log "Building ${JINA_RERANKER_IMAGE} with ${JINA_RERANKER_MODEL_NAME}"
  if docker buildx version >/dev/null 2>&1; then
    DOCKER_BUILDKIT="${DOCKER_BUILDKIT:-1}" docker build \
      --build-arg MODEL_NAME="${JINA_RERANKER_MODEL_NAME}" \
      -t "${JINA_RERANKER_IMAGE}" \
      "${BUILD_DIR}"
  else
    docker build \
      --build-arg MODEL_NAME="${JINA_RERANKER_MODEL_NAME}" \
      -t "${JINA_RERANKER_IMAGE}" \
      "${BUILD_DIR}"
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
