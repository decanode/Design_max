# EXECUTIVE DIRECTIVE: DYNAMIC WORKFLOW & TEMPLATING ENGINE

## 1. Mission Context
Antigravity is upgrading its core architecture. We are discarding hardcoded ticket lifecycles and moving to a **Dynamic State Machine & Templating Engine**. 
The Admin Panel must now control how a project behaves from inception to completion. A "Support" project operates fundamentally differently from an "SAP Implementation" project. The system must adapt dynamically without requiring code changes for new methodologies.

**Constraint Override:** Implementation time is not a factor. Architectural purity, absolute bug-free execution, and exceptional UI/UX ("UI-UX-MAX-PRO") are the highest priorities. Do not shrink scope; you are authorized to widen the scope to ensure enterprise-grade standardization.

---

## 2. Database Architectural Upgrades (PostgreSQL)

You must expand the relational schema to support dynamic configurations.

### A. New Configuration Tables
1. **`Template_Types`**: Master list of methodologies (e.g., Waterfall, Agile, Hybrid, ITIL).
2. **`Project_Types`**: Master list of domains (e.g., Implementation, Support, DevOps, Conversion).
3. **`Ticket_Types`**: Master list of tracking units. 
   - *Examples:* Incident, Problem, Change Request (CR), RITM, WRICEF, Feature, Bug, Epic.
4. **`Phases`**: The stages a project or ticket can exist in (e.g., Scoping, FS, TS, Dev, QA, Deployment, Closed).
5. **`Workflow_Transitions`**: The dynamic state machine. Maps `From_Phase` -> `To_Phase` based on the `Template_Type` and `Ticket_Type`.

### B. Upgrades to Existing Tables
1. **`Projects` Table:** Add foreign keys for `project_type_id` and `template_type_id`.
2. **`Tickets` Table:** 
   - Add `ticket_type_id` (links to whether it's an Incident, WRICEF, etc.).
   - Add a `JSONB` column named `dynamic_metadata`. 
   - *Rationale:* An Incident requires fields like "Impact & Urgency." A WRICEF requires fields like "RICEF Type (Workflow, Report, Interface, etc.)." Instead of altering the database schema for every new ticket type, use `JSONB` to store these type-specific fields.

---

## 3. Admin Panel Implementation (UI-UX-MAX-PRO)

Build a highly polished, interactive Admin Control Center.

### A. The "Project Template Builder" UI
- Create a drag-and-drop or highly intuitive interface for Admins to define a new Project configuration.
- **Setting 1: Project Type & Methodology:** Admin selects the nature of the project (e.g., SAP Implementation + SAP Activate Hybrid).
- **Setting 2: Phase Configuration:** Admin defines the phases for this project. They can toggle phases on/off (e.g., disabling "Hypercare" for a DevOps project).
- **Setting 3: Allowed Ticket Types:** Admin selects which tickets are allowed in this project.
   - *Logic Check:* If Admin selects "Support", default the toggles for "Incident" and "CR" to ON. If Admin selects "Implementation", default "WRICEF" and "Epic" to ON. The admin can override these.

---

## 4. Dynamic Project & Ticket UI Engine (Frontend)

The frontend must render dynamically based on the Admin's configurations.

### A. Dynamic Project Dashboard
- The Project Kanban board and Phase trackers must dynamically generate columns based on the specific `Phases` configured for that project. Do not hardcode "To Do, In Progress, Done".

### B. Dynamic Ticket Intake Form
- When a user clicks "Create Item", they first select the `Ticket_Type` (filtered by what the Admin allowed for this project).
- **Dynamic Field Rendering:**
   - If `Ticket_Type == 'Incident'`: Show fields for "Priority", "Impact", and "Steps to Reproduce".
   - If `Ticket_Type == 'WRICEF'`: Show fields for "RICEF Category", "SAP Module (FICO, SD, MM)", and "Business Value".
   - Store these dynamic inputs in the `JSONB` `dynamic_metadata` column.

### C. Dynamic State Machine Enforcement
- The "Move to Next Phase" button must query the `Workflow_Transitions` table. It must validate if the ticket is allowed to transition based on its specific `Ticket_Type` and current phase.

---

## 5. Automated Testing & Quality Assurance (Playwright)

Before committing this feature, you must write and pass rigorous End-to-End (E2E) Playwright tests.

1. **Test Scenario 1 (Support Project):** Automate the Admin creating a "Support" project with "ITIL" phases. Log in as a user, verify only "Incident" and "CR" can be created. Create an Incident and push it through the Support lifecycle.
2. **Test Scenario 2 (Implementation Project):** Automate the Admin creating an "Implementation" project. Verify the user can create a "WRICEF" ticket. Validate that WRICEF-specific fields appear in the UI and are saved correctly to the JSONB column.
3. **Test Scenario 3 (State Machine Violation):** Attempt to bypass a phase (e.g., Move from Draft to Deployed) and assert that the dynamic state machine throws a validation error.

---

## 6. Execution Protocol & Rules of Engagement

1. **Acknowledge and Log:** Before writing code, update `MEMORY.md` with your architectural plan to implement this Dynamic Engine.
2. **UI/UX First:** Treat the Admin Panel like a consumer-grade SaaS product. Use modern component libraries, smooth transitions, skeleton loaders, and intuitive layouts.
3. **No Assumptions:** Do not ask for permission to install necessary UI libraries (e.g., `framer-motion` for animations, `zod` for dynamic form validation, `react-hook-form`). Just install them and document them in `MEMORY.md`.
4. **Relentless Execution:** Do not stop until the database migrations, backend dynamic routing, Admin UI, Ticket UI, and Playwright tests are 100% complete and passing.