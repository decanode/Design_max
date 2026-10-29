# Design Max: Feature & Process Guide

**What this document is.** A plain-language walkthrough of everything the platform does today: what each feature is, how to use it, and what to expect from it. It is kept up to date after every new feature (see rule 9 in `system_ground_rules.md`).

**Status as of this version:** Sprints 0–3 are built, plus role-based access, technology scoping, reports and dashboards, multi-level approvals, column-level security, multi-project workspaces, and **download as Word (first stage of the document-template work)**. Sprint 4 (company single sign-on, final polish) and the live connections to Jira, ServiceNow, SAP and company email are not done yet; they are listed at the end.

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

## 3. Chat with the assistant

Open **Chat** and press **Start a conversation**. Design Max greets you by name and asks what you want to do. What happens next depends on who you are; this is fixed when the conversation opens.

### If you are a customer (your role cannot act as a consultant)
1. Pick a goal (**Report a problem**, **Ask how something works**, **Request a change or new feature**, **Check on an earlier request**) or just type.
2. **Reporting a problem:** after you describe it, the assistant first offers a few safe steps you can try yourself, and asks **"try these first, or raise an incident now?"**. If it worked, say so: nothing is raised. Problems that look like outages, data loss, money, security or compliance are never sent down the self-help path; they go straight to an incident.
3. When a ticket is the right outcome the assistant asks the few things the team needs (urgency, who is affected, and so on), then shows the **full scope** in the chat and in the **Your request** panel, and asks **"Shall I create this ticket?"**.
4. Reply **yes** (or press **Create ticket**) to confirm. Nothing is created before that.

### If you are a consultant, lead, project manager or admin
1. Pick a goal (**Scope a new requirement**, **Design a solution or logic**, **Troubleshoot an issue**, **Prepare a ticket**) or type.
2. The assistant works as a collaborator: it asks about the objective, who signs it off, objects and data volumes, authorisations, error handling and edge cases, suggests alternatives and things you may not have considered, and builds the overall picture with you.
3. A ticket is **not always the end product**. You may only want a solution, logic or outline: say **"The outline is enough"** and the chat ends with nothing created. If you want it as a ticket, press **Create a ticket**, review the full scope, and confirm.
4. A ticket you confirm is created owned by you; a customer's ticket belongs to the customer.

### Rules that apply to everyone
- **Nothing is created without your explicit confirmation**, and exactly one ticket is created even if you confirm twice. After that the conversation is finished; start a new chat for something else.
- The ticket type and its required fields come from the project's template (section 5). If something required is still missing the assistant asks for it, and **Create ticket** stays disabled.
- Quick-reply buttons appear under the assistant's question; you can always type instead.
- People with *view all conversations* can read other people's chats and comment, but the assistant only answers the person who opened the conversation.
- If the assistant fails, the chat says so, your message is kept, and sending again retries.
- Without an AI key configured, a simpler built-in assistant follows the same flow with fixed questions; it cannot answer "how do I" questions and offers to raise a request instead. With a key (`AI_PROVIDER` / its key variables), a language model follows the system prompts in `apps/api/src/chat/prompts.ts`.

## 4. Technology scoping

**What it is.** Each project can be limited to the technologies it works in (for example SAP only). The AI then drafts only within those technologies.

**How to use it**
- **Project Admin:** *Project settings → Technology*, tick the allowed technologies. Nothing ticked means no restriction.
- **Super Admin:** *Platform → Technology catalog* adds or edits the technologies themselves (name, a description told to the AI, and identifying keywords). Built in: SAP, .NET, Java, Node.js.

**What to expect**
- A chat request that needs another technology (for example "build a C# web API" in an SAP project) is flagged **out of scope**: a red notice appears and **Create ticket is disabled**. A request that mixes technologies gets an amber "check the scope" notice.
- Drafted specifications stay within the allowed technology; if one drifts, the ticket shows a warning banner naming the off-stack terms.
- Search suggestions only draw on assets from the allowed technologies.
- The server double-checks the AI with its keyword lists, so it does not rely on the AI behaving. Keywords are a safety net, not a guarantee.

---

