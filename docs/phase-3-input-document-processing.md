# Phase 3: Input and Document Processing

## 1. Purpose

Phase 3 adds project-scoped stakeholder text and document inputs to the Phase 2 application foundation. It records source material and exposes its submitted or deterministically extracted text for inspection. This phase does not interpret requirements or use AI.

## 2. Scope

Included: text input records, PDF/DOCX/TXT upload handling, metadata and content persistence, deterministic extraction, status/error reporting, project association, and frontend capture and inspection.

Excluded: semantic analysis, requirement generation, AI/LLM/agent/RAG functionality, prioritization, compliance assessment, and later lifecycle work.

## 3. Supported input types

Text input types are stakeholder statement, meeting notes, interview transcript, requirement notes, business context, process description, and other text. Uploaded file extensions are PDF, DOCX, and TXT, with MIME type checks. Extraction is limited to embedded text; scanned-image OCR is not included.

## 4. Data model

`project_inputs` stores a UUID, project foreign key, input type, title, source, file metadata where applicable, submitted text or extracted text, processing status/error, optional creator, and timestamps. Deleting a project cascades to its input records. Files use generated UUID-based names under the configured upload directory; original filenames are metadata only.

## 5. Processing lifecycle

Text records are stored with status `READY`. Document processing stores a `RECEIVED` row, marks it `PROCESSING`, then stores extracted text and marks it `READY`; storage or extraction failures are recorded as `FAILED` with a safe error message. Processing runs synchronously in the API request.

## 6. Extraction behavior

TXT is decoded as UTF-8. DOCX is read with Mammoth raw-text extraction. PDF text is read page by page with PDF.js. Empty extraction, invalid input, configured page limits, and configured character limits result in a failure rather than fabricated text. No semantic analysis is applied.

## 7. Validation and storage safeguards

The API validates project UUIDs, required title/source/content, supported text input types, filename, extension/MIME pairing, file size (10 MB default), PDF page count (200 default), and extracted text size (1,000,000 characters default). Text input is limited to 100,000 characters by default. Uploads are held in memory for validation and written under `storage/uploads` using a generated filename; that directory is ignored by Git. SQL queries use parameters.

## 8. API

All paths are under `/api`:

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/projects/:projectId/inputs` | Create a text input (`title`, `source`, `inputType`, `content`) |
| `POST` | `/projects/:projectId/inputs/documents` | Upload one multipart `file` with `title` and `source` |
| `GET` | `/projects/:projectId/inputs` | List project inputs |
| `GET` | `/inputs/:id` | Retrieve input metadata/status/error |
| `GET` | `/inputs/:id/content` | Retrieve submitted text or extracted text when ready |

An unsupported file receives HTTP 415. An extraction failure returns HTTP 422 and the persisted `FAILED` record. Content retrieval for a non-ready record returns HTTP 409.

## 9. Frontend

Project detail pages include an Inputs & documents area with text and file forms, source/title metadata, status display, and links to input inspection. Input detail shows metadata, status, processing errors, and submitted or extracted text when available.

## 10. Configuration

Optional backend settings: `UPLOAD_STORAGE_DIR` (default `storage/uploads`), `MAX_UPLOAD_BYTES` (10 MiB), `MAX_INPUT_CHARS` (100,000), `MAX_EXTRACTED_CHARS` (1,000,000), and `MAX_PDF_PAGES` (200). The application expects the Phase 2 PostgreSQL database and schema initializer.

## 11. Verification performed

- `npm run db:init` succeeded and printed `Database schema initialized (safe to run more than once).`
- `npm test --prefix backend` passed: 8 tests, 0 failures. Coverage included the Phase 2 API tests, text input validation and project association/list/retrieval, TXT/DOCX/PDF extraction, unsupported-file rejection, and failed-PDF extraction recording.
- `npm run build:frontend` succeeded.
- Browser verification confirmed text input creation, the created input appearing in the project input list, and the input detail page displaying its extracted content. PDF/DOCX/TXT uploads succeeded, reached `READY`, and displayed extracted text. Inputs remained available after a backend restart.
- Server-side unsupported-file validation was manually verified with a real JPG using `curl` at `POST /api/projects/00000000-0000-4000-8000-000000000002/inputs/documents`. The API returned HTTP 415 Unsupported Media Type with `{"error":{"message":"Supported document formats are PDF, DOCX, and TXT","code":"UNSUPPORTED_FILE_TYPE"}}`, confirming unsupported document types are rejected by the backend.
- Docker Compose startup and database verification completed successfully, consistent with the Phase 2 environment.

## 12. Verification limits

Automated upload success tests exercise TXT, DOCX, and PDF extraction using generated text-bearing fixtures. Browser, server-side file validation, persistence-after-restart, and Docker Compose verification have also been completed as recorded above.

## 13. Acceptance checklist

- [x] Text inputs can be created with required metadata and content.
- [x] Inputs are associated with a project and can be listed and retrieved with content.
- [x] TXT upload and deterministic extraction are implemented and verified.
- [x] Unsupported file types are rejected.
- [x] Invalid PDF extraction is recorded as `FAILED` and surfaced as an error.
- [x] Generated storage filenames and an ignored upload directory are used.
- [x] TXT, PDF, and DOCX text extraction passed automated fixture tests.
- [x] Project detail displays input actions and input inspection UI.
- [x] Database initialization, Phase 2 API tests, Phase 3 API tests, and frontend production build passed.
- [x] Browser text creation, input listing/detail content, PDF/DOCX/TXT upload and extraction, `READY` status, and persistence after backend restart were verified.
- [x] Server-side unsupported JPG upload was rejected with HTTP 415 and the expected `UNSUPPORTED_FILE_TYPE` response.
- [x] Docker Compose startup and database verification completed successfully.

## 14. Known limitations

PDF image-only pages return no extracted text; OCR is not implemented. Authentication/authorization is not implemented; optional creator IDs only link to existing development user rows.

## 15. Deferred work

Any semantic requirements analysis, AI/LLM/agent/RAG features, requirement generation, clarification, traceability automation, or later-phase features remain outside this Phase 3 implementation.
