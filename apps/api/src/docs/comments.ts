import { z } from 'zod';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { pool } from '../db.js';
import { need, ticketVisible, type SessionUser } from '../rbac/auth.js';
import { DocError } from '../errors.js';
import { KINDS, LABEL, type DocKind } from './kinds.js';
import type { Mailer } from './mailer.js';
import { effectiveSettings } from './settings.js';

const Kind = z.enum(KINDS);
const Anchor = z.object({ from: z.unknown(), to: z.unknown() }).nullable();
const rowOut = (r: any) => ({
  id: r.id, parentId: r.parent_id, authorId: r.author_id, author: r.author_name, body: r.body, quote: r.quote, anchor: r.anchor, version: r.version_number,
  status: r.status, resolvedBy: r.resolved_by_name ?? null, resolvedAt: r.resolved_at, mentions: r.mentions, createdAt: r.created_at, editedAt: r.edited_at,
});

/** Open and addressed root comments for a document: what is still waiting on someone. */
export const unresolvedCount = async (ticketId: string, kind: DocKind) =>
  (await pool.query(`SELECT count(*)::int n FROM doc_comments WHERE ticket_id=$1 AND kind=$2 AND parent_id IS NULL AND status <> 'resolved'`, [ticketId, kind])).rows[0].n as number;

/** Throws when the project requires comments to be resolved before approval and some are not. */
export async function assertCommentsResolved(projectId: string, ticketId: string, kind: DocKind) {
  if (!(await effectiveSettings(projectId)).blockApprovalOnOpenComments) return;
  const n = await unresolvedCount(ticketId, kind);
  if (n) throw new DocError(`Resolve the ${n} open review comment${n > 1 ? 's' : ''} before requesting approval`, 409);
}

