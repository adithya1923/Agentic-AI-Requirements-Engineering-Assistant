# Phase 4: Knowledge Base and RAG Foundation

## 1. Objective

Provide a project-independent, financial-sector-wide knowledge and evidence retrieval foundation capable of organizing trusted reference material across multiple financial-service domains. Trade Finance/Letter of Credit is one representative supported domain. The architecture can be extended with domain-specific knowledge and workflows; it does not claim complete domain knowledge or functionality for every service. Phase 4 returns relevant source chunks through retrieval APIs; it does not generate requirements, regulatory conclusions, or answers with an LLM.

## 2. Architecture

The shared knowledge base organizes reference documents from financial-sector domains with financial-domain metadata. The Express API reuses Phase 3 deterministic extraction, creates chunks, requests pretrained local embeddings from Ollama, and persists document metadata, chunks, and vectors in PostgreSQL with pgvector. The React Knowledge Base page supports ingestion, document inspection, and evidence search. Domain filtering lets later agents and workflows retrieve applicable evidence from the shared index. The named PostgreSQL volume remains the existing database volume.

```text
Financial services: Banking · Loans · Payments · Fraud · Insurance · KYC · Investment · Reporting · Trade Finance · …
                                  │
                                  ▼
                         Shared knowledge base
             documents + domain metadata + source traceability
                                  │
                 Phase 3 extraction → deterministic chunking
                                  │
                       Ollama embeddings (768d)
                                  │
                       PostgreSQL + pgvector
                                  │
                                  ▼
              Domain-aware retrieval → evidence chunks
                                  ▲
                                  │
                   React UI ← Express API
```

No agent or LLM answer-generation call is made.

## 3. Knowledge document schema

`knowledge_documents` has a UUID, title, source, document type, required financial domain for new uploads, optional jurisdiction/version/effective date/authority/tags, original filename, MIME type, size, generated storage key, extracted text, status/error, and timestamps. Document types cover regulatory material, organizational policy, business/domain reference, risk/control reference, legacy-system documentation, educational reference, and other. These categories do not assert that a document is authoritative. Documents are not attached to projects. Existing pre-taxonomy rows remain unclassified during schema upgrade until an operator assigns their actual domain; they are not silently labelled cross-domain.

## 4. Financial Domain Taxonomy

Financial-domain metadata records the intended service context of each knowledge document. It supports organization, inspection, and later domain-aware evidence retrieval over the project-independent shared knowledge base. `GENERAL_FINANCIAL` is reserved for material that genuinely applies across domains; it is not a default. `TRADE_FINANCE` remains one representative supported domain, not the system's exclusive scope.

Supported values are `GENERAL_FINANCIAL`, `DIGITAL_BANKING`, `LOANS_CREDIT`, `PAYMENTS`, `FRAUD_DETECTION`, `INSURANCE`, `INVESTMENT`, `REGULATORY_REPORTING`, `CUSTOMER_ONBOARDING_KYC`, `FINANCIAL_DATA_ANALYTICS`, `TRADE_FINANCE`, and `OTHER_FINANCIAL`. Upload validation and PostgreSQL constraints enforce the controlled vocabulary for new data. Each document's domain is returned in list/detail/chunk inspection and search evidence. Search can optionally filter to one domain; with no domain filter it can search across classified financial documents in the shared index. Existing unclassified legacy documents remain listable for review but do not participate in retrieval until assigned their actual domain. Later agents may use the returned domain and source links when selecting evidence appropriate to a target project. This metadata does not itself establish authority or applicability.

## 5. Ingestion pipeline

The synchronous upload lifecycle is `RECEIVED` → `PROCESSING` → `READY`, or `FAILED`. The API validates metadata, filename, extension/MIME type, size, and date; stores uploaded bytes under a generated UUID filename in the ignored `storage/knowledge` directory; extracts text; chunks it; requests embeddings; and writes all chunks/vectors and the final ready state in one database transaction. Failures keep a `FAILED` document record and safe error message. No placeholder text or embedding is generated on failure.

