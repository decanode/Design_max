import pg from 'pg';
import { migrate } from './migrate.js';

export const TEST_DB = 'design_max_test';
export const testDbUrl = (base = process.env.DATABASE_URL ?? 'postgres://antigravity:antigravity@localhost:5432/antigravity') => {
  const u = new URL(base);
  u.pathname = `/${TEST_DB}`;
  return u.toString();
};

/** Drops and recreates the throwaway test database, then migrates it. Never touches the dev database. */
export async function resetTestDb() {
  const url = testDbUrl();
  const admin = new pg.Pool({ connectionString: url.replace(`/${TEST_DB}`, '/postgres') });
  await admin.query(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${TEST_DB}`);
  await admin.end();
  const db = new pg.Pool({ connectionString: url });
  await migrate(db);
  await db.end();
}
