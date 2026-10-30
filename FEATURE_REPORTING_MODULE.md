# EXECUTIVE DIRECTIVE: HYBRID REPORTING & AI STEERCO ENGINE

## 1. Mission Context
Antigravity must evolve from a project execution tool into a strategic visibility platform. You are tasked with building the **Hybrid Reporting Engine**. 
This module will aggregate automated metrics (ticket states, velocities) with role-based manual inputs (timesheets, RAID logs) and utilize the **Gemini API** to auto-generate high-level Steering Committee (SteerCo) presentations and weekly RAG status reports.

**Constraint Override:** The reporting dashboards must be visually spectacular ("UI-UX-MAX-PRO"). Use modern charting libraries (e.g., Recharts, Tremor, or Chart.js). Ensure flawless integration of Gemini to summarize complex project data into executive narratives.

---

## 2. Database Architectural Upgrades (PostgreSQL)

Expand the schema to capture telemetry, time, and risks.

### A. Schema Updates
1. **`Timesheets` Table:** 
   - Columns: `id`, `user_id` (Consultant), `project_id`, `ticket_id` (optional), `hours_logged`, `date`, `notes`.
2. **`RAID_Log` Table:** 
   - Columns: `id`, `project_id`, `type` (Risk, Assumption, Issue, Dependency), `description`, `impact` (High/Med/Low), `mitigation_plan`, `owner_id`, `status` (Open/Closed).
3. **`Project_Snapshots` (Reports) Table:** 
   - Columns: `id`, `project_id`, `report_type` (Weekly RAG, SteerCo, Financial), `rag_status` (Red/Amber/Green), `generated_content` (JSONB/Markdown), `created_by`, `created_at`.
4. **`Projects` Table Update:** 
   - Add `baseline_budget`, `hourly_blended_rate` (for simple financial burn calculation).

---

## 3. Role-Based UI Components (Data Collection)

Build intuitive UI widgets to capture data from different user types without friction.

### A. The Consultant Timesheet Widget
- A persistent, globally accessible UI component (e.g., a slide-out drawer or sticky footer) where Consultants can quickly log hours against the tickets they worked on today.

### B. The Customer Feedback & UAT Widget
- When a ticket enters UAT, the Customer sees a specific "Approval UI" requiring them to select "Pass" or "Fail" and provide mandatory comments. Failing automatically logs a Defect metric.

### C. The PM RAID Tracker
- A dedicated tab in the Project Dashboard for the PM to log Risks and Dependencies. Include a risk matrix visualization (Impact vs. Probability).

---

## 4. The Reporting Dashboard & AI SteerCo Generator

Build the centralized Reporting Control Center for PMs and Sponsors.

### A. Automated Dashboards (Real-Time BI)
Integrate a charting library to build real-time visual dashboards for:
1. **Quality:** Defect density (Bug vs CR ratio).
2. **Financials:** Budget Burn Down chart (Baseline Budget minus [Logged Hours * Blended Rate]).
3. **Resources:** Capacity heatmaps based on logged hours.

### B. Gemini-Powered SteerCo Generator
- Add a highly visible action button for the PM: **"Draft Monthly SteerCo Report"**.
- **Data Aggregation:** The backend must programmatically aggregate:
  1. Financial burn rate.
  2. Open high-impact RAID items.
  3. Milestones achieved this month (completed phases/WBS elements).
  4. Outstanding defects.
- **Gemini Trigger:** Pass this massive JSON payload to the Gemini API with a strict system prompt.
  - *Prompt Instruction:* "You are an elite Project Management AI. Analyze this raw project telemetry. Draft a 4-section executive Steering Committee report. Section 1: Executive Summary. Section 2: Budget Health. Section 3: Critical Risks & Mitigations. Section 4: Next Month's Objectives. Maintain a highly professional, objective tone. Highlight any Red/Amber areas requiring sponsor intervention."
- **Interactive Output:** Render the Gemini output in the collaborative Rich-Text editor. The PM reviews, adjusts the narrative, and clicks "Publish & Distribute" to save it to the `Project_Snapshots` table.

---

## 5. Automated Testing (Playwright)

1. **Telemetry Test:** Automate a Consultant logging 40 hours. Assert that the Financial Dashboard correctly updates the budget burn down.
2. **RAID to SteerCo Test:** Automate logging a "High Impact Risk" in the RAID log. Trigger the mocked Gemini SteerCo generator and assert that the generated report includes a section addressing that specific risk.
3. **Role Access Test:** Ensure a Customer role cannot view the Financial Burn rate dashboard, but can view the UAT/Quality metrics.

---

## 6. Execution Protocol

1. **Acknowledge and Log:** Update `MEMORY.md` with your plan to implement the hybrid reporting engine and the Gemini SteerCo generator.
2. **Chart Library Selection:** Evaluate and install a React-compatible charting library (e.g., Tremor or Recharts) that fits the UI-UX-MAX-PRO mandate.
3. **Relentless Execution:** Do not stop until all data collection widgets, real-time charts, the Gemini report generator, and Playwright tests are seamlessly integrated and fully functional.