import { createHash } from 'node:crypto';
import { pool } from '../db.js';
import { applyTransition } from '../tickets.js';
import type { TicketState } from '../stateMachine.js';
import { KINDS, RULES, LABEL, generateHint, type DocKind as Kind } from './kinds.js';
import { toStored, versionPm, versionText } from './content.js';
import type { PmNode } from '../docgen/pm.js';
import { similar, type Embedder } from '../etl/vectorize.js';
import type { DocContext, DocGenerator, DocKind } from './generator.js';
import { diffLines } from './diff.js';
import { supersedeOpenRequest, requestsForTicket } from '../approvals/engine.js';
import { assessFit, loadStackPolicy, projectPolicyForTicket } from '../stacks.js';

import { DocError } from '../errors.js';
import { sanitizeTicket, type FieldAccess } from '../tickets/fields.js';
export { DocError };

/** True once an approval for this document has completed (TUT and CRC are then locked: the approved text is final). */
async function isApproved(q: { query: (s: string, p: unknown[]) => Promise<{ rowCount: number | null }> }, ticketId: string, kind: Kind) {
  return !!(await q.query(`SELECT 1 FROM approval_requests WHERE ticket_id=$1 AND kind=$2 AND status='approved'`, [ticketId, kind])).rowCount;
}
const hash = (t: string) => createHash('sha256').update(t).digest('hex');

export async function getTicket(id: string) {
  const t = (await pool.query('SELECT * FROM tickets WHERE id=$1', [id])).rows[0];
  if (!t) throw new DocError('Ticket not found', 404);
  return t;
}

export async function listVersions(ticketId: string, kind: DocKind) {
  const rows = (await pool.query(
    'SELECT version_number, content_json, content_md, content_text, author_name, change_note, created_at FROM documents WHERE ticket_id=$1 AND kind=$2 ORDER BY version_number DESC', [ticketId, kind])).rows;
  return rows.map((r) => ({ ...r, content_md: versionText(r) }));   // text rendering for clients that predate structured content
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
  if (kind !== 'FS') {
    const fs = (await listVersions(ticketId, 'FS'))[0];
    ctx.fs = fs && versionText(fs);
    if (kind !== 'TS') { const ts = (await listVersions(ticketId, 'TS'))[0]; ctx.ts = ts && versionText(ts); }
  }
  if (kind === 'TS') {
    // Only meaningful with a real embedding model; the offline stand-in would return noise.
    if (embedder?.semantic) {
      const hits = await similar(pool, embedder, `${t.title}\n${ctx.summary}`, 5, policy?.allowed.map((a) => a.name), t.project_id);   // this project's knowledge + shared platform knowledge only
      ctx.knowledge = hits.map((h) => `[${h.source_type}] ${h.source_ref}: ${String(h.content).slice(0, 600)}`);
    }
  }
  return ctx;
}

/** Creates v1 of a document, and for FS and TS advances the ticket. TUT and CRC need the approved FS and TS. */
export async function generateDocument(ticketId: string, kind: DocKind, gen: DocGenerator, embedder?: Embedder) {
  const t = await getTicket(ticketId);
  const rule = RULES[kind];
  if (!rule.generateIn.includes(t.current_state)) throw new DocError(`The ${kind} can only be generated ${generateHint(kind)} (ticket is in "${t.current_state}")`);
  if ((await listVersions(ticketId, kind)).length) throw new DocError(`A ${LABEL[kind]} already exists for this ticket. Edit it instead.`);
  const content = await gen.generate(kind, await buildContext(ticketId, kind, embedder));

  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    if (rule.onGenerate) await applyTransition(c, ticketId, rule.onGenerate); // re-checks state under lock: a concurrent generate fails here
    else await c.query('SELECT 1 FROM tickets WHERE id=$1 FOR UPDATE', [ticketId]);
    const st = toStored(content);
    const { rows } = await c.query(
      `INSERT INTO documents (ticket_id, kind, version_number, content_json, content_text, author_name, change_note) VALUES ($1,$2,1,$3,$4,'AI generator','Initial draft') RETURNING *`,
      [ticketId, kind, JSON.stringify(st.json), st.text]);
    await c.query('COMMIT');
    return rows[0];
  } catch (e) {
    await c.query('ROLLBACK');
    if ((e as Error).message?.startsWith('Illegal transition')) throw new DocError('Another draft was just created. Reload.');
    if ((e as { code?: string }).code === '23505') throw new DocError('Another draft was just created. Reload.');
    throw e;
  } finally { c.release(); }
}

