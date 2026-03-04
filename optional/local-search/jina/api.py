from fastapi import FastAPI, HTTPException, Body
from fastembed.rerank.cross_encoder import TextCrossEncoder
from pathlib import Path
from func import get_rough_token_count
from models import JinaRerankerResponse, JinaRerankerRequest
import os
import logging

logger = logging.getLogger(__name__)

MODEL_NAME = os.getenv("MODEL_NAME", "jinaai/jina-reranker-v1-tiny-en")
CACHE_DIR = os.getenv("CACHE_DIR", str(Path(__file__).parent.absolute() / ".cache"))
MAX_BATCH_SIZE = max(1, int(os.getenv("JINA_RERANKER_MAX_BATCH_SIZE", "2")))

try:
    encoder = TextCrossEncoder(model_name=MODEL_NAME, cache_dir=CACHE_DIR)
except Exception as e:
    raise RuntimeError(f"Error initializing encoder with model {MODEL_NAME} - {str(e)}")

app = FastAPI()


@app.post("/librechat/v1/rerank", response_model=JinaRerankerResponse)
def rerank(request: JinaRerankerRequest = Body(...)):
    try:
        query = request.query
        documents = request.documents
        batch_size = min(request.batch_size, MAX_BATCH_SIZE)

        logger.info("## Query ##")
        logger.info(query)
        logger.info("## Document count ##")
        logger.info(len(documents))

        data = encoder.rerank(query, documents, batch_size=batch_size)
        token_count = get_rough_token_count(query, documents)

        output_result = {
            "model": MODEL_NAME,
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

        logger.info("## Result ##")
        logger.info(output_result)

        return output_result
    except Exception as e:
        logger.error(str(e))
        raise HTTPException(status_code=500, detail="Error handling request")


@app.get("/health")
def health():
    return {"status": "ok"}
