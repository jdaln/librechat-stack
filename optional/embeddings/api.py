"""OpenAI-compatible embeddings server backed by fastembed.

Exposes:
  POST /v1/embeddings  — OpenAI-format embeddings endpoint
  GET  /health         — liveness probe

The model is loaded once at startup from the local on-disk cache that was
populated at image-build time (see Dockerfile). No network access is
required at runtime.

`rag_api` calls this via `RAG_OPENAI_BASEURL=http://embeddings:8000/v1`
with `RAG_OPENAI_API_KEY` set to any non-empty value (we don't validate
it — the only entrypoint to this service is the internal `lan` network,
so the auth check would be ceremony).
"""

import logging
import os
import threading
from typing import List

from fastapi import Body, FastAPI, HTTPException

from models import EmbeddingItem, EmbeddingsRequest, EmbeddingsResponse, Usage

logger = logging.getLogger("embeddings")

# Loaded at build time into MODEL_CACHE_DIR; never fetched at runtime.
MODEL_NAME = os.getenv("EMBEDDINGS_MODEL", "intfloat/multilingual-e5-large")
MODEL_CACHE_DIR = os.getenv("EMBEDDINGS_CACHE_DIR", "/app/models")
MAX_BATCH_SIZE = int(os.getenv("EMBEDDINGS_MAX_BATCH", "64"))

app = FastAPI(title="librechat-stack embeddings", version="1.0.0")

_encoder = None
_encoder_lock = threading.Lock()
_encoder_ready = threading.Event()


def _load_encoder() -> None:
    """Load the model in a background thread so /health is reachable
    immediately after the process starts. fastembed lazily loads on
    first call anyway, but we prime it here to bound first-request
    latency."""
    global _encoder
    try:
        from fastembed import TextEmbedding

        encoder = TextEmbedding(
            model_name=MODEL_NAME,
            cache_dir=MODEL_CACHE_DIR,
        )
        # Force first-call setup (ONNX session warmup).
        list(encoder.embed(["warmup"]))
        with _encoder_lock:
            _encoder = encoder
        _encoder_ready.set()
        logger.info("Loaded embeddings model %s", MODEL_NAME)
    except Exception:  # noqa: BLE001
        logger.exception("Failed to load embeddings model %s", MODEL_NAME)


@app.on_event("startup")
def _start_encoder_loader() -> None:
    threading.Thread(target=_load_encoder, name="embeddings-loader", daemon=True).start()


@app.get("/health")
def health() -> dict:
    return {
        "status": "ok",
        "model": MODEL_NAME,
        "ready": _encoder_ready.is_set(),
    }


def _normalize_inputs(payload_input) -> List[str]:
    if isinstance(payload_input, str):
        return [payload_input]
    if isinstance(payload_input, list) and all(isinstance(s, str) for s in payload_input):
        return payload_input
    raise HTTPException(
        status_code=400,
        detail="`input` must be a string or list of strings",
    )


@app.post("/v1/embeddings", response_model=EmbeddingsResponse)
def embeddings(req: EmbeddingsRequest = Body(...)) -> EmbeddingsResponse:
    if not _encoder_ready.wait(timeout=120):
        raise HTTPException(status_code=503, detail="embeddings model not loaded yet")

    texts = _normalize_inputs(req.input)
    if not texts:
        raise HTTPException(status_code=400, detail="`input` is empty")
    if len(texts) > MAX_BATCH_SIZE:
        raise HTTPException(
            status_code=400,
            detail=f"batch size {len(texts)} exceeds limit {MAX_BATCH_SIZE}",
        )

    with _encoder_lock:
        encoder = _encoder
    if encoder is None:
        raise HTTPException(status_code=503, detail="embeddings model failed to load")

    vectors = [list(map(float, vec)) for vec in encoder.embed(texts)]

    # Token counts are approximate — fastembed doesn't expose tokenizer
    # output here. We report a reasonable estimate so the response shape
    # matches OpenAI's; clients that depend on exact counts should use
    # a real OpenAI endpoint.
    approx_tokens = sum(max(1, len(t.split())) for t in texts)
    return EmbeddingsResponse(
        data=[EmbeddingItem(embedding=v, index=i) for i, v in enumerate(vectors)],
        model=MODEL_NAME,
        usage=Usage(prompt_tokens=approx_tokens, total_tokens=approx_tokens),
    )
