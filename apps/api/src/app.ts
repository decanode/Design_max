import Fastify from 'fastify';
import cors from '@fastify/cors';
import { z } from 'zod';
import { pool } from './db.js';
import { STATES } from './stateMachine.js';
import { createConversation, getConversationProject, getDraft, getMessages, canAccessConversation, listConversations } from './chat/service.js';
import { registerDocRoutes, type DocDeps } from './docs/routes.js';
import { DocError } from './docs/service.js';
import { isDatabaseDown } from './errors.js';
import { LlmGenerator, TemplateGenerator } from './docs/generator.js';
import { OutboxMailer } from './docs/mailer.js';
import { defaultLlm } from './chat/observer.js';
import { defaultEmbedder } from './etl/vectorize.js';
import { createTicket, transitionTicket, TransitionError } from './tickets.js';
import { need, needAny, registerAuth, ticketScope } from './rbac/auth.js';
import { registerAuthRoutes } from './rbac/authRoutes.js';
import { registerAdminRoutes, AdminError } from './rbac/adminRoutes.js';
import { registerDashboardRoutes } from './rbac/dashboardRoutes.js';
import { registerReportRoutes } from './reports/routes.js';
import { registerWorkflowRoutes } from './approvals/adminRoutes.js';
import { registerFieldAdminRoutes } from './tickets/fieldRoutes.js';
import { canWrite, sanitizeTicket } from './tickets/fields.js';
import { ticketVisible } from './rbac/auth.js';

