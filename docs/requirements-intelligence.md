# Requirements Intelligence (Agent 1)

Requirements Intelligence replaces the former separate Phase 5 extraction and Phase 6 analysis operations. A selected READY input is processed alongside the project's current candidate requirements in one compact structured generation request. Deterministic backend code handles retrieval, validation, IDs, persistence, and traceability; the model does not orchestrate other agents.

## Request and limits

`POST /api/projects/:projectId/requirements/intelligence` accepts `{ "inputId": "<uuid>" }`. The compatibility `requirements/extract` route delegates to the same service. The operation retrieves up to four Phase 4 pgvector chunks using Ollama EmbeddingGemma, then sends one request to the configured generation provider. Provider retries and provider fallbacks are disabled for this operation; failures leave prior candidates and findings unchanged.

The selected source input is limited to 12,000 characters. At most 6 existing requirements enter context, at most 5 new candidates and 6 findings are returned; security/privacy is limited to 2 observations, and risk and compliance to 1 each. Retrieval contributes at most one 250-character excerpt. The fully serialized prompt is limited to 18,000 characters; output is capped at 1,100 generation tokens. Oversized inputs/context fail clearly rather than being truncated. Output fields, evidence, confidence, enums, IDs, and citations are validated server-side.

## Persistence and evidence

New candidate UUIDs are assigned after the response has passed exact-source evidence validation. Findings refer to existing UUIDs or temporary `N1`–`N20` keys, which the backend maps to persisted candidate UUIDs before storing. Conflicts/consistency findings require at least two candidates. Original project input text is read-only during this flow.

The existing `requirement_analysis_runs` and `requirement_analysis_findings` tables store the latest successful result. The run summary retains security/privacy observations, risks, compliance mappings, retrieved evidence metadata, confidence, and timestamps; finding rows preserve requirement IDs, source quotes, clarification questions, and confidence. Knowledge-base citations must reference retrieved chunk IDs and exact chunk text. When the retrieval service has no usable results, the UI reports “No supporting knowledge-base evidence found.” The bundled demo corpus is explicitly labelled `DEMO / NON-AUTHORITATIVE` and must not be treated as official regulatory material.

## Demo data

Run `npm run db:init`, then `npm run seed:demo`. The idempotent seed creates one financial-services project, six READY inputs covering onboarding, payments, lending, fraud, and trade finance (including deliberately ambiguous/conflicting statements), and two small demo policy notes embedded with the existing embedding model. No frontend mocks are involved.

## Provider and scope

Gemini generation uses the official `@google/genai` SDK structured-output API. Groq and Ollama use the shared generation service's supported JSON modes. API keys stay in backend `.env`; messages returned to the browser are sanitized and provider-neutral. The agent offers advisory analysis and does not make binding legal, compliance, or regulatory determinations. Agent 2, which recommends an SDLC and gives software-engineering justification, is deferred.
