ARG JINA_RERANKER_BASE_IMAGE=librechat-jina-reranker:da638699-tiny-en
FROM ${JINA_RERANKER_BASE_IMAGE}

COPY optional/local-search/jina/main.py /app/main.py
COPY optional/local-search/jina/api.py /app/api.py
COPY optional/local-search/jina/models.py /app/models.py