/** Saves a new immutable revision. `baseVersion` guards against overwriting a colleague's concurrent edit. */
export async function saveVersion(ticketId: string, kind: DocKind, content: string | PmNode, baseVersion: number, author: string, note?: string) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const t = (await c.query('SELECT current_state FROM tickets WHERE id=$1 FOR UPDATE', [ticketId])).rows[0];
    if (!t) throw new DocError('Ticket not found', 404);
    if (!RULES[kind].editIn.includes(t.current_state)) throw new DocError(`The ${kind} is locked (ticket is in "${t.current_state}")`);
    if (RULES[kind].lockedWhenApproved && await isApproved(c, ticketId, kind)) throw new DocError(`The ${kind} is approved and locked`);
    const latest = (await c.query('SELECT max(version_number) v FROM documents WHERE ticket_id=$1 AND kind=$2', [ticketId, kind])).rows[0].v as number;
    if (latest !== baseVersion) throw new DocError('Someone saved a newer version. Reload to merge your changes.', 409, { latestVersion: latest });
    const st = toStored(content);
    if (st.text === versionText((await c.query('SELECT content_json, content_md, content_text FROM documents WHERE ticket_id=$1 AND kind=$2 AND version_number=$3', [ticketId, kind, latest])).rows[0]))
      throw new DocError('No changes to save', 400);
    const { rows } = await c.query(
      'INSERT INTO documents (ticket_id, kind, version_number, content_json, content_text, author_name, change_note) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *',
      [ticketId, kind, latest + 1, JSON.stringify(st.json), st.text, author, note ?? null]);
    // An edit invalidates any approval requested for the previous text.
    await supersedeOpenRequest(c, ticketId, kind);
    await c.query('COMMIT');
    return rows[0];
  } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
}

export async function diffVersions(ticketId: string, kind: DocKind, from: number, to: number) {
  const { rows } = await pool.query('SELECT version_number, content_json, content_md, content_text FROM documents WHERE ticket_id=$1 AND kind=$2 AND version_number = ANY($3)', [ticketId, kind, [from, to]]);
  const get = (v: number) => { const r = rows.find((x) => x.version_number === v); return r ? versionText(r) : undefined; };
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
  const doc = (await pool.query('SELECT content_json, content_md, content_text FROM documents WHERE ticket_id=$1 AND kind=$2 AND version_number=$3', [a.ticket_id, a.kind, a.version_number])).rows[0];
  const req = (await pool.query('SELECT workflow_name, levels FROM approval_requests WHERE id=$1', [a.request_id])).rows[0];
  const levels = req.levels as { position: number; name: string }[];
  return {
    ticketTitle: a.title, kind: a.kind as DocKind, version: a.version_number as number, status: effectiveStatus(a), comment: a.comment as string | null, content: versionText(doc), contentJson: versionPm(doc),
    level: { name: a.level_name as string, position: a.level as number, of: levels.length, workflow: req.workflow_name as string },
  };
}

export async function ticketOverview(id: string, fields: FieldAccess) {
  const base = await getTicket(id);
  const names = (await pool.query(
    `SELECT cu.display_name AS customer_name, co.display_name AS consultant_name, p.name AS project_name, (t.consultant_id IS NOT NULL) AS is_assigned FROM tickets t
     JOIN projects p ON p.id=t.project_id LEFT JOIN users cu ON cu.id=t.customer_id LEFT JOIN users co ON co.id=t.consultant_id WHERE t.id=$1`, [id])).rows[0];
  const ticket = sanitizeTicket({ ...base, ...names }, fields);     // column-level security
  const docs: Record<string, unknown> = {};
  for (const k of KINDS) { const v = await listVersions(id, k); docs[k] = v.length ? { latest: v[0], versions: v.map((x) => ({ version: x.version_number, author: x.author_name, note: x.change_note, at: x.created_at })) } : null; }
  const approvals = (await pool.query(
    `SELECT a.id, a.approver_id, a.kind, a.version_number, a.status, a.comment, a.level, a.level_name, a.requested_at, a.decided_at, u.email AS approver FROM approvals a JOIN users u ON u.id=a.approver_id WHERE a.ticket_id=$1 ORDER BY a.requested_at DESC`, [id])).rows;
  const policy = await projectPolicyForTicket(id);
  // Advisory: terms from stacks this project does not allow, found in the latest drafts.
  const stackWarnings = KINDS.flatMap((k) => {
    const l = (docs[k] as { latest: { content_json: PmNode | null; content_md: string | null; content_text: string | null } } | null)?.latest;
    const latest = l && versionText(l);
    return latest ? assessFit(latest, policy).foreign.map((f) => ({ kind: k, ...f })) : [];
  });
  const stacks = policy?.allowed.map((a) => a.name) ?? [];
  return { ticket, docs, approvals, requests: await requestsForTicket(id), stacks, stackWarnings, fields };
}
