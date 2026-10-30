# Operating modes (Full / Connected / Mirror): the approved plan and where it stands

**Status (2026-10-30): Stages 0 to 4 are built and tested; Stage 5 is partly built.** This file keeps the plan that was approved so the reasoning travels with the code. `MEMORY.md` ("START HERE") has the current state, and `FEATURE_PROCESS_GUIDE.md` (sections 4a and 4b) has the plain-language user guide.

## What was built, and where it differs from the plan below
| Stage | Built | Migrations | Main code |
|---|---|---|---|
| 0 Modes and guards | yes | 030 | `apps/api/src/rbac/modes.ts` (capability matrix, `assertCap`, `projectMode`), `loadUser` in `rbac/auth.ts`, `platform/routes.ts`, web `components/platform/ModeCards.tsx`, `ProjectsAdmin.tsx` |
| 1 Connect and mirror (Jira + ServiceNow) | yes | 031, 032 | `apps/api/src/integrations/*` (`jira.ts`, `servicenow.ts`, `sync.ts`, `secrets.ts`, `url.ts`, `scheduler.ts`, `routes.ts`), web `components/integration/IntegrationAdmin.tsx`, `components/ticket/SourceCard.tsx` |
| 2 Work locally | yes | 033 | `tickets/workItemRoutes.ts`, web `components/ticket/WorkItems.tsx` |
| 3 Write-back (Connected) | yes | 034 | `integrations/writeback.ts`, `integrations/outbox.ts`, rules/queue routes, "Send back" page |
| 4 Flow reporting | yes | 035, 036 | `reports/engine.ts` (datasets flow, intervals, signoffs, snapshots; `seriesBy` + chart `stack`), `reports/snapshots.ts`, Platform → Portfolio |
| 5 Hardening | webhooks only | 037 | public `POST /api/integrations/webhook/:id?token=` |

Deviations from the plan text below (deliberate):
- Source status history is kept in its own table `ticket_source_history`, **not** in `ticket_transitions`, so our own phase history stays pure. Reports union both through the `ticket_intervals_v` and `ticket_flow_v` views.
- Mirrored tickets reuse the existing `legacy_id` / `legacy_source` columns as their identity (unique per project) plus new `source_*` columns, instead of a new unique key. They are shown by their source key.
- People from the source tool become **inactive accounts with no project membership** (they cannot sign in); a person whose email matches an existing account is linked to it.
- `work_gate` was added as a fourth overridable capability (all tasks done before closing; off everywhere by default).
- A sync-only escape hatch in the state trigger (`app.sync_remap`, migration 032) lets "apply status map" move tickets nobody has touched.
- Write-back is queued **inside** the transaction of the change that causes it (`enqueueEvent` with a savepoint) from `applyTransition`, the approval engine's `decide`, and the sign-off decision.

## NOT built (decided out of scope for now)
SAP Cloud ALM connector (needs an API spike first); Entra ID reconciliation of external people; wiring attachment binary downloads (`etl/attachments.ts` is still unused); business-hours calendar for time measures; a UI for a project's own standard work-task lists (the API `/api/project/work-templates` exists); "adopt a mirrored project into Full" action; retention rules for tickets removed in the source.

---

# The approved plan (verbatim)

# Operating modes: Full, Connected (partial) and Mirror (read-only) adoption

## Context
Customers will not all move their whole lifecycle into Design Max. Some keep Jira or ServiceNow as the system of record and want us to help the project team (documents, approvals, decomposition, reporting) and, in some cases, push agreed outcomes back. The Super Admin must therefore decide, **per project**, how much of the app a project uses, **without scrapping or forking anything that exists**. Today every project behaves as "full"; the only Jira/ServiceNow code is a one-off CLI import (`apps/api/src/etl/*`) with no stored connections, no incremental sync, no status history and no write-back.

