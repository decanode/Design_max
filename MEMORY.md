# MEMORY.md — Design Max State Log

## Status
Sprint 0: **complete**. Sprint 1 (ETL & ingestion workers): **core ETL complete; ingestion workers partial (see Open Items); validated against fixtures only** — no live Jira/SNOW/SAP/SharePoint/Git/OpenAI connection has been tested. Sprint 2 (Intelligent Intake & Chat): **built, verified with offline observer only**. Sprint 3 (Documentation Engine & Approvals): **built, verified with offline generator/mailbox only**. RBAC added afterwards. Next: Sprint 4 (SSO, polish, handover) — but see PENDING security-foundations proposal.

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

## Sprint 3 Actions
- Migration `004_docs.sql`: immutable `documents` (DB trigger blocks UPDATE/DELETE), approvals extended (kind, version, hashed single-use token, expiry, comment, `superseded` status, one pending per ticket+kind), `email_outbox`.
- Gates enforced: Requirement Verified→FS Drafted (needs generated FS), FS Drafted→FS Approved, FS Approved→TS Drafted (needs generated TS), TS Drafted→TS Approved can only happen via the document/approval flow; generic `/transition` returns 409 for them. Board "Advance" button now only shows from TS Approved onward.
- `docs/` module: generator (`TemplateGenerator` offline skeleton; `LlmGenerator` via the `LlmClient` seam, so GitHub Models once a token exists), service (generate, versioned save with optimistic-concurrency `baseVersion`, LCS line diff, approval request/view/decide), routes, `OutboxMailer` (writes to `email_outbox`; M365 sender later).
- Approvals: emailed deep link `/approve/<token>`; token stored as SHA-256 only; single-use; 7-day expiry; tied to a document version; editing the doc supersedes the pending request; rejection requires a comment and keeps the ticket in Drafted.
- TS generation uses the approved FS plus vector-search hits, only when the embedder is semantic (the offline HashEmbedder is excluded as noise).
- Web: `/tickets/[id]` (lifecycle stepper, FS/TS tabs, markdown editor + live preview, version history, diff, request approval), `/approve/[token]`, `/mailbox` (dev). Markdown rendered with react-markdown (no raw HTML).
- Tests: 32 Vitest + 4 Playwright E2E passing (gated lifecycle, conflicts, reject, supersede, expiry, immutability, race on generate).

## Board cleanup + UI redesign (post-Sprint 3)
- **Tests/E2E now use a throwaway database `design_max_test`** (dropped+recreated+migrated each run via `resetTestDb`; vitest `globalSetup`, Playwright `globalSetup` shells out to `tsx` because Playwright loads config as CommonJS). Dev DB verified unchanged by test runs (110 tickets before and after). Migration logic moved to `migrate.ts` (`migrate(pool)`); CLI is `migrate-cli.ts`.
- **Cleaning the dev board's existing 110 test tickets: BLOCKED.** The auto-mode classifier denied the `TRUNCATE` as irreversible destruction, so it has NOT been run; user must run it or grant permission. (Dev DB holds only test data: 4 legacy-migrated fixtures, 30 conversations, 48 documents, 27 emails.)
- Board redesigned: phases grouped into lanes (Intake / Specification / Delivery / Done), stats strip, search, per-column scrolling, empty + loading states, card summaries, source/approval badges, relative times; brand mark nav; refined tokens; dev badge hidden. `/api/tickets` now returns `awaiting_approval`, `legacy_source`, timestamps and is capped at 500 rows (pagination TBD for larger boards).

