# Requirements Intelligence Agent

Agent 1 is the bounded requirements extraction and analysis workflow described in [the implemented architecture](architecture.md). Its responsibilities are to select source-grounded requirements, classify them, identify supported quality findings, retrieve separate knowledge evidence, and prepare persisted results for human review.

## Endpoints and behavior

`POST /api/projects/:projectId/requirements/intelligence` accepts `{ "inputId": "<uuid>" }`. The selected input must belong to the project and be READY. The API reads submitted or extracted text from PostgreSQL, builds bounded source candidates, and resolves all final requirement evidence and offsets from that authoritative source. Candidate IDs and model output are validated before persistence. Classification, findings, clarification questions, confidence, and retrieval metadata are stored in analysis runs/findings.

`GET /api/projects/:projectId/requirements?sourceInputId=<uuid>` returns persisted candidates with their source input metadata. `GET /api/projects/:projectId/requirements/analysis?sourceInputId=<uuid>` returns the latest successful run and its findings for that source. `PATCH /api/requirements/:id/review` persists a review state and optional revised text while retaining the original evidence.

## Retrieval and privacy

Knowledge documents form a shared multi-domain corpus, independent of projects. The agent searches pgvector using the separately configured Ollama embedding model. Retrieved chunks keep document/chunk IDs, source, authority metadata, domain and similarity and are displayed separately from project source evidence. Demo corpus entries explicitly say they are non-authoritative.

Common email, long number, phone-like, and IBAN patterns are masked, without changing string length, before generation and embedding calls. Original project inputs and source offsets stay unchanged in PostgreSQL. Pattern masking has known limits and cannot guarantee removal of every confidential value.

## Provider behavior

Generation provider settings are server-side. Agent 1 pins each operation to `LLM_GENERATION_PROVIDER`, uses structured output, and does not fail over to a different provider. Provider unavailability, quota, timeout, invalid JSON, or failed validation is returned as an error and does not create fabricated result rows or replace the previous successful result. Embedding failures are handled separately from generation failures.

All findings and retrieved sources are advisory. The agent does not make binding legal, regulatory, compliance, or fraud determinations.
