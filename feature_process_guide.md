# Design Max: Feature & Process Guide

**What this document is.** A plain-language walkthrough of everything the platform does today: what each feature is, how to use it, and what to expect from it. It is kept up to date after every new feature (see rule 9 in `system_ground_rules.md`).

**Status as of this version:** Sprints 0–3 are built, plus role-based access, technology scoping, reports and dashboards, multi-level approvals, column-level security, and multi-project workspaces. Sprint 4 (company single sign-on, final polish) and the live connections to Jira, ServiceNow, SAP and company email are not done yet; they are listed at the end.

---

## 1. Getting started

### Run it
```bash
npm install
cp .env.example .env     # add any API keys you have (all optional)
npm run dev              # database + upgrades + API (:4000) + web app (:3000)
```
Open http://localhost:3000.

- **If the sign-in page says the database is not running**, run `npm run dev:up`, then click *Try again*. This happens after a Codespace is paused; no data is lost.
- **Tests** (`npm run test:unit`, `npm run test:e2e`) use their own throw-away database and never touch your data.

### Sign in
Sign-in is a **development account picker** for now (company single sign-on replaces it in Sprint 4). On a brand-new system choose **Create demo accounts**:

| Account | Role | What they are for |
|---|---|---|
| Ada Admin | **Super Admin** | Creates projects and appoints their admins |
| Pia Project Admin | **Project Admin** | Runs the *Default* project |
| Leo Lead | Lead | Assigns work, sees the whole team |
| Mia Manager | Manager | Approves specifications, watches the portfolio |
| Sam Consultant | Consultant | Answers chats, writes specifications |
| Cleo Customer | Customer | Raises requirements and follows them |

*Expect:* clicking an account signs you in and lands you on your own view. **Sign out** is at the top right. A session lasts 8 hours.

---

## 2. Who can do what

### The two admin tiers
- **Super Admin**: runs the whole platform. Creates projects and accounts, appoints each project's Project Admin, and keeps the standard role list and technology list. A Super Admin can step into any project to help.
- **Project Admin**: runs **one** project. Chooses who is in it and in which role, tunes what each role can do there, sets approval workflows, the allowed technology and ticket field access.

### Project roles (the standard setup)
| Role | Can do by default |
|---|---|
| **Customer** | Starts chats, confirms the AI summary, sees only their own tickets and reads specifications |
| **Consultant** | Replies in chats, sees their own tickets plus the intake queue, claims tickets, writes and edits specifications, requests approvals, views dashboards |
| **Lead** | Everything a Consultant does, plus sees all tickets, creates tickets, assigns work, moves tickets through delivery, sees team workload, builds reports |
| **Manager** | Sees all tickets, moves tickets through delivery, sees the portfolio, builds reports |
| **Approver** | No screens of their own; approves through emailed links |
| **Project Admin** | Everything inside their project, always (cannot be restricted) |

A Project Admin can change any of these for their own project (section 11).

### One person, several projects
Roles belong to a **project membership**, not to the person. Someone can be a Consultant in one project and a Customer in another.

- **To give someone access to two projects:** the Project Admin of each project adds them under *Project settings → Members*, using the same email. The existing account is reused; no second account is created.
- **A project menu appears in the header** showing each project and their role in it. Switching reloads the page, so nothing from the previous project stays on screen.
- *Expect:* in each project they see only what their role there allows. They cannot see the other project's tickets, chats, approvals or reports, even by guessing a link.
- **Removing** them from one project ends access to that project only. **Deactivating** the account (Platform → Users) cuts them off everywhere.

---

## 3. Chat and the AI requirement summary

**What it is.** A real-time chat between a customer and a consultant. An AI assistant listens in silently and keeps a plain-English **requirement summary** up to date. The customer confirms it, which creates a ticket.

**How to use it**
1. Customer: **Chat → Start a conversation**, then describe the need.
2. The summary appears on the right: a title, the summary, and the business objects, vendors and material types it found.
3. Consultants (and Leads/Managers who can see all chats) pick the conversation from the left list and reply.
4. When the summary is right, the **customer** clicks **Verify & Approve**.

**What to expect**
- Messages are saved and survive a reload. Customers see only their own conversations; consultants can see all conversations in their project.
- Verifying creates **exactly one** ticket at *Requirement Verified*, even if the button is clicked twice. After that the summary is frozen.
- Each chat belongs to the project you are working in.
- Names on messages come from the signed-in account; they cannot be faked.