export function registerCommentRoutes(app: FastifyInstance, d: { mailer: Mailer; appUrl: string }) {
  const visible = async (req: FastifyRequest, id: string) => {
    if (!(await ticketVisible(req.user!, id))) throw new DocError('Ticket not found', 404);
  };
  const T = z.object({ id: z.string().uuid(), kind: Kind });

  const notify = async (to: { id: string; email: string }[], subject: string, body: string) => { for (const u of to) await d.mailer.send({ to: u.email, subject, body }); };
  const lines = (b: string) => b.length > 300 ? `${b.slice(0, 300)}…` : b;

  app.get('/api/tickets/:id/documents/:kind/comments', { preHandler: need('spec.view') }, async (req) => {
    const p = T.parse(req.params); await visible(req, p.id);
    const rows = (await pool.query(
      `SELECT c.*, ru.display_name AS resolved_by_name FROM doc_comments c LEFT JOIN users ru ON ru.id = c.resolved_by WHERE c.ticket_id=$1 AND c.kind=$2 ORDER BY c.created_at`, [p.id, p.kind])).rows.map(rowOut);
    const roots = rows.filter((r) => !r.parentId);
    return { threads: roots.map((r) => ({ ...r, replies: rows.filter((x) => x.parentId === r.id) })), unresolved: roots.filter((r) => r.status !== 'resolved').length };
  });

  app.get('/api/tickets/:id/mentionable', { preHandler: need('doc.comment') }, async (req) => {
    const p = z.object({ id: z.string().uuid() }).parse(req.params); await visible(req, p.id);
    return (await pool.query(
      `SELECT u.id, u.display_name AS name FROM project_members m JOIN users u ON u.id=m.user_id WHERE m.project_id=$1 AND u.active ORDER BY u.display_name`, [req.user!.projectId])).rows;
  });

  app.post('/api/tickets/:id/documents/:kind/comments', { preHandler: need('doc.comment') }, async (req, reply) => {
    const p = T.parse(req.params); await visible(req, p.id);
    const b = z.object({ body: z.string().trim().min(1).max(4000), parentId: z.string().uuid().optional(), quote: z.string().max(500).optional(), anchor: Anchor.optional(), mentions: z.array(z.string().uuid()).max(20).optional() }).parse(req.body);
    const u = req.user!;
    let parent: any = null;
    if (b.parentId) {
      parent = (await pool.query('SELECT * FROM doc_comments WHERE id=$1 AND ticket_id=$2 AND kind=$3', [b.parentId, p.id, p.kind])).rows[0];
      if (!parent || parent.parent_id) throw new DocError('Comment not found', 404);
    }
    const latest = (await pool.query('SELECT max(version_number) v FROM documents WHERE ticket_id=$1 AND kind=$2', [p.id, p.kind])).rows[0].v as number | null;
    if (!latest) throw new DocError('There is no document to comment on yet', 404);
    const mentions = b.mentions?.length ? (await pool.query('SELECT user_id FROM project_members WHERE project_id=$1 AND user_id = ANY($2)', [u.projectId, b.mentions])).rows.map((r) => r.user_id as string) : [];
    const row = (await pool.query(
      `INSERT INTO doc_comments (project_id, ticket_id, kind, parent_id, author_id, author_name, body, quote, anchor, version_number, mentions)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [u.projectId, p.id, p.kind, b.parentId ?? null, u.id, u.name, b.body, parent ? null : b.quote ?? null, parent ? null : b.anchor ? JSON.stringify(b.anchor) : null, latest, mentions])).rows[0];
    // A reply re-opens a resolved thread: someone is asking again.
    if (parent && parent.status === 'resolved') await pool.query(`UPDATE doc_comments SET status='open', resolved_by=NULL, resolved_at=NULL WHERE id=$1`, [parent.id]);

    // Notify the assigned consultant, the thread's participants and anyone mentioned (never the author).
    const t = (await pool.query('SELECT title, consultant_id FROM tickets WHERE id=$1', [p.id])).rows[0];
    const who = new Set<string>(mentions);
    if (t.consultant_id) who.add(t.consultant_id);
    if (parent) { who.add(parent.author_id); for (const r of (await pool.query('SELECT author_id FROM doc_comments WHERE parent_id=$1', [parent.id])).rows) who.add(r.author_id); }
    who.delete(u.id);
    const people = who.size ? (await pool.query('SELECT id, email FROM users WHERE id = ANY($1) AND active', [[...who]])).rows : [];
    await notify(people, `${parent ? 'Reply' : 'Comment'} on ${LABEL[p.kind]} – ${t.title}`,
      `${u.name} ${parent ? 'replied' : 'commented'}${mentions.length ? ' (you were mentioned)' : ''}:\n\n${lines(b.body)}\n\nOpen: ${d.appUrl}/tickets/${p.id}`);
    return reply.code(201).send(rowOut(row));
  });

  /** open -> addressed (the editor says they fixed it) -> resolved (the reviewer agrees). Reopening is the reviewer's call. */
  app.patch('/api/doc-comments/:id', { preHandler: need('doc.comment') }, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const b = z.object({ status: z.enum(['open', 'addressed', 'resolved']).optional(), body: z.string().trim().min(1).max(4000).optional() }).refine((x) => x.status || x.body).parse(req.body);
    const c = (await pool.query('SELECT * FROM doc_comments WHERE id=$1', [id])).rows[0];
    if (!c) throw new DocError('Comment not found', 404);
    await visible(req, c.ticket_id);
    const u: SessionUser = req.user!;
    const isAuthor = c.author_id === u.id, canReview = u.perms.has('doc.review');
    if (b.body !== undefined) {
      if (!isAuthor) throw new DocError('Only the author can edit a comment', 403);
      await pool.query('UPDATE doc_comments SET body=$2, edited_at=now() WHERE id=$1', [id, b.body]);
    }
    if (b.status) {
      if (c.parent_id) throw new DocError('Resolve the whole thread, not one reply', 400);
      const allowed = b.status === 'addressed' ? (u.perms.has('spec.edit') || isAuthor) : (canReview || isAuthor);
      if (!allowed) throw new DocError(b.status === 'addressed' ? 'You need edit access to mark a comment as addressed' : 'Only the reviewer can resolve or reopen a comment', 403);
      await pool.query(`UPDATE doc_comments SET status=$2, resolved_by=$3, resolved_at=$4 WHERE id=$1`, [id, b.status, b.status === 'resolved' ? u.id : null, b.status === 'resolved' ? new Date() : null]);
      if (b.status === 'addressed' && !isAuthor) {
        const au = (await pool.query('SELECT id, email FROM users WHERE id=$1 AND active', [c.author_id])).rows;
        await notify(au, `Comment addressed – ${LABEL[c.kind as DocKind]}`, `${u.name} marked your comment as addressed:\n\n${lines(c.body)}\n\nOpen: ${d.appUrl}/tickets/${c.ticket_id}`);
      }
    }
    const row = (await pool.query(`SELECT c.*, ru.display_name AS resolved_by_name FROM doc_comments c LEFT JOIN users ru ON ru.id=c.resolved_by WHERE c.id=$1`, [id])).rows[0];
    return rowOut(row);
  });

  app.get('/api/tickets/:id/documents/:kind/reviews', { preHandler: need('spec.view') }, async (req) => {
    const p = T.parse(req.params); await visible(req, p.id);
    return (await pool.query('SELECT id, reviewer_name AS reviewer, decision, note, version_number AS version, created_at AS "createdAt" FROM doc_reviews WHERE ticket_id=$1 AND kind=$2 ORDER BY created_at DESC', [p.id, p.kind])).rows;
  });

  /** A reviewer's verdict on the current version: it tells the editor whether they are done. */
  app.post('/api/tickets/:id/documents/:kind/reviews', { preHandler: need('doc.review') }, async (req, reply) => {
    const p = T.parse(req.params); await visible(req, p.id);
    const b = z.object({ decision: z.enum(['changes_requested', 'looks_good']), note: z.string().trim().max(2000).optional() }).parse(req.body);
    const u = req.user!;
    const latest = (await pool.query('SELECT max(version_number) v FROM documents WHERE ticket_id=$1 AND kind=$2', [p.id, p.kind])).rows[0].v as number | null;
    if (!latest) throw new DocError('There is no document to review yet', 404);
    if (b.decision === 'looks_good') {
      const n = await unresolvedCount(p.id, p.kind);
      if (n) throw new DocError(`There are still ${n} unresolved comment${n > 1 ? 's' : ''}. Resolve them first.`, 409);
    }
    const row = (await pool.query('INSERT INTO doc_reviews (project_id, ticket_id, kind, reviewer_id, reviewer_name, decision, note, version_number) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id', [u.projectId, p.id, p.kind, u.id, u.name, b.decision, b.note ?? null, latest])).rows[0];
    const t = (await pool.query('SELECT title, consultant_id FROM tickets WHERE id=$1', [p.id])).rows[0];
    if (t.consultant_id && t.consultant_id !== u.id) {
      const to = (await pool.query('SELECT id, email FROM users WHERE id=$1 AND active', [t.consultant_id])).rows;
      await notify(to, `${b.decision === 'looks_good' ? 'Review passed' : 'Changes requested'} – ${LABEL[p.kind]} – ${t.title}`,
        `${u.name} ${b.decision === 'looks_good' ? 'reviewed the document and it looks good' : 'requested changes'} (v${latest}).${b.note ? `\n\n${b.note}` : ''}\n\nOpen: ${d.appUrl}/tickets/${p.id}`);
    }
    return reply.code(201).send({ id: row.id });
  });
}