Decisions already made with the user:
- Three modes: **Full adoption**, **Connected** (customer keeps Jira/ServiceNow; we write back), **Mirror** (read-only, local work only).
- Connected mode: the admin **selects what is sent back** (status, comments, document attachments), per rule, with a safe preview.
- **Jira and ServiceNow both in the first release**, on one connector framework (SAP Cloud ALM later).
- Mirror mode keeps **our own local status** next to the source status; nothing is ever sent back.
- Existing behaviour must be unchanged for existing projects (default mode = Full).

## The idea in one paragraph
One column, `projects.operating_mode`, set only by a Super Admin. A single **capability matrix** (one file) turns the mode (plus optional per-project overrides) into a list of capabilities. That list is enforced in three places that already exist: the permission set loaded for each request (so routes and `can()` in the UI follow automatically), a domain assertion inside the few functions that create or change tickets (so chat, planning and import cannot bypass it), and the Nav/settings tabs. A new **integrations layer** (connections, incremental pull with history, status mapping, transactional outbox for write-back, sync-health screen) is used by Connected and Mirror projects. Reporting gains a time dimension from imported history.

## Capability matrix (defaults; Super Admin may override a subset per project)

| Capability | Full | Connected | Mirror |
|---|---|---|---|
| Create tickets natively (board, chat verify, planning convert) | yes | no (tickets come from the source) | no |
| Chat assistant for the team (scope/solution) | yes | yes, ticket creation off | yes, ticket creation off |
| Customer chat intake | yes | no | no |
| Local lifecycle / phases / custom lifecycles | yes | yes (local status drives write-back rules) | yes (local status, informational) |
| Documents FS/TS/TUT/CRC, review comments, Word export | yes | yes | yes |
| Document approval workflows | yes | yes | yes (local governance only) |
| Ticket-creation approvals | yes | no | no |
| Customer sign-off before close, closing gates (`closingProblem`) | yes | yes, configurable (gates the write-back of "Done") | off by default |
| Work items / decomposition, AI breakdown | yes | yes | yes |
| Planning module (charter, WBS, convert to tickets) | yes | charter/WBS yes, convert off | charter/WBS yes, convert off |
| Source connection, pull sync, status mapping | optional (one-off migration) | required | required |
| Write-back (status / comments / attachments) | n/a | yes, admin-selected | never |
| Flow reporting, snapshots | yes | yes | yes |

Overridable by Super Admin: customer sign-off, closing gates, planning convert, work-item gating. Never overridable: write-back in Mirror, native ticket creation in Connected/Mirror (it would create tickets with no source counterpart).

Mode changes: Super Admin only, audited, confirmation text explains consequences. Nothing is deleted on any change. Leaving Connected pauses and cancels the outbound queue (explicit prompt). Full to Connected/Mirror leaves native tickets in place, flagged "native".

