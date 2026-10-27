import { createHash } from 'node:crypto';
import { pool } from '../db.js';
import { applyTransition } from '../tickets.js';
import type { TicketState } from '../stateMachine.js';
import { similar, type Embedder } from '../etl/vectorize.js';
import type { DocContext, DocGenerator, DocKind } from './generator.js';
import { diffLines } from './diff.js';
import { supersedeOpenRequest, requestsForTicket } from '../approvals/engine.js';
import { assessFit, loadStackPolicy, projectPolicyForTicket } from '../stacks.js';

import { DocError } from '../errors.js';
export { DocError };

const draftedState = (k: DocKind) => `${k} Drafted` as TicketState;
const approvedState = (k: DocKind) => `${k} Approved` as TicketState;
const hash = (t: string) => createHash('sha256').update(t).digest('hex');

export async function getTicket(id: string) {
  const t = (await pool.query('SELECT * FROM tickets WHERE id=$1', [id])).rows[0];
  if (!t) throw new DocError('Ticket not found', 404);
  return t;
}

export async function listVersions(ticketId: string, kind: DocKind) {
  return (await pool.query(
    'SELECT version_number, content_md, author_name, change_note, created_at FROM documents WHERE ticket_id=$1 AND kind=$2 ORDER BY version_number DESC', [ticketId, kind])).rows;
}

async function buildContext(ticketId: string, kind: DocKind, embedder?: Embedder): Promise<DocContext> {
  const t = await getTicket(ticketId);
  const conv = (await pool.query(
    `SELECT d.entities, d.conversation_id FROM requirement_drafts d WHERE d.ticket_id=$1`, [ticketId])).rows[0];
  const transcript = conv
    ? (await pool.query(`SELECT body FROM messages WHERE conversation_id=$1 AND sender_role='customer' ORDER BY id`, [conv.conversation_id])).rows.map((r) => r.body as string)
    : [];
  const policy = await loadStackPolicy(t.project_id);
  const ctx: DocContext = { title: t.title, summary: t.ai_summary ?? t.title, transcript, entities: conv?.entities, policy };
  if (kind === 'TS') {
    ctx.fs = (await listVersions(ticketId, 'FS'))[0]?.content_md;
    // Only meaningful with a real embedding model; the offline stand-in would return noise.
    if (embedder?.semantic) {
      const hits = await similar(pool, embedder, `${t.title}\n${ctx.summary}`, 5, policy?.allowed.map((a) => a.name));
      ctx.knowledge = hits.map((h) => `[${h.source_type}] ${h.source_ref}: ${String(h.content).slice(0, 600)}`);
    }
  }
  return ctx;
}

/** Creates v1 of the FS (from Requirement Verified) or TS (from FS Approved) and advances the ticket. */
export async function generateDocument(ticketId: string, kind: DocKind, gen: DocGenerator, embedder?: Embedder) {
  const t = await getTicket(ticketId);
  const need: TicketState = kind === 'FS' ? 'Requirement Verified' : 'FS Approved';
  if (t.current_state !== need) throw new DocError(`The ${kind} can only be generated while the ticket is in "${need}" (currently "${t.current_state}")`);
  const content = await gen.generate(kind, await buildContext(ticketId, kind, embedder));

  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await applyTransition(c, ticketId, draftedState(kind)); // re-checks state under lock: a concurrent generate fails here
    const { rows } = await c.query(
      `INSERT INTO documents (ticket_id, kind, version_number, content_md, author_name, change_note) VALUES ($1,$2,1,$3,'AI generator','Initial draft') RETURNING *`,
      [ticketId, kind, content]);
    await c.query('COMMIT');
    return rows[0];
  } catch (e) {
    await c.query('ROLLBACK');
    if ((e as Error).message?.startsWith('Illegal transition')) throw new DocError('Another draft was just created. Reload.');
    throw e;
  } finally { c.release(); }
}

