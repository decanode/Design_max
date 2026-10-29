import Fastify from 'fastify';
import cors from '@fastify/cors';
import { z } from 'zod';
import { pool } from './db.js';
import { loadWorkflow, nextPhases, projectPhaseNames, typeFields, validateMetadata } from './workflow/service.js';
import { createConversation, getConversation, getConversationProject, getDraft, getMessages, canAccessConversation, listConversations, personaOf } from './chat/service.js';
import { registerDocRoutes, type DocDeps } from './docs/routes.js';
import { DocError } from './docs/service.js';
import { isDatabaseDown } from './errors.js';
import { LlmGenerator, TemplateGenerator } from './docs/generator.js';
import { OutboxMailer } from './docs/mailer.js';
import { defaultLlm } from './chat/llm.js';
import { defaultEmbedder } from './etl/vectorize.js';
import { createTicket, transitionTicket, TransitionError } from './tickets.js';
import { inProject, need, needAny, registerAuth, ticketScope } from './rbac/auth.js';
import { audit } from './rbac/audit.js';
import { membersWithPermission } from './rbac/effective.js';
import { registerAuthRoutes } from './rbac/authRoutes.js';
import { registerPlatformRoutes } from './platform/routes.js';
import { registerPlanningRoutes } from './planning/routes.js';
import { defaultPlanningAi, type PlanningAi } from './planning/ai.js';
import { registerPeopleRoutes } from './project/peopleRoutes.js';
import { registerFlowRoutes } from './workflow/flowRoutes.js';
import { registerBuilderRoutes } from './workflow/builderRoutes.js';
import { registerWorkflowAdminRoutes } from './workflow/platformRoutes.js';
import { registerProjectRoutes } from './project/routes.js';
import { registerDashboardRoutes } from './rbac/dashboardRoutes.js';
import { registerReportRoutes } from './reports/routes.js';
import { registerWorkflowRoutes } from './approvals/adminRoutes.js';
import { canWrite, sanitizeTicket } from './tickets/fields.js';
import { ticketVisible } from './rbac/auth.js';

