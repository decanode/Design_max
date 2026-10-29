import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool } from '../db.js';
import type { Embedder } from '../etl/vectorize.js';
import type { DocGenerator } from './generator.js';
import type { Mailer } from './mailer.js';
import { need, needSuper, ticketVisible } from '../rbac/auth.js';
import { DocError, diffVersions, draftLock, draftStatus, generateDocument, saveVersion, snapshotDraft, syncDraft, ticketOverview, viewApproval } from './service.js';
import { signCollab } from '../collab/token.js';
import { docName } from '../collab/token.js';
import { KINDS } from './kinds.js';
import { assertCommentsResolved, registerCommentRoutes } from './comments.js';
import { registerUploadRoutes } from './upload.js';
import { versionPm, versionText } from './content.js';
import { exportDocument } from '../docgen/exportDocument.js';
import { approvalPlan, cancelRequest, decideAsUser, decideByToken, requestApproval, resubmitTicketApproval } from '../approvals/engine.js';

const Id = z.object({ id: z.string().uuid() });
const Kind = z.enum(KINDS);

export interface DocDeps { generator: DocGenerator; mailer: Mailer; embedder?: Embedder; appUrl: string }

export function registerDocRoutes(app: FastifyInstance, d: DocDeps) {
  registerCommentRoutes(app, d);
  registerUploadRoutes(app);

  const visible = async (req: import('fastify').FastifyRequest, id: string) => {
    if (!(await ticketVisible(req.user!, id))) throw new DocError('Ticket not found', 404); // 404, not 403: do not reveal it exists
  };

  app.get('/api/tickets/:id', async (req) => {
    const { id } = Id.parse(req.params);
    await visible(req, id);
    const o = await ticketOverview(id, req.user!.fields);
    return req.user!.perms.has('spec.view') ? o : { ...o, docs: Object.fromEntries(KINDS.map((k) => [k, null])), approvals: [] };
  });

  app.post('/api/tickets/:id/documents/generate', { preHandler: need('spec.generate') }, async (req, reply) => {
    const { id } = Id.parse(req.params);
    await visible(req, id);
    const { kind } = z.object({ kind: Kind }).parse(req.body);
    const row = await generateDocument(id, kind, d.generator, d.embedder);
    return reply.code(201).send({ ...row, content_md: versionText(row) });
  });

  app.post('/api/tickets/:id/documents/:kind/versions', { preHandler: need('spec.edit') }, async (req, reply) => {
    const { id, kind } = z.object({ id: z.string().uuid(), kind: Kind }).parse(req.params);
    await visible(req, id);
    const b = z.object({ content: z.string().min(1).max(200_000), baseVersion: z.number().int(), author: z.string().max(80).optional(), note: z.string().max(200).optional() }).parse(req.body);
    const row = await saveVersion(id, kind, b.content, b.baseVersion, req.user!.name, b.note);
    await syncDraft(req.user!.projectId!, id, kind, row);
    return reply.code(201).send({ ...row, content_md: versionText(row) });
  });

  /** A short-lived pass to join the live editing room for this document (read-only unless the person may edit it right now). */
  app.post('/api/tickets/:id/documents/:kind/collab-token', { preHandler: need('spec.view') }, async (req) => {
    const p = z.object({ id: z.string().uuid(), kind: Kind }).parse(req.params);
    await visible(req, p.id);
    const lock = await draftLock(p.id, p.kind);
    const edit = req.user!.perms.has('spec.edit') && !lock;
    const u = req.user!, pid = u.projectId!;
    return { token: signCollab({ uid: u.id, name: u.name, pid, ticket: p.id, kind: p.kind, edit }), room: docName(pid, p.id, p.kind), canEdit: edit, lock };
  });

  /** Whether the shared draft has unsaved changes compared with the latest version. */
  app.get('/api/tickets/:id/documents/:kind/draft-status', { preHandler: need('spec.view') }, async (req) => {
    const p = z.object({ id: z.string().uuid(), kind: Kind }).parse(req.params);
    await visible(req, p.id);
    return { ...(await draftStatus(req.user!.projectId!, p.id, p.kind)), lock: await draftLock(p.id, p.kind) };
  });

  /** "Save version": the shared draft becomes a new immutable version. */
  app.post('/api/tickets/:id/documents/:kind/snapshot', { preHandler: need('spec.edit') }, async (req, reply) => {
    const p = z.object({ id: z.string().uuid(), kind: Kind }).parse(req.params);
    const b = z.object({ note: z.string().max(200).optional() }).parse(req.body ?? {});
    await visible(req, p.id);
    const lock = await draftLock(p.id, p.kind);
    if (lock) throw new DocError(lock, 409);
    const row = await snapshotDraft(req.user!.projectId!, p.id, p.kind, req.user!.name, b.note);
    return reply.code(row ? 201 : 200).send(row ? { version: row.version_number } : { unchanged: true });
  });

  app.get('/api/tickets/:id/documents/:kind/versions/:v', { preHandler: need('spec.view') }, async (req) => {
    const p = z.object({ id: z.string().uuid(), kind: Kind, v: z.coerce.number().int() }).parse(req.params);
    await visible(req, p.id);
    const r = (await pool.query('SELECT version_number, content_json, content_md, content_text, author_name, change_note, created_at FROM documents WHERE ticket_id=$1 AND kind=$2 AND version_number=$3', [p.id, p.kind, p.v])).rows[0];
    if (!r) throw new DocError('Version not found', 404);
    return { ...r, content_md: versionText(r), content_json: versionPm(r) };
  });

  /** Download one version (default: the latest) as a Word file in the project's document design. */
  app.get('/api/tickets/:id/documents/:kind/export', { preHandler: need('spec.view') }, async (req, reply) => {
    const p = z.object({ id: z.string().uuid(), kind: Kind }).parse(req.params);
    const q = z.object({ version: z.coerce.number().int().positive().optional() }).parse(req.query);
    await visible(req, p.id);
    const r = await exportDocument(req.user!, p.id, p.kind, q.version);
    return reply
      .header('content-type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')
      .header('content-disposition', `attachment; filename="${r.filename}"`)
      .header('cache-control', 'no-store')
      .send(r.buffer);
  });

  app.get('/api/tickets/:id/documents/:kind/diff', { preHandler: need('spec.view') }, async (req) => {
    const p = z.object({ id: z.string().uuid(), kind: Kind }).parse(req.params);
    await visible(req, p.id);
    const q = z.object({ from: z.coerce.number().int(), to: z.coerce.number().int() }).parse(req.query);
    return diffVersions(p.id, p.kind, q.from, q.to);
  });

  /** Who would be asked, in what order, under the workflow that covers this document. */
  app.get('/api/tickets/:id/approval-plan', { preHandler: need('approval.request') }, async (req) => {
    const { id } = Id.parse(req.params);
    const { kind } = z.object({ kind: z.union([Kind, z.literal('TICKET')]) }).parse(req.query);
    await visible(req, id);
    return approvalPlan(id, kind, req.user!.id);
  });

  app.post('/api/tickets/:id/approvals', { preHandler: need('approval.request') }, async (req, reply) => {
    const { id } = Id.parse(req.params);
    const { kind } = z.object({ kind: Kind }).parse(req.body);
    await visible(req, id);
    await assertCommentsResolved(req.user!.projectId!, id, kind);
    if (!(await draftLock(id, kind))) await snapshotDraft(req.user!.projectId!, id, kind, req.user!.name, 'Snapshot for approval');   // approvers review exactly this text
    return reply.code(201).send(await requestApproval(id, kind, req.user!, d.mailer, d.appUrl));
  });

  /** A ticket that was refused its creation approval is sent again: by whoever raised it, or someone who manages approvals. */
  app.post('/api/tickets/:id/approvals/resubmit', async (req) => {
    const { id } = Id.parse(req.params);
    await visible(req, id);
    const u = req.user!;
    const t = (await pool.query('SELECT customer_id, consultant_id FROM tickets WHERE id=$1', [id])).rows[0];
    const mine = t && (t.customer_id === u.id || t.consultant_id === u.id);
    if (!mine && !u.perms.has('admin.workflows') && !u.perms.has('approval.request')) throw new DocError('Only the person who raised this ticket, or an approvals admin, can send it again', 403);
    return resubmitTicketApproval(id, u.id, d.mailer, d.appUrl);
  });

  app.post('/api/tickets/:id/approvals/cancel', { preHandler: need('approval.request') }, async (req) => {
    const { id } = Id.parse(req.params);
    const { kind } = z.object({ kind: z.union([Kind, z.literal('TICKET')]) }).parse(req.body);
    await visible(req, id);
    await cancelRequest(id, kind, req.user!);
    return { ok: true };
  });

  // Token-holder endpoints (no login yet; the emailed single-use token is the credential).
  app.get('/api/approvals/:token', async (req) => viewApproval(z.object({ token: z.string().min(20) }).parse(req.params).token));
  app.post('/api/approvals/:token/decision', async (req) => {
    const { token } = z.object({ token: z.string().min(20) }).parse(req.params);
    const b = z.object({ decision: z.enum(['approved', 'rejected']), comment: z.string().max(2000).optional() }).parse(req.body);
    return decideByToken(token, b.decision, b.comment, d.mailer, d.appUrl);
  });

  app.post('/api/my/approvals/:id/decision', async (req) => {
    const { id } = Id.parse(req.params);
    const b = z.object({ decision: z.enum(['approved', 'rejected']), comment: z.string().max(2000).optional() }).parse(req.body);
    return decideAsUser(id, req.user!.id, req.user!.projectId, b.decision, b.comment, d.mailer, d.appUrl);
  });

  if (process.env.NODE_ENV !== 'production')
    app.get('/api/dev/outbox', { preHandler: needSuper() }, async () => (await pool.query('SELECT * FROM email_outbox ORDER BY id DESC LIMIT 100')).rows);
}