## Data model (migrations 030+)
- `projects.operating_mode TEXT NOT NULL DEFAULT 'full' CHECK (full|connected|mirror)`; `projects.mode_overrides JSONB NOT NULL DEFAULT '{}'`.
- `integration_connections` (project_id, kind `jira|servicenow`, name, base_url, auth_type, `secret_enc` AES-256-GCM, config JSONB (JQL / tables / custom fields), enabled, sync_interval_min, last_sync_at, cursor JSONB, writeback_enabled, dry_run, health). RLS like other project tables. Several connections per project allowed.
- Tickets: add `connection_id`, `source_key`, `source_url`, `source_status`, `source_updated_at`, `source_hash`, `source_removed_at`, `out_of_sync BOOL`. Keep existing `legacy_*` columns (backwards compatible); unique `(connection_id, source_key)`. Imported tickets keep their own local `current_state`; sync stops overwriting it (today `loadRecord` never updates it, which is what we want, but `legacy_status` becomes `source_status`).
- `ticket_transitions`: add `source TEXT DEFAULT 'app'` ('app'|'import'), `source_status`. Imported history is inserted directly with real timestamps (the UPDATE-only guard trigger is not involved).
- `status_maps` (connection_id, ticket kind, source_status, local phase_id, is_start/is_done) used for the initial local state and for normalising reports.
- `writeback_rules` (connection_id, event, condition JSON, action `status|comment|attach`, target (external status / transition / state value, comment template, doc kinds), enabled, position). Events: `phase_entered`, `document_approved`, `signoff_approved`, `ticket_closed_locally`.
- `outbound_queue` (transactional outbox): connection_id, ticket_id, action, payload, idempotency_key UNIQUE, status `pending|sent|failed|skipped|cancelled`, attempts, next_attempt_at, last_error, dry_run. Written **in the same transaction** as the event that causes it (inside `applyTransition`, approval `decide`, sign-off decision).
- `sync_runs` and `sync_failures` (counts, duration, error) for the health screen.
- `external_identities` mapping external users to members (extends existing `user_identity_map`).
- Work decomposition: `work_items` (ticket_id, parent_id, title, state `todo|doing|blocked|done`, owner_id, estimate_h, actual_h, position, depends_on) and `work_item_templates` (ticket type to default tasks).
- Reporting: `ticket_phase_intervals` view (window over `ticket_transitions`), `ticket_daily_snapshot` table, new datasets in `reports/engine.ts`.

## Backend design
1. **`apps/api/src/rbac/modes.ts` (new)**: `MODES`, `CAPABILITIES`, `capabilitiesOf(mode, overrides)` (pure, table-driven, unit-tested). `loadUser` (`rbac/auth.ts:72`) adds `operatingMode` + `caps` to `SessionUser` and removes permission keys a capability denies (e.g. `ticket.create`, `chat.as_customer`), so `need()` guards and the web `can()` follow with no per-route edits. `GET /api/auth/me` (`rbac/authRoutes.ts`) returns `project.operatingMode` and `project.caps`.
2. **Domain assertions** (`assertCap(projectId, cap)` helper in `modes.ts`, throwing `DocError` 409 `MODE_RESTRICTED`): `createTicket` (`tickets.ts:24`), chat `verifyDraft` (`chat/service.ts`), planning `convertToTickets` (`planning/service.ts:258`), `openTicketApproval`, `closingProblem` (honour the sign-off/gating overrides). The ETL/sync path is the only thing allowed to create tickets in Connected/Mirror.
3. **Integrations layer `apps/api/src/integrations/` (new)**:
   - `types.ts`: `Connector { test(); pull(cursor): AsyncGenerator<SourceTicket>; history(ref); transitions(ref); push(action) }`.
   - `jira.ts`, `servicenow.ts`: refactor the existing extractors (`etl/jira.ts`, `etl/servicenow.ts`) into connectors. Add incremental pull (`updated >= cursor` / `sys_updated_on`), changelog (Jira) and `sys_audit` (ServiceNow) for history, comment pagination, attachment metadata, deletion detection, backoff on 429. Replace the deprecated Jira search endpoint where needed.
   - `secrets.ts`: AES-256-GCM with `INTEGRATION_KEY` env; secrets never returned by any route. Base URL validation (https, block private/loopback ranges unless explicitly allow-listed) to prevent SSRF.
   - `sync.ts`: `runSync(connection)` upserts tickets by `(connection_id, source_key)`, skips unchanged records by `source_hash`, inserts history into `ticket_transitions`, maps users (reuse `upsertUser` in `etl/load.ts`, stop auto-granting Customer role to everyone: map to external identity and a read-only "External" role), flags removed/moved issues, records a `sync_run`. Keeps the existing CLI working by delegating to it.
   - `scheduler.ts`: in-process interval with `pg_try_advisory_lock` so several API instances do not double-run; per-connection interval and a manual "Sync now".
   - `outbox.ts`: worker that drains `outbound_queue` with retry/backoff, idempotency keys, per-connection rate limit, **dry-run** (records what would be sent, sends nothing), kill switch, and conflict check (if `source_updated_at` moved since our last read, skip and set `out_of_sync` instead of overwriting).
   - `writeback.ts`: rule engine. Event hooks added at: `applyTransition` (`tickets.ts:78`), `approvals/engine.ts` `decide`, `tickets/workRoutes.ts` sign-off decision. Rules produce queue rows; admin chooses which events, target statuses, comment templates (internal notes never sent), and which document kinds to attach (reuse the existing Word export `docs/routes.ts` export path).
   - `webhooks.ts` (later stage): signed inbound endpoints that enqueue a single-ticket refresh.
   - Routes `integrations/routes.ts`: connection CRUD, test, sync now, runs, failures, queue list/retry/skip, status maps, rules, preview ("what would be sent for this ticket"). Permission `integration.manage` (Project Admin) with Super Admin required to create connections and to set the mode.