**Which AI does the summarising.** The server picks the first one configured in `.env`: GitHub Models (company licence) → Google Gemini → Anthropic. With none set it uses a simple offline stand-in that recognises a few keywords (fine for trying the screens; not a language model). Set `AI_PROVIDER=gemini` (or `github`, `anthropic`, `offline`) to force one. If the AI is briefly unavailable, chat keeps working and the summary simply does not update.

---

## 4. Technology scoping

**What it is.** Each project can be limited to the technologies it works in (for example SAP only). The AI then drafts only within those technologies.

**How to use it**
- **Project Admin:** *Project settings → Technology*, tick the allowed technologies. Nothing ticked means no restriction.
- **Super Admin:** *Platform → Technology catalog* adds or edits the technologies themselves (name, a description told to the AI, and identifying keywords). Built in: SAP, .NET, Java, Node.js.

**What to expect**
- A chat request that needs another technology (for example "build a C# web API" in an SAP project) is flagged **out of scope**: a red notice appears and **Verify & Approve is disabled**. A request that mixes technologies gets an amber "check the scope" notice.
- Drafted specifications stay within the allowed technology; if one drifts, the ticket shows a warning banner naming the off-stack terms.
- Search suggestions only draw on assets from the allowed technologies.
- The server double-checks the AI with its keyword lists, so it does not rely on the AI behaving. Keywords are a safety net, not a guarantee.

---

## 5. The board and the ticket lifecycle

**What it is.** Every ticket moves through nine phases, in order, one step at a time:

`Requirement Verified → FS Drafted → FS Approved → TS Drafted → TS Approved → Development → QA → UAT → Deployed`

The database itself refuses any other move, and every move is logged.

**How to use it**
- **Board** (home page): columns grouped as Intake, Specification, Delivery and Done. Use the search box to filter by title. Click a card to open the ticket.
- **Create a ticket** (roles that may): type a title and click *Create ticket*. It always lands in the project you are working in.
- **Advance** (Lead, Manager and others who may): the button appears on tickets from *TS Approved* onward.
- **Steps before TS Approved cannot be skipped.** Moving into *FS Drafted* needs a generated Functional Specification, and moving out of the specification phases needs the approvals described in section 7.
- Each role gets a panel at the top of the board: customers a "Raise a new request" button; consultants the **Intake queue** (unassigned tickets with a *Claim* button); leads **Team workload** and assignment; managers the **Portfolio** chart; anyone with approvals waiting sees **Waiting for your approval**.

**What to expect:** customers see only their own tickets; consultants their own plus the unassigned queue; leads and managers all tickets in the project. A ticket you cannot see answers "not found", never "forbidden", so its existence is not revealed.

**Ticket page and details.** Opening a ticket shows who the customer and consultant are, the lifecycle stepper, a **Details** panel (summary, resolution notes, acceptance criteria, project, legacy reference) and the specification tabs. Roles that may edit fields see **Edit details**; a save is refused as a whole if it touches any field your role cannot edit.

---

## 6. Functional and Technical Specifications

**What it is.** The FS and TS documents for a ticket, drafted by AI from the chat, edited by people, with full history.

**How to use it** (Consultants, Leads and anyone with the right permissions)
1. On a ticket at *Requirement Verified*, open **Functional Spec** and click **Generate FS draft**. The ticket moves to *FS Drafted*.
2. Edit in the markdown editor (live preview alongside). Click **Save new version**.
3. Open any older version from the **Versions** list. A diff shows what changed compared with the latest.
4. Request approval (section 7). Once the FS is approved it is **locked**, and the **Technical Spec** can be generated from it.

**What to expect**
- Every save is a new immutable version; nothing is overwritten, and the database refuses edits to history.
- If a colleague saved first, you get a clear conflict message and must reload; you can never silently overwrite their work.
- The author shown is the signed-in person.
- Without an AI key the draft is a structured outline for the consultant to complete, not finished prose. With a key, the AI writes a fuller draft; always review it before approval.
- Editing a document **withdraws** any approval request still open on it, because the text being approved no longer exists.

---

## 7. Approval workflows (L1, L2, L3…)

**What it is.** The chain of sign-offs a specification needs. The Admin decides who approves and in what order; any number of levels.

