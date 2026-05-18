from fastapi import FastAPI, HTTPException, Body
from pathlib import Path
from func import get_rough_token_count
from models import JinaRerankerResponse, JinaRerankerRequest
import os
import logging
import math
import re
import threading

LOG_LEVEL = os.getenv("JINA_RERANKER_LOG_LEVEL", "WARNING").upper()
logging.basicConfig(
    level=getattr(logging, LOG_LEVEL, logging.WARNING),
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)
logger = logging.getLogger(__name__)
for uvicorn_logger in ("uvicorn", "uvicorn.error", "uvicorn.access"):
    logging.getLogger(uvicorn_logger).setLevel(getattr(logging, LOG_LEVEL, logging.WARNING))

MODEL_NAME = os.getenv("MODEL_NAME", "jinaai/jina-reranker-v1-tiny-en")
CACHE_DIR = os.getenv("CACHE_DIR", str(Path(__file__).parent.absolute() / ".cache"))
MAX_BATCH_SIZE = max(1, int(os.getenv("JINA_RERANKER_MAX_BATCH_SIZE", "2")))
LOAD_MODEL = os.getenv("JINA_RERANKER_LOAD_MODEL", "0").lower() in ("1", "true", "yes")

encoder = None
encoder_error = None
encoder_lock = threading.Lock()


def _load_encoder():
    global encoder, encoder_error
    try:
        from fastembed.rerank.cross_encoder import TextCrossEncoder

        loaded = TextCrossEncoder(model_name=MODEL_NAME, cache_dir=CACHE_DIR)
        with encoder_lock:
            encoder = loaded
            encoder_error = None
        logger.info("Loaded Jina reranker model %s", MODEL_NAME)
    except Exception as e:
        with encoder_lock:
            encoder_error = str(e)
        logger.exception("Error initializing encoder with model %s", MODEL_NAME)


def _tokens(value):
    return set(re.findall(r"[a-z0-9]+", str(value).lower()))


def _fallback_rerank(query, documents):
    query_tokens = _tokens(query)
    scores = []
    for document in documents:
        document_tokens = _tokens(document)
        if not query_tokens or not document_tokens:
            scores.append(0.0)
            continue
        overlap = len(query_tokens & document_tokens)
        scores.append(overlap / math.sqrt(len(query_tokens) * len(document_tokens)))
    return scores


if LOAD_MODEL:
    threading.Thread(target=_load_encoder, name="jina-reranker-loader", daemon=True).start()

app = FastAPI()


@app.post("/librechat/v1/rerank", response_model=JinaRerankerResponse)
def rerank(request: JinaRerankerRequest = Body(...)):
    try:
        query = request.query
        documents = request.documents
        batch_size = min(request.batch_size, MAX_BATCH_SIZE)

        logger.debug(
            "Received rerank request query_chars=%d documents=%d batch_size=%d",
            len(query),
            len(documents),
            batch_size,
        )

        with encoder_lock:
            active_encoder = encoder

        if active_encoder is None:
            data = _fallback_rerank(query, documents)
            response_model = f"{MODEL_NAME}:lexical-fallback"
        else:
            data = active_encoder.rerank(query, documents, batch_size=batch_size)
            response_model = MODEL_NAME

        token_count = get_rough_token_count(query, documents)

        output_result = {
            "model": response_model,
            "usage": {"total_tokens": token_count},
            "results": [
                {
                    "index": i,
                    "relevance_score": float(score),
                    "document": documents[i],
                }
                for i, score in enumerate(data)
            ],
        }

        logger.debug(
            "Rerank completed results=%d total_tokens=%d",
            len(output_result["results"]),
            token_count,
        )

        return output_result
    except Exception as e:
        logger.exception("Rerank request failed: %s", e)
        raise HTTPException(status_code=500, detail="Error handling request")


@app.get("/health")
def health():
    with encoder_lock:
        ready = encoder is not None
        error = encoder_error
    return {
        "status": "ok",
        "model_enabled": LOAD_MODEL,
        "model_ready": ready,
        "fallback_ready": True,
        "error": error,
    }
