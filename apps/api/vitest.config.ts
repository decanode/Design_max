import { defineConfig } from 'vitest/config';

// Tests share one Postgres instance, so files run serially.
export default defineConfig({ test: { fileParallelism: false } });
