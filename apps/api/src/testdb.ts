import pg from 'pg';
import { migrate } from './migrate.js';

export const TEST_DB = 'design_max_test';
const OWNER = 'postgres://antigravity:antigravity@localhost:5432/antigravity';
const APP = 'postgres://design_max_app:design_max_app@localhost:5432/antigravity';
const onTestDb = (base: string) => { const u = new URL(base); u.pathname = `/${TEST_DB}`; return u.toString(); };
/** The restricted application account, pointed at the throwaway test database. */
export const testDbUrl = () => onTestDb(process.env.TEST_APP_DATABASE_URL ?? APP);
/** The database owner on the test database: creates it, migrates it, and is used only for that. */
export const testOwnerUrl = () => onTestDb(process.env.TEST_OWNER_DATABASE_URL ?? OWNER);

/** Drops and recreates the throwaway test database, then migrates it. Never touches the dev database. */
export async function resetTestDb() {
  const url = testOwnerUrl();
  const admin = new pg.Pool({ connectionString: url.replace(`/${TEST_DB}`, '/postgres') });
  await admin.query(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${TEST_DB}`);
  await admin.end();
  const db = new pg.Pool({ connectionString: url });
  await migrate(db);
  await db.end();
}
