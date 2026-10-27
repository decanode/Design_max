import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool } from '../db.js';
import type { Embedder } from '../etl/vectorize.js';
import type { DocGenerator } from './generator.js';
import type { Mailer } from './mailer.js';
import { need, needSuper, ticketVisible } from '../rbac/auth.js';
import { DocError, diffVersions, generateDocument, saveVersion, ticketOverview, viewApproval } from './service.js';
import { KINDS } from './kinds.js';
import { versionPm, versionText } from './content.js';
import { exportDocument } from '../docgen/exportDocument.js';
import { approvalPlan, cancelRequest, decideAsUser, decideByToken, requestApproval } from '../approvals/engine.js';

const Id = z.object({ id: z.string().uuid() });
const Kind = z.enum(KINDS);

export interface DocDeps { generator: DocGenerator; mailer: Mailer; embedder?: Embedder; appUrl: string }

export function registerDocRoutes(app: FastifyInstance, d: DocDeps) {

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
    return reply.code(201).send({ ...row, content_md: versionText(row) });
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
    const { kind } = z.object({ kind: Kind }).parse(req.query);
    await visible(req, id);
    return approvalPlan(id, kind, req.user!.id);
  });

  app.post('/api/tickets/:id/approvals', { preHandler: need('approval.request') }, async (req, reply) => {
    const { id } = Id.parse(req.params);
    const { kind } = z.object({ kind: Kind }).parse(req.body);
    await visible(req, id);
    return reply.code(201).send(await requestApproval(id, kind, req.user!, d.mailer, d.appUrl));
  });

  app.post('/api/tickets/:id/approvals/cancel', { preHandler: need('approval.request') }, async (req) => {
    const { id } = Id.parse(req.params);
    const { kind } = z.object({ kind: Kind }).parse(req.body);
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
