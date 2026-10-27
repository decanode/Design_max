import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool } from '../db.js';
import type { Embedder } from '../etl/vectorize.js';
import type { DocGenerator } from './generator.js';
import type { Mailer } from './mailer.js';
import { need, ticketVisible } from '../rbac/auth.js';
import { DocError, decideApproval, decideApprovalAsUser, diffVersions, generateDocument, requestApproval, saveVersion, ticketOverview, viewApproval } from './service.js';

const Id = z.object({ id: z.string().uuid() });
const Kind = z.enum(['FS', 'TS']);

export interface DocDeps { generator: DocGenerator; mailer: Mailer; embedder?: Embedder; appUrl: string }

export function registerDocRoutes(app: FastifyInstance, d: DocDeps) {

  const visible = async (req: import('fastify').FastifyRequest, id: string) => {
    if (!(await ticketVisible(req.user!, id))) throw new DocError('Ticket not found', 404); // 404, not 403: do not reveal it exists
  };

  app.get('/api/tickets/:id', async (req) => {
    const { id } = Id.parse(req.params);
    await visible(req, id);
    const o = await ticketOverview(id);
    return req.user!.perms.has('spec.view') ? o : { ...o, docs: { FS: null, TS: null }, approvals: [] };
  });

  app.post('/api/tickets/:id/documents/generate', { preHandler: need('spec.generate') }, async (req, reply) => {
    const { id } = Id.parse(req.params);
    await visible(req, id);
    const { kind } = z.object({ kind: Kind }).parse(req.body);
    return reply.code(201).send(await generateDocument(id, kind, d.generator, d.embedder));
  });

  app.post('/api/tickets/:id/documents/:kind/versions', { preHandler: need('spec.edit') }, async (req, reply) => {
    const { id, kind } = z.object({ id: z.string().uuid(), kind: Kind }).parse(req.params);
    await visible(req, id);
    const b = z.object({ content: z.string().min(1).max(200_000), baseVersion: z.number().int(), author: z.string().max(80).optional(), note: z.string().max(200).optional() }).parse(req.body);
    return reply.code(201).send(await saveVersion(id, kind, b.content, b.baseVersion, req.user!.name, b.note));
  });

  app.get('/api/tickets/:id/documents/:kind/versions/:v', { preHandler: need('spec.view') }, async (req) => {
    const p = z.object({ id: z.string().uuid(), kind: Kind, v: z.coerce.number().int() }).parse(req.params);
    await visible(req, p.id);
    const r = (await pool.query('SELECT version_number, content_md, author_name, change_note, created_at FROM documents WHERE ticket_id=$1 AND kind=$2 AND version_number=$3', [p.id, p.kind, p.v])).rows[0];
    if (!r) throw new DocError('Version not found', 404);
    return r;
  });

  app.get('/api/tickets/:id/documents/:kind/diff', { preHandler: need('spec.view') }, async (req) => {
    const p = z.object({ id: z.string().uuid(), kind: Kind }).parse(req.params);
    await visible(req, p.id);
    const q = z.object({ from: z.coerce.number().int(), to: z.coerce.number().int() }).parse(req.query);
    return diffVersions(p.id, p.kind, q.from, q.to);
  });

  app.post('/api/tickets/:id/approvals', { preHandler: need('approval.request') }, async (req, reply) => {
    const { id } = Id.parse(req.params);
    await visible(req, id);
    const b = z.object({ kind: Kind, approverEmail: z.string().email() }).parse(req.body);
    return reply.code(201).send(await requestApproval(id, b.kind, b.approverEmail, d.mailer, d.appUrl));
  });

  // Token-holder endpoints (no login yet; the emailed single-use token is the credential).
  app.get('/api/approvals/:token', async (req) => viewApproval(z.object({ token: z.string().min(20) }).parse(req.params).token));
  app.post('/api/approvals/:token/decision', async (req) => {
    const { token } = z.object({ token: z.string().min(20) }).parse(req.params);
    const b = z.object({ decision: z.enum(['approved', 'rejected']), comment: z.string().max(2000).optional() }).parse(req.body);
    return decideApproval(token, b.decision, b.comment);
  });

  app.post('/api/my/approvals/:id/decision', { preHandler: need('approval.decide') }, async (req) => {
    const { id } = Id.parse(req.params);
    const b = z.object({ decision: z.enum(['approved', 'rejected']), comment: z.string().max(2000).optional() }).parse(req.body);
    return decideApprovalAsUser(id, req.user!.id, b.decision, b.comment);
  });

  if (process.env.NODE_ENV !== 'production')
    app.get('/api/dev/outbox', { preHandler: need('mailbox.view') }, async () => (await pool.query('SELECT * FROM email_outbox ORDER BY id DESC LIMIT 100')).rows);
}