### The Technology screen (Project Admin)
**Project settings → Technology** is a set of cards, one per technology, each showing what the system recognises it by. Tick the ones this project works in and press **Save technology** (nothing changes until you save; **Discard** goes back). The banner at the top says whether the project is limited or unrestricted, with **Select all** and **Clear (no restriction)**.
- **What this means for existing tickets:** as you tick, it counts how many existing tickets already mention technology outside your choice, with links to examples. They are not changed; it is a heads-up.
- **Try a request:** paste something a customer might ask for and press **Check it** to see whether it would be *In scope*, *Check the scope* or *Outside the technology* under your current (unsaved) choice, and which terms triggered it.
- **Where this applies:** the chat assistant, the specification and document drafts, and the warning on ticket pages.

## 5. The board, ticket types and the project template (dynamic workflows)

**What it is.** How a project works is configured, not hard-coded. Each project has a **project type** (Implementation, Support, DevOps, Conversion), a **methodology** (Waterfall, Agile, Hybrid, ITIL), a set of **phases** it uses and a set of **ticket types** its people may create (Incident, Problem, Change Request, Request Item, WRICEF, Epic, Feature, Bug, Requirement). The board, the create form and the allowed moves all follow that configuration, so a Support project and an SAP implementation behave differently without any code change.

**The original lifecycle is the "Waterfall" methodology**, and every project that existed before this feature keeps it unchanged: `Requirement Verified → FS Drafted → FS Approved → TS Drafted → TS Approved → Development → QA → UAT → Deployed` (two optional phases, *Hypercare* and *Closed*, exist after *Deployed* and start switched off for those projects). Other methodologies:
- **ITIL** (Support): incidents, problems and requests go `New → Triage → In Progress ⇄ Pending → Resolved → Closed` (a resolved item can be reopened). **Change Requests** have their own controlled flow: `New → Assessment → Change Approved → Implementation ⇄ Review → Closed` (an assessment can also close a rejected change).
- **Agile**: `Backlog ⇄ Ready → In Progress ⇄ In Review → Done`.
- **Hybrid**: `Backlog → Requirement Verified → FS … TS Approved` (with the same document sign-offs) `→ In Progress ⇄ In Review → UAT → Deployed → Closed`.

**How to use it**

*Super Admin, when creating a project:* Platform → Projects → *New project*. Choose a **Project type** and, if you like, a **Methodology** (the default follows the type). The project starts with that type's phases and ticket types.

*Project Admin, to tune it:* Project settings → **Template builder**.
1. **Project type**: pick a card. Changing it re-applies its defaults (for example Support switches on Incident and Change Request; Implementation switches on WRICEF, Epic and Requirement).
2. **Methodology**: pick a card. Changing it re-applies that methodology's phases.
3. **Phases**: switch phases on or off. A switched-off phase is skipped: tickets go straight to the next phase that is on (for example turn off *Hypercare* for a DevOps-style project). Phases that carry documents and approvals (*FS Drafted … TS Approved*) are locked on. Phases currently holding tickets show how many.
4. **Ticket types**: switch types on or off and choose the **default** type (what the intake chat creates). Each card lists the fields that type asks for.
5. The **Preview** shows how a ticket of the chosen type moves, with skipped phases listed. Click **Save template**.

*Everyone who may create tickets:* on the board click **Create item**. First choose the **type** (only the types the project allows are offered), then fill in the type's fields. Required fields are checked as you submit and again on the server. Examples: an **Incident** asks for Priority, Impact, Urgency, Affected service and Steps to reproduce; a **WRICEF** asks for RICEF category, SAP module and Business value. The values are stored with the ticket and shown on its page in a **<Type> details** panel, where roles with edit access can change them (with the same checks).

*Moving a ticket:* the board shows **Advance → X** when there is exactly one manual next phase, or a **Move to…** menu when there are several. The ticket page has a **Next phase** line with the same choices. Steps that belong to documents and approvals show what they need (for example *Generate the Functional Specification to move forward*) instead of a button.

*Super Admin, to change the building blocks:* Platform → **Workflows**.
- **Ticket types**: create or edit a type and its fields (text, long text, choice, number, date, checkbox; required or not; help text; order). A type can be deleted only if no ticket uses it.
- **Methodologies**: edit phases and their board order, which are on by default, which ticket types a methodology can carry, and the **transitions** between phases (a general flow, plus a flow of its own for a specific ticket type). Create a new methodology empty or as a copy. Projects using a methodology follow the change.
- **Project types**: the methodology, ticket types and phases a new project of that type starts with.

