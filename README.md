# Financial-Sector Requirements Engineering Assistant

The project is a requirements engineering assistant for software across the financial sector, with a domain-aware architecture that can be extended across financial services. Trade Finance / Letter of Credit is one representative domain and the seeded project example; this does not claim complete domain knowledge or functionality for every service. Phase 4 provides project-independent, source-linked evidence retrieval. Phase 5 adds candidate requirement extraction from READY project inputs using a configurable local generative LLM. It does not perform requirement quality analysis, regulatory conclusions, or financial operations.

## Architecture

```text
React + Vite frontend (127.0.0.1:5173)
        │ HTTP / JSON
        ▼
Node.js + Express API (localhost:4000)
        ├── PostgreSQL + pgvector (localhost:5432)
        └── Ollama local model APIs (localhost:11434; separate embedding and generation models)
```

The frontend uses the API for application data. The API owns validation, extraction and database access. Ollama generates pretrained local text embeddings; pgvector stores and searches them alongside source-linked chunks. Financial-domain metadata supports filtering evidence within the shared knowledge base. The seeded example project is “Trade Finance / Letter of Credit Requirements Project”.

## Technology

- Frontend: React 18, Vite 5, React Router 6, JavaScript
- Backend: Node.js ES modules, Express 4, `pg`, `dotenv`, and `cors`
- Database: PostgreSQL 16 with pgvector, initialized by an idempotent SQL script
- Local embeddings: Ollama with `embeddinggemma` (768 dimensions)
- Local database: Docker Compose with a named persistent volume

## Project structure

```text
backend/
  scripts/init-db.js       # repeatable schema initialization command
  src/
    app.js                 # Express app, CORS, routes, error handling
    config.js              # environment configuration
    db/pool.js             # PostgreSQL pool
    middleware/            # centralized error responses
    routes/                # health, projects, inputs, users, knowledge, and requirements APIs
  test/                    # API, project, input, knowledge-base, and extraction tests
database/schema.sql        # application tables and representative Trade Finance project
docs/
  phase-1-use-case-definition.md
  phase-2-application-foundation.md
  phase-3-input-document-processing.md
  phase-4-knowledge-base-rag-foundation.md
  phase-5-llm-requirement-extraction.md
frontend/
  src/                     # React app, pages, components, API client, styles
  vite.config.js
docker-compose.yml         # PostgreSQL only
.env.example
```

## Prerequisites

- Node.js 20 or later and npm
- Docker Desktop with Docker Compose enabled
- Ollama 0.11.10 or later with `embeddinggemma` downloaded

No local PostgreSQL installation is required. Packages are installed independently in `backend` and `frontend`; each has its own lockfile.

## Setup and run

1. Copy `.env.example` to `.env` in the repository root. Change `POSTGRES_PASSWORD` to a local password, and set `DATABASE_PASSWORD` to the same value. `.env` is ignored by Git.
2. Copy `frontend/.env.example` to `frontend/.env.local` if the API is not at its default URL. These frontend values are public configuration; do not put secrets in them.
3. Install packages:

   ```powershell
   npm --prefix backend install
   npm --prefix frontend install
   ```

4. Pull the pgvector PostgreSQL image and start PostgreSQL (the named PostgreSQL volume remains in use):

   ```powershell
   docker compose pull postgres
   docker compose up -d --force-recreate postgres
   docker compose ps
   ```

5. Download the local embedding model:

   ```powershell
   ollama pull embeddinggemma
   ```

6. Initialize the schema and seeded representative Trade Finance / LC project:

   ```powershell
   npm run db:init
   ```

   The script is repeatable and does not delete existing records.

7. In one terminal, start the API:

   ```powershell
   npm run dev:backend
   ```

8. In another terminal, start the frontend:

   ```powershell
   npm run dev:frontend
   ```

9. Open `http://127.0.0.1:5173`. The dashboard and projects page load rows through the API. Visit Knowledge Base to upload PDF/DOCX/TXT reference documents, inspect chunks, and search for source-linked evidence.

## Environment variables

| Variable | Used by | Purpose |
|---|---|---|
| `POSTGRES_DB` | Compose | Database created by the PostgreSQL container |
| `POSTGRES_USER` | Compose | Local database user |
| `POSTGRES_PASSWORD` | Compose | Local database password; replace the example value |
| `DATABASE_HOST` | API | Database hostname from the API process (usually `localhost`) |
| `DATABASE_PORT` | Compose and API | Host port mapped to PostgreSQL, and API connection port |
| `DATABASE_NAME` | API | Database name (usually same as `POSTGRES_DB`) |
| `DATABASE_USER` | API | Database user (usually same as `POSTGRES_USER`) |
| `DATABASE_PASSWORD` | API | Password (set to same local value as `POSTGRES_PASSWORD`) |
| `API_PORT` | API | HTTP port for Express (default `4000`) |
| `FRONTEND_ORIGIN` | API | Allowed local browser origin (default `http://127.0.0.1:5173`) |
| `VITE_API_BASE_URL` | Frontend | API base URL (default `http://localhost:4000/api`) |
| `OLLAMA_BASE_URL` | API | Local Ollama server base URL (default `http://localhost:11434`) |
| `OLLAMA_EMBEDDING_MODEL` | API | Ollama embedding model; must produce 768 dimensions (default `embeddinggemma`) |
| `OLLAMA_TIMEOUT_MS` | API | Embedding request timeout (default `120000`) |
| `OLLAMA_GENERATION_BASE_URL` | API | Ollama chat API base URL for requirement extraction (default `http://localhost:11434`) |
| `OLLAMA_GENERATION_MODEL` | API | Generative model for Phase 5 (default `qwen2.5:3b`; install manually, never downloaded by the app) |
| `OLLAMA_GENERATION_TIMEOUT_MS` | API | Generation request timeout (default `120000`) |
| `KB_DOCUMENT_EMBEDDING_PREFIX` | API | Document embedding task prefix/template |
| `KB_QUERY_EMBEDDING_PREFIX` | API | Search query embedding task prefix/template |
| `KB_UPLOAD_STORAGE_DIR` | API | Generated-name reference file storage directory |
| `KB_MAX_CHUNK_CHARS` | API | Deterministic chunk window (default `1200`) |
| `KB_CHUNK_OVERLAP_CHARS` | API | Chunk overlap (default `150`) |
| `KB_MAX_SEARCH_TOP_K` | API | Maximum search result count (default `20`) |