## 6. Extraction

PDF, DOCX, and TXT use the existing Phase 3 extraction service (PDF.js, Mammoth, UTF-8 TXT). Extraction is text-only; image OCR is excluded. Empty or invalid text fails ingestion.

## 7. Chunking strategy

Text is normalized to LF line endings and trimmed. The chunker emits consecutive windows up to 1,200 characters, prefers a nearby whitespace/paragraph boundary after 60% of the window, and overlaps the next window by 150 characters. It records chunk order and character start/end offsets. This deterministic `fixed-character-window-v1` strategy is simple to inspect and can split a long paragraph when needed. `KB_MAX_CHUNK_CHARS` and `KB_CHUNK_OVERLAP_CHARS` configure the window and overlap; overlap must be smaller than the window.

## 8. Embedding model/provider

The default provider is the local Ollama HTTP API (`POST /api/embed`) with Google's pretrained `embeddinggemma` model, configured as `OLLAMA_EMBEDDING_MODEL`. This is not a trained or fine-tuned project model. The model is downloaded separately with `ollama pull embeddinggemma`; the API does not silently create or fall back to vectors. Provider failures, malformed vectors, non-finite values, zero vectors, and wrong vector counts fail ingestion/search. Requests use `truncate: false` so oversized input fails rather than being silently shortened. Ollama must be reachable at `OLLAMA_BASE_URL`. See the [Ollama embedding API](https://docs.ollama.com/api/embed) and [EmbeddingGemma model page](https://ollama.com/library/embeddinggemma).

EmbeddingGemma is documented by Ollama as a 300M parameter local-capable embedding model; the default model produces 768-dimensional embeddings and needs Ollama 0.11.10 or later. The application requires exactly 768 dimensions to match the database schema. Model and task prefixes can be configured, but switching models requires re-embedding the entire knowledge base; vectors from different embedding spaces cannot be compared.

## 9. Embedding dimensionality

Vectors are 768-dimensional. The `vector(768)` column enforces this at persistence time, and the API validates the provider response before insertion. There is no fabricated-vector fallback.

## 10. Vector storage