/** Saves a new immutable revision. `baseVersion` guards against overwriting a colleague's concurrent edit. */
export async function saveVersion(ticketId: string, kind: DocKind, content: string, baseVersion: number, author: string, note?: string) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const t = (await c.query('SELECT current_state FROM tickets WHERE id=$1 FOR UPDATE', [ticketId])).rows[0];
    if (!t) throw new DocError('Ticket not found', 404);
    if (t.current_state !== draftedState(kind)) throw new DocError(`The ${kind} is locked (ticket is in "${t.current_state}")`);
    const latest = (await c.query('SELECT max(version_number) v FROM documents WHERE ticket_id=$1 AND kind=$2', [ticketId, kind])).rows[0].v as number;
    if (latest !== baseVersion) throw new DocError('Someone saved a newer version. Reload to merge your changes.', 409, { latestVersion: latest });
    if (content === (await c.query('SELECT content_md FROM documents WHERE ticket_id=$1 AND kind=$2 AND version_number=$3', [ticketId, kind, latest])).rows[0].content_md)
      throw new DocError('No changes to save', 400);
    const { rows } = await c.query(
      'INSERT INTO documents (ticket_id, kind, version_number, content_md, author_name, change_note) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *',
      [ticketId, kind, latest + 1, content, author, note ?? null]);
    // An edit invalidates any approval requested for the previous text.
    await supersedeOpenRequest(c, ticketId, kind);
    await c.query('COMMIT');
    return rows[0];
  } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
}

export async function diffVersions(ticketId: string, kind: DocKind, from: number, to: number) {
  const { rows } = await pool.query('SELECT version_number, content_md FROM documents WHERE ticket_id=$1 AND kind=$2 AND version_number = ANY($3)', [ticketId, kind, [from, to]]);
  const get = (v: number) => rows.find((r) => r.version_number === v)?.content_md as string | undefined;
  if (get(from) == null || get(to) == null) throw new DocError('Version not found', 404);
  return diffLines(get(from)!, get(to)!);
}

async function findByToken(q: { query: (s: string, p: unknown[]) => Promise<{ rows: any[] }> }, token: string, lock = '') {
  const a = (await q.query(
    `SELECT a.*, t.title, t.current_state FROM approvals a JOIN tickets t ON t.id=a.ticket_id WHERE a.token_hash=$1 AND a.request_id IS NOT NULL ${lock}`, [hash(token)])).rows[0];
  if (!a) throw new DocError('This approval link is not valid', 404);
  return a;
}

const effectiveStatus = (a: { status: string; expires_at: Date }) => (a.status === 'pending' && a.expires_at < new Date() ? 'expired' : a.status);

export async function viewApproval(token: string) {
  const a = await findByToken(pool, token);
  const doc = (await pool.query('SELECT content_md FROM documents WHERE ticket_id=$1 AND kind=$2 AND version_number=$3', [a.ticket_id, a.kind, a.version_number])).rows[0];
  const req = (await pool.query('SELECT workflow_name, levels FROM approval_requests WHERE id=$1', [a.request_id])).rows[0];
  const levels = req.levels as { position: number; name: string }[];
  return {
    ticketTitle: a.title, kind: a.kind as DocKind, version: a.version_number as number, status: effectiveStatus(a), comment: a.comment as string | null, content: doc.content_md as string,
    level: { name: a.level_name as string, position: a.level as number, of: levels.length, workflow: req.workflow_name as string },
  };
}

export async function ticketOverview(id: string) {
  const base = await getTicket(id);
  const names = (await pool.query(
    `SELECT cu.display_name AS customer_name, co.display_name AS consultant_name FROM tickets t
     LEFT JOIN users cu ON cu.id=t.customer_id LEFT JOIN users co ON co.id=t.consultant_id WHERE t.id=$1`, [id])).rows[0];
  const ticket = { ...base, ...names };
  const docs: Record<string, unknown> = {};
  for (const k of ['FS', 'TS'] as const) { const v = await listVersions(id, k); docs[k] = v.length ? { latest: v[0], versions: v.map((x) => ({ version: x.version_number, author: x.author_name, note: x.change_note, at: x.created_at })) } : null; }
  const approvals = (await pool.query(
    `SELECT a.id, a.approver_id, a.kind, a.version_number, a.status, a.comment, a.level, a.level_name, a.requested_at, a.decided_at, u.email AS approver FROM approvals a JOIN users u ON u.id=a.approver_id WHERE a.ticket_id=$1 ORDER BY a.requested_at DESC`, [id])).rows;
  const policy = await projectPolicyForTicket(id);
  // Advisory: terms from stacks this project does not allow, found in the latest drafts.
  const stackWarnings = (['FS', 'TS'] as const).flatMap((k) => {
    const latest = (docs[k] as { latest: { content_md: string } } | null)?.latest.content_md;
    return latest ? assessFit(latest, policy).foreign.map((f) => ({ kind: k, ...f })) : [];
  });
  const stacks = policy?.allowed.map((a) => a.name) ?? [];
  return { ticket, docs, approvals, requests: await requestsForTicket(id), stacks, stackWarnings };
}