### Setting it up (Project Admin)
*Project settings → Approval workflows → Edit / New workflow*:
- Choose which documents it covers (FS, TS or both).
- Add **levels** (up to 10). Name them L1, L2, L3 or anything you like, and reorder them.
- For each level choose the approvers: **specific people** and/or **whole roles** (a role means every active person in this project holding it).
- Choose the rule per level: **any one approver is enough**, or **everyone must approve**.
- Workflows can be switched on or off. Only one active workflow per document type per project.
- Every new project starts with its own copy of **Standard approval** (L1: any Manager).

### Using it
1. A Consultant or Lead finishes the draft and sees the **Approval route** (for example *L1 Managers → L2 Leads*). They click **Request approval**.
2. Level 1 approvers get an email with a one-click link and see the task under **Waiting for your approval** on their board.
3. Approvers open the ticket and click **Approve**, or **Reject** with a comment (required).
4. When a level is complete, the next level is asked. When the last level approves, the ticket moves to *FS Approved* / *TS Approved* and the requester is emailed.
5. A live **timeline** on the ticket shows each level: approved, waiting, not started, passed, or rejected, with who and when.

### What to expect
- A rejection at any level ends the request, sends the reason to the requester, and returns the document to drafting. Fix it and request again from L1.
- **Nobody approves their own request.** A request will not start if a level would have no one eligible.
- Someone who already approved at an earlier level is **not asked again**.
- Two people approving at the same instant can never advance a level twice.
- Changing a workflow never changes a request already under way; it follows the route it started with.
- The requester (or a Project Admin) can **Cancel request**.
- Emailed links work once and expire after 7 days. Decisions made inside the app do not expire.
- **Email today:** emails are written to a local **Mailbox** page (visible to Super Admins), not sent. Connecting company email (Microsoft 365) is planned.

---

## 8. Dashboards and reports

**What it is.** Tracking and reporting you can build yourself, without code.

**How to use it** (menu: **Dashboards**; roles with the report permissions)
- Open **Delivery overview**, a ready-made dashboard: open tickets, average age, approval time, tickets by phase, approvals by status, new tickets per month, deployments per month, workload by consultant, tickets by source.
- Built-in dashboards and reports are **copy-only**: click **Copy to customize** to get your own editable version.
- **Edit dashboard**: add reports, remove, reorder, resize (small/medium/large), rename, and choose *private* or *shared with the project*.
- **Reports → New report**: pick what to report on (Tickets, Approvals or Phase changes), the measure (a count, average age, average time to decision), how to group (phase, consultant, source, month/week/day, approval level…), filters, and how to show it: single number, columns, bars, line, share of total, or table. The preview updates as you change things.
- Every chart has a **Table** view and a **CSV** download.

**What to expect**
- **Numbers always respect what the viewer may see.** A shared dashboard shows each person only their own slice (a customer would see only their tickets).
- Reports are per project: a custom report never appears in another project.
- A report that groups by a field you are not allowed to read shows "your role cannot see this data" instead of leaking it.
- Empty months show as zero; ties are ordered by name so charts do not jump around.
- Not yet: dashboard-wide filters, click-through to the tickets behind a bar, scheduled or emailed reports, PDF export.

---

## 9. Column-level security (who sees which ticket fields)

**What it is.** Control over which parts of a ticket each role can see or change: title, requirement summary, customer, assigned consultant, project, legacy Jira/ServiceNow reference, resolution notes, acceptance criteria. Each is **Hidden**, **Read only** or **Can edit** per role.

**How to use it**
- **Project Admin:** *Project settings → Ticket fields*. Change a cell; it applies immediately. A role you changed shows **Customized**; **Reset** returns it to the standard role.
- **Super Admin:** *Platform → Default ticket fields* sets the standard every project starts from.

**What to expect**
- ID, phase, dates and the awaiting-approval flag are always visible; the title can never be hidden; customer, project and legacy fields are never editable.
- A hidden field leaves no trace: no label, no blank space. It is removed from the board, ticket page, API responses, reports and CSV downloads.
- Which tickets a person sees is separate from which columns they can read.
- A brand-new role starts closed (title only) until opened.
- Specifications, chat summaries and approvals follow their own permissions, not these field rules.

---

## 10. Platform console (Super Admin)

