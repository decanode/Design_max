import { defineConfig } from 'vitest/config';
import { testDbUrl } from './src/testdb.js';

// Tests run against a throwaway database (recreated each run), never the dev database.
// Files run serially because they share it. dist/ holds compiled copies; never test those.
// AI_PROVIDER=offline keeps tests deterministic and off the network even when .env holds real keys.
export default defineConfig({
  test: {
    globalSetup: './test-setup.ts',
    // Fixtures run outside any request, so they act as the platform; the app code under test runs inside each request's own project context.
    setupFiles: ['./test-context.ts'],
    fileParallelism: false,
    exclude: ['dist/**', 'node_modules/**'],
    env: { AI_PROVIDER: 'offline', DATABASE_URL: testDbUrl() },
  },
});
