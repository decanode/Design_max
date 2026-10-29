import { createHash } from 'node:crypto';
import type pg from 'pg';
import { pool } from '../db.js';
import { boardPhases } from '../workflow/service.js';
import { decryptSecret } from './secrets.js';
import { JiraConnector } from './jira.js';
import { ServiceNowConnector } from './servicenow.js';
import type { Connector, ConnectorConfig, SourceTicket, SourceUser } from './types.js';
import type { Fetcher } from '../etl/types.js';

type Q = Pick<pg.Pool, 'query'>;
export interface ConnectionRow { id: string; project_id: string; kind: 'jira' | 'servicenow'; name: string; base_url: string; username: string; secret_enc: string | null; config: Record<string, unknown>; enabled: boolean; sync_interval_min: number; cursor: { updatedSince?: string; lastFullAt?: string }; last_sync_at: Date | null }

/** The right connector for a stored connection. `fetch` is only for tests. */
export function connectorFor(c: ConnectionRow, fetch?: Fetcher): Connector {
  const cfg: ConnectorConfig = { baseUrl: c.base_url, username: c.username, secret: c.secret_enc ? decryptSecret(c.secret_enc) : '', config: c.config, fetch };
  return c.kind === 'jira' ? new JiraConnector(cfg) : new ServiceNowConnector(cfg);
}