## RBAC & role-based views (user-requested after testing the flow)
- **User request:** different chat/dashboard views for Customer, Consultant, Lead, Manager; Admin sees all; a dashboard to assign permissions per feature to roles; admins can build custom roles per project needs. Treated as an approved design change; design document updated (section F).
- Migration `005_rbac.sql`: roles gain description/is_system, `Project_Admin` renamed `Admin`, new `Lead`/`Manager`, `role_permissions`, `users.active`, `conversations.customer_id`, `audit_log`. Default permission sets seeded in SQL; catalog lives in `rbac/permissions.ts` (22 permissions).
- `rbac/` module: HMAC-signed 8h session cookie (`dm_session`, HttpOnly, SameSite=Lax; `SESSION_SECRET` required in production), `need()/needAny()` route guards, default-deny hook on all `/api/*` except `/api/auth/*`, `/api/states`, and the token-based approval routes; `ticketScope()` for data scoping; admin routes (roles, permissions, users, audit); dashboards (`/api/dashboard/team`, `/portfolio`, `/api/my/approvals`).
- Dev sign-in (`/login`): account picker + one-click "Create demo accounts" when no users exist (Ada Admin, Leo Lead, Mia Manager, Sam Consultant, Cleo Customer @designmax.dev). Disabled when `NODE_ENV=production` or `DEV_LOGIN=off`. Replaced by SSO in Sprint 4.
- Behaviour: customers see only their own tickets/conversations; consultants see own + unassigned (claim) and all conversations; leads/managers see all, leads assign; managers decide approvals addressed to them in-app (only the addressed approver may); chat sender name and document author come from the session, not the client; permissions are re-read per request/socket event so role edits apply immediately; unseen tickets return 404.
- Web: `AuthProvider` (redirects to /login, refreshes on tab focus), permission-aware Nav with user/role badge + sign out, role panels on the home board (Raise a request / Intake queue / Team workload / Portfolio), chat inbox with role-aware composer, ticket page claim/assign/decide controls, `/admin` (permission matrix with instant save, role builder with clone, user management, activity log), `NoAccess` states. Dev badge hidden; board title is "My work" for non-viewers-of-all.
- Tests: 51 Vitest (17 new access-control tests incl. sockets) + 13 Playwright (per-role views, sign-in redirect, admin builds a role and the user's access changes live). Playwright now has a `setup` project creating demo accounts and per-role storage states in `.auth/`.

## Technology-stack scoping (user request: projects only talk in their allowed stack, e.g. SAP)
- **Request:** a project's AI context must be limited to its technology (an SAP project's chat only works in SAP); other platforms are not to be given solutions. Interpreted as: confine the AI to the project's allowed stacks and refuse/flag off-stack work. (The message said "only give solutions on other platforms", read as a typo for "not".) Design doc section G added.
- Migration `006_stacks.sql`: `tech_stacks` (SAP/.NET/Java/Node.js seeded, with description + keywords), `project_stacks`, `requirement_drafts.stack_fit/stack_note`, `embeddings.stack`.
- `stacks.ts`: policy loading, whole-term keyword matching, `assessFit` (in_scope / unclear / out_of_scope), `stackInstruction` prompt block. New permission `admin.projects` (23 permissions). Admin API for stacks and projects (+ audit). `/api/projects` now lists allowed stacks.
- Enforcement layers: (1) prompts for Observer and FS/TS generators; (2) model returns `stackFit`/`stackNote`; (3) server keyword backstop downgrades an in_scope verdict if the customer used off-stack terms; (4) `out_of_scope` drafts cannot be verified (server-side); (5) ticket page warns when a draft mentions a non-allowed stack; (6) `similar()` filters retrieval by stack; SAP worker tags items `SAP`.
- UI: project picker + "SAP only" chips + warning banner + disabled Verify in chat; "Projects & stacks" admin tab (create projects, tick allowed stacks, manage stack catalog/keywords); stack chips and warning on ticket page.
- **Live-verified with Gemini (gemini-3.5-flash)** against an SAP-only policy: on-stack request in_scope; "React + Spring Boot" out_of_scope; ambiguous web report steered to Fiori/UI5; FS stayed within SAP. Added retry (429/503, 3 attempts) to GeminiClient after a transient 503.
- Tests: 64 Vitest (13 new) + 14 Playwright (new stacks spec) passing.
- Known limits: keyword lists are heuristics (the model is the main judge); migrated-ticket embeddings are not stack-tagged (generic); Git/SharePoint ingested items are untagged unless set; there is no conversational assistant replying in chat yet (the AI only observes and drafts), so "chatbot answers" are not yet a thing to restrict; project access per user (membership) is still pending.