**Menu: Platform.** Tabs:
- **Projects**: *New project* (name, optional first Project Admin's email, optional technology). The project starts with its own copy of the standard approval workflow. *Appoint* additional Project Admins; *Open project* to step into it; *Archive* to cut everyone off at once (nothing is deleted; *Restore* brings it back).
- **Users**: everyone on the platform, the projects and roles each holds, and toggles for **Super Admin** and **Active**. A new account can reach nothing until a Project Admin adds them to a project.
- **Role catalog**: the standard roles and what each can do. Add a custom role (optionally copying an existing one). Only project-level permissions can be given to a role.
- **Default ticket fields**, **Technology catalog**, **Activity** (platform-wide log).

**What to expect:** at least one active Super Admin always remains. When a Super Admin steps into a project they do not belong to, the entry is recorded in **that project's** activity log, where its own admin can see it.

---

## 11. Project settings (Project Admin)

**Menu: Project settings** (shows the project name). Tabs:
- **Members**: add people by email with a role (a new email creates an account that can reach nothing else), change someone's role, or remove them. A project always keeps at least one Project Admin.
- **Roles & permissions**: what each role can do **in this project**. Roles you have not touched follow the standard; changing one affects only this project, and **Reset** undoes it. Platform powers cannot be given to a project role.
- **Ticket fields**, **Technology**, **Approval workflows**: as in sections 9, 4 and 7.
- **Activity**: a log of changes made in this project.

---

## 12. Isolation and security, in plain terms

- **Projects are separate workspaces.** Tickets, chats, specifications, approvals, workflows, reports and the activity log all belong to one project, and every request is limited to the project you are working in. The project is taken from your session, never from the request.
- **Two layers.** The application filters by project, and the **database itself also refuses** to return another project's rows. The server connects as a restricted database account that cannot bypass these rules, so even a coding mistake cannot leak data across a project wall. The audit trail cannot be edited by the application.
- **Access is checked on the server for everything.** Hiding a button is a convenience, never the protection.
- **Sessions** are signed and expire; a deactivated user loses access immediately; a forged project cookie changes nothing.
- **Audit log.** Changes to roles, members, workflows, fields, technology and projects are recorded with who and when (field *names* are logged, never the sensitive values).

---

## 13. Migrating legacy data (Jira and ServiceNow)

**What it is.** Importers that bring existing Jira issues and ServiceNow incidents/problems/changes into a project, with comments, attachments and resolutions. Legacy statuses map to phases (for example Jira *Done* and ServiceNow *Resolved* become *Deployed*). Resolution notes and acceptance criteria are turned into searchable knowledge so the AI can suggest past fixes.

**How to use it:** `npm run etl -w apps/api -- <jira|servicenow> <projectId>` with the credentials from `.env.example`. Other ingestion tools read Git repositories, SAP program metadata and SharePoint documents.

**What to expect, honestly:** this is built and tested against sample data only. It has **not** been run against a real Jira, ServiceNow, SAP, SharePoint or Git system. Imported people become **Customers of the project they were imported into**, and the same Jira key can exist in two projects without clashing. The import tools still need a project argument wired in for the Git/SAP/SharePoint workers; attachment storage is local-disk only.

---

## 14. Reliability and development notes

- The database restarts itself after a restart of the environment; `npm run dev:up` repairs a stuck container and applies pending upgrades.
- If the database is down the app says so clearly and recovers on its own when it returns.
- `npm run db:migrate` applies upgrades as the database owner. The running app uses a separate restricted account (see README for the production password step).

---

## 15. Not built yet

- **Company single sign-on** (Entra ID / SAML / OIDC), Sprint 4. Until then sign-in is the development account picker.
- **Real email** (Microsoft 365). Approval emails go to the local Mailbox.
- **Live connections** to Jira, ServiceNow, SAP (RFC), SharePoint and company Git; Confluence; PDF/Word text extraction; S3/Azure file storage.
- **Real-time co-editing** of specifications (today: save with conflict detection).
- **Approval escalation**, reminders, delegation and conditional levels.
- **Call-transcript upload** (Teams/Zoom) as a chat source.
- **Dashboard-wide filters**, click-through to tickets, scheduled/emailed/PDF reports.
- **Project-specific custom roles** (projects tune the standard roles) and a screen for editing the platform's template workflow.
- Production hosting package and IT handover checklist.
