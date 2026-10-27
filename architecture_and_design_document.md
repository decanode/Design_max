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
*   **Identity:** signed, expiring session cookie. Development uses an account-picker login; Sprint 4 replaces it with SAML/OIDC SSO (Entra ID) mapped onto the same users and roles. Roles are global per user for now; per-project membership is a planned refinement.

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