# Self-contained OpenAI-compatible embeddings server.
#
# Architecture: pure Python + fastembed (ONNX runtime). Runs natively on
# both amd64 and arm64 — no GPU, no SIMD assumptions, no Rosetta.
#
# Offline-after-build: the model is downloaded into /app/models during
# `RUN python -m fastembed_warmup` below, then never fetched again. The
# container at runtime has no network egress (the lan network is the
# only attachment).

ARG EMBEDDINGS_BASE_IMAGE=python:3.12-slim-bookworm@sha256:76d4b7b6305788c6b4c6a19d6a22a3921bf802e9af4d5e1e5bd771208dba74bf
FROM ${EMBEDDINGS_BASE_IMAGE}

# Bake-in default model. Override with `--build-arg EMBEDDINGS_MODEL=...`
# at build time to ship a different model in the image. Runtime
# `EMBEDDINGS_MODEL` env must match this value — the cache layout is
# per-model.
ARG EMBEDDINGS_MODEL=intfloat/multilingual-e5-large
ENV EMBEDDINGS_MODEL=${EMBEDDINGS_MODEL} \
    EMBEDDINGS_CACHE_DIR=/app/models \
    PIP_NO_CACHE_DIR=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /app

# System-level dependencies. libgomp1 is needed by onnxruntime; curl is
# only used during build to warm the model cache (not in the runtime
# image — slim base ships curl).
RUN apt-get update \
 && apt-get install -y --no-install-recommends libgomp1 \
 && rm -rf /var/lib/apt/lists/*

COPY optional/embeddings/requirements.txt /tmp/requirements.txt
# --require-hashes makes pip refuse to install anything whose SHA-256
# doesn't match the lockfile, AND forces every transitive dep to be
# explicitly pinned. A supply-chain attacker who replaces a package on
# PyPI cannot smuggle it past this gate.
RUN pip install --no-cache-dir --require-hashes -r /tmp/requirements.txt \
 && rm -f /tmp/requirements.txt

# Pre-download the embedding model into the image so first run is offline
# and the container needs no WAN access at all. fastembed downloads ONNX
# weights from Hugging Face during this step.
RUN python -c "import os; from fastembed import TextEmbedding; \
    TextEmbedding(model_name=os.environ['EMBEDDINGS_MODEL'], cache_dir=os.environ['EMBEDDINGS_CACHE_DIR']); \
    print('cached', os.environ['EMBEDDINGS_MODEL'], '->', os.environ['EMBEDDINGS_CACHE_DIR'])"

# Create a non-root user that owns /app. Runtime drops to it via the
# compose `user:` directive; the model cache is read-only.
RUN useradd --system --uid 10001 --no-create-home --shell /usr/sbin/nologin app \
 && chown -R 10001:10001 /app

COPY --chown=10001:10001 optional/embeddings/api.py /app/api.py
COPY --chown=10001:10001 optional/embeddings/main.py /app/main.py
COPY --chown=10001:10001 optional/embeddings/models.py /app/models.py

USER 10001

EXPOSE 8000
CMD ["python", "/app/main.py"]
