# Design Max

Chat-first enterprise project lifecycle platform: intake chat with an AI observer, specifications with
multi-level approvals, dashboards and reports, role-based access.

## Running locally

```bash
npm install
cp .env.example .env      # then add any API keys you have (see comments inside)
npm run dev               # database + migrations + API (:4000) + web (:3000)
```

- `npm run dev:up` starts only the database and applies migrations. Run it first if the sign-in page says the
  database is not running (this happens after a Codespace is paused: the container is stopped, the data is not lost).
- `npm run test:unit` and `npm run test:e2e` use a separate throwaway database and never touch your data.
- Open http://localhost:3000. On first run, choose **Create demo accounts** on the sign-in page.
- **Two database accounts.** The server connects as `design_max_app`, a restricted account that cannot bypass the row-level
  security keeping projects apart (`DATABASE_URL`). Schema upgrades run as the database owner (`MIGRATE_DATABASE_URL`) and
  create that account. In production, set its password yourself: `ALTER ROLE design_max_app PASSWORD '…'`.
- **People.** *Super Admins* (the platform tier) create projects and appoint each project's *Project Admin*, who runs that
  project's members, roles, workflows, technology and fields. Roles belong to a project, so one person can hold different
  roles in different projects; use the project menu in the header to switch.

## Word export and its test
Specifications download as .docx. The automated rendering check converts a generated file with LibreOffice and runs only
where it is installed (`apt-get install libreoffice-writer poppler-utils` on Debian/Ubuntu); without it that one test is skipped.
