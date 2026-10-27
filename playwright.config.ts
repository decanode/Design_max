import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'tests/e2e',
  fullyParallel: false,
  workers: 1,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: { baseURL: 'http://localhost:3000', trace: 'retain-on-failure' },
  webServer: [
    { command: 'npm run dev:api', url: 'http://localhost:4000/health', reuseExistingServer: true, timeout: 60_000 },
    { command: 'npm run dev:web', url: 'http://localhost:3000', reuseExistingServer: true, timeout: 120_000 },
  ],
});