4. **Platform routes** (`platform/routes.ts`): `POST /api/platform/projects` accepts `operatingMode` (default full); `PATCH /api/platform/projects/:id` accepts `operatingMode` and `modeOverrides` (Super Admin, audited as `project.mode`). `GET /api/platform/projects` returns the mode.
5. **Reporting** (`reports/engine.ts`): see Stage 4.

## Frontend design
- **Platform → Projects** (`components/platform/ProjectsAdmin.tsx`): "Operating mode" as three cards (what it is, what is on/off, a capability preview table) in the New project page and on the project page; change requires confirmation listing consequences; overrides in an "Advanced" section. Project list shows a mode chip.
- **Header/Nav** (`components/Nav.tsx`, `lib/auth.tsx`): mode chip beside the project name; hide Chat intake / Planning convert / create buttons by capability (already via `can()` for most).
- **Project settings** (`app/admin/page.tsx`): new group **Integration** (Connected and Mirror only): Connection (+ Test), Import scope, Status mapping, Write-back (Connected only: rules table, "Send back" toggles for status / comments / attachments, dry-run switch, preview), Sync health (runs, failures, outbound queue with retry/skip), Identity mapping. Template builder / ticket approvals / lifecycle tabs are hidden or read-only per matrix.
- **Ticket page** (`app/tickets/[id]/page.tsx`, `components/ticket/*`): a **Source** card (key + deep link, "Source says: In Progress (as of 14:02)", "Out of sync" banner, last events sent/queued, "don't sync this ticket" switch), shown beside our local status. Work-items card ("Work" with progress 6/9). Closing checklist only when closing gates are on.
- **Board** (`app/page.tsx`): source badge on cards, filter by connection/source, out-of-sync and write-back-failed filters.
- **Reports**: new built-in reports and a Portfolio view (Stage 4).

## Delivery stages (each shippable; default behaviour unchanged throughout)
**Stage 0: Modes and guards.** Migration 030 (`operating_mode`, `mode_overrides`); `rbac/modes.ts`; `loadUser`/`me` changes; domain assertions; Platform selector; Nav/settings hiding; mode chip; audit. Default Full means no visible change. Table-driven tests of every capability in every mode.
**Stage 1: Connect and mirror (Jira + ServiceNow).** Migrations for connections, ticket source columns, status maps, sync runs, history source; connectors with incremental pull, history, comments; secrets; scheduler; Integration settings screens; Sync health; status mapping UI. Mirror mode is usable end to end after this stage.
**Stage 2: Work locally in Mirror/Connected.** Source/local status panel, work items and templates, AI breakdown (reuse `planning/ai.ts`), documents and approvals on mirrored tickets, board source filters.
**Stage 3: Write-back (Connected).** Outbox, rules engine, event hooks, dry-run and preview, conflict handling, comment and attachment actions, queue/retry UI, kill switch, audit.
**Stage 4: Advanced reporting.** `ticket_phase_intervals`, `ticket_flow` dataset (lead/cycle time with p50/p85/p95, time in status, aging buckets, bounce/rework), approval and sign-off turnaround percentiles, `ticket_daily_snapshot` + nightly job (reuses the scheduler) for cumulative flow, WIP over time and trends, multi-series chart components, source/connection dimensions, Super Admin cross-project Portfolio (platform context), CSV export.
**Stage 5: Hardening.** Webhooks, SAP Cloud ALM spike and adapter, identity reconciliation with Entra, attachment download wiring (`etl/attachments.ts`), business-hours calendar.

