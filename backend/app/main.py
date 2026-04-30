import os
import re
import tempfile
from datetime import datetime
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Optional

import cohere
from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from dotenv import load_dotenv
from groq import Groq

from backend.app.ingestion.parsers import parse_pdf
from backend.app.sync.sync import sync_deleted_source, sync_single_file
from backend.app.vectorstore.milvus_store import get_or_create_collection, search

# ---------------------------------------------------------------------------
# ENV LOADING
# ---------------------------------------------------------------------------

SKIP_MILVUS = os.getenv("SKIP_MILVUS")

# if not SKIP_MILVUS:
#     get_col()


env_path = Path(__file__).resolve().parents[1] / ".env"
print("Loading .env from:", env_path)
load_dotenv(dotenv_path=env_path)

COHERE_API_KEY = os.getenv("COHERE_API_KEY", "")
GROQ_API_KEY = os.getenv("GROQ_API_KEY", "")

ALLOW_ORIGINS = os.getenv("ALLOW_ORIGINS", "*").split(",")
EMBED_MODEL = "embed-english-v3.0"
KNOWLEDGE_DIR = os.getenv("KNOWLEDGE_DIR", "knowledge")

_REPO_ROOT = Path(__file__).resolve().parents[2]

_collection = None


def get_col():
    global _collection
    if _collection is None:
        _collection = get_or_create_collection()
    return _collection


# ---------------------------------------------------------------------------
# APP SETUP
# ---------------------------------------------------------------------------
@asynccontextmanager
async def lifespan(app):
    if os.getenv("SKIP_MILVUS") == "true":
        print("Skipping Milvus connection (CI mode)")
    else:
        print("Connecting to Milvus...")
        get_col()
    yield

app = FastAPI(title="Synced Brain API", version="FINAL", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOW_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ---------------------------------------------------------------------------
# SCHEMAS
# ---------------------------------------------------------------------------
class QueryRequest(BaseModel):
    question: str
    top_k: int = 3
    filters: Optional[dict] = None
    debug: bool = False


class CitationItem(BaseModel):
    source: str
    chunk_index: int
    text: str
    score: Optional[float] = None


class QueryResponse(BaseModel):
    answer: str
    citations: list[CitationItem]
    retrieval: Optional[dict] = None


class UploadResponse(BaseModel):
    status: str
    source: str
    action: str
    chunks: int


# ---------------------------------------------------------------------------
# HELPERS
# ---------------------------------------------------------------------------
def _slugify_filename_stem(name: str) -> str:
    stem = Path(name).stem.lower()
    stem = re.sub(r"[^a-z0-9._-]+", "-", stem)
    return stem or "file"


def _build_markdown_from_upload(filename: str, content: bytes) -> str:
    ext = Path(filename).suffix.lower()

    if ext == ".pdf":
        with tempfile.NamedTemporaryFile(suffix=".pdf", delete=True) as temp:
            temp.write(content)
            temp.flush()
            pages = parse_pdf(temp.name)

        return "\n\n".join([p["text"] for p in pages])

    return content.decode("utf-8").strip()


# ---------------------------------------------------------------------------
# ENDPOINTS
# ---------------------------------------------------------------------------
@app.get("/health")
def health():
    return {"status": "ok"}

@app.get("/")
def root():
    return {"message": "CI/CD is hopefully working"}

# -------------------- QUERY --------------------
@app.post("/query", response_model=QueryResponse)
def query_brain(req: QueryRequest):

    # 1. Embedding
    try:
        co = cohere.Client(COHERE_API_KEY)
        emb = co.embed(
            texts=[req.question],
            model=EMBED_MODEL,
            input_type="search_query",
        )
        query_vec = emb.embeddings[0]
    except Exception as e:
        raise HTTPException(500, f"Embedding failed: {e}")

    # 2. Search
    col = get_col()
    hits = search(col, query_vec, top_k=req.top_k)

    # 3. Filter
    hits = [h for h in hits if h["score"] > 0.5]

    # 4. No hallucination
    if not hits:
        return QueryResponse(
            answer="Not found in knowledge base.",
            citations=[],
            retrieval={"raw_chunks": []},
        )

    # 5. Context
    context = "\n\n".join([h["chunk_text"] for h in hits])

    prompt = f"""
Use ONLY the context below.
If answer not found, say: Not found in knowledge base.

Context:
{context}

Question: {req.question}
Answer:
"""

    # 6. LLM
    try:
        client = Groq(api_key=GROQ_API_KEY)
        res = client.chat.completions.create(
            model="llama-3.1-8b-instant",
            messages=[{"role": "user", "content": prompt}],
        )
        answer = res.choices[0].message.content.strip()
    except Exception as e:
        answer = f"LLM error: {e}"

    # 7. Citations
    citations = [
        CitationItem(
            source=h["source"],
            chunk_index=h["chunk_index"],
            text=h["chunk_text"],
            score=round(h["score"], 4),
        )
        for h in hits
    ]

    # 🔥 RAW DB DATA (IMPORTANT FOR MARKS)
    retrieval = {
        "raw_chunks": [
            {
                "source": h["source"],
                "chunk_text": h["chunk_text"],
                "score": round(h["score"], 4),
            }
            for h in hits
        ]
    }

    return QueryResponse(answer=answer, citations=citations, retrieval=retrieval)


# -------------------- UPLOAD --------------------
@app.post("/upload", response_model=UploadResponse)
async def upload_file(file: UploadFile = File(...)):
    content = await file.read()
    markdown = _build_markdown_from_upload(file.filename, content)

    uploads_dir = (_REPO_ROOT / KNOWLEDGE_DIR / "uploads")
    uploads_dir.mkdir(parents=True, exist_ok=True)

    filename = f"{_slugify_filename_stem(file.filename)}-{int(datetime.utcnow().timestamp())}.md"
    path = uploads_dir / filename

    path.write_text(markdown, encoding="utf-8")

    result = sync_single_file(str(path))

    return UploadResponse(
        status="ok",
        source=result["source"],
        action=result["action"],
        chunks=result["chunks"],
    )


# -------------------- LIST FILES --------------------
@app.get("/uploads")
def list_uploads():
    try:
        uploads_dir = (_REPO_ROOT / KNOWLEDGE_DIR / "uploads")
        uploads_dir.mkdir(parents=True, exist_ok=True)

        files = []
        for f in uploads_dir.glob("*.md"):
            files.append({
                "name": f.name,
                "source": f"{KNOWLEDGE_DIR}/uploads/{f.name}",
                "size_bytes": f.stat().st_size,
                "modified_at": datetime.utcfromtimestamp(f.stat().st_mtime).isoformat() + "Z",
            })

        return {"status": "ok", "files": files}

    except Exception as e:
        raise HTTPException(500, f"List uploads failed: {e}")


# -------------------- DELETE --------------------
@app.delete("/uploads/{filename}")
def delete_upload(filename: str):
    try:
        uploads_dir = (_REPO_ROOT / KNOWLEDGE_DIR / "uploads")
        path = uploads_dir / filename

        if not path.exists():
            raise HTTPException(404, "File not found")

        path.unlink()
        sync_deleted_source(f"{KNOWLEDGE_DIR}/uploads/{filename}")

        return {"status": "ok", "deleted": filename}

    except Exception as e:
        raise HTTPException(500, f"Delete failed: {e}")