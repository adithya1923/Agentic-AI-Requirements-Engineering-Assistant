# Implemented architecture and workflow

The implementation has two logical AI agents and supporting deterministic services.

## Agent 1: Requirements Intelligence

`POST /api/projects/:projectId/requirements/intelligence` runs source-grounded extraction and analysis. It asks the configured provider to select from bounded, source-addressable candidates, classifies the selected requirements, and checks each independently for supported quality concerns. Backend validation resolves IDs and exact source evidence/offsets and rejects unsupported IDs, evidence, or confidence values. Provider retries and failover are disabled for an agent operation. The service persists requirements, findings, retrieval metadata, and run metadata. Knowledge retrieval is shared across projects and its sources remain distinct from the stakeholder source.

The API stores original inputs unchanged. Before generation or embedding calls, a length-preserving masker obscures common email, long account/card number, phone-like number, and IBAN patterns. This reduces accidental disclosure while leaving source offsets stable. It is not a substitute for production data-loss prevention and does not identify every possible personal or confidential value.

## Agent 2: SDLC + Documentation

`POST /api/projects/:projectId/sdlc` requires at least one approved requirement. It derives ten inspectable 1–5 project factors from approved requirement text and persisted analysis findings. A fixed weighted scoring function ranks eight approaches: Agile, Incremental, Spiral, V-Model, Waterfall, Prototyping, RAD, and DevSecOps. Ties are resolved by method name. Factor values, ranking, and top choice are computed in application code.

The configured generation provider receives project context, factors, ranking, and the selected method and must return a structured explanation. This request is pinned to the configured provider with one attempt; a provider error fails the operation rather than switching models. The generated explanation cannot alter the score or selection. Workflow stages and three draft artefacts (requirements summary, source traceability, and project workflow) are assembled deterministically and persisted with requirement IDs and source evidence.

## Human review and persistence

Candidate requirement review states are `DRAFT`, `REVIEWED`, `APPROVED`, `REJECTED`, and `MODIFIED`. Requirement modifications preserve original source evidence and offsets. SDLC analyses have persisted review states and notes. `PATCH /api/requirements/:id/review` changes a candidate state; `PATCH /api/sdlc/:id/review` changes the analysis state. These routes do not implement enterprise role-based access control.

All primary application data is served from PostgreSQL. The UI has no hardcoded project or requirement result arrays. The idempotent demo seed writes only synthetic users/projects/inputs and clearly labelled non-authoritative knowledge notes/chunks; it does not insert fake LLM outputs. Run the actual agent flows in the project UI to produce persisted analysis results.

## Configuration and boundaries

Generation provider/model configuration is separate from Ollama EmbeddingGemma configuration. Supported generation providers are Gemini, Groq, and Ollama. Provider keys are backend-only and are not stored in project records. The API returns sanitized provider errors. A generation call that fails does not create placeholder requirements or explanations.

This application is advisory. Retrieved content is evidence with source metadata, not proof of a binding regulatory obligation. It does not execute transactions, make binding legal/regulatory decisions, or act as a production financial system. Authentication, authorization, formal audit controls, and comprehensive sensitive-data detection are limitations.
