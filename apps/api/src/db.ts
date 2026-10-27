import { config } from 'dotenv';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

// Load the repo-root .env regardless of the process's working directory (npm runs workspaces from apps/api).
// Variables already set in the environment win.
config({ path: resolve(dirname(fileURLToPath(import.meta.url)), '../../../.env'), quiet: true });

export const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL ?? 'postgres://antigravity:antigravity@localhost:5432/antigravity',
});
