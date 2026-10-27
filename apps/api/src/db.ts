import { AsyncLocalStorage } from 'node:async_hooks';
import { config } from 'dotenv';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

// Load the repo-root .env regardless of the process's working directory (npm runs workspaces from apps/api).
// Variables already set in the environment win.
config({ path: resolve(dirname(fileURLToPath(import.meta.url)), '../../../.env'), quiet: true });

/**
 * Who a database call is made for. The database enforces row-level security from this:
 *   { projectId }   work inside one project: project tables show only that project's rows
 *   { platform }    a platform operation (Super Admin console, sign-in, public approval links, import tools)
 *   neither         project tables show nothing at all (fail closed)
 */
export interface DbContext { projectId?: string | null; platform?: boolean }
const als = new AsyncLocalStorage<DbContext>();
let fallback: DbContext | null = null;

export const runWithContext = <T>(ctx: DbContext, fn: () => T): T => als.run(ctx, fn);
export const currentContext = () => als.getStore() ?? fallback;
/** For code that runs outside any request (tests, CLIs). Never set this in the server. */
export const setDefaultContext = (ctx: DbContext | null) => { fallback = ctx; };

async function stamp(c: pg.PoolClient) {
  const ctx = currentContext();
  await c.query('SELECT set_config($1, $2, false), set_config($3, $4, false)',
    ['app.project_id', ctx?.projectId ?? '', 'app.platform', ctx?.platform ? 'on' : 'off']);
}

/**
 * A pool that stamps every connection it hands out with the current context before use, so the database's
 * row-level-security policies know which project the work is for. Every query in the app goes through it.
 */
class ScopedPool extends pg.Pool {
  // The stamp is always rewritten on checkout, so a connection never carries a previous caller's project.
  override async connect(...args: any[]): Promise<any> {
    if (typeof args[0] === 'function') return super.connect(args[0]);        // callback form: not used by the app
    const c = await super.connect();
    try { await stamp(c); } catch (e) { c.release(true); throw e; }
    return c;
  }
  override query(...args: any[]): any {
    if (typeof args[args.length - 1] === 'function') return (super.query as any)(...args);
    return (async () => {
      const c = await super.connect();
      try { await stamp(c); return await (c.query as any)(...args); } finally { c.release(); }
    })();
  }
}

/** The runtime connection: a restricted account that cannot bypass row-level security. */
export const pool = new ScopedPool({
  connectionString: process.env.DATABASE_URL ?? 'postgres://design_max_app:design_max_app@localhost:5432/antigravity',
}) as unknown as pg.Pool;   // typed as an ordinary pool; the scoping is a runtime detail of the class above

/** Owner connection for migrations only (creates tables, policies, roles). Never used while serving requests. */
export const migrationUrl = () => process.env.MIGRATE_DATABASE_URL ?? 'postgres://antigravity:antigravity@localhost:5432/antigravity';

// The database may restart while the API runs. Without a listener, Node treats a dropped idle connection as a
// fatal unhandled error; with one, the pool simply discards it and reconnects on the next query.
pool.on('error', (e) => console.error('[db] idle connection dropped:', (e as Error).message));
