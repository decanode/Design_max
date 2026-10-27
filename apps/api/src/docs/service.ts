import { createHash, randomBytes } from 'node:crypto';
import { pool } from '../db.js';
import { applyTransition } from '../tickets.js';
import type { TicketState } from '../stateMachine.js';
import { similar, type Embedder } from '../etl/vectorize.js';
import type { DocContext, DocGenerator, DocKind } from './generator.js';
import type { Mailer } from './mailer.js';
import { diffLines } from './diff.js';

/** `status` carries the HTTP code the route should answer with. */
export class DocError extends Error {
  constructor(message: string, public status = 409, public extra?: Record<string, unknown>) { super(message); }
}

const draftedState = (k: DocKind) => `${k} Drafted` as TicketState;
const approvedState = (k: DocKind) => `${k} Approved` as TicketState;
const hash = (t: string) => createHash('sha256').update(t).digest('hex');
const APPROVAL_TTL_DAYS = 7;

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
  const ctx: DocContext = { title: t.title, summary: t.ai_summary ?? t.title, transcript, entities: conv?.entities };
  if (kind === 'TS') {
    ctx.fs = (await listVersions(ticketId, 'FS'))[0]?.content_md;
    // Only meaningful with a real embedding model; the offline stand-in would return noise.
    if (embedder?.semantic) {
      const hits = await similar(pool, embedder, `${t.title}\n${ctx.summary}`, 5);
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
    await c.query(`UPDATE approvals SET status='superseded' WHERE ticket_id=$1 AND kind=$2 AND status='pending'`, [ticketId, kind]);
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

/** Emails the approver a single-use deep link tied to the current version. */
export async function requestApproval(ticketId: string, kind: DocKind, approverEmail: string, mailer: Mailer, appUrl: string) {
  const token = randomBytes(32).toString('base64url');
  const c = await pool.connect();
  let title: string, version: number;
  try {
    await c.query('BEGIN');
    const t = (await c.query('SELECT title, current_state FROM tickets WHERE id=$1 FOR UPDATE', [ticketId])).rows[0];
    if (!t) throw new DocError('Ticket not found', 404);
    if (t.current_state !== draftedState(kind)) throw new DocError(`Approval for the ${kind} can only be requested while the ticket is in "${draftedState(kind)}"`);
    title = t.title;
    version = (await c.query('SELECT max(version_number) v FROM documents WHERE ticket_id=$1 AND kind=$2', [ticketId, kind])).rows[0].v;
    const email = approverEmail.trim().toLowerCase();
    const approver = (await c.query(
      `INSERT INTO users (email, display_name, role_id) VALUES ($1,$1,(SELECT id FROM roles WHERE name='Approver'))
       ON CONFLICT (email) DO UPDATE SET email=EXCLUDED.email RETURNING id`, [email])).rows[0].id;
    try {
      await c.query(
        `INSERT INTO approvals (ticket_id, approver_id, kind, version_number, token_hash, expires_at) VALUES ($1,$2,$3,$4,$5, now() + ($6 || ' days')::interval)`,
        [ticketId, approver, kind, version, hash(token), String(APPROVAL_TTL_DAYS)]);
    } catch (e) {
      if ((e as { code?: string }).code === '23505') throw new DocError('An approval is already pending for this document');
      throw e;
    }
    await c.query('COMMIT');
  } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }

  await mailer.send({
    to: approverEmail.trim().toLowerCase(),
    subject: `Approval needed: ${kind === 'FS' ? 'Functional' : 'Technical'} Specification – ${title}`,
    body: `Please review and approve or reject (version ${version}):\n\n${appUrl}/approve/${token}\n\nThis link is single-use and expires in ${APPROVAL_TTL_DAYS} days.`,
  });
  return { version };
}

async function findByToken(q: { query: (s: string, p: unknown[]) => Promise<{ rows: any[] }> }, token: string, lock = '') {
  const a = (await q.query(
    `SELECT a.*, t.title, t.current_state FROM approvals a JOIN tickets t ON t.id=a.ticket_id WHERE a.token_hash=$1 ${lock}`, [hash(token)])).rows[0];
  if (!a) throw new DocError('This approval link is not valid', 404);
  return a;
}

const effectiveStatus = (a: { status: string; expires_at: Date }) => (a.status === 'pending' && a.expires_at < new Date() ? 'expired' : a.status);

export async function viewApproval(token: string) {
  const a = await findByToken(pool, token);
  const doc = (await pool.query('SELECT content_md FROM documents WHERE ticket_id=$1 AND kind=$2 AND version_number=$3', [a.ticket_id, a.kind, a.version_number])).rows[0];
  return { ticketTitle: a.title, kind: a.kind as DocKind, version: a.version_number as number, status: effectiveStatus(a), comment: a.comment as string | null, content: doc.content_md as string };
}

export async function decideApproval(token: string, decision: 'approved' | 'rejected', comment?: string) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const a = await findByToken(c, token, 'FOR UPDATE OF a');
    const st = effectiveStatus(a);
    if (st !== 'pending') throw new DocError(`This approval is already ${st}`, st === 'expired' || st === 'superseded' ? 410 : 409);
    if (decision === 'rejected' && !comment?.trim()) throw new DocError('Please say why you are rejecting', 400);
    await c.query(`UPDATE approvals SET status=$2, comment=$3, decided_at=now() WHERE id=$1`, [a.id, decision, comment?.trim() || null]);
    if (decision === 'approved') await applyTransition(c, a.ticket_id, approvedState(a.kind), a.approver_id);
    await c.query('COMMIT');
    return { status: decision };
  } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
}

export async function ticketOverview(id: string) {
  const ticket = await getTicket(id);
  const docs: Record<string, unknown> = {};
  for (const k of ['FS', 'TS'] as const) { const v = await listVersions(id, k); docs[k] = v.length ? { latest: v[0], versions: v.map((x) => ({ version: x.version_number, author: x.author_name, note: x.change_note, at: x.created_at })) } : null; }
  const approvals = (await pool.query(
    `SELECT a.kind, a.version_number, a.status, a.comment, a.requested_at, a.decided_at, u.email AS approver FROM approvals a JOIN users u ON u.id=a.approver_id WHERE a.ticket_id=$1 ORDER BY a.requested_at DESC`, [id])).rows;
  return { ticket, docs, approvals };
}
