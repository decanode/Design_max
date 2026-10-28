# Enterprise AI Project Lifecycle Platform (Architecture & Design Document)

**Project Name:** Design Max
**Document Version:** 2.0 (Final Draft for Kickoff)
**Project Objective:** Build a unified, chat-first enterprise platform consolidating IT Service Management, Agile Project Management, and Technical Documentation into a single AI-driven workflow, serving SAP and multi-stack (.NET/Java/Node) environments. It includes full ETL capabilities to migrate legacy Jira and ServiceNow data.

---

## 1. Core System Architecture

The platform operates on an event-driven microservices architecture, utilizing an AI Observer pattern for data intake and a centralized Vector Knowledge Graph to prevent duplicate enterprise development and leverage historical data.

### A. The Front Door: AI-Observed Omnichannel Intake
*   **Customer-to-Consultant Chat:** Real-time WebSocket-based chat interface.
*   **The AI Observer:** An LLM silently monitors the chat or uploaded call transcripts (Teams/Zoom). It performs Named Entity Recognition (extracting business objects, vendors, material types) and drafts a plain-English requirement summary.
*   **Verification Gate:** The customer clicks "Verify & Approve" on the AI summary to officially log the ticket.

### B. The State Machine Engine
Every ticket adheres to a strict, immutable lifecycle enforced at the database level.
*   **Phase Gating:** `Requirement Verified` -> `FS Drafted` -> `FS Approved` -> `TS Drafted` -> `TS Approved` -> `Development` -> `QA` -> `UAT` -> `Deployed`.
*   **Approval Workflows:** State transitions trigger automated SMTP deep-link emails to designated managers/owners for one-click approvals.

### C. Legacy Migration Engine (ETL for ServiceNow & Jira)
*   **Extraction (API Connectors):** Scripts to pull data from ServiceNow (Incidents, Problems, Changes) and Jira (Epics, Stories, Bugs, Comments, Attachments).
*   **Transformation:** Map legacy states (e.g., Jira "Done", SNOW "Resolved") to Design Max's Phase Gates. Map `sys_users` and Jira Account IDs to corporate Entra ID emails.
*   **Vectorization:** Run Resolution Notes and Acceptance Criteria through the LLM to store as embeddings, allowing the AI to suggest historical fixes for new incoming tickets.
*   **Attachments:** Migrate legacy binaries to S3/Blob storage and link to migrated tickets.

### D. Hybrid Knowledge & Discovery Engine (The Ingestion Workers)
Automated background ingestion workers populate a central Vector Database (`pgvector`):
*   **Static KB Worker:** Connects to SharePoint/Confluence APIs to ingest legacy PDFs and SOPs. Exposes a manual upload dashboard strictly to `Project_Admins` via RBAC.
*   **SAP Metadata Worker:** Connects via RFC to extract ABAP program headers (`TRDIR`), transaction codes (`TSTC`), selection screens, ALV field catalogs, and usage frequency (`ST03N`).
*   **Git AST Worker:** Clones corporate Git repositories for non-SAP stacks, parsing `README.md` files, Swagger/OpenAPI specs, and function headers.

### E. Auto-Documentation Engine
*   **Generative Markdown:** Upon FS phase entry, the LLM aggregates the chat transcript to output a Functional Specification in a collaborative markdown editor.
*   **Technical Translation:** Following FS approval, the LLM maps the business logic to the ingested SAP/Git metadata to draft the Technical Specification.
*   **Versioning:** All document changes track Git-style diffs and immutable revision histories.

---

