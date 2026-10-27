# MEMORY.md — Design Max State Log

## Status
Sprint 0: **complete**. Sprint 1 (ETL & ingestion workers): **core ETL complete; ingestion workers partial (see Open Items); validated against fixtures only** — no live Jira/SNOW/SAP/SharePoint/Git/OpenAI connection has been tested. Sprint 2 (Intelligent Intake & Chat): **built, verified with offline observer only**. Next: Sprint 3 (docs engine & approvals).

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

## Sprint 2 Actions
- Migration `003_chat.sql`: conversations, messages, requirement_drafts (one running AI draft per conversation, frozen once verified).
- Socket.io backend (`chat/socket.ts`): join / message / verify; per-conversation serialized observer runs; zod validation on all inputs.
- `Observer` interface: `RuleBasedObserver` (deterministic, offline default) and `ClaudeObserver` (Messages API, JSON reply validated by zod; model `claude-sonnet-5-5`; used automatically when `ANTHROPIC_API_KEY` is set). ClaudeObserver tested with mocked HTTP only.
- "Verify & Approve" creates exactly one ticket at `Requirement Verified` (row lock; double-click safe); later customer messages cannot change a verified draft.
- Web: `/chat` page (conversation + live AI summary pane + Verify & Approve, entity chips, reconnect/error states, ARIA live regions, responsive), shared Nav.
- Tests: 22 Vitest (incl. real-socket integration) + 3 Playwright E2E, all passing.

- Renamed project to **Design Max** (UI, package scopes `@design-max/*`, design doc title, MEMORY). Left as-is: Postgres user/db name `antigravity` (renaming means recreating the DB volume), a comment in applied migration 002, and the persona name in `system_ground_rules.md` (user-authored).
- Bug fix: browser showed "Cannot reach the API" because the frontend called `http://localhost:4000` directly, which doesn't resolve to the Codespace from the user's browser. Web now uses same-origin and Next rewrites `/api/*` and `/socket.io` to the API (`API_INTERNAL_URL`). Only port 3000 needs forwarding.

## Decisions
- **Same-origin API proxy via Next rewrites**: removes CORS and the second-port forwarding requirement. `skipTrailingSlashRedirect` + explicit `/socket.io` rewrite because engine.io requires the trailing slash Next strips.
- **USER DIRECTIVE: connectors/integrations are parked** (Jira, ServiceNow, SAP, SharePoint, Git, OpenAI keys) until the user obtains approvals/keys/system access. Do not work on them or the embedding-recording step until told.
- **Observer behind an interface with an offline stand-in**: build and test the intake flow with no API key.
- **Observer failures never block chat**: messages persist first; draft errors surface as a non-blocking notice.
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
- Sprint 2 gaps: uploaded call-transcript (Teams/Zoom) intake not built; chat has no auth (sender is a self-selected role until Sprint 4 SSO); the "silent" observer is not rate-limited/debounced (one LLM call per customer message); observer is not told about similar historical tickets (vector search) yet.
- Observer quality with the real Claude model is unevaluated.
- UNTESTED against real systems: field names (e.g. Jira acceptance-criteria custom field id, SNOW state codes for problem/change), Jira `/rest/api/3/search` (Atlassian is migrating to `/search/jql`; verify on target instance), RFC_READ_TABLE field-width limits, Graph auth/token acquisition.
- SAP: node-rfc + NW RFC SDK integration and ST03N usage FM not implemented (RfcClient is an interface). SAP selection screens / ALV field catalogs not yet extracted.
- Git worker: function headers are regex-based; OpenAPI YAML unsupported, not a true AST (tree-sitter later).
- SharePoint worker: PDF/DOCX text extraction missing; Confluence connector and Project_Admin manual upload dashboard not built.
- S3/Azure BlobStore not implemented; no scheduler/queue for workers yet.
- Attachment/comment loading has no batching; fine for fixtures, review for large migrations.
- Auth/RBAC not yet enforced on endpoints (Sprint 4 SSO); roles are seeded only.
- Approval-gate logic (`APPROVAL_GATES`) defined but not enforced until Sprint 3 email approvals.
- `.env` is gitignored; `.env.example` committed.
