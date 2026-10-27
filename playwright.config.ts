import { defineConfig } from '@playwright/test';

// E2E runs its own servers on separate ports against the throwaway test database with the offline AI stand-ins, so results are deterministic
// and never depend on (or disturb) the dev servers or a live AI provider.
const API = 4100, WEB = 3100;
// Same rule as apps/api/src/testdb.ts (duplicated: this file is loaded as CommonJS and cannot import ESM).
const testDbUrl = () => { const u = new URL(process.env.DATABASE_URL ?? 'postgres://antigravity:antigravity@localhost:5432/antigravity'); u.pathname = '/design_max_test'; return u.toString(); };

export default defineConfig({
  testDir: 'tests/e2e',
  globalSetup: './tests/e2e/global-setup.ts',
  fullyParallel: false,
  workers: 1,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: { baseURL: `http://localhost:${WEB}`, trace: 'retain-on-failure' },
  projects: [
    // Creates the demo accounts and saves one signed-in browser state per role in .auth/
    { name: 'setup', testMatch: /auth\.setup\.ts/ },
    { name: 'e2e', testIgnore: /auth\.setup\.ts/, dependencies: ['setup'], use: { storageState: '.auth/Super Admin.json' } },
  ],
  webServer: [
    { command: 'npm run dev:api', url: `http://localhost:${API}/health`, reuseExistingServer: false, timeout: 60_000,
      env: { API_PORT: String(API), AI_PROVIDER: 'offline', DATABASE_URL: testDbUrl() } },
    { command: `npm run dev -w apps/web -- -p ${WEB}`, url: `http://localhost:${WEB}`, reuseExistingServer: false, timeout: 120_000,
      env: { API_INTERNAL_URL: `http://localhost:${API}`, NEXT_DIST_DIR: '.next-e2e' } },
  ],
});
