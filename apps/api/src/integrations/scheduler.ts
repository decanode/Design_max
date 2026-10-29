import { pool, runWithContext } from '../db.js';
import { runSync, type ConnectionRow } from './sync.js';

/**
 * Runs the pull sync for every enabled connection that is due. Several API instances can run this at once: a
 * connection is only synced by the instance that wins its advisory lock.
 */
export async function syncDueConnections(now = new Date()): Promise<number> {
  const due = await runWithContext({ platform: true }, async () => (await pool.query(
    `SELECT c.* FROM integration_connections c JOIN projects p ON p.id = c.project_id
     WHERE c.enabled AND p.status = 'active' AND (c.last_sync_at IS NULL OR c.last_sync_at < $1::timestamptz - (c.sync_interval_min || ' minutes')::interval) ORDER BY c.last_sync_at NULLS FIRST LIMIT 20`, [now])).rows as ConnectionRow[]);
  let ran = 0;
  for (const c of due) {
    const lock = await pool.connect();
    try {
      if (!(await lock.query('SELECT pg_try_advisory_lock(hashtext($1)) AS ok', [c.id])).rows[0].ok) continue;
      try { await runWithContext({ projectId: c.project_id }, () => runSync(c, { trigger: 'schedule' })); ran++; }
      finally { await lock.query('SELECT pg_advisory_unlock(hashtext($1))', [c.id]); }
    } catch (e) { console.error('sync failed', c.name, (e as Error).message); } finally { lock.release(); }
  }
  return ran;
}

export function startSyncScheduler(everyMs = 60_000) {
  if (process.env.SYNC_SCHEDULER === 'off') return () => {};
  const t = setInterval(() => { syncDueConnections().catch((e) => console.error('sync scheduler', e)); }, everyMs);
  t.unref();
  return () => clearInterval(t);
}
