import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import type pg from 'pg';

const dir = join(dirname(fileURLToPath(import.meta.url)), '../db/migrations');

/** Applies any pending SQL migrations, in filename order, each in its own transaction. */
export async function migrate(db: pg.Pool, log: (m: string) => void = () => {}) {
  await db.query('CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ DEFAULT now())');
  for (const f of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
    if ((await db.query('SELECT 1 FROM _migrations WHERE name=$1', [f])).rowCount) continue;
    await db.query('BEGIN');
    try {
      await db.query(readFileSync(join(dir, f), 'utf8'));
      await db.query('INSERT INTO _migrations(name) VALUES($1)', [f]);
      await db.query('COMMIT');
      log(`applied ${f}`);
    } catch (e) {
      await db.query('ROLLBACK');
      throw e;
    }
  }
}
