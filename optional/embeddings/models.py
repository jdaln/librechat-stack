"""OpenAI-compatible request/response schemas for /v1/embeddings.

Only the fields rag_api actually consumes are typed; everything else is
ignored. This keeps the surface area narrow and the validator forgiving
of upstream OpenAI clients that send extra fields.
"""

from typing import List, Optional, Union

from pydantic import BaseModel


class EmbeddingsRequest(BaseModel):
    # Accept either a single string or a list of strings, matching OpenAI.
    input: Union[str, List[str]]
    # Clients send a model field; this server has exactly one model loaded
    # (baked in at build time), so the field is informational only.
    model: Optional[str] = None
    # Accept-and-ignore: clients may send these; they don't apply here.
    encoding_format: Optional[str] = None
    dimensions: Optional[int] = None
    user: Optional[str] = None


class EmbeddingItem(BaseModel):
    object: str = "embedding"
    embedding: List[float]
    index: int


class Usage(BaseModel):
    prompt_tokens: int
    total_tokens: int


class EmbeddingsResponse(BaseModel):
    object: str = "list"
    data: List[EmbeddingItem]
    model: str
    usage: Usage
