# EXECUTIVE DIRECTIVE: AI-DRIVEN PROJECT PLANNING MODULE (CHARTER & WBS)

## 1. Mission Context
Antigravity is expanding its capabilities to the very beginning of the project lifecycle: **Initiation and Planning**. 
You are tasked with building a feature where Project Managers (PMs) can use the **Gemini API** to automatically draft Project Charters, generate Work Breakdown Structures (WBS), and draft initial RITMs (Request Items/Requirements). 
This module must be feature-flagged at the project level, meaning Admins must explicitly enable the "PM Planning Module" for a given project. All generated artifacts must be fully editable by the PM via rich interactive UIs.

**Constraint Override:** UI/UX must be exceptional ("UI-UX-MAX-PRO"). Do not shrink scope. Ensure flawless Gemini API integration and interactive editing capabilities.

---

## 2. Database Architectural Upgrades (PostgreSQL)

Expand the schema to support project-level feature toggles and planning artifacts.

### A. Schema Updates
1. **`Projects` Table Update:** Add a `JSONB` column named `enabled_modules`. This will store feature flags (e.g., `{"planning_module": true, "finance_tracking": false}`).
2. **`Project_Charters` Table:** 
   - Columns: `id`, `project_id`, `executive_summary`, `objectives`, `scope`, `stakeholders`, `risks`, `status` (Draft, Approved), `created_at`, `updated_at`.
3. **`WBS_Elements` Table:** 
   - A self-referencing hierarchical table to store the WBS.
   - Columns: `id`, `project_id`, `parent_id` (null if root phase), `title`, `description`, `estimated_effort`, `order_index`.

---

## 3. Admin Panel: Module Configuration

Upgrade the Admin Control Center to manage this new capability.

### A. Project Feature Toggles
- In the Admin Project Settings UI, add a "Module Configuration" section.
- Add a toggle switch: **"Enable AI Project Planning (Charter & WBS)"**.
- When toggled ON, the `enabled_modules` JSONB column for that project updates, which dynamically unlocks the "Planning" tab for the PMs assigned to that project.

---

## 4. The AI Planning Co-Pilot (Gemini API Integration)

This is the core engine for the PM. It must live inside a newly unlocked "Planning" tab in the Project Dashboard.

### A. Step 1: The Charter Intake Wizard
- Build a beautiful, step-by-step UI wizard asking the PM for raw inputs:
  1. What is the business problem?
  2. Who is the sponsor?
  3. What are the high-level goals and known constraints?
- **Gemini Trigger:** Send these inputs to the Gemini API with a strict system prompt to return a structured, professional Project Charter (Executive Summary, Scope, Out-of-Scope, Milestones, Risks).
- **Charter Editor:** Load the Gemini response into the collaborative Markdown/Rich-Text Editor. The PM can now manually rewrite, format, or tweak the AI's draft.

### B. Step 2: The WBS Auto-Generator
- Once the Charter is approved by the PM, add a button: **"Generate WBS with Gemini"**.
- **Gemini Trigger:** Send the approved Project Charter to the Gemini API. Prompt Gemini to break the scope down into a 3-level hierarchical Work Breakdown Structure (Phases -> Deliverables -> Work Packages).
- **Interactive WBS Builder UI:** 
  - Do NOT just dump text. Render the Gemini output into an interactive, drag-and-drop hierarchical Tree UI or Kanban-style phase board. 
  - The PM must be able to add new child nodes, drag a work package to a different phase, and edit titles/descriptions inline.
  - *Tech Suggestion:* Use libraries like `react-sortable-tree`, `dnd-kit`, or `@atlaskit/pragmatic-drag-and-drop` for exceptional UX.

### C. Step 3: RITM/Requirement Extraction
- From the WBS terminal nodes (Work Packages), the PM can click "Convert to RITMs".
- This pushes the WBS elements into the main `Tickets` table as RITMs (or WRICEFs, based on the dynamic workflows built previously), officially bridging the Planning phase into the Execution phase.

---

## 5. Automated Testing & Quality Assurance (Playwright)

1. **Admin Toggle Test:** Log in as Admin, create a project, leave the Planning Module OFF. Log in as PM, verify the "Planning" tab is hidden. Log back in as Admin, toggle it ON. Verify the tab appears for the PM.
2. **Gemini Mock Integration Test:** Mock the Gemini API response. Automate a PM entering basic details in the Intake Wizard, triggering the API, and verifying the returned text populates the Markdown editor.
3. **WBS UI Test:** Automate adding a parent phase, adding a child work package, and converting that work package into a ticket/RITM.

---

## 6. Execution Protocol & Rules of Engagement

1. **Acknowledge and Log:** Update `MEMORY.md` with your plan to implement the Gemini API integration and the drag-and-drop WBS interface.
2. **Gemini API Setup:** Ensure the backend Node.js service utilizes the official `@google/generative-ai` SDK. Create a secure service to handle the prompt construction and API keys (do not expose keys to the frontend).
3. **UI/UX First:** The WBS tree must feel tactile, responsive, and enterprise-grade. The Charter editor must be a joy to type in. 
4. **Relentless Execution:** Do not stop until the database tables, Admin toggles, Gemini prompts, Interactive WBS UI, and E2E tests are perfectly integrated.