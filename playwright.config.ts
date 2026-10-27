import { defineConfig } from '@playwright/test';

// E2E runs its own servers on separate ports with the offline AI stand-ins, so results are deterministic
// and never depend on (or disturb) the dev servers or a live AI provider.
const API = 4100, WEB = 3100;

export default defineConfig({
  testDir: 'tests/e2e',
  fullyParallel: false,
  workers: 1,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: { baseURL: `http://localhost:${WEB}`, trace: 'retain-on-failure' },
  webServer: [
    { command: 'npm run dev:api', url: `http://localhost:${API}/health`, reuseExistingServer: false, timeout: 60_000,
      env: { API_PORT: String(API), AI_PROVIDER: 'offline' } },
    { command: `npm run dev -w apps/web -- -p ${WEB}`, url: `http://localhost:${WEB}`, reuseExistingServer: false, timeout: 120_000,
      env: { API_INTERNAL_URL: `http://localhost:${API}`, NEXT_DIST_DIR: '.next-e2e' } },
  ],
});