**What to expect**
- **The database enforces the rules.** A ticket can only move along its project's workflow, one legal step at a time; an illegal jump (for example *New → Closed*, or *Requirement Verified → Deployed*) is refused with a clear message by the application and by the database itself. Every move is logged.
- **Each project has its own configuration.** One project's template never affects another's, and a Project Admin can only change their own.
- **Changing methodology** is refused while tickets sit in phases (or are of a kind) the new methodology does not have; the message names them. Switching a phase off never strands tickets already in it: they can still move on.
- **Board columns** are the project's enabled phases, grouped into Intake, Specification, Delivery, Review and Done lanes; a switched-off phase that still holds tickets stays visible, marked *(off)*.
- **Dashboards and reports** list the project's own phases. "Open" means "not in a finishing phase".
- **Documents depend on phases.** FS and TS documents exist in methodologies that have the document phases (Waterfall, Hybrid). Unit Test and Code Review are available in Development, QA, UAT, In Progress and In Review. In an ITIL or Agile project those document tabs simply say they are not available yet.
- **Column-level security:** the type-specific details are one field, *Type-specific details*, in Ticket fields; roles started with the same access as the AI summary.
- **Not built yet:** custom per-project fields beyond a type's own fields, per-project transitions (projects choose phases and types, not new moves), drag-and-drop ordering (use the arrows in the Platform editor), and approvals attached to non-document phases.

**Who sees what on the board (unchanged):** customers see only their own tickets; consultants their own plus the unassigned queue; leads and managers all tickets in the project. A ticket you cannot see answers "not found", never "forbidden", so its existence is not revealed. Each role gets a panel at the top of the board: customers a "Raise a new request" button; consultants the **Intake queue**; leads **Team workload**; managers the **Portfolio** chart; anyone with approvals waiting sees **Waiting for your approval**.

**Ticket page and details.** Opening a ticket shows who the customer and consultant are, the phase stepper, the **Next phase** moves, a **Details** panel (summary, resolution notes, acceptance criteria, project, legacy reference), the type's own details panel, and the document tabs. Roles that may edit fields see **Edit details**; a save is refused as a whole if it touches any field your role cannot edit.

---

### Customising a lifecycle (Project Admin, or a Super Admin working in the project)
The template gives every kind of item a standard lifecycle (for an ITIL Incident: New → Triage → In Progress ⇄ Pending → Resolved → Closed). A project that works differently can change it for one kind of item at a time: **Project settings → Lifecycles**.

1. The list shows each item type with its current flow and whether it is *Standard* or *Customised*. Press **Edit lifecycle**.
2. **Statuses:** reorder them (the order is the board order), remove ones you do not use, add a standard status from the list, or **create your own** (for example *Awaiting vendor*) and choose its **category** (Intake, Specification, Delivery, Review or Done). Only *Done* statuses finish a ticket.
3. **Allowed moves:** for each status, tick where a ticket may go next, and where a new ticket starts.
4. **Save lifecycle.** New and existing tickets of that type now follow it; the board gets a column for any new status. Other item types are not affected.
5. **Restore standard** goes back to the methodology's flow for that type.

Rules the system enforces and explains in plain words: a new ticket must have a starting status; every status must be reachable; a status that is not a *Done* status must lead somewhere (no dead ends); there must be at least one finishing status; a status that holds tickets cannot be removed; steps that need a document or an approval (for example FS → FS Approved) stay fixed and cannot be removed. You cannot change the project's methodology while a customised lifecycle exists; restore it first. Your own statuses belong to your project and are invisible to others; a status that tickets have passed through cannot be deleted, so history stays readable. (Renaming a status is not offered yet.)

## 6. Documents: Functional Spec, Technical Spec, Unit Test and Code Review

**What it is.** Four documents per ticket, each drafted by the system, edited online by the team (several people at once), reviewed with comments, approved through the L1…Ln workflow, and downloaded as Word:

