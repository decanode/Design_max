import { pool } from '../db.js';
import type { ChatMessage, Draft, Observer } from './observer.js';
import { loadStackPolicy } from '../stacks.js';

export async function createConversation(projectId: string, title?: string, customerId?: string | null) {
  const { rows } = await pool.query('INSERT INTO conversations (project_id, title, customer_id) VALUES ($1,$2,$3) RETURNING *', [projectId, title ?? null, customerId ?? null]);
  return rows[0];
}

/** A user may open a conversation they own, or any conversation if their role can see all of them. */
export async function canAccessConversation(u: { id: string; perms: Set<string>; projectId: string | null }, conversationId: string) {
  const c = (await pool.query('SELECT customer_id, project_id FROM conversations WHERE id=$1', [conversationId])).rows[0];
  if (!c || c.project_id !== u.projectId) return false;                       // other projects' conversations do not exist for you
  return u.perms.has('chat.view_all') || c.customer_id === u.id;
}

export async function listConversations(u: { id: string; perms: Set<string>; projectId: string | null }) {
  const all = u.perms.has('chat.view_all');
  return (await pool.query(
    `SELECT c.id, c.created_at, c.customer_id, cu.display_name AS customer, pr.name AS project, d.title AS draft_title, d.status AS draft_status,
            (SELECT body FROM messages m WHERE m.conversation_id = c.id ORDER BY m.id DESC LIMIT 1) AS last_message,
            COALESCE((SELECT max(created_at) FROM messages m WHERE m.conversation_id = c.id), c.created_at) AS last_at
     FROM conversations c LEFT JOIN users cu ON cu.id = c.customer_id LEFT JOIN requirement_drafts d ON d.conversation_id = c.id JOIN projects pr ON pr.id = c.project_id
     WHERE c.project_id = $3 AND ($1 OR c.customer_id = $2) ORDER BY last_at DESC LIMIT 100`, [all, u.id, u.projectId])).rows;
}

export async function getMessages(conversationId: string) {
  const { rows } = await pool.query('SELECT id, sender_role, sender_name, body, created_at FROM messages WHERE conversation_id=$1 ORDER BY id', [conversationId]);
  return rows;
}

export async function getConversationProject(conversationId: string) {
  const r = (await pool.query(
    `SELECT p.id, p.name, COALESCE((SELECT array_agg(s.name ORDER BY s.name) FROM project_stacks ps JOIN tech_stacks s ON s.id=ps.stack_id WHERE ps.project_id=p.id), '{}') AS stacks
     FROM conversations c JOIN projects p ON p.id=c.project_id WHERE c.id=$1`, [conversationId])).rows[0];
  return r ?? null;
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
  const policy = await loadStackPolicy((await pool.query('SELECT project_id FROM conversations WHERE id=$1', [conversationId])).rows[0].project_id);
  const d: Draft | null = await observer.draft(msgs, policy);
  if (!d) return null;
  const { rows } = await pool.query(
    `INSERT INTO requirement_drafts (conversation_id, title, summary, entities, stack_fit, stack_note) VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (conversation_id) DO UPDATE SET title=EXCLUDED.title, summary=EXCLUDED.summary, entities=EXCLUDED.entities,
       stack_fit=EXCLUDED.stack_fit, stack_note=EXCLUDED.stack_note, updated_at=now()
     WHERE requirement_drafts.status='draft' RETURNING *`,
    [conversationId, d.title, d.summary, JSON.stringify(d.entities), d.stackFit, d.stackNote]);
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
    if (d.stack_fit === 'out_of_scope') throw new VerifyError(d.stack_note || 'This request is outside the project\'s allowed technology. Rephrase it, or raise it in the right project.');
    const conv = (await client.query('SELECT project_id, customer_id FROM conversations WHERE id=$1', [conversationId])).rows[0];
    const t = await client.query('INSERT INTO tickets (project_id, title, ai_summary, customer_id) VALUES ($1,$2,$3,$4) RETURNING id', [conv.project_id, d.title, d.summary, conv.customer_id]);
    const upd = await client.query(`UPDATE requirement_drafts SET status='verified', ticket_id=$2, updated_at=now() WHERE conversation_id=$1 RETURNING *`, [conversationId, t.rows[0].id]);
    await client.query('COMMIT');
    return { draft: upd.rows[0], ticketId: t.rows[0].id as string, created: true };
  } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
}
