import os
import threading
import uuid
from pathlib import Path
from typing import Dict, List, Optional

import boto3
from dotenv import load_dotenv
from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from langchain_aws import BedrockEmbeddings, ChatBedrockConverse
from langchain_community.document_loaders import PyPDFDirectoryLoader, PyPDFLoader
from langchain_community.vectorstores import FAISS
from langchain_text_splitters import RecursiveCharacterTextSplitter
from langchain_core.messages import AIMessage, HumanMessage
from langchain_core.prompts import ChatPromptTemplate, MessagesPlaceholder
from langchain_classic.chains import create_history_aware_retriever
from pydantic import BaseModel, Field

load_dotenv()

REGION = os.getenv("AWS_REGION", "ap-southeast-2")
MODEL_ID = os.getenv("BEDROCK_MODEL_ID", "mistral.mistral-large-2402-v1:0")
EMBEDDING_ID = os.getenv("BEDROCK_EMBEDDING_MODEL_ID", "amazon.titan-embed-text-v2:0")
BASE_DIR = Path(__file__).resolve().parents[1]
DATA_DIR = Path(os.getenv("DATA_DIR", str(BASE_DIR / "data"))).expanduser().resolve()
CHUNK_SIZE = int(os.getenv("CHUNK_SIZE", "1000"))
CHUNK_OVERLAP = int(os.getenv("CHUNK_OVERLAP", "150"))
RETRIEVAL_K = int(os.getenv("RETRIEVAL_K", "3"))
MAX_UPLOAD_MB = int(os.getenv("MAX_UPLOAD_MB", "25"))

DATA_DIR.mkdir(parents=True, exist_ok=True)
bedrock = boto3.client("bedrock-runtime", region_name=REGION)

app = FastAPI(title="Retrieva_AI RAG API")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Demo session storage. Use Redis or a database for production deployments.
histories= {}
history_lock = threading.Lock() ## threading.Lock() is used in Python to prevent multiple threads from modifying shared data at the same time.

# The in-memory FAISS index is built lazily and updated whenever a PDF is uploaded.
vector_store = None
vector_store_lock = threading.RLock()


class ChatRequest(BaseModel):
    session_id: str = Field(min_length=1, max_length=128)
    question: str = Field(min_length=1, max_length=8000)


class ChatResponse(BaseModel):
    answer: str
    sources: list
    standalone_question: Optional[str] = None


def get_embeddings():
    return BedrockEmbeddings(model_id=EMBEDDING_ID, region_name=REGION)


def split_documents(documents):
    splitter = RecursiveCharacterTextSplitter(
        chunk_size=CHUNK_SIZE,
        chunk_overlap=CHUNK_OVERLAP,
    )
    return splitter.split_documents(documents)


def get_vector_store():
    """Load all saved PDFs once when the first chat request arrives."""
    global vector_store
    with vector_store_lock:
        if vector_store is not None:
            return vector_store

        pdf_paths = list(DATA_DIR.glob("*.pdf"))
        if not pdf_paths:
            raise HTTPException(
                status_code=400,
                detail="Your PDF knowledge base is empty. Upload PDF documents to get started.",
            )

        documents = PyPDFDirectoryLoader(str(DATA_DIR)).load()
        chunks = split_documents(documents)
        if not chunks:
            raise HTTPException(
                status_code=400,
                detail="No readable text was found in the PDF documents. Please upload text-based PDFs.",
            )

        vector_store = FAISS.from_documents(chunks, get_embeddings())
        return vector_store


def get_chat_model():
    """Create the LangChain chat model backed by Amazon Bedrock."""
    return ChatBedrockConverse(
        model=MODEL_ID,
        region_name=REGION,
        temperature=0.2,
        max_tokens=700,
    )


def convert_history_to_messages(history: List[dict]):
    """Convert stored role/content dictionaries into LangChain messages."""
    messages = []

    for message in history[-10:]:
        if message["role"] == "user":
            messages.append(HumanMessage(content=message["content"]))
        elif message["role"] == "assistant":
            messages.append(AIMessage(content=message["content"]))

    return messages


def get_history_aware_retriever(retriever):
    """Create a retriever that rewrites follow-up questions using chat history."""
    contextualize_prompt = ChatPromptTemplate.from_messages([
        (
            "system",
            "Given the conversation history and the latest user question, "
            "rewrite the latest question as a standalone question that can be "
            "understood without the conversation history. If it is already "
            "standalone, return it unchanged. Do not answer the question. "
            "Return only the standalone question."
        ),
        MessagesPlaceholder("chat_history"),
        ("human", "{input}"),
    ])

    return create_history_aware_retriever(
        get_chat_model(),
        retriever,
        contextualize_prompt,
    )


def generate_answer(question: str, context: str) -> str:
    """Generate an answer grounded in the retrieved PDF context."""
    prompt = f"""
You are a document-grounded assistant. Answer using only the retrieved context.
If the answer is not supported by the context, say:
"I don't know based on the provided documents."

Retrieved context:
{context or "No relevant context was retrieved."}

Original user question:
{question}

Answer:
"""
    response = get_chat_model().invoke(prompt)
    return response.content.strip()