Vite reads `frontend/.env.local`. Only `VITE_` variables are exposed to browser code; never put secrets in such variables.

Uploaded files are stored under `storage/uploads` (ignored by Git) with generated storage names. Defaults are 10 MiB per file, 100,000 characters per text input, 1,000,000 extracted characters, and 200 PDF pages. These limits can be changed with `UPLOAD_STORAGE_DIR`, `MAX_UPLOAD_BYTES`, `MAX_INPUT_CHARS`, `MAX_EXTRACTED_CHARS`, and `MAX_PDF_PAGES`. Extraction is deterministic text extraction; scanned-image OCR and semantic analysis are not implemented. See [Phase 3 documentation](docs/phase-3-input-document-processing.md) for lifecycle, verification, and limitations.

## API endpoints

All endpoints are under `/api` and return JSON.

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/health` | API status |
| `GET` | `/api/health/db` | Database connectivity status |
| `GET` | `/api/projects` | List projects |
| `GET` | `/api/projects/:id` | Retrieve a project by UUID |
| `POST` | `/api/projects` | Create a project (`name`, optional `description`, `selectedDomain`, `ownerId`) |
| `POST` | `/api/projects/:projectId/inputs` | Add project text (`title`, `source`, `inputType`, `content`) |
| `POST` | `/api/projects/:projectId/inputs/documents` | Upload a PDF, DOCX, or TXT document (multipart `file`, `title`, `source`) |
| `GET` | `/api/projects/:projectId/inputs` | List inputs attached to a project |
| `GET` | `/api/inputs/:id` | Retrieve input metadata and processing status |
| `GET` | `/api/inputs/:id/content` | Retrieve submitted or extracted text |
| `GET` | `/api/users` | List development user/role records |
| `POST` | `/api/users` | Create a development user/role record (`displayName`, `email`, optional `role`) |
| `POST` | `/api/knowledge/documents` | Upload and ingest one PDF, DOCX, or TXT reference with metadata |
| `GET` | `/api/knowledge/documents` | List knowledge document metadata and chunk counts |
| `GET` | `/api/knowledge/documents/:id` | Retrieve knowledge document metadata and extracted text |
| `GET` | `/api/knowledge/documents/:id/chunks` | Retrieve ordered chunks with source-document metadata |
| `POST` | `/api/knowledge/search` | Retrieve semantically relevant evidence chunks and source metadata |
| `POST` | `/api/projects/:projectId/requirements/extract` | Extract candidates from a READY input (`inputId`) |
| `GET` | `/api/projects/:projectId/requirements` | List candidate requirements for a project with source-input references |
| `GET` | `/api/requirements/:id` | Retrieve one candidate with evidence and source-input metadata |

Knowledge document uploads require a `financialDomain` from the supported domain taxonomy. Search may include `filters.financialDomain` to restrict retrieval; without it, the shared knowledge base is searched across domains. See [Phase 4 documentation](docs/phase-4-knowledge-base-rag-foundation.md) for the supported values and API details. Phase 5 extraction uses `OLLAMA_GENERATION_MODEL`, separate from the Phase 4 embedding model; see [Phase 5 documentation](docs/phase-5-llm-requirement-extraction.md) for setup and behavior.

Supported project statuses are `DRAFT`, `ACTIVE`, and `ARCHIVED`. Supported role labels are `ADMIN`, `BUSINESS_STAKEHOLDER`, `REQUIREMENTS_ENGINEER`, `TECHNICAL_STAKEHOLDER`, `COMPLIANCE`, `SECURITY`, `RISK`, `PROJECT_MANAGER`, and `APPROVER`.

## Verification

Run the frontend production build and backend request-validation tests:

```powershell
npm run build:frontend
npm test --prefix backend
```

With Docker running, the end-to-end check is: start Compose, run `npm run db:init`, start the API and frontend, verify `/api/health` and `/api/health/db`, create a project in the UI, and verify it appears in the project list and detail view after a reload. The database-backed flow requires Docker/PostgreSQL and cannot be replaced by static frontend data.

Phase 4 setup and verification details are in [the Phase 4 documentation](docs/phase-4-knowledge-base-rag-foundation.md).

## Intentionally deferred

This foundation does not include production authentication/authorization, MFA, autonomous agents, requirement quality/classification analysis, clarification, compliance/security/risk decisions, approval workflows, SRS/story/acceptance criteria generation, hallucination detection, SDLC recommendations, advanced audit, or deployment of a banking system. Phase 5 candidate extraction is source-based only and is not RAG-enabled analysis. User records and role labels are data-model foundations only; they do not enforce access control.