PostgreSQL remains the only database. The Compose PostgreSQL 16 image changes to `pgvector/pgvector:pg16`; schema initialization enables `vector`, stores chunk embeddings in `knowledge_chunks.embedding`, and creates an HNSW cosine index. The project-input and project tables remain in the same schema. The existing named volume is reused; no `down -v` or volume deletion is part of setup. pgvector supports vector storage and cosine-distance queries in PostgreSQL; see the [pgvector documentation](https://github.com/pgvector/pgvector).

## 11. Retrieval algorithm

Search embeds the natural-language query with the configured query prefix and orders ready chunks by pgvector cosine distance (`<=>`). The response score is `1 - cosine_distance`. `topK` or `limit` accepts 1 through 20; optional document-type, jurisdiction, and financial-domain filters are parameterized SQL values. A supplied domain filter restricts retrieval before ranking; omission permits cross-domain search. The query is not sent to an LLM and no answer synthesis occurs.

## 12. API endpoints

All routes are under `/api/knowledge`:

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/documents` | Multipart upload and synchronous ingestion; required `title`, `source`, `documentType`, `financialDomain`, `file`; optional jurisdiction, version, effectiveDate, authority, tags |
| `GET` | `/documents` | List metadata (including financial domain) and chunk counts |
| `GET` | `/documents/:id` | Retrieve metadata (including financial domain), status/error, and extracted text |
| `GET` | `/documents/:id/chunks` | Retrieve document domain and ordered chunks |
| `POST` | `/search` | Retrieve evidence by `{ "query": "...", "topK": 5, "filters": { "documentType": "...", "jurisdiction": "...", "financialDomain": "PAYMENTS" } }`; filters are optional |

Unsupported formats return HTTP 415. Extraction failures return HTTP 422 and embedding-service failures return HTTP 503, both with persisted processing status when ingestion had begun.

## 13. Evidence/source traceability

Each search result contains a `chunkId`, `knowledgeDocumentId`, chunk index/text/metadata, similarity score, and source document title, source, type, financial domain, jurisdiction, version, effective date, authority, and tags. Chunks reference documents with a foreign key and cascade on document deletion. `/documents/:id/chunks` exposes the parent document domain alongside the chunks. Later RAG consumers can cite the returned document and chunk IDs as evidence; Phase 4 does not make the conclusions for those consumers.

## 14. Frontend

The `/knowledge` page lets users select a financial domain during upload and optionally filter search by domain. The domain appears in document rows, source-document inspection, and evidence results; chunk inspection remains linked to its parent document and domain. The page lists processing states and chunk counts, supports descriptive metadata, and labels the feature as evidence retrieval only. No fabricated regulatory content is seeded.

## 15. Configuration/setup

Copy `.env.example` to `.env`, set database credentials, install the usual backend/frontend packages, and ensure Ollama 0.11.10+ is installed with `embeddinggemma` pulled. Replace the Compose PostgreSQL image with the pgvector image and recreate the service while retaining its named volume:

```powershell
docker compose pull postgres
docker compose up -d --force-recreate postgres
ollama pull embeddinggemma
npm run db:init
npm run dev:backend
npm run dev:frontend
```

Ollama runs separately on the host by default. Relevant settings are `OLLAMA_BASE_URL`, `OLLAMA_EMBEDDING_MODEL`, `OLLAMA_TIMEOUT_MS`, `KB_DOCUMENT_EMBEDDING_PREFIX`, `KB_QUERY_EMBEDDING_PREFIX`, `KB_UPLOAD_STORAGE_DIR`, `KB_MAX_CHUNK_CHARS`, `KB_CHUNK_OVERLAP_CHARS`, and `KB_MAX_SEARCH_TOP_K`. Document/query prefix defaults follow EmbeddingGemma's retrieval task convention; choose matching prefixes when selecting another 768-dimensional model.

## 16. Automated verification in the Codex restricted environment

The Phase 4 test file covers deterministic chunking, Ollama adapter request/response validation and failure handling, financial-domain metadata validation, and unsupported-file rejection. Its database integration test creates explicitly-labelled development/demonstration fixture documents for PAYMENTS and LOANS_CREDIT, ingests chunks with test-only deterministic vector fixtures, verifies coexistence, persisted domain metadata, domain-filtered search exclusion, existing document-type/jurisdiction filters, source/chunk traceability, and persisted provider failure, then deletes the fixtures. Test vectors are isolated to that test and are never a production fallback. Phase 2/3 test files continue running in the same backend suite.

In the Codex restricted environment, the latest `npm test --prefix backend` run reported 12 tests: 12 passed, 0 failed, and 0 skipped. This includes the database-backed Phase 4 integration test, which ran against the configured PostgreSQL database with the Phase 4 schema and pgvector available. The integration test injects deterministic test-only vectors; it verifies database persistence, search, domain filtering, and source/chunk traceability, but does not call Ollama or perform actual model embedding. The backend suite also passed the existing Phase 2 and Phase 3 regression tests. `npm run build:frontend` passed. The Docker CLI was unavailable in the Codex shell. An Ollama CLI/model operation was not part of the automated suite, so these test results do not establish real Ollama embedding. This automated test record is separate from the developer-machine manual verification below.

## 17. Successful manual verification on the developer machine

After Docker, pgvector, Ollama, and `embeddinggemma` were available on the developer machine, the following manual verification was completed:

1. Docker 29.8.0 and Docker Compose v5.5.1 were available.
2. PostgreSQL 16 was running from `pgvector/pgvector:pg16` with database `requirements_assistant`; the `vector` extension was enabled successfully.
3. Ollama 0.34.4 was available, `embeddinggemma:latest` was downloaded, and it was used for real document/query embeddings.
4. Phase 4 `knowledge_documents` and `knowledge_chunks` tables initialized successfully.
5. `GET /api/health` returned `status: ok`; `GET /api/health/db` returned `status: ok` and `database: connected`.
6. A PAYMENTS test document uploaded successfully, reached `READY`, and produced one chunk. Semantic search for `transaction` returned its PAYMENTS evidence with source, document, and chunk traceability.
7. A LOANS_CREDIT test document uploaded successfully. Semantic search for `loan approval` returned LOANS_CREDIT evidence.
8. Domain filtering was verified against both coexisting documents: a LOANS_CREDIT-filtered search returned loan evidence and excluded the PAYMENTS document; a PAYMENTS-filtered search did not return the LOANS_CREDIT document.
9. The complete Knowledge Base browser workflow was manually verified: domain selection during upload, READY status and chunk count, document inspection with extracted text, semantic search, evidence traceability, and domain-filtered search across the PAYMENTS and LOANS_CREDIT documents.
10. These results verified that multiple financial domains coexist in the shared knowledge base and that real semantic ingestion/search and domain filtering work with the configured services.

These test documents were verification fixtures and are not represented as authoritative regulatory or financial policy.

## 18. Limitations

Search quality depends on model, chunk boundaries, and reference quality. There is no OCR, hybrid/full-text search, document reprocessing UI, deletion UI, authentication/authorization, access control, or model-version migration tool. A different embedding model requires re-indexing all chunks. Source metadata records what the uploader supplies and does not independently validate authority or effective status.

## 19. Deferred functionality

LLM requirement generation/extraction/classification, clarification, multi-agent/autonomous coordination, compliance/security/risk analysis or decisions, approval workflows, hallucination detection, final requirements/stories/use cases/acceptance criteria, SDLC recommendations, and project-specific workflows remain out of Phase 4 scope.

## 20. Phase 4 acceptance checklist

### Implemented

- [x] Project-independent knowledge document model covers provenance and authority metadata.
- [x] Financial-sector-wide, multi-domain knowledge-base architecture is documented; Trade Finance/LC is one representative domain.
- [x] Financial domain taxonomy is validated and persisted for new knowledge documents; API responses and evidence include the domain.
- [x] Retrieval supports parameterized optional financial-domain filtering while retaining document-type and jurisdiction filters.
- [x] PDF/DOCX/TXT ingestion reuses deterministic Phase 3 extraction and records status/failures.
- [x] Deterministic overlapping chunks preserve order and source offsets.
- [x] Ollama embedding provider validates actual provider output and fails closed; test doubles are test-only.
- [x] PostgreSQL/pgvector schema, 768-dimensional storage, and cosine HNSW index are implemented.
- [x] Management, chunk inspection, and semantic retrieval APIs include source/evidence metadata.
- [x] Knowledge Base UI supports domain selection, display, and optional search filtering.
- [x] Automated integration coverage defines PAYMENTS and LOANS_CREDIT fixtures in the same knowledge base and asserts domain exclusion; it passed against PostgreSQL/pgvector using test-only deterministic vectors.
- [x] Knowledge Base UI supports upload, status, inspection, search, and source-linked results.
- [x] Automated Phase 4 unit/API validation tests, Phase 2/3 regression tests, and frontend production build passed; the database integration test passed with test-only vectors.
- [x] No Phase 5+ generation, agent, or decision functionality was added.

### Verification-dependent

- [x] PostgreSQL/pgvector initialization and database-backed upload, chunk persistence, semantic search, and source/document/chunk traceability were manually verified on the developer machine. The Codex automated database integration test also passed using test-only deterministic vectors.
- [x] Actual Ollama `embeddinggemma:latest` embeddings, successful PAYMENTS and LOANS_CREDIT ingestion, semantic search, and domain filtering were manually verified on the developer machine. The Codex automated test suite did not run this real-model flow.
- [x] Full browser workflow was manually verified on the developer machine, including domain selection, READY status and chunk count, extracted-text inspection, semantic search, source/document/chunk traceability, and domain-filtered exclusion across PAYMENTS and LOANS_CREDIT.
