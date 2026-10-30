# Design Max: instructions for Claude Code

Read these, in this order, before doing anything in a new session:
1. `MEMORY.md`, the section **START HERE** at the top: what exists, how to run and test it, conventions, gotchas, and what is open.
2. `system_ground_rules.md`: the operating rules (update `FEATURE_PROCESS_GUIDE.md` and `MEMORY.md` after every feature; plain-language, concise replies; ask before design changes).
3. `architecture_and_design_document.md`: the source of truth for architecture.
4. For work on source-system integration, modes, write-back or flow reports: `FEATURE_OPERATING_MODES.md`.

Quick commands: `npm run db:up && npm run db:migrate`, `npm run dev:api`, `npm run dev:web`; API tests `cd apps/api && npx vitest run [path]`; e2e `npx playwright test [spec]` (starts its own test database and servers); type check `npx tsc --noEmit` in `apps/api` and `apps/web`.

Do not commit secrets. Do not write to a customer's Jira or ServiceNow except through the app's write-back, which stays off unless a Super Admin switches it on.
