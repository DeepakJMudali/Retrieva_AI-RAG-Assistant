# Retrieva_AI — React + FastAPI + Amazon Bedrock RAG

## Features
- Upload one or more PDF files from the React sidebar.
- FastAPI validates and saves PDFs in `backend/data`.
- PyPDF extracts text; RecursiveCharacterTextSplitter creates chunks.
- Amazon Titan embeddings are added to an in-memory FAISS index.
- New uploads are merged into the existing index; saved PDFs are re-indexed after a backend restart.
- Mistral Large on Amazon Bedrock answers questions using retrieved chunks.
- Conversation history is kept in memory by session ID (demo only).

## 1. Backend setup
Open a terminal in the `backend` directory:

```powershell
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
copy .env.example .env
```

Configure AWS credentials with an identity that can invoke the selected Bedrock chat and embedding models:

```powershell
aws configure
```

Edit `.env` if your AWS region or model IDs differ. Then start FastAPI:

```powershell
uvicorn app.main:app --reload --port 8000
```

Swagger docs: http://localhost:8000/docs

## 2. Frontend setup
Open a second terminal in `frontend`:

```powershell
npm install
npm run dev
```

Open http://localhost:5173.

## 3. Upload and chat
1. Wait for the API indicator to show `API connected`.
2. Click **Upload PDFs** in the left sidebar.
3. Select one or more PDF files (up to 25 MB each).
4. Wait for the success message. Text extraction, chunking, and Titan embedding happen during upload.
5. Ask a question in the chat composer.

The upload endpoint is `POST /api/upload` and accepts multipart form data with repeated `files` fields. `GET /api/documents` lists saved PDFs.

## Important implementation notes
- Uploaded PDFs are saved under `backend/data` and remain on disk across backend restarts.
- The FAISS index is held in memory. It is rebuilt from all PDFs in `backend/data` when the backend starts and the first chat request arrives. Uploading a PDF while the server is running adds its chunks to the current index.
- Scanned/image-only PDFs need OCR before they can be searched. This starter detects PDFs with no extractable text and reports a processing error.
- The 25 MB per-file limit is configurable with `MAX_UPLOAD_MB`.
- Chat history is in-memory only and is lost when the backend restarts. Use a database/Redis for production.
- For production, add authentication, per-user storage isolation, upload quotas, malware scanning, durable vector storage, and background ingestion for large PDFs.
