import type pg from 'pg';
import type { LegacyRecord, LegacyUser } from './types.js';
import { mapState } from './transform.js';

type Q = Pick<pg.Pool, 'query'>;

/** Resolve a legacy identity to a user, creating one keyed on corporate email. */
export async function upsertUser(db: Q, source: string, u?: LegacyUser): Promise<string | null> {
  if (!u?.legacyId) return null;
  const mapped = await db.query('SELECT user_id FROM user_identity_map WHERE source=$1 AND legacy_id=$2', [source, u.legacyId]);
  if (mapped.rowCount) return mapped.rows[0].user_id;
  // Without a resolvable email use a placeholder so it can be reconciled with Entra ID later.
  const email = (u.email ?? `${u.legacyId}@unmapped.${source}.invalid`).toLowerCase();
  const { rows } = await db.query(
    `INSERT INTO users (email, display_name, role_id) VALUES ($1,$2,(SELECT id FROM roles WHERE name='Customer'))
     ON CONFLICT (email) DO UPDATE SET display_name = users.display_name RETURNING id`, [email, u.name ?? email]);
  await db.query('INSERT INTO user_identity_map(source, legacy_id, user_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [source, u.legacyId, rows[0].id]);
  return rows[0].id;
}

/** Idempotent: re-running updates the ticket by legacy_id. Returns the ticket id. */
export async function loadRecord(db: Q, projectId: string, r: LegacyRecord): Promise<string> {
  const customer = await upsertUser(db, r.source, r.reporter);
  const consultant = await upsertUser(db, r.source, r.assignee);
  // Legacy tickets enter directly at their mapped phase; the transition trigger guards UPDATEs only.
  const { rows } = await db.query(
    `INSERT INTO tickets (project_id, title, current_state, customer_id, consultant_id, ai_summary, legacy_id,
        legacy_source, legacy_type, legacy_status, resolution_notes, acceptance_criteria)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     ON CONFLICT (legacy_id) WHERE legacy_id IS NOT NULL DO UPDATE SET
        title=EXCLUDED.title, customer_id=EXCLUDED.customer_id, consultant_id=EXCLUDED.consultant_id,
        ai_summary=EXCLUDED.ai_summary, legacy_status=EXCLUDED.legacy_status,
        resolution_notes=EXCLUDED.resolution_notes, acceptance_criteria=EXCLUDED.acceptance_criteria
     RETURNING id`,
    [projectId, r.title, mapState(r), customer, consultant, r.description ?? null, r.legacyId,
     r.source, r.type, r.status, r.resolutionNotes ?? null, r.acceptanceCriteria ?? null]);
  const id: string = rows[0].id;

  for (const c of r.comments) {
    await db.query(
      `INSERT INTO ticket_comments (ticket_id, author_id, body, legacy_id, created_at) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (legacy_id) DO NOTHING`,
      [id, await upsertUser(db, r.source, c.author), c.body, c.legacyId, c.createdAt]);
  }
  for (const a of r.attachments) {
    await db.query(
      `INSERT INTO attachments (ticket_id, filename, mime_type, size_bytes, legacy_url, legacy_id) VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (legacy_id) DO NOTHING`, [id, a.filename, a.mimeType ?? null, a.size ?? null, a.url, a.legacyId]);
  }
  return id;
}