export function buildApp(deps: Partial<DocDeps> & { planningAi?: PlanningAi } = {}) {
  const app = Fastify();
  app.register(cors, { origin: true, credentials: true });
  registerAuth(app);
  registerAuthRoutes(app);

  app.setErrorHandler((err: any, _req, reply) => {
    if (err instanceof DocError) return reply.code(err.status).send({ error: err.message, ...err.extra });
    if (err instanceof z.ZodError) return reply.code(400).send({ error: 'Invalid request', details: err.issues });
    if (isDatabaseDown(err)) return reply.code(503).send({ error: 'The database is unavailable', code: 'DATABASE_DOWN' });
    app.log.error(err);
    return reply.code(500).send({ error: 'Something went wrong' });
  });

  app.get('/health', async () => ({ ok: true }));
  app.get('/health/db', async (_req, reply) => { await pool.query('SELECT 1'); return reply.send({ ok: true }); });   // 503 via the error handler when the database is down
  /** Phase names of the project you are working in, in board order. */
  app.get('/api/states', async (req) => (req.user?.projectId ? projectPhaseNames(req.user.projectId) : (await pool.query('SELECT name FROM phases ORDER BY id')).rows.map((r) => r.name as string)));
  /** The project's methodology, phases and allowed ticket types (with their form fields): everything the board and the create form render from. */
  app.get('/api/workflow', { preHandler: inProject() }, async (req) => {
    const pid = req.user!.projectId!;
    const rows = (await pool.query(
      `SELECT ty.ticket_type_id AS ty, ph.name AS "from", n.to_phase AS "to", n.gated_reason AS gated
       FROM project_ticket_types ty
       JOIN (SELECT project_id, phase_id FROM project_phases UNION SELECT project_id, phase_id FROM project_flow_phases) pp ON pp.project_id = ty.project_id
       JOIN phases ph ON ph.id = pp.phase_id CROSS JOIN LATERAL next_phases(ty.project_id, ty.ticket_type_id, ph.name) n WHERE ty.project_id = $1`, [pid])).rows;
    const moves: Record<number, Record<string, { to: string; gated: string | null }[]>> = {};
    for (const r of rows) ((moves[r.ty] ??= {})[r.from] ??= []).push({ to: r.to, gated: r.gated });
    return { ...(await loadWorkflow(pid)), moves };       // moves: for each ticket type, where a ticket can go from each phase
  });

  /** Projects the person can work in (Super Admins: every active project), with the technology each allows. */
  app.get('/api/projects', async (req) => (await pool.query(
    `SELECT p.id, p.name, COALESCE((SELECT array_agg(s.name ORDER BY s.name) FROM project_stacks ps JOIN tech_stacks s ON s.id = ps.stack_id WHERE ps.project_id = p.id), '{}') AS stacks
     FROM projects p WHERE p.status = 'active' AND ($1 OR EXISTS (SELECT 1 FROM project_members m WHERE m.project_id = p.id AND m.user_id = $2)) ORDER BY p.name`, [req.user!.isSuper, req.user!.id])).rows);

  app.get('/api/tickets', { preHandler: need('board.view') }, async (req) => {
    const s = ticketScope(req.user!, 1);
    const rows = (await pool.query(
      `SELECT t.id, t.title, t.current_state, t.ai_summary, t.ticket_type_id, tt.name AS type_name, tt.short AS type_short, tt.key AS type_key, (ph.tone = 'done') AS is_done, t.team_id, tm.name AS team_name, t.dynamic_metadata, t.legacy_id, t.legacy_source, t.created_at, t.updated_at, t.consultant_id,
              c.display_name AS consultant, (t.consultant_id IS NOT NULL) AS is_assigned,
              EXISTS (SELECT 1 FROM approvals a WHERE a.ticket_id = t.id AND a.status = 'pending') AS awaiting_approval
       FROM tickets t LEFT JOIN users c ON c.id = t.consultant_id LEFT JOIN ticket_types tt ON tt.id = t.ticket_type_id LEFT JOIN phases ph ON ph.name = t.current_state LEFT JOIN teams tm ON tm.id = t.team_id
       WHERE ${s.sql} ORDER BY t.updated_at DESC LIMIT 500`, s.params)).rows;
    return rows.map((r) => sanitizeTicket(r, req.user!.fields));      // column-level security: hidden fields never leave the server
  });
  app.post('/api/tickets', { preHandler: need('ticket.create') }, async (req, reply) => {
    const b = z.object({ title: z.string().trim().min(1).max(300), aiSummary: z.string().optional(), ticketTypeId: z.number().int().positive().optional(), dynamicMetadata: z.record(z.string(), z.unknown()).optional() }).parse(req.body);   // the project is the one you are working in, never taken from the request
    return reply.code(201).send(sanitizeTicket(await createTicket(req.user!.projectId!, b.title, b.aiSummary, { ticketTypeId: b.ticketTypeId, dynamicMetadata: b.dynamicMetadata }), req.user!.fields));
  });
  /** Where this ticket can go next, according to its project's workflow; steps taken through documents and approvals say why they are not manual. */
  app.get('/api/tickets/:id/next', { preHandler: need('board.view') }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    if (!(await ticketVisible(req.user!, id))) return reply.code(404).send({ error: 'Ticket not found' });
    const t = (await pool.query('SELECT current_state, project_id, ticket_type_id FROM tickets WHERE id=$1', [id])).rows[0];
    return { current: t.current_state as string, options: await nextPhases(t.project_id, t.ticket_type_id, t.current_state) };
  });
  app.post('/api/tickets/:id/transition', { preHandler: need('ticket.advance') }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const b = z.object({ to: z.string().min(1).max(60) }).parse(req.body);
    if (!(await ticketVisible(req.user!, id))) return reply.code(404).send({ error: 'Ticket not found' });
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
    dynamicMetadata: { field: 'details', column: 'dynamic_metadata' },
  };
  app.patch('/api/tickets/:id', async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const b = z.object({
      title: z.string().trim().min(1).max(200).optional(), aiSummary: z.string().max(20000).nullable().optional(),
      resolutionNotes: z.string().max(20000).nullable().optional(), acceptanceCriteria: z.string().max(20000).nullable().optional(),
      dynamicMetadata: z.record(z.string(), z.unknown()).optional(),
    }).strict().parse(req.body);
    const keys = Object.keys(b) as (keyof typeof b)[];
    if (!keys.length) return reply.code(400).send({ error: 'Nothing to change' });
    if (!(await ticketVisible(req.user!, id))) return reply.code(404).send({ error: 'Ticket not found' });
    const denied = keys.filter((k) => !canWrite(req.user!.fields, EDITABLE[k].field));
    if (denied.length) return reply.code(403).send({ error: `Your role cannot edit: ${denied.map((k) => EDITABLE[k].field.replace('_', ' ')).join(', ')}`, denied: denied.map((k) => EDITABLE[k].field) });
    const values: unknown[] = keys.map((k) => (b[k] === '' ? null : b[k]));
    const mi = keys.indexOf('dynamicMetadata');
    if (mi >= 0) {      // the type-specific details must satisfy the ticket type's form definition
      const t = (await pool.query('SELECT ticket_type_id FROM tickets WHERE id=$1', [id])).rows[0];
      values[mi] = JSON.stringify(validateMetadata((await typeFields()).get(t.ticket_type_id) ?? [], b.dynamicMetadata));
    }
    const sets = keys.map((k, i) => `${EDITABLE[k].column} = $${i + 2}`);
    const row = (await pool.query(`UPDATE tickets SET ${sets.join(', ')} WHERE id = $1 RETURNING *`, [id, ...values])).rows[0];
    // The log records WHICH fields changed, never their (possibly sensitive) values.
    await audit(req, 'ticket.update', { ticketId: id, fields: keys.map((k) => EDITABLE[k].field) });
    return sanitizeTicket(row, req.user!.fields);
  });

  /** A consultant takes an unassigned ticket. */
  app.post('/api/tickets/:id/claim', { preHandler: need('ticket.claim') }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    if (!canWrite(req.user!.fields, 'consultant')) return reply.code(403).send({ error: 'Your role cannot change the assigned consultant' });
    if (!(await ticketVisible(req.user!, id))) return reply.code(404).send({ error: 'Ticket not found' });
    const r = await pool.query('UPDATE tickets SET consultant_id=$2 WHERE id=$1 AND project_id=$3 AND (consultant_id IS NULL OR consultant_id=$2) RETURNING id', [id, req.user!.id, req.user!.projectId]);
    if (!r.rowCount) return reply.code(409).send({ error: 'Already assigned to someone else, or not found' });
    return { ok: true };
  });

  /** People in this project who could own a ticket (their role can claim). */
  app.get('/api/users/assignable', { preHandler: need('ticket.assign') }, async (req) => membersWithPermission(pool, req.user!.projectId!, 'ticket.claim'));

  app.post('/api/tickets/:id/assign', { preHandler: need('ticket.assign') }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const { consultantId } = z.object({ consultantId: z.string().uuid().nullable() }).parse(req.body);
    if (!canWrite(req.user!.fields, 'consultant')) return reply.code(403).send({ error: 'Your role cannot change the assigned consultant' });
    if (!(await ticketVisible(req.user!, id))) return reply.code(404).send({ error: 'Ticket not found' });
    if (consultantId && !(await membersWithPermission(pool, req.user!.projectId!, 'ticket.claim')).some((m) => m.id === consultantId))
      return reply.code(400).send({ error: 'That person is not on this project, or their role cannot own tickets' });
    await pool.query('UPDATE tickets SET consultant_id=$2 WHERE id=$1 AND project_id=$3', [id, consultantId, req.user!.projectId]);
    return { ok: true };
  });

  app.get('/api/conversations', { preHandler: needAny('chat.as_customer', 'chat.as_consultant', 'chat.view_all') }, async (req) => listConversations(req.user!));
  app.post('/api/conversations', { preHandler: needAny('chat.as_customer', 'chat.as_consultant') }, async (req, reply) => {
    const b = z.object({ title: z.string().optional() }).parse(req.body ?? {});
    const u = req.user!;
    return reply.code(201).send(await createConversation(u.projectId!, b.title, { id: u.id, persona: personaOf(u.perms), name: u.name }));
  });
  app.get('/api/conversations/:id', async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    if (!(await canAccessConversation(req.user!, id))) return reply.code(404).send({ error: 'Conversation not found' });
    return { messages: await getMessages(id), draft: await getDraft(id), project: await getConversationProject(id), conversation: await getConversation(id) };
  });

  const llm = defaultLlm();
  registerDocRoutes(app, {
    generator: deps.generator ?? (llm ? new LlmGenerator(llm) : new TemplateGenerator()),
    mailer: deps.mailer ?? new OutboxMailer(),
    embedder: deps.embedder ?? defaultEmbedder(),
    appUrl: deps.appUrl ?? process.env.APP_URL ?? 'http://localhost:3000',
  });
  registerPlatformRoutes(app);
  registerProjectRoutes(app);
  registerBuilderRoutes(app);
  registerFlowRoutes(app);
  registerPeopleRoutes(app);
  registerPlanningRoutes(app, { ai: deps.planningAi ?? defaultPlanningAi() });
  registerWorkflowAdminRoutes(app);
  registerDashboardRoutes(app);
  registerReportRoutes(app);
  registerWorkflowRoutes(app);
  return app;
}
