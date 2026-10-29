import { pool, runWithContext } from '../db.js';
import { exportDocument } from '../docgen/exportDocument.js';
import { loadUser } from '../rbac/auth.js';
import { projectMode } from '../rbac/modes.js';
import type { Fetcher } from '../etl/types.js';
import type { Connector } from './types.js';
import { connectorFor, type ConnectionRow } from './sync.js';

const MAX_ATTEMPTS = 6;
const backoffMin = (attempts: number) => Math.min(2 ** attempts, 60);

interface Row { id: string; connection_id: string; project_id: string; ticket_id: string; action: 'status' | 'comment' | 'attach'; payload: any; actor_id: string | null; dry_run: boolean; attempts: number }
const MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

/** Sends one queued item. Returns what happened; throws only for problems worth retrying. */
async function sendOne(row: Row, conn: Connector): Promise<{ status: 'sent' | 'skipped'; result: unknown }> {
  const t = (await pool.query('SELECT legacy_id, legacy_type, source_status, source_updated_at, writeback_paused, project_id FROM tickets WHERE id=$1', [row.ticket_id])).rows[0];
  if (!t?.legacy_id) return { status: 'skipped', result: { reason: 'The ticket has no source ticket' } };
  if (t.writeback_paused) return { status: 'skipped', result: { reason: 'Sending is paused for this ticket' } };
  if (!(await projectMode(t.project_id)).caps.writeback) return { status: 'skipped', result: { reason: 'This project no longer sends changes back' } };
  const ref = { key: t.legacy_id as string, type: t.legacy_type as string };
  if (row.dry_run) return { status: 'skipped', result: { dryRun: true, wouldSend: { action: row.action, ref, payload: row.payload } } };
  if (row.action === 'status') {
    const now = await conn.current!(ref);
    if (now.status.toLowerCase() === String(row.payload.status).toLowerCase()) return { status: 'sent', result: { detail: 'Already in that status' } };
    // somebody changed it in the source since we last read it: do not overwrite their work
    if (t.source_updated_at && Date.parse(now.updatedAt) > new Date(t.source_updated_at).getTime() + 1000 && now.status !== t.source_status) {
      await pool.query('UPDATE tickets SET out_of_sync=true WHERE id=$1', [row.ticket_id]);
      return { status: 'skipped', result: { reason: `The source ticket changed since we last read it (it is now “${now.status}”). Nothing was changed there.` } };
    }
    const r = await conn.transitionTo!(ref, row.payload.status);
    await pool.query('UPDATE tickets SET source_status=$2, out_of_sync=false WHERE id=$1', [row.ticket_id, row.payload.status]);
    return { status: 'sent', result: r };
  }
  if (row.action === 'comment') return { status: 'sent', result: await conn.addComment!(ref, row.payload.body) };
  const user = row.actor_id ? await loadUser(row.actor_id, row.project_id) : null;
  if (!user) return { status: 'skipped', result: { reason: 'Nobody to attribute the document export to' } };
  const done: string[] = [];
  for (const kind of row.payload.kinds as string[]) {
    const ap = (await pool.query(`SELECT version_number FROM approval_requests WHERE ticket_id=$1 AND kind=$2 AND status='approved' ORDER BY completed_at DESC LIMIT 1`, [row.ticket_id, kind])).rows[0];
    if (!ap) continue;                                                                 // only approved documents leave the building
    const f = await exportDocument(user, row.ticket_id, kind, ap.version_number);
    await conn.attach!(ref, { filename: f.filename, mime: MIME, data: f.buffer });
    done.push(f.filename);
  }
  return done.length ? { status: 'sent', result: { attached: done } } : { status: 'skipped', result: { reason: 'There is no approved document to send yet' } };
}

/** Sends what is due for one connection, oldest first. Failed items retry with growing gaps, then stop and wait for a person. */
export async function drainConnection(c: ConnectionRow, opts: { now?: Date; connector?: Connector; fetch?: Fetcher; limit?: number } = {}) {
  const now = opts.now ?? new Date();
  const live = (await pool.query('SELECT enabled, writeback_enabled FROM integration_connections WHERE id=$1', [c.id])).rows[0];
  const out = { sent: 0, skipped: 0, failed: 0, retry: 0 };
  if (!live?.enabled || !live.writeback_enabled) return out;                          // the kill switch: nothing leaves while it is off
  const conn = opts.connector ?? connectorFor(c, opts.fetch);
  const rows = (await pool.query(`SELECT * FROM outbound_queue WHERE connection_id=$1 AND status='pending' AND next_attempt_at <= $2 ORDER BY created_at LIMIT $3`, [c.id, now, opts.limit ?? 50])).rows as Row[];
  for (const row of rows) {
    // claim it, so two workers never send the same thing
    const claimed = await pool.query(`UPDATE outbound_queue SET attempts = attempts + 1 WHERE id=$1 AND status='pending' AND attempts = $2`, [row.id, row.attempts]);
    if (!claimed.rowCount) continue;
    try {
      const r = await sendOne({ ...row, attempts: row.attempts + 1 }, conn);
      await pool.query(`UPDATE outbound_queue SET status=$2, result=$3, sent_at=now(), last_error=NULL WHERE id=$1`, [row.id, r.status, JSON.stringify(r.result)]);
      out[r.status === 'sent' ? 'sent' : 'skipped']++;
    } catch (e) {
      const attempts = row.attempts + 1, give = attempts >= MAX_ATTEMPTS;
      await pool.query(`UPDATE outbound_queue SET status=$2, last_error=$3, next_attempt_at=$4 WHERE id=$1`, [row.id, give ? 'failed' : 'pending', (e as Error).message.slice(0, 500), new Date(now.getTime() + backoffMin(attempts) * 60_000)]);
      out[give ? 'failed' : 'retry']++;
    }
  }
  return out;
}

/** The scheduler's pass over every connection that has something waiting. */
export async function drainDue(now = new Date()): Promise<number> {
  const conns = await runWithContext({ platform: true }, async () => (await pool.query(
    `SELECT DISTINCT c.* FROM integration_connections c JOIN outbound_queue q ON q.connection_id = c.id WHERE c.enabled AND c.writeback_enabled AND q.status='pending' AND q.next_attempt_at <= $1`, [now])).rows as ConnectionRow[]);
  let sent = 0;
  for (const c of conns) {
    const lock = await pool.connect();
    try {
      if (!(await lock.query('SELECT pg_try_advisory_lock(hashtext($1)) AS ok', ['out:' + c.id])).rows[0].ok) continue;
      try { sent += (await runWithContext({ projectId: c.project_id }, () => drainConnection(c, { now }))).sent; } finally { await lock.query('SELECT pg_advisory_unlock(hashtext($1))', ['out:' + c.id]); }
    } catch (e) { console.error('write-back pass failed', c.name, (e as Error).message); } finally { lock.release(); }
  }
  return sent;
}
