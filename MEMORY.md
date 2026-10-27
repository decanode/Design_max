# MEMORY.md — Project Antigravity State Log

## Status
Sprint 0 (Architecture & State Machine): **complete**. Next: Sprint 1 (ETL & ingestion workers).

## Completed Actions
- Read directives. NOTE: files are named `architecture_and_design_document.md` and `system_ground_rules.md` (not DESIGN_DOCUMENT.md / GROUND_RULES.md); treated as the same documents.
- Created npm-workspaces monorepo: `apps/api` (Node/Fastify/TS), `apps/web` (Next.js/React), root Playwright.
- Provisioned PostgreSQL 16 + pgvector via `docker-compose.yml` (`npm run db:up`).
- Migration `001_init.sql`: roles, users, projects, tickets, ticket_transitions, approvals, documents, embeddings (vector(1536)).
- DB-level state machine trigger (forward-only, one step) + transition audit log.
- Backend state machine module, ticket service, REST API (`/api/states|projects|tickets|tickets/:id/transition`).
- Web: accessible Kanban board (dark/light, skip link, focus styles) wired to API.
- Tests: Vitest (state machine + DB trigger lifecycle) and Playwright E2E (create + advance ticket). All passing.

## Decisions
- **Fastify over Express**: schema-friendly, fast, good TS support; Socket.io attaches to its HTTP server in Sprint 2.
- **Docker for Postgres**: no local Postgres in Codespace; pgvector image is the simplest provisioning path.
- **Trigger-enforced transitions**: design doc demands DB-level enforcement; app layer also pre-checks for clean 409 errors.
- **Plain SQL migrations + tiny runner**: avoids an ORM dependency until needed (ground rule 5).
- **vector(1536)**: matches OpenAI text-embedding dimension; revisit if the embedding model changes.
- **Next.js scaffolded manually** (not create-next-app) to keep only phase-relevant dependencies.

## Open Items / Notes
- Auth/RBAC not yet enforced on endpoints (Sprint 4 SSO); roles are seeded only.
- Approval-gate logic (`APPROVAL_GATES`) defined but not enforced until Sprint 3 email approvals.
- `.env` is gitignored; `.env.example` committed.