### F. Role-Based Access Control (added by approved design change)
*   **Roles & views:** Customer, Consultant, Lead, Manager and Admin ship built in; each gets a different home view (customer: own requests and a "raise a request" entry; consultant: own work plus the intake queue; lead: team workload and assignment; manager: portfolio and an approvals queue; admin: everything plus the console). A sixth built-in role, `Approver`, covers external approvers who act only through emailed links.
*   **Permissions:** a fixed catalog of permissions grouped by feature (Board, Tickets, Chat, Specifications, Approvals, Dashboards, Developer tools, Administration). A role is a set of permissions. `Admin` implicitly holds every permission and cannot be restricted.
*   **Admin console:** admins create and delete custom roles (optionally cloning an existing role), tick permissions per role per feature, and assign roles to users. Every change is written to an audit log and takes effect immediately; the system refuses to leave zero active Admins.
*   **Enforcement:** server-side on every API route and Socket.io event (the UI hiding controls is a convenience only). Ticket visibility is scoped by permission (`view_all`, `view_own` = customer or assigned consultant, `view_unassigned`); tickets a user may not see answer 404.
*   **Superseded by section K:** roles are now per project, not global, and "Admin" is split into Super Admin and Project Admin. The sentence below about roles being global per user no longer applies.
*   **Identity:** signed, expiring session cookie. Development uses an account-picker login; Sprint 4 replaces it with SAML/OIDC SSO (Entra ID) mapped onto the same users and roles. Roles are global per user for now; per-project membership is a planned refinement.

### G. Technology-Stack Scoping (added by approved design change)
*   **Allowed stacks per project:** admins maintain a catalog of technology stacks (SAP, .NET, Java, Node.js built in; more can be added, each with a description told to the AI and identifying keywords) and choose which stacks each project allows. A project with no stacks is unrestricted.
*   **The AI works only inside them:** the AI Observer and the FS/TS generators receive the project's allowed stacks as a hard constraint in their instructions. A request that needs another technology is flagged `out_of_scope` (no solution is drafted) and cannot be verified; partly-outside requests are flagged `unclear`.
*   **Server-side backstop:** the model is not trusted alone. Keyword checks over the customer's words and over generated specs raise flags (and downgrade an `in_scope` verdict) when terms from a non-allowed stack appear; ticket pages show a warning banner for off-stack content.
*   **Retrieval is stack-filtered:** embeddings can carry a stack tag, and Technical Spec generation only draws on generic assets and assets tagged with an allowed stack (SAP metadata is tagged `SAP`).
*   **Project choice:** customers pick the project when starting a conversation; the conversation shows the project and its allowed stacks.

