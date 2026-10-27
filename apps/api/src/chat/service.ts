import { pool } from '../db.js';
import type { ChatMessage, Draft, Observer } from './observer.js';

export async function createConversation(projectId: string, title?: string) {
  const { rows } = await pool.query('INSERT INTO conversations (project_id, title) VALUES ($1,$2) RETURNING *', [projectId, title ?? null]);
  return rows[0];
}

export async function getMessages(conversationId: string) {
  const { rows } = await pool.query('SELECT id, sender_role, sender_name, body, created_at FROM messages WHERE conversation_id=$1 ORDER BY id', [conversationId]);
  return rows;
}

export async function getDraft(conversationId: string) {
  return (await pool.query('SELECT * FROM requirement_drafts WHERE conversation_id=$1', [conversationId])).rows[0] ?? null;
}

export async function addMessage(conversationId: string, role: ChatMessage['role'], name: string, body: string) {
  const { rows } = await pool.query(
    'INSERT INTO messages (conversation_id, sender_role, sender_name, body) VALUES ($1,$2,$3,$4) RETURNING id, sender_role, sender_name, body, created_at',
    [conversationId, role, name, body]);
  return rows[0];
}

/** Re-runs the observer. Returns null if the draft is already verified (frozen) or nothing to draft. */
export async function refreshDraft(conversationId: string, observer: Observer) {
  const existing = await getDraft(conversationId);
  if (existing?.status === 'verified') return null;
  const msgs = (await getMessages(conversationId)).map((m): ChatMessage => ({ role: m.sender_role, name: m.sender_name, body: m.body }));
  const d: Draft | null = await observer.draft(msgs);
  if (!d) return null;
  const { rows } = await pool.query(
    `INSERT INTO requirement_drafts (conversation_id, title, summary, entities) VALUES ($1,$2,$3,$4)
     ON CONFLICT (conversation_id) DO UPDATE SET title=EXCLUDED.title, summary=EXCLUDED.summary, entities=EXCLUDED.entities, updated_at=now()
     WHERE requirement_drafts.status='draft' RETURNING *`,
    [conversationId, d.title, d.summary, JSON.stringify(d.entities)]);
  return rows[0] ?? null;
}

export class VerifyError extends Error {}

/** "Verify & Approve": logs the ticket exactly once (row lock makes double-clicks safe). */
export async function verifyDraft(conversationId: string) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const d = (await client.query('SELECT * FROM requirement_drafts WHERE conversation_id=$1 FOR UPDATE', [conversationId])).rows[0];
    if (!d) throw new VerifyError('Nothing to verify yet');
    if (d.status === 'verified') { await client.query('COMMIT'); return { draft: d, ticketId: d.ticket_id as string, created: false }; }
    const project = (await client.query('SELECT project_id FROM conversations WHERE id=$1', [conversationId])).rows[0].project_id;
    const t = await client.query('INSERT INTO tickets (project_id, title, ai_summary) VALUES ($1,$2,$3) RETURNING id', [project, d.title, d.summary]);
    const upd = await client.query(`UPDATE requirement_drafts SET status='verified', ticket_id=$2, updated_at=now() WHERE conversation_id=$1 RETURNING *`, [conversationId, t.rows[0].id]);
    await client.query('COMMIT');
    return { draft: upd.rows[0], ticketId: t.rows[0].id as string, created: true };
  } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
}
