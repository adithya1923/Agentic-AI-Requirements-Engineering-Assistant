# Agentic AI Requirements Engineering Assistant for Trade Finance and Letters of Credit

Phase 2 provides the application foundation for the project defined in [Phase 1](docs/phase-1-use-case-definition.md). It gives a team a place to create and retrieve requirements-engineering project records for the selected Trade Finance / Letter of Credit domain. It does not process LCs or banking transactions and contains no AI analysis functionality yet.

## Architecture

```text
React + Vite frontend (127.0.0.1:5173)
        │ HTTP / JSON
        ▼
Node.js + Express API (localhost:4000)
        │ PostgreSQL driver
        ▼
PostgreSQL 16 via Docker Compose (localhost:5432)
```

The frontend uses the API for all project data. The API owns validation, database access, and structured error responses. The initial project context is seeded as “Trade Finance / Letter of Credit Requirements Project”.

## Technology

- Frontend: React 18, Vite 5, React Router 6, JavaScript
- Backend: Node.js ES modules, Express 4, `pg`, `dotenv`, and `cors`
- Database: PostgreSQL 16, initialized by an idempotent SQL script
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
    routes/                # health, projects, and users APIs
  test/api.test.js         # API health and request validation tests
database/schema.sql        # users and projects tables plus initial LC project
docs/
  phase-1-use-case-definition.md
  phase-2-application-foundation.md
frontend/
  src/                     # React app, pages, components, API client, styles
  vite.config.js
docker-compose.yml         # PostgreSQL only
.env.example
```

## Prerequisites

- Node.js 20 or later and npm
- Docker Desktop with Docker Compose enabled

No local PostgreSQL installation is required. Packages are installed independently in `backend` and `frontend`; each has its own lockfile.

## Setup and run

1. Copy `.env.example` to `.env` in the repository root. Change `POSTGRES_PASSWORD` to a local password, and set `DATABASE_PASSWORD` to the same value. `.env` is ignored by Git.
2. Copy `frontend/.env.example` to `frontend/.env.local` if the API is not at its default URL. These frontend values are public configuration; do not put secrets in them.
3. Install packages:

   ```powershell
   npm --prefix backend install
   npm --prefix frontend install
   ```

4. Start PostgreSQL:

   ```powershell
   docker compose up -d postgres
   docker compose ps
   ```

5. Initialize the schema and initial Trade Finance / LC project:

   ```powershell
   npm run db:init
   ```

   The script is repeatable and does not delete existing records.

6. In one terminal, start the API:

   ```powershell
   npm run dev:backend
   ```

7. In another terminal, start the frontend:

   ```powershell
   npm run dev:frontend
   ```

8. Open `http://127.0.0.1:5173`. The dashboard and projects page load rows through the API. Create a project, open its detail page, and refresh; it should remain available from PostgreSQL.

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

Vite reads `frontend/.env.local`. Only `VITE_` variables are exposed to browser code; never put secrets in such variables.

## API endpoints

All endpoints are under `/api` and return JSON.

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/health` | API status |
| `GET` | `/api/health/db` | Database connectivity status |
| `GET` | `/api/projects` | List projects |
| `GET` | `/api/projects/:id` | Retrieve a project by UUID |
| `POST` | `/api/projects` | Create a project (`name`, optional `description`, `selectedDomain`, `ownerId`) |
| `GET` | `/api/users` | List development user/role records |
| `POST` | `/api/users` | Create a development user/role record (`displayName`, `email`, optional `role`) |

Supported project statuses are `DRAFT`, `ACTIVE`, and `ARCHIVED`. Supported role labels are `ADMIN`, `BUSINESS_STAKEHOLDER`, `REQUIREMENTS_ENGINEER`, `TECHNICAL_STAKEHOLDER`, `COMPLIANCE`, `SECURITY`, `RISK`, `PROJECT_MANAGER`, and `APPROVER`.

## Verification

Run the frontend production build and backend request-validation tests:

```powershell
npm run build:frontend
npm test --prefix backend
```

With Docker running, the end-to-end check is: start Compose, run `npm run db:init`, start the API and frontend, verify `/api/health` and `/api/health/db`, create a project in the UI, and verify it appears in the project list and detail view after a reload. The database-backed flow requires Docker/PostgreSQL and cannot be replaced by static frontend data.

## Intentionally deferred

This foundation does not include production authentication/authorization, MFA, AI agents, LLM calls, RAG, embeddings, knowledge ingestion, requirement extraction or analysis, compliance/security/risk engines, clarification, SRS/story/acceptance criteria generation, traceability automation, SDLC recommendations, advanced audit, or deployment of a banking system. User records and role labels are data-model foundations only; they do not enforce access control. These boundaries follow Phase 1 and the original project statement.