@app.get("/api/health")
def health():
    return {"status": "ok", "region": REGION, "model": MODEL_ID}


@app.get("/api/documents")
def list_documents():
    """Return the PDFs currently saved in the knowledge-base folder."""
    files = sorted(DATA_DIR.glob("*.pdf"), key=lambda path: path.name.lower())
    return {
        "documents": [
            {"name": path.name, "size_bytes": path.stat().st_size}
            for path in files
        ]
    }


@app.post("/api/upload")
async def upload_pdfs(files: List[UploadFile] = File(...)):
    """Save PDFs, extract and chunk text, embed it, and add it to FAISS."""
    global vector_store

    if not files:
        raise HTTPException(status_code=400, detail="Select at least one PDF file.")

    uploaded = []
    saved_paths = []

    for upload in files:
        original_name = Path(upload.filename or "document.pdf").name
        if not original_name.lower().endswith(".pdf"):
            raise HTTPException(status_code=400, detail=f"{original_name} is not a PDF file.")

        content = await upload.read()
        if not content:
            raise HTTPException(status_code=400, detail=f"{original_name} is empty.")
        if len(content) > MAX_UPLOAD_MB * 1024 * 1024:
            raise HTTPException(
                status_code=413,
                detail=f"{original_name} exceeds the {MAX_UPLOAD_MB} MB upload limit.",
            )
        if not content.startswith(b"%PDF-"):
            raise HTTPException(status_code=400, detail=f"{original_name} is not a valid PDF file.")

        safe_stem = Path(original_name).stem[:80]
        stored_name = f"{safe_stem}_{uuid.uuid4().hex[:8]}.pdf"
        destination = DATA_DIR / stored_name
        destination.write_bytes(content)
        saved_paths.append(destination)

        try:
            documents = PyPDFLoader(str(destination)).load()
            chunks = split_documents(documents)
            if not chunks:
                raise ValueError("No readable text was found. The PDF may be scanned or image-only.")

            # Locking prevents concurrent uploads from overwriting one another's index updates.
            with vector_store_lock:
                if vector_store is None:
                    # If PDFs were already present before the first upload, index them too.
                    existing_paths = [p for p in DATA_DIR.glob("*.pdf") if p != destination]
                    existing_chunks = []
                    if existing_paths:
                        existing_docs = PyPDFDirectoryLoader(str(DATA_DIR)).load()
                        existing_chunks = split_documents(
                            [doc for doc in existing_docs if Path(doc.metadata.get("source", "")).resolve() != destination.resolve()]
                        )
                    if existing_chunks:
                        vector_store = FAISS.from_documents(existing_chunks, get_embeddings())
                        vector_store.add_documents(chunks)
                    else:
                        vector_store = FAISS.from_documents(chunks, get_embeddings())
                else:
                    vector_store.add_documents(chunks)

            uploaded.append({"name": stored_name, "chunks": len(chunks)})

        except Exception as exc:
            # Do not leave an unreadable/failed upload in the folder.
            try:
                destination.unlink(missing_ok=True)
            except OSError:
                pass
            raise HTTPException(status_code=400, detail=f"Could not process {original_name}: {exc}") from exc

    return {
        "message": f"Successfully processed {len(uploaded)} PDF file(s).",
        "uploaded": uploaded,
    }


@app.post("/api/chat", response_model=ChatResponse)
def chat(req: ChatRequest):
    question = req.question.strip()
    if not question:
        raise HTTPException(status_code=400, detail="Question cannot be empty.")

    with history_lock:
        history = list(histories.get(req.session_id, []))

    try:
        store = get_vector_store()
        retriever = store.as_retriever(search_kwargs={"k": RETRIEVAL_K})
        history_aware_retriever = get_history_aware_retriever(retriever)
        chat_history = convert_history_to_messages(history)

        docs = history_aware_retriever.invoke({
            "input": question,
            "chat_history": chat_history,
        })

        context = "\\n\\n".join(doc.page_content for doc in docs)
        answer = generate_answer(question, context)

        sources, seen = [], set()
        for doc in docs:
            filename = Path(str(doc.metadata.get("source", "Unknown source"))).name
            page = doc.metadata.get("page")
            item = {"file": filename, "page": int(page) + 1 if page is not None else None}
            print(f"Retrieved source: {item}")
            key = (item["file"], item["page"])
            if key not in seen:
                seen.add(key)
                sources.append(item)

        with history_lock:
            current = histories.setdefault(req.session_id, [])
            current.extend([
                {"role": "user", "content": question},
                {"role": "assistant", "content": answer},
            ])
            histories[req.session_id] = current[-20:]

        return ChatResponse(
            answer=answer,
            sources=sources,
            # The history-aware retriever performs rewriting internally and
            # returns documents, not the rewritten query itself.
            standalone_question=None,
        )

    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.delete("/api/clear_chat/{session_id}")
def clear_chat(session_id: str):
    with history_lock:
        histories.pop(session_id, None)
    return {"status": "cleared"}
