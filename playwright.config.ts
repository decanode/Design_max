import { defineConfig } from '@playwright/test';

// E2E runs its own servers on separate ports against the throwaway test database with the offline AI stand-ins, so results are deterministic
// and never depend on (or disturb) the dev servers or a live AI provider.
const API = 4100, WEB = 3100;
// Same rule as apps/api/src/testdb.ts (duplicated: this file is loaded as CommonJS and cannot import ESM).
// The API under test connects as the restricted application account (row-level security applies); only the test setup uses the owner.
const testDbUrl = () => process.env.TEST_APP_DATABASE_URL ?? 'postgres://design_max_app:design_max_app@localhost:5432/design_max_test';

export default defineConfig({
  testDir: 'tests/e2e',
  globalSetup: './tests/e2e/global-setup.ts',
  expect: { timeout: 15_000 },   // the first visit to a page compiles it in the dev server
  timeout: 60_000,           // several specs drive three browsers; a cold dev-server compile can take a while
  fullyParallel: false,
  workers: 1,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: { baseURL: `http://localhost:${WEB}`, trace: 'retain-on-failure', launchOptions: { args: ['--disable-dev-shm-usage'] } },   // containers have a tiny /dev/shm; without this Chromium crashes under load
  projects: [
    // Creates the demo accounts and saves one signed-in browser state per role in .auth/
    { name: 'setup', testMatch: /auth\.setup\.ts/ },
    { name: 'e2e', testIgnore: /auth\.setup\.ts/, dependencies: ['setup'], use: { storageState: '.auth/Super Admin.json' } },
  ],
  webServer: [
    // A stand-in for Gemini: the API's real SDK calls it, so prompts, parsing and the UI are tested without spending quota
    { command: 'node tests/e2e/mock-gemini.mjs', url: 'http://localhost:4300/health', reuseExistingServer: false, timeout: 20_000 },
    { command: 'npm run dev:api', url: `http://localhost:${API}/health`, reuseExistingServer: false, timeout: 60_000,
      env: { API_PORT: String(API), AI_PROVIDER: 'offline', DATABASE_URL: testDbUrl(), PLANNING_PROVIDER: 'gemini', GEMINI_API_KEY: 'e2e-test-key', GEMINI_MODEL: 'gemini-e2e', GEMINI_API_BASE_URL: 'http://localhost:4300' } },
    // A production build: leaner than the dev server (no per-page compiles or hot reloads), and it proves the app builds.
    { command: `npx next build && npx next start -p ${WEB}`, cwd: 'apps/web', url: `http://localhost:${WEB}`, reuseExistingServer: false, timeout: 300_000,
      env: { API_INTERNAL_URL: `http://localhost:${API}`, NEXT_DIST_DIR: '.next-e2e' } },
  ],
});