| Tab | Document | Created when | Edited when | Approval does |
|---|---|---|---|---|
| **Functional Spec** (FS) | Functional Specification | ticket is *Requirement Verified* | *FS Drafted* | moves the ticket to *FS Approved* |
| **Technical Spec** (TS) | Technical Specification | *FS Approved* | *TS Drafted* | moves the ticket to *TS Approved* |
| **Unit Test** (TUT) | Technical Unit Test | *Development*, *QA* or *UAT* | the same stages | locks the document (no ticket move) |
| **Code Review** (CRC) | Code Review Checklist | *Development*, *QA* or *UAT* | the same stages | locks the document (no ticket move) |

**How to use it** (Consultants, Leads and anyone with the right permissions)
1. Open the ticket and choose a tab. Click **Generate … draft** when the tab says it is available.
2. **Edit in the shared editor.** The toolbar has bold, italic, underline, headings, lists, checklists, tables and links. Everyone who has the document open edits the **same draft** and sees each other's cursors and names. Closing the page loses nothing: the draft is kept on the server.
3. Click **Save version** to turn the draft into a numbered version (v2, v3 …). Requesting approval saves a version automatically, so approvers always see exactly what was requested.
4. Open any older version from **Versions** (read-only, with a diff against the latest), or **Download vN as Word**.
5. **Upload & merge a Word file**, **comments** and **approval**: see the sections below and section 7.

**What to expect**
- Versions are immutable; nothing is overwritten and the database refuses edits to history.
- **Locking:** the draft is read-only while an approval is in progress (cancel the request to edit), after an FS/TS is approved, and for an approved Unit Test or Code Review. The editor says why.
- **View-only people** (no edit permission) can still open the live draft and watch it change; they cannot type.
- **Offline or dropped connection:** the editor shows *Offline*, keeps your changes in the page and syncs them when it reconnects.
- **What the draft contains:**
  - **FS** and **TS** follow an outline per technology (SAP, .NET, Java, Node.js, generic). A SAP TS has *Technical Objects, Technical Design, Data Dictionary, Authorizations, Interfaces & Enhancements, Transports & Deployment…*; a .NET one has *Solution Structure, APIs & Contracts, Migrations, Packages…* and so on.
  - **Unit Test** lists one test case per acceptance criterion of the FS, each tracing back to it.
  - **Code Review** is a checklist: general checks, extra checks for the technology (for example *AUTHORITY-CHECK* for SAP, *npm audit* for Node.js) and for the kinds of object named in the TS.
  - Without an AI key the draft is a structured outline for people to complete. With a key the AI writes each section following the same outline and the project's technology limits. Always review it before approval.
- Drafts that mention technology outside the project's allowed stack get a warning banner (section 4).
- Optional project rule: **Unit Test and Code Review must be approved before a ticket moves to QA** (Project settings → Documents). It is **off by default**, so existing projects behave as before.
- Editing through the older "save as new version" API still works and updates the shared draft.

### Download as Word (DOCX)

**What it is.** Any version of any of the four documents can be downloaded as a Word file with a cover page, header and footer, styled headings, lists, tables, links and checklists.

**How to use it:** open the ticket, choose the tab, click **Download vN as Word** above the versions list. It downloads the version you are looking at (the latest, or an older one you opened).

**What to expect**
- **File name** like `FS_<ticket title>_v2.docx`, with only safe characters.
- **Cover page and tables are filled in for you:** project name, client, document number, ticket, version, status (*Draft*, *In approval*, *Approved*, *Superseded*), date, author, technology; an **Approvals table** from the real approval history; a **Revision history** from the saved versions. Nobody types these.
- **The design comes from the template library** (below). Until your company templates are uploaded, a built-in stand-in design is used.
- **Fonts, sizes, names and numbering** come from the project's Document settings.
- **Respects ticket-field access:** if your role cannot read the customer field, the customer's name is not in your file. Every download is logged.
- Checked by opening and paginating the files in LibreOffice. They have **not yet been opened in Microsoft Word itself**.

### Document settings (Project Admin)

**What it is.** The look and rules for the project's documents.

