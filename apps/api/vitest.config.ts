import { defineConfig } from 'vitest/config';

// Tests share one Postgres instance, so files run serially. dist/ holds compiled copies; never test those.
export default defineConfig({ test: { fileParallelism: false, exclude: ['dist/**', 'node_modules/**'] } });