/* ------------------------------------------------------------------ mapping the source's words onto ours */
export type Tone = 'intake' | 'spec' | 'build' | 'review' | 'done';
/** A guess at what a status means, from its name, used until an admin maps it. */
export function toneOf(status: string): Tone {
  const s = status.toLowerCase();
  if (/(done|closed|resolved|complete|cancel|reject|won'?t|fixed|deployed|released)/.test(s)) return 'done';
  if (/(review|qa|test|uat|verify|validation|accept|approval)/.test(s)) return 'review';
  if (/(progress|develop|implement|build|work|fix|analys|assess|rca)/.test(s)) return 'build';
  if (/(design|spec|plan|refine|ready|authoriz|schedul)/.test(s)) return 'spec';
  return 'intake';
}
export const PRIORITIES = ['Critical', 'High', 'Medium', 'Low'] as const;
export function priorityOf(p?: string): (typeof PRIORITIES)[number] {
  const s = (p ?? '').toLowerCase();
  if (/(highest|critical|blocker|urgent|^1)/.test(s)) return 'Critical';
  if (/(high|major|^2)/.test(s)) return 'High';
  if (/(low|minor|trivial|lowest|^4|^5)/.test(s)) return 'Low';
  return /^critical|^high|^medium|^low/i.test(p ?? '') ? ((p![0].toUpperCase() + p!.slice(1).toLowerCase()) as (typeof PRIORITIES)[number]) : 'Medium';
}
const TYPE_KEYS: Record<string, string> = { bug: 'bug', story: 'feature', epic: 'epic', task: 'feature', 'sub-task': 'feature', incident: 'incident', problem: 'problem', change_request: 'change', change: 'change', 'service request': 'ritm' };

/** The project's own phase for a source status: the admin's mapping first, then the first phase of the guessed kind. */
async function localPhase(db: Q, c: ConnectionRow, status: string): Promise<string> {
  const mapped = (await db.query('SELECT ph.name FROM status_maps m JOIN phases ph ON ph.id = m.phase_id WHERE m.connection_id=$1 AND m.source_status=$2', [c.id, status])).rows[0]?.name;
  if (mapped) return mapped;
  const phases = (await boardPhases(c.project_id, db)).filter((p) => p.enabled);
  const t = toneOf(status);
  return (phases.find((p) => p.name.toLowerCase() === status.toLowerCase()) ?? phases.find((p) => p.tone === t) ?? phases.find((p) => p.tone === 'intake') ?? phases[0]).name;
}
async function ticketTypeFor(db: Q, projectId: string, t: SourceTicket): Promise<number> {
  const key = TYPE_KEYS[t.type.toLowerCase()];
  const id = key ? (await db.query('SELECT id FROM ticket_types WHERE key=$1', [key])).rows[0]?.id as number | undefined : undefined;
  if (id) { await db.query('INSERT INTO project_ticket_types (project_id, ticket_type_id, enabled, is_default) VALUES ($1,$2,false,false) ON CONFLICT DO NOTHING', [projectId, id]); return id; }
  return (await db.query('SELECT ticket_type_id FROM project_ticket_types WHERE project_id=$1 AND enabled ORDER BY is_default DESC, ticket_type_id LIMIT 1', [projectId])).rows[0].ticket_type_id;
}

/**
 * People who appear in the source tool become inactive accounts (they cannot sign in, and belong to no project) so names show on tickets.
 * Someone whose email matches an existing account is linked to it instead.
 */
export async function upsertExternalUser(db: Q, source: string, u: SourceUser | undefined): Promise<string | null> {
  if (!u?.id) return null;
  const mapped = (await db.query('SELECT user_id FROM user_identity_map WHERE source=$1 AND legacy_id=$2', [source, u.id])).rows[0];
  if (mapped) return mapped.user_id;
  const email = (u.email ?? `${u.id}@unmapped.${source}.invalid`).toLowerCase();
  const found = (await db.query('SELECT id FROM users WHERE email=$1', [email])).rows[0]
    ?? (await db.query('INSERT INTO users (email, display_name, active) VALUES ($1,$2,false) RETURNING id', [email, u.name ?? email])).rows[0];
  await db.query('INSERT INTO user_identity_map(source, legacy_id, user_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [source, u.id, found.id]);
  return found.id;
}

const hashOf = (t: SourceTicket) => createHash('sha256').update(JSON.stringify([t.title, t.description, t.status, t.priority, t.dueDate, t.assignee?.id, t.reporter?.id, t.updatedAt, t.type, t.comments.length, t.attachments.length, t.resolutionNotes])).digest('hex');

/** Creates or refreshes one mirrored ticket. Its own (local) phase is only set when it first arrives. Returns what happened. */
export async function mirrorTicket(db: Q, c: ConnectionRow, t: SourceTicket): Promise<'created' | 'updated' | 'unchanged'> {
  const hash = hashOf(t);
  const cur = (await db.query('SELECT id, source_hash FROM tickets WHERE project_id=$1 AND legacy_id=$2', [c.project_id, t.key])).rows[0];
  if (cur?.source_hash === hash) { await db.query('UPDATE tickets SET source_removed_at=NULL, connection_id=$2 WHERE id=$1 AND (source_removed_at IS NOT NULL OR connection_id IS DISTINCT FROM $2)', [cur.id, c.id]); return 'unchanged'; }
  const customer = await upsertExternalUser(db, t.source, t.reporter), consultant = await upsertExternalUser(db, t.source, t.assignee);
  let id: string; let inserted = false;
  if (cur) {
    id = cur.id;
    await db.query(
      `UPDATE tickets SET title=$2, customer_id=$3, consultant_id=$4, ai_summary=$5, legacy_status=$6, legacy_type=$7, resolution_notes=$8, acceptance_criteria=$9, priority=$10, due_date=$11,
          connection_id=$12, source_url=$13, source_status=$14, source_updated_at=$15, source_hash=$16, source_removed_at=NULL WHERE id=$1`,
      [id, t.title.slice(0, 300), customer, consultant, t.description ?? null, t.status, t.type, t.resolutionNotes ?? null, t.acceptanceCriteria ?? null, priorityOf(t.priority), t.dueDate ?? null, c.id, t.url ?? null, t.status, t.updatedAt, hash]);
  } else {
    inserted = true;
    id = (await db.query(
      `INSERT INTO tickets (project_id, title, current_state, ticket_type_id, customer_id, consultant_id, ai_summary, legacy_id, legacy_source, legacy_type, legacy_status, resolution_notes, acceptance_criteria,
          priority, due_date, created_at, connection_id, source_url, source_status, source_updated_at, source_hash)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21) RETURNING id`,
      [c.project_id, t.title.slice(0, 300), await localPhase(db, c, t.status), await ticketTypeFor(db, c.project_id, t), customer, consultant, t.description ?? null, t.key, t.source, t.type, t.status, t.resolutionNotes ?? null, t.acceptanceCriteria ?? null,
       priorityOf(t.priority), t.dueDate ?? null, t.createdAt, c.id, t.url ?? null, t.status, t.updatedAt, hash])).rows[0].id;
  }
  if (inserted) await db.query('UPDATE ticket_transitions SET created_at=$2 WHERE ticket_id=$1 AND from_state IS NULL', [id, t.createdAt]);   // it was not created now; it was created then
  await db.query('DELETE FROM ticket_source_history WHERE ticket_id=$1', [id]);
  for (const s of t.history) await db.query('INSERT INTO ticket_source_history (ticket_id, project_id, at, from_status, to_status, actor) VALUES ($1,$2,$3,$4,$5,$6)', [id, c.project_id, s.at, s.from, s.to, s.actor ?? null]);
  for (const cm of t.comments) await db.query(
    `INSERT INTO ticket_comments (ticket_id, author_id, body, legacy_id, created_at) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (ticket_id, legacy_id) DO NOTHING`,
    [id, await upsertExternalUser(db, t.source, cm.author), cm.body, cm.id, cm.createdAt]);
  for (const a of t.attachments) await db.query(
    `INSERT INTO attachments (ticket_id, filename, mime_type, size_bytes, legacy_url, legacy_id) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (ticket_id, legacy_id) DO NOTHING`,
    [id, a.filename, a.mimeType ?? null, a.size ?? null, a.url, a.id]);
  return inserted ? 'created' : 'updated';
}

export interface SyncResult { runId: string; created: number; updated: number; unchanged: number; failed: number; removed: number; fullScan: boolean; error?: string }
const FULL_SCAN_EVERY_MS = 24 * 3600 * 1000, OVERLAP_MS = 2 * 60 * 1000;

/** Pulls what changed since the last run and mirrors it. Safe to run again at any time. Never writes to the source. */
export async function runSync(c: ConnectionRow, opts: { trigger?: 'schedule' | 'manual' | 'webhook'; connector?: Connector; fetch?: Fetcher; db?: Q } = {}): Promise<SyncResult> {
  const db = opts.db ?? pool;
  const full = !c.cursor?.updatedSince || !c.cursor.lastFullAt || Date.now() - Date.parse(c.cursor.lastFullAt) > FULL_SCAN_EVERY_MS;
  const since = full ? null : new Date(Date.parse(c.cursor.updatedSince!) - OVERLAP_MS).toISOString();
  const run = (await db.query(`INSERT INTO sync_runs (connection_id, project_id, trigger, full_scan) VALUES ($1,$2,$3,$4) RETURNING id, started_at`, [c.id, c.project_id, opts.trigger ?? 'manual', full])).rows[0];
  const r: SyncResult = { runId: run.id, created: 0, updated: 0, unchanged: 0, failed: 0, removed: 0, fullScan: full };
  let newest = c.cursor?.updatedSince ?? null;
  try {
    const conn = opts.connector ?? connectorFor(c, opts.fetch);
    const seen = new Set<string>();
    for await (const t of conn.pull(since)) {
      seen.add(t.key);
      try { r[await mirrorTicket(db, c, t)]++; } catch (e) { r.failed++; await db.query('INSERT INTO sync_failures (run_id, project_id, source_key, error) VALUES ($1,$2,$3,$4)', [run.id, c.project_id, t.key, (e as Error).message.slice(0, 500)]); }
      if (!newest || t.updatedAt > newest) newest = t.updatedAt;
    }
    if (full) r.removed = (await db.query(`UPDATE tickets SET source_removed_at=now() WHERE connection_id=$1 AND source_removed_at IS NULL AND NOT (legacy_id = ANY($2))`, [c.id, [...seen]])).rowCount ?? 0;
    const cursor = { updatedSince: newest ?? new Date(run.started_at).toISOString(), lastFullAt: full ? new Date(run.started_at).toISOString() : c.cursor.lastFullAt };
    await db.query(`UPDATE integration_connections SET cursor=$2, last_sync_at=now(), health=$3 WHERE id=$1`, [c.id, JSON.stringify(cursor), r.failed && !r.created && !r.updated ? 'error' : 'ok']);
    await db.query(`UPDATE sync_runs SET status='ok', finished_at=now(), created=$2, updated=$3, unchanged=$4, failed=$5, removed=$6 WHERE id=$1`, [run.id, r.created, r.updated, r.unchanged, r.failed, r.removed]);
  } catch (e) {
    r.error = (e as Error).message.slice(0, 500);
    await db.query(`UPDATE integration_connections SET health='error', last_sync_at=now() WHERE id=$1`, [c.id]);
    await db.query(`UPDATE sync_runs SET status='error', finished_at=now(), created=$2, updated=$3, unchanged=$4, failed=$5, error=$6 WHERE id=$1`, [run.id, r.created, r.updated, r.unchanged, r.failed, r.error]);
  }
  return r;
}