**How to use it:** **Project settings → Documents.** Set the *project name and client name shown on documents*, extra header and footer text, the confidentiality line, the *document number format* (for example `{PROJECT}-{TICKET}-{TYPE}`), the *body and heading fonts* (from a safe list) and *sizes*, the *template set* (SAP, .NET, Java, Node.js, Generic, or follow the project's technology), and the two delivery rules (QA gate; block approval while comments are open). A **preview** shows the style as you change it, and **Download a sample in this style** gives a real Word file with your unsaved changes, before they reach any real document. Click **Save settings**.

**What to expect:** values the project does not set fall back to the platform's defaults, then to the built-in ones. Only listed fonts and sensible size ranges are accepted. Changes apply to new downloads, not to files already downloaded. **Not built yet:** a logo on the cover page.

### Template library (Super Admin)

**What it is.** The Word files that give each document its design, per technology and document type.

**How to use it:** **Platform → Documents → Word templates.** Pick the technology and document, choose a `.docx` and click **Upload template**. In the Word file, put `{{BODY}}` alone on its own line where the content goes, and placeholders such as `{{PROJECT_NAME}}`, `{{TICKET_TITLE}}`, `{{VERSION}}`, `{{DOC_NUMBER}}`, `{{APPROVALS}}`, `{{REVISIONS}}` where details should appear (the screen lists all of them). Page numbers and styles in your file are kept.

**What to expect**
- The upload is checked: it must be a real `.docx`, with no macros or embedded objects, not password-protected, well-formed, and containing `{{BODY}}`. Problems are explained in plain words. Unrecognised placeholders are listed and left empty.
- Each upload becomes the **active version** for that technology and document; earlier versions are kept and can be made active again or downloaded.
- A project uses its technology's template; if there is none, the **Generic** one; if there is none, the built-in design.
- **Platform defaults** for fonts, sizes and labels are set on the same screen. Projects override them.
- **To use your company templates** (TUT, TS, CRC and the FS in the TS design): add the placeholders above to each Word file and upload them here. No code change is needed.

### Review comments (Leads and anyone with comment access)

**What it is.** Confluence-style review: comments on selected text or on the document as a whole, threaded replies, mentions, and a review decision.

**How to use it**
1. Open the document. In the **Review comments** panel, **select text** in the document and write the comment, or add a *General comment*. Use **@ Mention** to name someone.
2. The author sees the comment at once (highlighted in the text, listed in the panel) and is emailed (local Mailbox for now). They **Reply**, edit the text, and click **Mark addressed**.
3. The reviewer clicks **Resolve** (or **Reopen**). Replying to a resolved thread reopens it.
4. A reviewer with review access records **Request changes** or **Looks good** (with an optional note). *Looks good* is refused while comments are unresolved.

**What to expect**
- Highlights **follow the text** as people keep editing. If the commented text is deleted, the comment stays, shows the text it was about, and says it was removed.
- Anyone who can read the document can read comments; **commenting needs the "Comment on documents" permission** and does not require edit access, so a reviewer can comment without being able to change the text. **Resolving or reopening** another person's comment needs the "Review documents" permission. Editors can mark comments *addressed*.
- The tab shows how many comments are still open.
- Optional project rule (Document settings): **approval cannot be requested while comments are unresolved**.
- Comments stay with the ticket across versions; a comment from an older version says which version it was written on.
- **Not built yet:** exporting comments into the Word file as Word comments, and importing Word comments from an uploaded file.

### Upload & merge your own Word file

**What it is.** A consultant can write or edit offline in Word and bring the result back into the system's draft instead of retyping.

**How to use it:** in the editor click **Upload & merge a Word file**, choose a `.docx`, and review the **merge screen**: each section of your file is lined up with the draft section it matches (by heading, ignoring numbering), with both texts side by side. Choose per section: *Use my file's version*, *Keep the draft*, or *Keep both*. Sections only in your file can be *added* (they go under an "Additional sections" heading) or left out. Click **Merge into the document**.

**What to expect**
- **Nothing changes until you confirm.** Before merging, the team's current draft is saved as its own version, and the merge becomes the next version, so it can always be undone by opening the earlier one.
- Headings, paragraphs, lists, tables, bold/italic/underline and web links are carried over. **Images are not imported** (you are told how many were skipped). Links other than web and email links are dropped.
- Files are treated as untrusted: only `.docx` up to 8 MB; macro-enabled and password-protected files are refused; nothing in them is run or fetched. The original file is kept for audit.
- Matching is by heading text; if your file uses very different headings, its sections show as "Only in your file" and you decide where they go.
- Not available while the document is locked.

---

## 6a. AI Project Planning (Charter, WBS and tickets)

**What it is.** An optional, per-project module for the very start of a project. A Project Manager answers three questions and **Google Gemini** drafts a **project charter**; the PM edits it live and approves it; Gemini then breaks the approved charter into a **work breakdown structure (WBS)** of phases, deliverables and work packages, which the PM edits on an interactive board and finally **converts into tickets** (Request Items, WRICEFs and so on, whatever the project's template allows).

**Switching it on (Project Admin).** Project settings → **Modules**. Planning has three separate switches under **Project set-up**: **Project charter**, **Work breakdown structure (WBS)** and **RITM preparation steps** (turning work packages into tickets). The Planning tab shows only the steps whose switch is on, and the server refuses the others. Each builds on the one before (WBS needs the charter, RITM preparation needs the WBS), and the screen tells you if you switch them on or off out of order. The Planning tab appears when at least one is on. It is off for every project until someone does this, and it affects only that project. Switching it off hides the tab; nothing already planned is deleted. The change is written to the project's activity log.

**Who can use it.** People whose role has **Plan the project** (`planning.manage`): the new built-in **Project Manager** role, Project Admins and Super Admins. The **Planning** tab appears for them only when the module is on; a Consultant, Lead or Customer never sees it. Opening `/planning` anyway shows why it is not available, and the server refuses the calls too.

**How to use it**
1. **Intake.** Planning tab → answer *What is the business problem?*, *Who is the sponsor?* and *What are the high-level goals and known constraints?* (plus a review screen). Each answer is checked as you go. Click **Draft the charter with Gemini**. A progress panel shows while it works (usually 10 to 40 seconds). If it fails, your answers are kept and the message says what to do.
2. **Charter.** The draft (Executive Summary, Objectives, Scope, Out of Scope, Stakeholders, Milestones, Risks) opens in the rich-text editor: headings, lists, tables, links. **Several people can edit at once** and see each other's cursors; changes save by themselves. **Approve charter** locks it (read-only, with who approved it); **Reopen to edit** unlocks it. **Draft again…** returns to the questions and replaces the draft after confirmation.
3. **Work breakdown.** Once the charter is approved, **Generate WBS with Gemini** builds a board: one column per phase, deliverable cards inside, work packages inside those, each with an effort in person-days that rolls up to the deliverable and phase totals.
   - **Edit anything in place:** click a title, description or effort, type, press Enter.
   - **Add** a phase (**+ Add phase**), a deliverable (**+ Add deliverable**) or a work package (**+ Add work package**); the new item opens ready to name.
   - **Drag and drop** with the ⋮⋮ handle: reorder phases, move a deliverable to another phase, move a work package to another deliverable. Keyboard users can pick up a handle with Space and move it with the arrow keys, or use each item's **Move to…** menu and the ◀ ▶ buttons on phases.
   - Three levels only: a fourth level, or moving something under itself, is refused (by the screen and by the database).
4. **Convert to tickets.** Tick work packages (or **Select all**) and click **Convert to tickets**. Choose the ticket type (a Request Item if the project allows it, otherwise the project's default) and fill that type's required fields once; `{title}`, `{phase}` and `{deliverable}` are replaced per work package. The tickets appear on the board in the type's first phase, each work package shows a **Ticket · phase** link, and the **Tickets** step lists them. A work package becomes a ticket only once.

**What to expect**
- **AI output is a draft.** Gemini is told to use only what you wrote and to label assumptions; it can still be wrong. Read before approving. The text you type is passed to Gemini as data, not instructions.
- **Limits:** a person can start about 12 AI drafts per 10 minutes. If Google is busy it retries automatically; a persistent outage gives a plain message and loses nothing.
- **Technology scope:** if the project is limited to certain technologies (section 4), Gemini is told to plan only within them.
- **After conversion** the plan can no longer be regenerated (tickets depend on it) and converted branches cannot be deleted; edit by hand instead. Before conversion, regenerating replaces the plan after a confirmation.
- **No Gemini key?** The module still works with a simple offline template that organises what you wrote; the badge at the top says which is in use. The key is configured on the server (`GEMINI_API_KEY`, `GEMINI_MODEL`) and is never shown to the browser.
- **Not built yet:** live co-editing of the WBS (it saves each change, so two people editing at once see each other's changes on reload), exporting the charter or WBS to Word or Excel, dependencies and a schedule between work packages, and a separate approval workflow for the charter.

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

### Approving new tickets, not just documents (Project Admin)
A workflow can also cover **the creation of tickets**. In **Project settings → Approval workflows**, tick one or more ticket types under **New tickets (approved before work starts)**, for example Incident and Change Request, instead of (or as well as) documents. Pick the levels and approvers as usual.

- When someone raises a ticket of that type (from the board, the chat assistant, or an AI plan), it is created but **waits**: its phase cannot be moved and documents cannot be generated until every level approves. The approvers are emailed and see it under their approvals; the ticket page shows a **Ticket approval** card with progress and, for an approver, **Approve** and **Reject** (a reason is required to reject).
- If an approver rejects, the ticket is parked as *Not approved* with the reason shown. The person who raised it (or an approvals admin) can fix it and press **Send for approval again**. **Withdraw request** also parks it.
- A ticket type with no workflow, or with its workflow switched off, needs no approval, exactly as before.
- A ticket cannot be created if a level has nobody who could approve it (nobody approves their own request); you get a clear message and nothing is created.
- One active workflow per ticket type, and one per document type, per project.

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
- **Projects**: a searchable list (filter Active / Archived / All) showing each project's admins, members, tickets and technology. **Switch to** steps into a project (it then shows *Working here*). **+ New project** opens a short page in four parts: the project name, an optional first Project Admin (email, and name if the account is new), the project type and methodology, and optional allowed technology. The project starts with its own copy of the standard approval workflow.
  Select a project to open its page: an at-a-glance summary, its **Project Admins** (each with a switch, **May create roles of their own**: on lets that Project Admin, and only them, create, rename and delete roles for the project; off takes it back, roles already made stay), **Appoint a Project Admin**, and **Archive** (cuts everyone off at once; nothing is deleted; **Restore** brings it back).
- **Users**: everyone on the platform, the projects and roles each holds, and toggles for **Super Admin** and **Active**. A new account can reach nothing until a Project Admin adds them to a project.
- **Role catalog**: the standard roles, in the same two steps (a list, then each role’s own page; **+ New role** adds a custom role, optionally copying an existing one). Only project-level permissions can be given to a role.
- **Default ticket fields**, **Technology catalog**, **Workflows** (ticket types and their fields, methodologies and their transitions, project-type defaults; section 5), **Documents** (Word template library and document defaults, section 6), **Activity** (platform-wide log).

**What to expect:** at least one active Super Admin always remains. When a Super Admin steps into a project they do not belong to, the entry is recorded in **that project's** activity log, where its own admin can see it.

---

## 11. Project settings (Project Admin)

**Menu: Project settings** (shows the project name). The sections are listed in a navigation rail on the left, grouped as **People & access** (Members, Teams, Roles & permissions, Ticket fields), **How work flows** (Template builder, Approval workflows, Technology), **Features & content** (Modules, Documents) and **Audit** (Activity). Pick one and only that section is shown, with a one-line description; arrow keys move between sections, and the address (for example `/admin#modules`) remembers where you were, so a reload or a shared link lands on the same section. On a narrow screen the rail becomes a scrolling strip. The Platform console uses the same layout (Workspace, Standards, Building blocks, Audit). The sections are:
- **Members**: a searchable table of everyone in the project, with their role, user ID, job and department, teams, phone, open tickets and when they were added. Use the search box (name, email, user ID, title, team) and the role and team filters; click a column heading to sort. Click a person, or **+ Add member**, to open their own page (the address becomes `#members/<id>` or `#members/new`, and the breadcrumb takes you back).
  - **Fields:** *Identity* (first and last name, email, user ID, employee ID), *Contact* (phone, mobile, location, time zone, language), *Organisation* (job title, department, company, cost center, manager) and *Access in this project* (role and teams), plus private admin *Notes*. Display names follow first and last name.
  - **Adding someone:** an email is the only thing needed for a person who already has an account (they join with their existing profile, which is not overwritten). A new email creates the account with whatever you filled in; the user ID is made from the email if left empty. Each field is checked as you submit (for example phone numbers and user IDs, which must be unique).
  - **Identity is protected:** a person who works in several projects can have their email and user ID changed only by a Super Admin; any Project Admin can change their other details and their role and teams *here*. Every change is logged with the field names, never the values.
  - A project always keeps at least one Project Admin. **Remove** takes the person out of this project and its teams; their account and other projects are untouched.
- **Teams**: create teams (name, description, lead, people) and put people in them either from the team's page or from a person's page. Anyone with the role permission **Work team tickets** (Consultants, Leads and Project Managers have it by default) can **see and work the tickets assigned to the teams they belong to**, in addition to what their role already shows; what they may *change* still follows their ticket-field access. Assign a ticket to a team on the ticket page (**Assign team**, for people who may assign tickets); the board card shows the team. Deleting a team leaves its tickets, without a team.
- **Roles & permissions**: maintained in **two steps**.
  - **Step 1, the list:** every role with its kind (*Standard*, *Standard · customized here*, *This project’s role*, *Full access*), how many people hold it, how many permissions it has, and a summary of its ticket-field access. The **Roles / Compare permissions / Compare ticket fields** switch above the table gives you the old side-by-side grids when you want to compare roles.
  - **Step 2, the role’s own page** (click a role, or **+ New role**): *Permissions* (grouped by feature, with descriptions, a search box and **Select all / Clear all** per group, saved as you tick), *Field access* (what the role may see or edit on a ticket), the **people who hold it** (each links to their member page), and for roles you own, *Details* (rename, description) and **Delete**. A standard role you have changed shows **Reset to standard**; Project Admin is always full access. The address is `#roles/<id>`, so the page can be bookmarked.
  - **Creating a role is also two steps** (when allowed, see below): *1 Name the role* (name, description, optionally **Start from** a copy of a role), then *2 Choose what it can do*, which opens the new role’s page with a banner; click **Done** when finished.
  - **Creating roles of your own (when a Super Admin allows it).** A Project Admin sees **+ New role** (name, description, and optionally *Start from* a copy of an existing role, permissions and ticket-field access included). The role is **private to this project**: other projects, and the Platform role catalog, never list it. It appears in the list marked *This project’s role*; tick what it can do, set its ticket fields, and give it to people under Members. It can be **renamed** or **deleted** (deletion is refused while anyone holds it or an approval workflow uses it). A project role can only hold project-level permissions, never platform powers, and standard roles can still only be tuned here, not renamed or deleted. Without the Super Admin's permission, the form is not shown.
- **Template builder**: the project's type, methodology, phases and allowed ticket types (section 5).
- **Modules**: switch optional capabilities on or off for this project, such as the parts of AI Project Planning (section 6a). The tiles are grouped (Project set-up, Planning & estimation, Governance & control). Tiles marked **Coming soon** (effort and cost estimation, timesheets, milestones, risks, RACI, change control, assumptions) are placeholders: you can choose them now and the choice is remembered, but they do nothing yet.
- **Ticket fields**, **Technology**, **Approval workflows**: as in sections 9, 4 and 7.
- **Documents**: fonts, names, numbering, template set and the delivery rules for the project's documents (section 6).
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
- **The company's own SAP templates** (TUT, TS, CRC, FS): the mechanism is built (Platform → Documents); the files themselves still need to be supplied and uploaded. Equivalent .NET, Java and Node.js *content outlines* are built; their Word *designs* are the built-in stand-in until templates are uploaded.
- **Documents still to come:** a logo on the cover page, Word comments in the exported file (and imported on upload), regenerating a single section with the AI, images in the editor, and checking the exported files in Microsoft Word itself.
- **Approval escalation**, reminders, delegation and conditional levels.
- **Call-transcript upload** (Teams/Zoom) as a chat source.
- **Dashboard-wide filters**, click-through to tickets, scheduled/emailed/PDF reports.
- **Project-specific custom roles** (projects tune the standard roles) and a screen for editing the platform's template workflow.
- Production hosting package and IT handover checklist.
