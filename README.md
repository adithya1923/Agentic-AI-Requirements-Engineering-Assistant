# Financial-Sector Requirements Engineering Assistant

An advisory requirements engineering application for synthetic and real project inputs in financial services. It turns source material into source-linked candidate requirements, quality findings, a deterministic SDLC ranking, and reviewable engineering artefacts. It does not execute banking operations or make binding legal or regulatory decisions.

## Architecture

The application has exactly two logical AI agents, coordinated by deterministic backend services:

1. **Requirements Intelligence Agent** extracts source-grounded candidate requirements, classifies them, checks quality, and attaches source evidence and retrieval context. The database remains authoritative for source text, offsets, IDs, and project ownership. Exact evidence is resolved by the backend; model-generated requirement text cannot replace it.
2. **SDLC + Documentation Agent** uses approved requirements to calculate transparent project factors and deterministically rank SDLC approaches. One configured LLM request explains the top-ranked method; it cannot change the ranking. The service creates source-traceable workflow and draft artefacts.

Supporting services handle PostgreSQL persistence, file extraction, sensitive-data masking, embeddings and retrieval, response validation, and persisted human review. These are not additional agents.

```text
React + Vite → Express API → PostgreSQL + pgvector
                       ├── Requirements Intelligence Agent
                       ├── deterministic SDLC scoring + SDLC/Documentation Agent
                       ├── configured generation provider (Gemini, Groq, or Ollama)
                       └── Ollama embeddings (independent from generation settings)
```

## Requirements and review flow

Create a project and add stakeholder text or upload PDF, DOCX, or TXT. Select a READY input and run Requirements Intelligence. Requirements, evidence offsets, classifications, confidence, findings, citations, and run metadata are stored in PostgreSQL. Retrieved knowledge is labelled separately from stakeholder source evidence; demo knowledge notes are explicitly non-authoritative.

Each candidate requirement has a persisted review state (`DRAFT`, `REVIEWED`, `APPROVED`, `REJECTED`, or `MODIFIED`). Approving one or more requirements unlocks Agent 2. Agent 2 stores its factor values, complete method ranking, recommendation, explanation, workflow, and draft artefacts in PostgreSQL. Its analysis also has a persisted review state. Artefacts include an SRS-style summary, requirement traceability, and a project delivery workflow. Modifications preserve the original source evidence and are marked as modified.

All outputs are advisory. A retrieved knowledge document is not authoritative just because it is indexed. The application does not produce binding policy or regulatory conclusions.

## Setup

Prerequisites: Node.js 20+, npm, Docker Desktop with Compose, and Ollama with `embeddinggemma` for retrieval/knowledge ingestion. Configure one generation provider separately from embeddings.

```powershell
Copy-Item .env.example .env
# Set local database passwords and one LLM provider key in .env
npm --prefix backend install
npm --prefix frontend install
docker compose up -d postgres
ollama pull embeddinggemma
npm run db:init
npm run seed:demo
npm run dev:backend
# In another terminal:
npm run dev:frontend
```

Open <http://127.0.0.1:5173>. The repeatable demo seed writes a synthetic multi-domain project, READY inputs, and non-authoritative knowledge documents/chunks to PostgreSQL. It does not insert fabricated model outputs. Run the real analysis from the project screen using a configured generation provider; review and approve candidates before requesting SDLC analysis.

## Configuration

Copy `.env.example` to `.env`; never put server credentials in frontend environment files. The validated demo configuration uses Groq `openai/gpt-oss-20b` for both agents; set `GROQ_API_KEY` in the backend environment. Agent operations stay pinned to `LLM_GENERATION_PROVIDER` and return a safe error instead of silently changing providers. The local quality comparison favored Groq on extraction coverage, classifications, evidence grounding, semantic repeatability, and latency. Groq did return intermittent 429 quota responses during rapid repeated calls, then recovered; leave enough time between live demo runs and keep quota available. Full Gemini Agent 1 runs returned provider unavailable despite a successful structured-output smoke check. Local `qwen2.5:1.5b` was materially slower and less accurate on the evaluated source, while `qwen2.5:3b` failed confidence validation after a 204-second run. Change the selected provider only when a different configured model has been re-evaluated. Knowledge embeddings have independent Ollama URL/model/prefix/timeout settings and use `embeddinggemma` (768 dimensions) by default.

## API summary

- `GET /api/health`, `GET /api/health/db`
- `/api/projects` and `/api/projects/:id/inputs` for projects and source material
- `/api/knowledge/documents` and `/api/knowledge/search` for shared knowledge ingestion and retrieval
- `POST /api/projects/:id/requirements/intelligence` for Agent 1
- `GET /api/projects/:id/requirements` and `GET /api/projects/:id/requirements/analysis` for persisted results
- `PATCH /api/requirements/:id/review` for persisted candidate review
- `POST /api/projects/:id/sdlc` and `GET /api/projects/:id/sdlc` for Agent 2
- `PATCH /api/sdlc/:id/review` for persisted recommendation/artefact review

## Verification

```powershell
npm test --prefix backend
npm run build:frontend
```

Database integration tests and the seeded full workflow require PostgreSQL, pgvector, Ollama embeddings, and a configured generation provider. Tests validate saved records where the database is available. Demo fixtures are synthetic and repeatable.

## Limitations

This academic application does not implement production authentication/authorization, MFA, legal/regulatory determination, advanced audit controls, or execution of financial transactions. Human review is persisted but does not enforce an enterprise access-control policy. Requirements Intelligence currently analyzes up to 12,000 source characters, with up to 30 selected requirements from a maximum of 80 semantic spans; split larger inputs into smaller, clearly bounded sources. SDLC factors are deterministic heuristics intended to make reasoning inspectable, not a universal project-management standard.
