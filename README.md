# Financial-Sector Requirements Engineering Assistant

The project is a requirements engineering assistant for financial services. Phase 4 provides project-independent source-linked retrieval. Agent 1, Requirements Intelligence, consolidates requirement extraction and analysis into one bounded structured generation request per selected READY input. It uses the shared provider layer and Phase 4 retrieval, preserves exact source evidence, and stores advisory findings, clarification questions, confidence, and citations. Security/privacy/risk/policy observations are not binding legal or regulatory conclusions. Agent 2 (SDLC and documentation) is planned for a later phase.

## Architecture

```text
React + Vite frontend (127.0.0.1:5173)
        │ HTTP / JSON
        ▼
Node.js + Express API (localhost:4000)
        ├── PostgreSQL + pgvector (localhost:5432)
        ├── Shared LLM generation provider (Gemini → Groq → Ollama)
        └── Ollama + EmbeddingGemma (separate embedding service)

```

The frontend uses the API for application data. The API owns validation, deterministic orchestration, and database access. The shared server-side generation provider supports Gemini through the official `@google/genai` SDK, Groq, and local Ollama. Requirements Intelligence pins each operation to the configured provider and makes one generation request; provider retry/fallback is disabled for this operation. Ollama `embeddinggemma` remains separate for Phase 4 embeddings and pgvector retrieval. The deterministic demo project is available through `npm run seed:demo`.

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
  scripts/seed-demo.js     # idempotent PostgreSQL demo project and KB seed
  src/
    app.js                 # Express app, CORS, routes, error handling
    config.js              # environment configuration
    db/pool.js             # PostgreSQL pool
    middleware/            # centralized error responses
    routes/                # health, projects, inputs, users, knowledge, and requirements APIs
    services/              # unified requirements intelligence, shared generation, RAG and validation
  test/                    # API, project, input, knowledge-base, extraction, and analysis tests
database/schema.sql        # application tables and representative Trade Finance project
test-data/requirements/    # synthetic project-input fixtures; not Knowledge Base sources
docs/
  phase-1-use-case-definition.md
  phase-2-application-foundation.md
  phase-3-input-document-processing.md
  phase-4-knowledge-base-rag-foundation.md
  phase-5-llm-requirement-extraction.md
  requirements-intelligence.md
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
| `LLM_GENERATION_PROVIDER` | API | Configured generation provider used by Requirements Intelligence (default `gemini`) |
| `LLM_GENERATION_FALLBACKS` | API | Ordered comma-separated fallbacks (default `groq,ollama` for Gemini) |
| `LLM_GENERATION_RETRY_ATTEMPTS` | API | Bounded attempts for transient failures (default `2`, maximum `3`) |
| `LLM_GENERATION_RETRY_MAX_DELAY_MS` | API | Maximum retry delay (default `1500`, maximum `3000`) |
| `LLM_PROVIDER_HEALTH_CACHE_MS` | API | Brief cache for failed provider health during adjacent requests (default `45000`, maximum `120000`) |
| `GROQ_API_KEY` | API | Groq API key; keep it in the backend `.env`, never in frontend variables or source |
| `GROQ_BASE_URL` | API | Groq OpenAI-compatible API base URL (default `https://api.groq.com/openai/v1`) |
| `GROQ_MODEL` | API | Groq generation model (default `openai/gpt-oss-20b`) |
| `GEMINI_API_KEY` | API | Gemini API key; keep it in the backend `.env`, never in frontend variables or source |
| `GEMINI_MODEL` | API | Gemini generation model (default `gemini-3.8-flash`) |

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
| `POST` | `/api/projects` | Create a project (
ame`, optional `description`, `selectedDomain`, `ownerId`) |
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
| `POST` | `/api/projects/:projectId/requirements/intelligence` | Extract and analyze one READY input in one generation request (`inputId`) |
| `POST` | `/api/projects/:projectId/requirements/extract` | Compatibility alias for the unified intelligence operation |
| `GET` | `/api/projects/:projectId/requirements` | List candidate requirements for a project with source-input references |
| `GET` | `/api/requirements/:id` | Retrieve one candidate with evidence and source-input metadata |
| `GET` | `/api/projects/:projectId/requirements/analysis` | Retrieve the latest successful analysis and findings |
| `GET` | `/api/requirements/:id/analysis` | Retrieve current analysis findings for one candidate |

Knowledge document uploads require a `financialDomain` from the supported domain taxonomy. Search may include `filters.financialDomain` to restrict retrieval; without it, the shared knowledge base is searched across domains. See [Phase 4 documentation](docs/phase-4-knowledge-base-rag-foundation.md). Gemini uses the official `@google/genai` SDK and structured JSON output. Each Requirements Intelligence operation uses the configured provider once; quota, overload, and timeout errors are provider-neutral. The demo KB corpus is labelled `DEMO / NON-AUTHORITATIVE`. See [Requirements Intelligence documentation](docs/requirements-intelligence.md).

Supported project statuses are `DRAFT`, `ACTIVE`, and `ARCHIVED`. Supported role labels are `ADMIN`, `BUSINESS_STAKEHOLDER`, `REQUIREMENTS_ENGINEER`, `TECHNICAL_STAKEHOLDER`, `COMPLIANCE`, `SECURITY`, `RISK`, `PROJECT_MANAGER`, and `APPROVER`.

## Verification

Run the frontend production build and backend request-validation tests:

```powershell
npm run build:frontend
npm test --prefix backend
```

With PostgreSQL running, initialize and seed the database with `npm run db:init` and `npm run seed:demo`, then start the API and frontend. Verify `/api/health` and `/api/health/db`, open the “Requirements Intelligence Financial Services Demo” project, choose a READY input, and run Requirements Intelligence. The seeded project and knowledge notes are real PostgreSQL records; the UI does not use static project mocks.

Phase 4 setup and verification details are in [the Phase 4 documentation](docs/phase-4-knowledge-base-rag-foundation.md).

## Intentionally deferred

This foundation does not include production authentication/authorization, MFA, autonomous planning or recursive agent spawning, approval workflows, SRS/story/acceptance-criteria generation, advanced audit, or deployment of a banking system. Requirements Intelligence provides advisory requirement extraction and analysis, including retrieval-grounded policy/security/privacy/risk observations; it does not make binding legal/regulatory decisions. Agent 2 SDLC recommendations and documentation are deferred. User records and role labels are data-model foundations only; they do not enforce access control.
