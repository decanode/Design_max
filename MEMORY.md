# MEMORY.md — Project Antigravity State Log

## Status
Sprint 0: **complete**. Sprint 1 (ETL & ingestion workers): **core ETL complete; ingestion workers partial (see Open Items); validated against fixtures only** — no live Jira/SNOW/SAP/SharePoint/Git/OpenAI connection has been tested. Next: Sprint 2 (chat + AI Observer).

## Completed Actions
- Read directives. NOTE: files are named `architecture_and_design_document.md` and `system_ground_rules.md` (not DESIGN_DOCUMENT.md / GROUND_RULES.md); treated as the same documents.
- Created npm-workspaces monorepo: `apps/api` (Node/Fastify/TS), `apps/web` (Next.js/React), root Playwright.
- Provisioned PostgreSQL 16 + pgvector via `docker-compose.yml` (`npm run db:up`).
- Migration `001_init.sql`: roles, users, projects, tickets, ticket_transitions, approvals, documents, embeddings (vector(1536)).
- DB-level state machine trigger (forward-only, one step) + transition audit log.
- Backend state machine module, ticket service, REST API (`/api/states|projects|tickets|tickets/:id/transition`).
- Web: accessible Kanban board (dark/light, skip link, focus styles) wired to API.
- Tests: Vitest (state machine + DB trigger lifecycle) and Playwright E2E (create + advance ticket). All passing.

## Sprint 1 Actions
- Migration `002_etl.sql`: legacy_* ticket columns, resolution_notes, acceptance_criteria, ticket_comments, attachments, user_identity_map, unique (source_type, source_ref) on embeddings.
- `apps/api/src/etl/`: Jira extractor (paginated, ADF flattening), ServiceNow extractor (incident/problem/change_request + journals, attachments, sys_user resolution), state mapping, idempotent loader, pipeline, CLI (`npm run etl -w apps/api -- <jira|servicenow> <projectId>`).
- Vectorization: `Embedder` interface; `OpenAIEmbedder` (text-embedding-3-small) and offline `HashEmbedder`; pgvector cosine similarity search.
- Attachment migration to a `BlobStore` (LocalBlobStore implemented; S3/Azure implementation still TODO).
- `apps/api/src/workers/`: Git worker (README, OpenAPI JSON, function-header regex), SAP worker (TRDIR/TSTC via injected RFC client + optional usage provider), SharePoint worker (Graph API, text files).
- Tests: 16 Vitest tests pass (fake HTTP fixtures, real Postgres), repeatable; vitest runs files serially (shared DB).

- Approved proposal (recorded real embeddings for tests): built `RecordedEmbedder` + `npm run embeddings:record -w apps/api` + text list `etl/fixtures/embeddingTexts.ts`. **PENDING: needs OPENAI_API_KEY once**; until recorded, tests still use HashEmbedder. After recording, switch etl.test/workers.test to RecordedEmbedder and drop HashEmbedder from tests.
- Git worker can now clone from a URL (system `git`, no new deps). Added `npm run ingest -w apps/api -- git|sharepoint ...` entry point (embeds results).

## Decisions
- **Ground rule 8 added (user-approved)**: Claude may propose design changes in short plain terms; proceed only after approval, then update the design doc and log here.
- **Fastify over Express**: schema-friendly, fast, good TS support; Socket.io attaches to its HTTP server in Sprint 2.
- **Docker for Postgres**: no local Postgres in Codespace; pgvector image is the simplest provisioning path.
- **Trigger-enforced transitions**: design doc demands DB-level enforcement; app layer also pre-checks for clean 409 errors.
- **Plain SQL migrations + tiny runner**: avoids an ORM dependency until needed (ground rule 5).
- **vector(1536)**: matches OpenAI text-embedding dimension; revisit if the embedding model changes.
- **Next.js scaffolded manually** (not create-next-app) to keep only phase-relevant dependencies.

- **Injectable fetch / RFC client / BlobStore**: lets extractors be tested without credentials; real connections are swapped in at the CLI/config level.
- **Legacy tickets inserted at mapped phase** (not walked through the lifecycle): the state trigger guards UPDATEs only; history is not fabricated. Unmapped statuses default to `Requirement Verified`.
- **Placeholder users** (`<id>@unmapped.<source>.invalid`) when legacy email is hidden; reconcile to Entra ID emails later via user_identity_map.
- **HashEmbedder** is for tests/keyless dev only — not semantically meaningful; use OpenAIEmbedder for real data.
- **No new dependencies** added in Sprint 1 (native fetch, no node-rfc/AWS SDK yet — ground rule 5).

## Open Items / Notes
- UNTESTED against real systems: field names (e.g. Jira acceptance-criteria custom field id, SNOW state codes for problem/change), Jira `/rest/api/3/search` (Atlassian is migrating to `/search/jql`; verify on target instance), RFC_READ_TABLE field-width limits, Graph auth/token acquisition.
- SAP: node-rfc + NW RFC SDK integration and ST03N usage FM not implemented (RfcClient is an interface). SAP selection screens / ALV field catalogs not yet extracted.
- Git worker: function headers are regex-based; OpenAPI YAML unsupported, not a true AST (tree-sitter later).
- SharePoint worker: PDF/DOCX text extraction missing; Confluence connector and Project_Admin manual upload dashboard not built.
- S3/Azure BlobStore not implemented; no scheduler/queue for workers yet.
- Attachment/comment loading has no batching; fine for fixtures, review for large migrations.
- Auth/RBAC not yet enforced on endpoints (Sprint 4 SSO); roles are seeded only.
- Approval-gate logic (`APPROVAL_GATES`) defined but not enforced until Sprint 3 email approvals.
- `.env` is gitignored; `.env.example` committed.