## Decisions
- **Project selection at chat start** (no per-user project membership yet): any chat user can pick from all projects; membership + row-level security remain the pending security proposal.
- **Empty stack list = unrestricted** (backward compatible); the admin UI states this explicitly.
- **Roles are global per user, not per project** (simplest correct slice). Per-project membership + Postgres row-level security remain the PENDING security-foundations proposal (embeddings still have no project scoping).
- **Admin is implicit-all and locked** so an Admin can never lock themselves/everyone out; last-active-Admin guard enforced server-side.
- **Permissions are a fixed catalog; roles are free-form sets** so admins can build roles without code changes while the server still knows exactly what each key protects. New features add keys to the catalog.
- **Approver stays a built-in role** (not in the user's list of four) because emailed-link approvers need a user row; it has no permissions and is hidden from the dev sign-in list.
- **Gemini is live-verified** (user supplied a key, stored only in gitignored `.env`; user will delete it later — **rotate/delete it when testing ends**). Findings: `gemini-2.5-*` are retired for new users; `gemini-3.1-pro-preview` has free-tier quota 0 (needs billing); **`gemini-3.5-flash` works on the free tier and is the default**. Live checks passed: observer JSON draft, FS generation, embeddings (1536 dims, related 0.80 vs unrelated 0.43). `batchEmbedContents` works despite the model list showing only `embedContent`. FS output quality note: an "Out of Scope" bullet contradicted the requirement once — prompts need tuning/human review.
- **Root `.env` now loaded explicitly** from `db.ts` (npm runs workspaces from apps/api, so the previous cwd-relative load never saw it).
- **Tests/E2E are isolated from live AI**: vitest sets `AI_PROVIDER=offline`; Playwright starts its own API (:4100) and web (:3100, `NEXT_DIST_DIR=.next-e2e`) with offline stand-ins, never reusing dev servers.
- **USER DECISION: use Gemini (user has a Pro plan) for testing until the build completes.** Note: the Gemini Pro *subscription* has no API access; an API key from Google AI Studio is needed. Added `GeminiClient` (default model `gemini-2.5-pro`, configurable via `GEMINI_MODEL`; model id unverified as the best current one) and `GeminiEmbedder` (`gemini-embedding-001`, 1536 dims via outputDimensionality, re-normalized). `AI_PROVIDER=github|gemini|anthropic|offline` forces a provider; otherwise first configured wins (GitHub Models > Gemini > Anthropic). Server logs the active provider at start. Mocked-HTTP tests only; not run against live Gemini.
- **Embeddings from different models are not comparable**: if the embedder changes, clear `embeddings` (`DELETE FROM embeddings`) and re-ingest. Free-tier Gemini API terms may allow Google to use inputs for product improvement: test with synthetic data only, never client data.
- **Approvals bound to a document version and invalidated by edits**: prevents approving text that later changed.
- **Gates enforced in the service layer, not only the UI**: the generic transition endpoint cannot bypass sign-off. (DB trigger still enforces ordering only; approval presence is not enforced in SQL.)
- **Optimistic concurrency instead of real-time co-editing**: safe multi-user saving without CRDT/websocket complexity; true live collaboration deferred.
- **react-markdown**: only new web dependency; chosen over raw HTML rendering for XSS safety.
- **USER DECISION: AI calls go through the firm's GitHub license (GitHub Models API first); email via M365 later.** Researched: Copilot SDK (GA 2026-06-02) is an agent runtime; GitHub Models API (`models.github.ai`, org-attributed via `/orgs/{org}/inference/...`, token needs `models: read`) fits our chat-completion + embeddings needs. Built `LlmClient` seam (`GitHubModelsClient`, `AnthropicClient`) + `LlmObserver`, and `GitHubModelsEmbedder`; provider priority GitHub Models > Anthropic > offline. Replaces the earlier ClaudeObserver. **UNVERIFIED against the live service**: model ids (`openai/gpt-4.1`, `openai/text-embedding-3-small`), whether the firm's license covers Models API usage or bills separately, embedding availability, data-handling terms. Needs the firm's GitHub admin to confirm.
- Firm-side hosting direction: `DATABASE_URL` points to the firm's Postgres (+pgvector); containers for web/API; deployment package + IT handover checklist still TO BUILD (user did not object). Hosting platform (Azure/AWS/on-prem) not yet answered.
- **PENDING USER APPROVAL**: security foundations before Sprint 3 (project membership, project_id on embeddings, Postgres RLS, dev login, HNSW index).
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
- Sprint 3 gaps: no real-time collaborative editing (save-with-conflict-detection only); approver/author are unauthenticated names/emails (the emailed token is the only credential until SSO); real SMTP/M365 sending not built; rejection does not email the consultant; no reminder/escalation for pending approvals; documents list `approvals` visibility is not role-restricted; embeddings still lack project scoping (a TS could cite another client's assets once real embeddings exist — see PENDING security proposal).
- LLM-generated FS/TS quality is unevaluated (only mocked).
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
