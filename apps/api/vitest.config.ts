import { defineConfig } from 'vitest/config';

// Tests share one Postgres instance, so files run serially. dist/ holds compiled copies; never test those.
// AI_PROVIDER=offline keeps tests deterministic and off the network even when .env holds real keys.
export default defineConfig({ test: { fileParallelism: false, exclude: ['dist/**', 'node_modules/**'], env: { AI_PROVIDER: 'offline' } } });