export function buildApp(deps: Partial<DocDeps> = {}) {
  const app = Fastify();
  app.register(cors, { origin: true, credentials: true });
  registerAuth(app);
  registerAuthRoutes(app);

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof DocError) return reply.code(err.status).send({ error: err.message, ...err.extra });
    if (err instanceof AdminError) return reply.code(err.status).send({ error: err.message });
    if (err instanceof z.ZodError) return reply.code(400).send({ error: 'Invalid request', details: err.issues });
    if (isDatabaseDown(err)) return reply.code(503).send({ error: 'The database is unavailable', code: 'DATABASE_DOWN' });
    app.log.error(err);
    return reply.code(500).send({ error: 'Something went wrong' });
  });

  app.get('/health', async () => ({ ok: true }));
  app.get('/health/db', async (_req, reply) => { await pool.query('SELECT 1'); return reply.send({ ok: true }); });   // 503 via the error handler when the database is down
  app.get('/api/states', async () => STATES);

  app.get('/api/projects', { preHandler: needAny('ticket.create', 'chat.as_customer', 'chat.as_consultant') }, async () => (await pool.query(
    `SELECT p.id, p.name, COALESCE((SELECT array_agg(s.name ORDER BY s.name) FROM project_stacks ps JOIN tech_stacks s ON s.id = ps.stack_id WHERE ps.project_id = p.id), '{}') AS stacks
     FROM projects p ORDER BY p.created_at`)).rows);
  app.post('/api/projects', { preHandler: need('ticket.create') }, async (req, reply) => {
    const b = z.object({ name: z.string().min(1) }).parse(req.body);
    const { rows } = await pool.query('INSERT INTO projects (name) VALUES ($1) RETURNING *', [b.name]);
    return reply.code(201).send(rows[0]);
  });

  app.get('/api/tickets', { preHandler: need('board.view') }, async (req) => {
    const s = ticketScope(req.user!, 1);
    const rows = (await pool.query(
      `SELECT t.id, t.title, t.current_state, t.ai_summary, t.legacy_id, t.legacy_source, t.created_at, t.updated_at, t.consultant_id,
              c.display_name AS consultant, (t.consultant_id IS NOT NULL) AS is_assigned,
              EXISTS (SELECT 1 FROM approvals a WHERE a.ticket_id = t.id AND a.status = 'pending') AS awaiting_approval
       FROM tickets t LEFT JOIN users c ON c.id = t.consultant_id
       WHERE ${s.sql} ORDER BY t.updated_at DESC LIMIT 500`, s.params)).rows;
    return rows.map((r) => sanitizeTicket(r, req.user!.fields));      // column-level security: hidden fields never leave the server
  });
  app.post('/api/tickets', { preHandler: need('ticket.create') }, async (req, reply) => {
    const b = z.object({ projectId: z.string().uuid(), title: z.string().min(1), aiSummary: z.string().optional() }).parse(req.body);
    return reply.code(201).send(sanitizeTicket(await createTicket(b.projectId, b.title, b.aiSummary), req.user!.fields));
  });
  app.post('/api/tickets/:id/transition', { preHandler: need('ticket.advance') }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const b = z.object({ to: z.enum(STATES) }).parse(req.body);
    try { return sanitizeTicket(await transitionTicket(id, b.to, req.user!.id), req.user!.fields); }
    catch (e) {
      if (e instanceof TransitionError) return reply.code(409).send({ error: e.message });
      throw e;
    }
  });

  /** Edit ticket details. Each field is checked against the viewer's column access; a field they can't edit refuses the whole request. */
  const EDITABLE: Record<string, { field: string; column: string }> = {
    title: { field: 'title', column: 'title' }, aiSummary: { field: 'ai_summary', column: 'ai_summary' },
    resolutionNotes: { field: 'resolution_notes', column: 'resolution_notes' }, acceptanceCriteria: { field: 'acceptance_criteria', column: 'acceptance_criteria' },
  };
  app.patch('/api/tickets/:id', async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const b = z.object({
      title: z.string().trim().min(1).max(200).optional(), aiSummary: z.string().max(20000).nullable().optional(),
      resolutionNotes: z.string().max(20000).nullable().optional(), acceptanceCriteria: z.string().max(20000).nullable().optional(),
    }).strict().parse(req.body);
    const keys = Object.keys(b) as (keyof typeof b)[];
    if (!keys.length) return reply.code(400).send({ error: 'Nothing to change' });
    if (!(await ticketVisible(req.user!, id))) return reply.code(404).send({ error: 'Ticket not found' });
    const denied = keys.filter((k) => !canWrite(req.user!.fields, EDITABLE[k].field));
    if (denied.length) return reply.code(403).send({ error: `Your role cannot edit: ${denied.map((k) => EDITABLE[k].field.replace('_', ' ')).join(', ')}`, denied: denied.map((k) => EDITABLE[k].field) });
    const sets = keys.map((k, i) => `${EDITABLE[k].column} = $${i + 2}`);
    const row = (await pool.query(`UPDATE tickets SET ${sets.join(', ')} WHERE id = $1 RETURNING *`, [id, ...keys.map((k) => b[k] === '' ? null : b[k])])).rows[0];
    // The log records WHICH fields changed, never their (possibly sensitive) values.
    await pool.query('INSERT INTO audit_log (actor_id, action, detail) VALUES ($1,$2,$3)', [req.user!.id, 'ticket.update', JSON.stringify({ ticketId: id, fields: keys.map((k) => EDITABLE[k].field) })]);
    return sanitizeTicket(row, req.user!.fields);
  });

  /** A consultant takes an unassigned ticket. */
  app.post('/api/tickets/:id/claim', { preHandler: need('ticket.claim') }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    if (!canWrite(req.user!.fields, 'consultant')) return reply.code(403).send({ error: 'Your role cannot change the assigned consultant' });
    const r = await pool.query('UPDATE tickets SET consultant_id=$2 WHERE id=$1 AND (consultant_id IS NULL OR consultant_id=$2) RETURNING id', [id, req.user!.id]);
    if (!r.rowCount) return reply.code(409).send({ error: 'Already assigned to someone else, or not found' });
    return { ok: true };
  });

  app.get('/api/users/assignable', { preHandler: need('ticket.assign') }, async () =>
    (await pool.query(
      `SELECT u.id, u.display_name AS name, r.name AS role FROM users u JOIN roles r ON r.id=u.role_id
       WHERE u.active AND (r.name='Admin' OR EXISTS (SELECT 1 FROM role_permissions p WHERE p.role_id=r.id AND p.permission='ticket.claim')) ORDER BY u.display_name`)).rows);

  app.post('/api/tickets/:id/assign', { preHandler: need('ticket.assign') }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const { consultantId } = z.object({ consultantId: z.string().uuid().nullable() }).parse(req.body);
    if (!canWrite(req.user!.fields, 'consultant')) return reply.code(403).send({ error: 'Your role cannot change the assigned consultant' });
    if (consultantId && !(await pool.query('SELECT 1 FROM users WHERE id=$1 AND active', [consultantId])).rowCount) return reply.code(404).send({ error: 'No such user' });
    const r = await pool.query('UPDATE tickets SET consultant_id=$2 WHERE id=$1 RETURNING id', [id, consultantId]);
    return r.rowCount ? { ok: true } : reply.code(404).send({ error: 'Ticket not found' });
  });

  app.get('/api/conversations', { preHandler: needAny('chat.as_customer', 'chat.as_consultant', 'chat.view_all') }, async (req) => listConversations(req.user!));
  app.post('/api/conversations', { preHandler: needAny('chat.as_customer', 'chat.as_consultant') }, async (req, reply) => {
    const b = z.object({ projectId: z.string().uuid().optional(), title: z.string().optional() }).parse(req.body ?? {});
    let pid = b.projectId ?? (await pool.query('SELECT id FROM projects ORDER BY created_at LIMIT 1')).rows[0]?.id;
    pid ??= (await pool.query("INSERT INTO projects (name) VALUES ('Default') RETURNING id")).rows[0].id;
    if (!(await pool.query('SELECT 1 FROM projects WHERE id=$1', [pid])).rowCount) return reply.code(404).send({ error: 'Project not found' });
    const owner = req.user!.perms.has('chat.as_customer') ? req.user!.id : null;
    return reply.code(201).send(await createConversation(pid, b.title, owner));
  });
  app.get('/api/conversations/:id', async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    if (!(await canAccessConversation(req.user!, id))) return reply.code(404).send({ error: 'Conversation not found' });
    return { messages: await getMessages(id), draft: await getDraft(id), project: await getConversationProject(id) };
  });

  const llm = defaultLlm();
  registerDocRoutes(app, {
    generator: deps.generator ?? (llm ? new LlmGenerator(llm) : new TemplateGenerator()),
    mailer: deps.mailer ?? new OutboxMailer(),
    embedder: deps.embedder ?? defaultEmbedder(),
    appUrl: deps.appUrl ?? process.env.APP_URL ?? 'http://localhost:3000',
  });
  registerAdminRoutes(app);
  registerDashboardRoutes(app);
  registerReportRoutes(app);
  registerWorkflowRoutes(app);
  registerFieldAdminRoutes(app);
  return app;
}
