import type pg from 'pg';
import { pool, runWithContext } from '../db.js';

type Q = Pick<pg.Pool, 'query'>;
const dayOf = (d: Date) => d.toISOString().slice(0, 10);

/** Records how many tickets sit in each phase today (replacing a previous record for the same day). */
export async function takeSnapshot(projectId: string, day = new Date(), db: Q = pool): Promise<number> {
  const d = dayOf(day);
  await db.query('DELETE FROM ticket_daily_snapshot WHERE project_id=$1 AND day=$2', [projectId, d]);
  return (await db.query(
    `INSERT INTO ticket_daily_snapshot (project_id, day, phase, tone, tickets, oldest_days)
     SELECT t.project_id, $2::date, t.current_state, COALESCE(p.tone, 'intake'), count(*), round(max(extract(epoch from (($2::date + 1) - t.created_at)) / 86400)::numeric, 1)
     FROM tickets t LEFT JOIN phases p ON p.name = t.current_state WHERE t.project_id=$1 AND t.source_removed_at IS NULL AND t.created_at < ($2::date + 1) GROUP BY 1, 3, 4`, [projectId, d])).rowCount ?? 0;
}

/**
 * Reconstructs past days from the phase history we already keep, so trends exist from the day this is switched on,
 * not from the day the first nightly record is taken. Our own phases only; a mirrored ticket's history is in its source statuses.
 */
export async function backfillSnapshots(projectId: string, days = 90, db: Q = pool): Promise<number> {
  const n = Math.min(Math.max(days, 1), 365);
  await db.query(`DELETE FROM ticket_daily_snapshot WHERE project_id=$1 AND day >= current_date - $2::int AND day < current_date`, [projectId, n]);
  return (await db.query(
    `WITH h AS MATERIALIZED (SELECT x.ticket_id, x.to_state, x.created_at AS at, x.id, t.created_at AS created FROM ticket_transitions x JOIN tickets t ON t.id = x.ticket_id WHERE t.project_id = $1)
     INSERT INTO ticket_daily_snapshot (project_id, day, phase, tone, tickets, oldest_days)
     SELECT $1, d::date, s.to_state, COALESCE(p.tone, 'intake'), count(*), round(max(extract(epoch from ((d::date + 1) - s.created)) / 86400)::numeric, 1)
     FROM generate_series(current_date - $2::int, current_date - 1, interval '1 day') d
     JOIN LATERAL (SELECT DISTINCT ON (h.ticket_id) h.ticket_id, h.to_state, h.created FROM h WHERE h.at < (d::date + 1) ORDER BY h.ticket_id, h.at DESC, h.id DESC) s ON true
     LEFT JOIN phases p ON p.name = s.to_state GROUP BY d, s.to_state, p.tone
     ON CONFLICT (project_id, day, phase) DO NOTHING`, [projectId, n])).rowCount ?? 0;
}

/** Takes today's record for every active project that does not have one yet. Cheap enough to call every minute. */
export async function snapshotDue(now = new Date()): Promise<number> {
  return runWithContext({ platform: true }, async () => {
    const due = (await pool.query(`SELECT p.id FROM projects p WHERE p.status = 'active' AND NOT EXISTS (SELECT 1 FROM ticket_daily_snapshot s WHERE s.project_id = p.id AND s.day = $1::date)`, [dayOf(now)])).rows;
    for (const p of due) { await takeSnapshot(p.id, now); await backfillSnapshots(p.id, 30); }       // a new project's first record also fills in what we can know of the past month
    return due.length;
  });
}