### H. Customizable Dashboards & Reporting (added by approved design change)
*   **Reports are saved definitions, not SQL:** a report picks a dataset (Tickets, Approvals, Phase changes), a measure (count, average age, average time to decision, …), an optional grouping (phase, project, consultant, source, month/week/day, …), filters, and a chart (single number, columns, bars, line, share-of-total, table). The server validates the definition and builds the query only from whitelisted fragments with bound parameters.
*   **Every number respects visibility:** report queries are restricted to the tickets the *viewer* may see (same rule as the board), so the same shared dashboard shows each person only their own slice.
*   **Dashboards are arranged collections of report widgets** (small/medium/large, reorderable) that can be private or shared. Built-in reports and a "Delivery overview" dashboard ship ready to use; they can be copied and customized.
*   **Permissions:** `report.view`, `report.build` (create/edit/copy/share own), `report.manage_all` (edit anyone's, including built-ins). Admin can grant these to any role.
*   **Reporting output:** each report downloads as CSV (formula-injection safe); every chart has a table view and hover/keyboard tooltips for accessibility.
*   **Not yet:** scheduled/emailed reports, dashboard-wide filters, drill-through to tickets, and PDF export.

### I. Multi-Level Approval Workflows (added by approved design change)
*   **Admin-defined chains (ServiceNow-style L1, L2, L3…):** an approval workflow is an ordered list of levels (1–10, renameable). Each level names approvers — specific people and/or roles (a role means every active member) — and a rule: *any one* approver completes the level, or *everyone* must approve. Workflows apply to the Functional Spec, the Technical Spec, or both, for all projects or a single project (project-specific wins); at most one active workflow per project and document type. A built-in "Standard approval" (L1: any Manager) ships as the default.
*   **Sequential execution:** level N+1 is only asked after level N completes; each asked person gets an emailed single-use deep link (and sees the task in-app). A rejection (reason required) at any level ends the request and returns the document to drafting; the requester is told why. Final approval moves the ticket to `FS Approved` / `TS Approved`.
*   **Guardrails:** requesters cannot approve their own request; a person who already approved at an earlier level is not asked again (levels they cover pass automatically); every level must be satisfiable before a request starts; requests carry a frozen copy of the workflow, so editing a workflow never changes one in flight; editing the document withdraws a running request; the requester or an Admin can cancel. Decisions lock the request row so concurrent approvers cannot double-advance a level.
*   **Authority:** being named in a workflow is the authority to decide (the standalone `approval.decide` permission was removed). New permission `admin.workflows` manages workflows; changes are audit-logged.
*   **Visibility:** the ticket page shows the route before requesting and a live level-by-level timeline afterwards (who approved, who is pending, comments); reports gain an "Approval level" grouping.
*   **Not yet:** escalation/timeouts, delegation/out-of-office, conditional levels (e.g. by ticket size), and email/Teams reminders.

### J. Column-Level Security for Tickets (added by approved design change)
*   **Field access per role:** each ticket field — title, requirement summary, customer, assigned consultant, project, legacy (Jira/ServiceNow) reference, resolution notes, acceptance criteria — is set per role to **Hidden**, **Read only** or **Can edit** by an Admin in a grid (fields × roles). ID, phase, dates, the awaiting-approval flag and an "is assigned" flag are core and always visible; the title can never be hidden; customer, project and legacy fields are never editable. Admin always has the maximum for every field.
*   **Defaults:** existing roles keep today's access (built-in roles tuned: Customer cannot see the legacy reference; Consultant and Lead can edit summary, notes, criteria and the assignment; Manager reads everything; Approver sees little). A newly created role is closed — title only — until an Admin opens fields; cloning a role copies its field access.
*   **Enforced server-side wherever ticket data leaves:** board list, ticket detail, create/phase-change responses, ticket edits, claim/assign (need Edit on the consultant field), reports and CSV downloads (a report may not group or filter by a field the viewer cannot read — the widget shows "your role cannot see this data" instead of leaking it), and the team dashboard. A ticket's *visibility* (which rows) is decided independently of which columns are readable.
*   **Editing:** a Details panel on the ticket page edits title/summary/notes/criteria; a request touching any field the role cannot edit is refused as a whole; the audit log records which fields changed, never their values.
*   **Scope and limits:** this is application-level enforcement. Documents (FS/TS), chat summaries and approvals are governed by their own permissions, not by these field rules. Database-level protection (Postgres row-level security / column grants) remains part of the pending security-foundations work. Reads are not audit-logged.

### K. Multi-Project Workspaces and Delegated Administration (added by approved design change)
*   **Two admin tiers.** A **Super Admin** (a flag on the account, not a role) runs the platform: creates projects and accounts, appoints each project's Project Admin, and owns the shared catalogs (the standard roles with their default permissions and ticket-field access, and the technology stacks). A **Project Admin** (a built-in role held inside one project) runs that project only: members and their roles, tuning what each role can do and see in the project, approval workflows, the allowed technology, and the project's reports. A Super Admin can step into any project; each entry into a project they do not belong to is written to that project's activity log.
*   **Roles belong to a project membership, not to a person.** One person can be a Consultant in Project A and a Customer in Project B. The header's project switcher chooses which project the person is working in; permissions, ticket-field access and every row they can see are computed for that project. Accounts with no membership can sign in but reach nothing.
*   **Each project is a separate workspace.** Tickets, chats, drafts, documents, approvals, workflows, custom reports and dashboards, knowledge-base entries and the audit trail all carry a project, and every query is scoped to the person's current project taken from the session (never from the request). Role-based approvers mean *this project's* members of that role. Built-in reports and dashboards are shared templates: they show each project its own numbers and are read-only for everyone (copy to customize). Knowledge entries with no project are shared platform knowledge; all others are visible to their own project only.
*   **Per-project rules.** Each role has a standard template (platform catalog); a Project Admin may override a role's permissions and its ticket-field access for their project (with Reset to the standard role). Only project-level permissions can be given to a project role; platform permissions (manage projects/users/catalogs, the dev mailbox) are Super Admin only.
*   **Guardrails.** A project always keeps a Project Admin; the platform always keeps a Super Admin; archived projects cut every member off at once; a forged project cookie changes nothing because membership is re-checked on every request.
*   **Migration.** Existing data keeps working: the old Admin role became Super Admin, every existing person kept their role in every existing project, each project received its own copy of the standard approval workflow, and existing custom reports moved into the first project.
*   **Second layer: the database enforces the wall too.** The app connects as a restricted Postgres account (`design_max_app`: not a superuser, cannot bypass row-level security, cannot alter the schema or the migration history); migrations run as the owner. Every query is stamped with the caller's project (or "platform" for Super Admin console, sign-in and the public emailed-link approval; nothing at all = fail closed), and row-level-security policies on all project tables (tickets, conversations, messages, drafts, documents, approvals and requests, transitions, comments, attachments, workflows and their levels, reports, dashboards, knowledge, audit) show and accept only that project's rows. Child tables inherit their parent's visibility. Shared rows (built-in reports/dashboards, platform knowledge) are readable everywhere but writable only by the platform. The audit trail is append-only for the application account. As a result even a query that forgets its WHERE clause cannot cross a project wall.
*   **Production note:** set the application account's password out of band (`ALTER ROLE design_max_app PASSWORD '…'`) and point `DATABASE_URL` at it; `MIGRATE_DATABASE_URL` stays the owner.
*   **Not yet:** the old shared "Standard approval" template is not editable from the UI; no per-project custom roles (projects tune the catalog's roles).

## 2. Technology Stack

| Layer | Component | Purpose |
| :--- | :--- | :--- |
| **Frontend** | React (Next.js) | UI for Kanban, chat windows, and Markdown editors. |
| **Backend API** | Node.js | Event-driven backend for WebSockets and ETL workers. |
| **Database** | PostgreSQL | Relational schema enforcing the State Machine. |
| **Vector Search**| `pgvector` | Store AI embeddings of Jira/SNOW data, SAP metadata, and Git code. |
| **Real-Time** | Socket.io | Bi-directional communication for chat. |
| **AI / LLM** | OpenAI API / Claude | AI Observer, FS/TS generation, Vector Embeddings. |
| **Testing** | Playwright | Automated end-to-end (E2E) testing framework. |
| **Security** | SAML 2.0 / OIDC | Integrates with corporate IdP (Entra ID) for Smart Card SSO. |

---

## 3. Database Schema Blueprint (PostgreSQL)

**Core Tables:**
1.  **`Users` & `Roles`**: SSO identities to RBAC permissions.
2.  **`Projects`**: Scopes, target environments, and associated SharePoint/Git links.
3.  **`Tickets`**: Contains `current_state`, `customer_id`, `consultant_id`, `ai_summary`, and `legacy_id` (for migrated records).
4.  **`Approvals`**: Tracks `ticket_id`, `approver_id`, `status`, and timestamps.
5.  **`Documents`**: Markdown content for FS/TS, linked to `ticket_id` with `version_number`.
6.  **`Embeddings` (pgvector)**: Vector arrays of migrated tickets, SAP headers, Git repos, and KB docs.

---

## 4. Execution Roadmap

**Sprint 0: Architecture & State Machine (Weeks 1-2)**
*   Monorepo setup, PostgreSQL + pgvector provisioning, Playwright configuration.
*   Deploy relational schema (Tickets, States, Users) and backend State Machine logic.

**Sprint 1: ETL Migration & Ingestion Workers (Weeks 3-5)**
*   Develop Jira and ServiceNow API Extractors. Map and load legacy data.
*   Develop SAP RFC extractor and Git/SharePoint API connectors.
*   Build vectorization pipeline for all ingested legacy and metadata.

**Sprint 2: Intelligent Intake & Chat (Weeks 6-8)**
*   Build React chat UI and Socket.io backend.
*   Integrate LLM "Observer" to draft the Ticket Summary and wire the "Verify & Approve" flow.

**Sprint 3: Documentation Engine & Approvals (Weeks 9-11)**
*   Implement Markdown collaborative editor.
*   Write LLM prompts for auto-generating FS and TS from Ticket Context + Vector Results.
*   Build SMTP email trigger system for Approvals.

**Sprint 4: Enterprise Handover (Weeks 12-14)**
*   Configure SAML 2.0 / OIDC for Smart Card SSO.
*   Playwright E2E test passes, UI/UX polish, UAT, and Go-Live.

---

## L. Documents: types, live drafts, comments, templates (approved 2026-10; supersedes the Markdown-only document model)

**Types.** Four fixed document types in code (`docs/kinds.ts`) and in DB check constraints: FS, TS, TUT (Technical Unit Test), CRC (Code Review Checklist). Per-type rules say when each can be generated and edited, and whether approval moves the ticket (FS → FS Approved, TS → TS Approved) or locks the document (TUT, CRC). Approval workflows (`approval_workflows.kinds`), requests, reports and the UI cover all four. The optional **QA gate** (`project_doc_settings.qaGate`, default false) blocks `Development → QA` until TUT and CRC have an approved request; enforced in `transitionTicket` (non-internal path).

**Content.** Canonical form is ProseMirror JSON (`documents.content_json`), with a plain-text rendering (`content_text`) for diffs, checks and search. `content_md` is nullable and legacy rows are converted on read (`markdownToPm`). Versions stay immutable (trigger). The editor schema lives in one shared workspace package, `packages/doc-schema` (Tiptap extensions), used by the browser editor and the collaboration server so both agree on what content can exist.

**Two layers: working draft and versions.** The *draft* is a Yjs document per (ticket, kind) stored in `document_drafts` (RLS by project). Versions are immutable snapshots of it, created by *Save version*, automatically when approval is requested, before a merge, and by the legacy `POST …/versions` API (which then resets the draft). A draft is read-only while an approval is in progress, after FS/TS approval, and for an approved TUT/CRC.

**Live co-editing.** Hocuspocus (`apps/api/src/collab`) is attached to the same HTTP server on `/collab` (WebSocket upgrade; Socket.io keeps its own path). The browser reaches it through the Next.js rewrite, so it stays same-origin (works in Codespaces). Authentication is a **short-lived (5 min) HMAC pass** from `POST …/collab-token` naming exactly one room `projectId:ticketId:kind` and whether the person may edit; the server re-checks ticket visibility and permissions when issuing it and opens read-only connections for people without edit rights. Storage runs inside the project's database context (RLS). Decision: Tiptap 2.x pinned, Yjs CRDT, Hocuspocus 4.

**Comments.** `doc_comments` (threads: root + replies, status open → addressed → resolved, mentions) and `doc_reviews` (request changes / looks good), both RLS-isolated. Anchors are stored as **Yjs relative positions plus the quoted text**, so they move with the text, can be created by read-only reviewers (no mutation of the draft) and degrade to "text removed" instead of vanishing. Permissions `doc.comment` and `doc.review` are project-scoped; notifications go through the Mailer. Optional project rule `blockApprovalOnOpenComments`.

**Upload and merge.** `mammoth` converts .docx to HTML and `htmlparser2` to editor content, after checks (size, zip entries and expanded size, no macros, no encryption, no DOCTYPE/ENTITY). Sections (headings level ≤ 2) are matched by normalised title then by word overlap; the merge screen chooses per section (use upload / keep draft / keep both / add / leave out). Before merging the draft is snapshotted; the merge becomes a normal new version and the draft is reset to it. Originals are kept in `doc_uploads`. Section-level content-control tags in exported files were considered and dropped as out of scope.

**Templates and settings.** `doc_templates` (platform-owned, one active version per (stack, type), `docx bytea`) is validated on upload and selected at export (stack → generic → built-in). `fillTemplate` fills `{{TOKENS}}`, `{{BODY}}`, `{{APPROVALS}}`, `{{REVISIONS}}` in place so styles, fields and page numbers survive. Per-technology content **outlines** (`docs/outlines.ts`: SAP, .NET, Java, Node.js, generic) drive both the offline draft and the AI's instructions. Settings layer: built-in → `platform_doc_defaults` → `project_doc_settings`. Not built: logo, Word comments in the export, per-section AI regeneration (it would replace the whole shared draft and orphan comment anchors).

---

## M. Dynamic state machine and templating engine (directive FEATURE_DYNAMIC_WORKFLOWS.md)

**Decision.** The ticket lifecycle is data, not code. The enum `ticket_state` and the linear trigger are gone; `tickets.current_state` holds a phase name, and legality of a move comes from `workflow_transitions` evaluated per project and ticket type.

**Model.** Masters (platform-owned): `template_types` (methodology), `project_types`, `ticket_types`, `phases` (with a lane tone), `template_phases` (a methodology's phases, board order, default on/off), `template_ticket_types`, `workflow_transitions(template, ticket_type NULL=general flow, from NULL=entry, to, gated_reason)`, `ticket_type_fields` (the dynamic form definition) and the `project_type_*_defaults` tables. Per project (RLS-isolated): `projects.project_type_id/template_type_id`, `project_phases(enabled, position)`, `project_ticket_types(enabled, is_default)`. Tickets gain `ticket_type_id` and `dynamic_metadata JSONB` (validated against the type's fields on create and edit with a zod schema built at runtime; covered by column security as field `details`).

**Graph rule.** SQL function `next_phases(project, ticket_type, from)`: a ticket type with transitions of its own uses only those, otherwise the methodology's general flow; the walk skips switched-off phases (a recursive CTE with a depth bound), and `from = NULL` yields the entry phase. The same function backs the trigger `tickets_state_guard` (the database refuses illegal moves), the `BEFORE INSERT` trigger that gives a new ticket its project's default type and entry phase, the application's `transitionTicket`, the `/api/tickets/:id/next` endpoint and `/api/workflow` (which also returns the full move table for the board). Document-driven steps carry `gated_reason` and can only be taken by the document/approval flow (`internal`). Phases that touch gated steps cannot be switched off or removed.

**Defaults and compatibility.** Existing projects were backfilled to Implementation + Waterfall with the nine original phases on and Requirement as the only ticket type; a project inserted without a template gets the same (trigger `project_defaults`), so nothing that predates the feature changes. `seed_project_workflow` applies a project type's defaults when a project is created with a type or when the builder changes it.

**Administration.** Project Admin: `GET/PUT /api/project/template` (validated in one transaction: methodology and types must be compatible, locked phases stay on, existing tickets must still fit, every enabled type must have an entry phase). Super Admin: `/api/platform/workflow/*` manages ticket types and fields, phases, methodologies (phases, ticket types, transitions; a methodology can be copied) and project-type defaults; changing a methodology re-syncs the projects that use it and is refused if it would strand tickets.

**Consumers that stopped using a fixed state list:** board columns, ticket stepper, dashboards ("open" = not in a `done`-tone phase), reports (phase dimension and filters), legacy import (names only). Document rules still refer to phase names, so documents are unavailable where a methodology has no such phase.

**Libraries added (web):** `react-hook-form` (form state), `zod` (the same field rules as the server), `@hookform/resolvers`, `framer-motion` (card, dialog and flow transitions). Drag-and-drop was not added: phase order is edited with explicit up/down controls, which are keyboard-accessible.

