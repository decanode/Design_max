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
