import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { pool } from './db.js';

const dir = join(dirname(fileURLToPath(import.meta.url)), '../db/migrations');
await pool.query('CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ DEFAULT now())');
for (const f of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
  const done = await pool.query('SELECT 1 FROM _migrations WHERE name=$1', [f]);
  if (done.rowCount) continue;
  await pool.query('BEGIN');
  try {
    await pool.query(readFileSync(join(dir, f), 'utf8'));
    await pool.query('INSERT INTO _migrations(name) VALUES($1)', [f]);
    await pool.query('COMMIT');
    console.log('applied', f);
  } catch (e) {
    await pool.query('ROLLBACK');
    throw e;
  }
}
await pool.end();