## Critical files
Modify: `apps/api/src/rbac/auth.ts`, `rbac/authRoutes.ts`, `rbac/permissions.ts`, `platform/routes.ts`, `tickets.ts`, `chat/service.ts`, `planning/service.ts`, `approvals/engine.ts`, `tickets/workRoutes.ts`, `etl/load.ts`, `etl/jira.ts`, `etl/servicenow.ts`, `etl/cli.ts`, `reports/engine.ts`, `app.ts`; web: `lib/auth.tsx`, `components/Nav.tsx`, `components/platform/ProjectsAdmin.tsx`, `app/admin/page.tsx`, `app/page.tsx`, `app/tickets/[id]/page.tsx`, `components/charts.tsx`.
New: `rbac/modes.ts`, `integrations/*`, migrations `030`+, web `components/integration/*`, `components/ticket/SourceCard.tsx`, `components/ticket/WorkItems.tsx`.

## Reuse (do not rebuild)
`need()/needSuper()/inProject()` and `audit()` (`rbac/auth.ts`, `rbac/audit.ts`); `runWithContext` and RLS patterns (`db.ts`, migration 012/026); `modulesOf/setModule` as the pattern for flags (`planning/service.ts`); `moduleOn` as the template for the mode guard (`planning/routes.ts:36`); `upsertUser`, `loadRecord`, `fakeHttp` fixtures (`etl/load.ts`, `etl/fixtures/fakeHttp.ts`); existing Word export for attachments (`docs/routes.ts`); report dataset/measure registry (`reports/engine.ts` `DATASETS`); `SettingsShell`, `useSectionHash`, `ProjectsAdmin` drill pattern for UI.

## Verification
- **Unit**: capability matrix per mode and override; secret encrypt/decrypt round trip and redaction; SSRF validation; status-map resolution; rule evaluation; idempotency key stability.
- **API integration** (vitest, DB): table-driven guard test (every state-changing route and the three non-HTTP creators in each mode); sync against extended fake Jira/ServiceNow (incremental cursor, deletions, history timestamps, 429 backoff, unchanged-hash skip, RLS isolation between projects); outbox (queued in same transaction as the transition, retry/backoff, dry-run sends nothing, conflict sets `out_of_sync`, kill switch, Mirror can never enqueue); report measures on seeded history.
- **E2E (Playwright)**: Super Admin sets each mode and sees the UI change; Mirror project: no create/intake, local status + source status shown, nothing sent; Connected project against a local mock Jira/ServiceNow server (like `tests/e2e/mock-gemini.mjs`): pull, approve Unit Test + customer sign-off, rule fires, mock receives the status; failure shows in Sync health and retries.
- **Regression**: existing suites run unchanged for default Full projects (the proof that nothing was scrapped).

## Risks and open items
- Jira Cloud vs Data Center auth/endpoints differ; ServiceNow states differ per table and per instance (mapping UI is the answer). SAP Cloud ALM API coverage must be confirmed with a spike before promising write support.
- Webhooks need a reachable public URL; polling is the baseline.
- Identity mapping quality decides whether "customer who raised it" and assignees resolve; unmapped users must not become privileged members.
- Closing outside the app cannot be prevented in Connected mode; we detect it and flag `out_of_sync`.
- Decide later: one-way "adopt into Full" action for a mirrored project; data retention for removed source tickets.
