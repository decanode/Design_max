import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool } from '../db.js';
import { need, ticketVisible } from '../rbac/auth.js';
import { audit } from '../rbac/audit.js';
import { DocError } from '../errors.js';
import type { LlmClient } from '../chat/llm.js';

const Id = z.object({ id: z.string().uuid() });
const State = z.enum(['todo', 'doing', 'blocked', 'done']);

/** The standard breakdown for a kind of ticket when a project has set none up. */
const DEFAULT_TASKS: Record<string, string[]> = {
  incident: ['Reproduce and confirm the problem', 'Find the cause', 'Apply the fix', 'Test the fix', 'Confirm with the customer'],
  problem: ['Collect the related incidents', 'Analyse the root cause', 'Agree a permanent fix', 'Test the fix', 'Close the related incidents'],
  change: ['Assess impact and risk', 'Prepare the implementation and rollback plans', 'Build the change', 'Test the change', 'Get approval to deploy', 'Deploy and verify'],
  bug: ['Reproduce the bug', 'Fix it', 'Test the fix', 'Regression test'],
  requirement: ['Clarify the requirement with the customer', 'Write the functional specification', 'Write the technical specification', 'Build', 'Test', 'Hand over and document'],
  wricef: ['Clarify the requirement', 'Write the functional specification', 'Write the technical specification', 'Build and unit test', 'Integration test', 'Deploy'],
  feature: ['Clarify the requirement', 'Design the solution', 'Build', 'Test', 'Hand over and document'],
};
const FALLBACK = ['Understand the request', 'Do the work', 'Test it', 'Hand over'];

/** Breaking a ticket into work, inside Design Max. Staff only: it is the team's own working list, not part of what the customer sees. */
export function registerWorkItemRoutes(app: FastifyInstance, deps: { llm?: LlmClient | null } = {}) {
  const staff = (p: Set<string>) => p.has('ticket.view_all') || p.has('ticket.advance') || p.has('ticket.claim');
  const editor = (p: Set<string>) => p.has('ticket.advance') || p.has('ticket.claim') || p.has('ticket.assign');
  const guard = async (req: import('fastify').FastifyRequest, ticketId: string, write = false) => {
    if (!(await ticketVisible(req.user!, ticketId)) || !staff(req.user!.perms)) throw new DocError('Ticket not found', 404);
    if (write && !editor(req.user!.perms)) throw new DocError('Your role cannot change the work on tickets', 403);
  };
  const ticketOf = async (id: string) => (await pool.query('SELECT t.id, t.project_id, t.title, t.ai_summary, t.ticket_type_id, tt.key AS type_key, tt.name AS type_name FROM tickets t LEFT JOIN ticket_types tt ON tt.id = t.ticket_type_id WHERE t.id=$1', [id])).rows[0];
  const list = async (ticketId: string) => {
    const items = (await pool.query(
      `SELECT w.id, w.title, w.state, w.owner_id AS "ownerId", u.display_name AS owner, w.estimate_h::float AS "estimateH", w.actual_h::float AS "actualH", w.position, w.depends_on AS "dependsOn", w.done_at AS "doneAt"
       FROM work_items w LEFT JOIN users u ON u.id = w.owner_id WHERE w.ticket_id=$1 ORDER BY w.position, w.created_at`, [ticketId])).rows;
    const done = items.filter((i) => i.state === 'done').length;
    return { items, progress: { done, total: items.length }, estimateH: items.reduce((a, i) => a + (i.estimateH ?? 0), 0), actualH: items.reduce((a, i) => a + (i.actualH ?? 0), 0) };
  };

  app.get('/api/tickets/:id/work', { preHandler: need('board.view') }, async (req) => { const { id } = Id.parse(req.params); await guard(req, id); return list(id); });

  app.post('/api/tickets/:id/work', { preHandler: need('board.view') }, async (req, reply) => {
    const { id } = Id.parse(req.params); await guard(req, id, true);
    const b = z.object({ title: z.string().trim().min(1).max(300), ownerId: z.string().uuid().nullable().optional(), estimateH: z.number().min(0).max(10000).nullable().optional() }).parse(req.body);
    const t = await ticketOf(id);
    const pos = (await pool.query('SELECT coalesce(max(position),0)+1 AS p FROM work_items WHERE ticket_id=$1', [id])).rows[0].p;
    const w = (await pool.query('INSERT INTO work_items (ticket_id, project_id, title, owner_id, estimate_h, position, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id', [id, t.project_id, b.title, b.ownerId ?? null, b.estimateH ?? null, pos, req.user!.id])).rows[0];
    return reply.code(201).send({ id: w.id, ...(await list(id)) });
  });

  app.patch('/api/work/:id', { preHandler: need('board.view') }, async (req) => {
    const { id } = Id.parse(req.params);
    const w = (await pool.query('SELECT ticket_id, depends_on FROM work_items WHERE id=$1', [id])).rows[0];
    if (!w) throw new DocError('Work item not found', 404);
    await guard(req, w.ticket_id, true);
    const b = z.object({ title: z.string().trim().min(1).max(300).optional(), state: State.optional(), ownerId: z.string().uuid().nullable().optional(),
      estimateH: z.number().min(0).max(10000).nullable().optional(), actualH: z.number().min(0).max(10000).nullable().optional(), dependsOn: z.array(z.string().uuid()).max(20).optional() }).strict().parse(req.body);
    const deps = b.dependsOn ?? w.depends_on;
    if (b.dependsOn) {
      if (b.dependsOn.includes(id)) throw new DocError('A task cannot depend on itself', 400);
      const ok = (await pool.query('SELECT count(*)::int n FROM work_items WHERE ticket_id=$1 AND id = ANY($2)', [w.ticket_id, b.dependsOn])).rows[0].n;
      if (ok !== new Set(b.dependsOn).size) throw new DocError('A task can only depend on other tasks of the same ticket', 400);
    }
    if (b.state === 'doing' || b.state === 'done') {
      const open = (await pool.query(`SELECT title FROM work_items WHERE id = ANY($1) AND state <> 'done' ORDER BY position`, [deps])).rows.map((r) => r.title as string);
      if (open.length) throw new DocError(`This task waits for: ${open.join(', ')}`, 409);
    }
    await pool.query(
      `UPDATE work_items SET title=COALESCE($2,title), state=COALESCE($3,state), owner_id = CASE WHEN $4::boolean THEN $5 ELSE owner_id END, estimate_h = CASE WHEN $6::boolean THEN $7 ELSE estimate_h END,
         actual_h = CASE WHEN $8::boolean THEN $9 ELSE actual_h END, depends_on=$10, done_at = CASE WHEN $3 = 'done' THEN now() WHEN $3 IS NOT NULL THEN NULL ELSE done_at END WHERE id=$1`,
      [id, b.title ?? null, b.state ?? null, 'ownerId' in b, b.ownerId ?? null, 'estimateH' in b, b.estimateH ?? null, 'actualH' in b, b.actualH ?? null, deps]);
    await pool.query('UPDATE tickets SET updated_at=now() WHERE id=$1', [w.ticket_id]);
    return list(w.ticket_id);
  });

  app.delete('/api/work/:id', { preHandler: need('board.view') }, async (req) => {
    const { id } = Id.parse(req.params);
    const w = (await pool.query('SELECT ticket_id FROM work_items WHERE id=$1', [id])).rows[0];
    if (!w) throw new DocError('Work item not found', 404);
    await guard(req, w.ticket_id, true);
    await pool.query('DELETE FROM work_items WHERE id=$1', [id]);
    await pool.query(`UPDATE work_items SET depends_on = array_remove(depends_on, $1::uuid) WHERE ticket_id=$2`, [id, w.ticket_id]);
    return list(w.ticket_id);
  });

  /** Adds the project's standard tasks for this kind of ticket (or a sensible default), once. */
  app.post('/api/tickets/:id/work/from-template', { preHandler: need('board.view') }, async (req) => {
    const { id } = Id.parse(req.params); await guard(req, id, true);
    const t = await ticketOf(id);
    if ((await pool.query('SELECT 1 FROM work_items WHERE ticket_id=$1 LIMIT 1', [id])).rowCount) throw new DocError('This ticket already has work items. Add to them, or remove them first.', 409);
    const own = (await pool.query('SELECT title, estimate_h::float AS h FROM work_item_templates WHERE project_id=$1 AND ticket_type_id=$2 ORDER BY position', [t.project_id, t.ticket_type_id])).rows as { title: string; h: number | null }[];
    const tasks = own.length ? own : (DEFAULT_TASKS[t.type_key] ?? FALLBACK).map((title) => ({ title, h: null }));
    let pos = 0;
    for (const x of tasks) await pool.query('INSERT INTO work_items (ticket_id, project_id, title, estimate_h, position, created_by) VALUES ($1,$2,$3,$4,$5,$6)', [id, t.project_id, x.title, x.h, ++pos, req.user!.id]);
    return list(id);
  });

  /** Suggested breakdown for the person to accept or edit. Uses the AI when one is set up, otherwise the standard tasks. Nothing is saved. */
  app.post('/api/tickets/:id/work/suggest', { preHandler: need('board.view') }, async (req) => {
    const { id } = Id.parse(req.params); await guard(req, id, true);
    const t = await ticketOf(id);
    const fallback = (DEFAULT_TASKS[t.type_key] ?? FALLBACK).map((title) => ({ title }));
    const llm = deps.llm === undefined ? (await import('../chat/llm.js')).defaultLlm() : deps.llm;
    if (!llm) return { by: 'standard', tasks: fallback };
    try {
      const text = await llm.complete('You break a delivery ticket down into 4 to 9 concrete tasks a consultant can do. Reply with ONLY a JSON array of objects {"title": string, "estimateH": number|null}. Titles are short, start with a verb, and are specific to this ticket. Do not invent facts.',
        `Ticket type: ${t.type_name}\nTitle: ${t.title}\nDescription:\n${String(t.ai_summary ?? '').slice(0, 3000)}`);
      const arr = JSON.parse(text.slice(text.indexOf('['), text.lastIndexOf(']') + 1));
      const tasks = z.array(z.object({ title: z.string().trim().min(1).max(300), estimateH: z.number().min(0).max(1000).nullable().optional() })).max(15).parse(arr);
      return tasks.length ? { by: 'ai', tasks } : { by: 'standard', tasks: fallback };
    } catch { return { by: 'standard', tasks: fallback }; }
  });
  app.post('/api/tickets/:id/work/bulk', { preHandler: need('board.view') }, async (req) => {
    const { id } = Id.parse(req.params); await guard(req, id, true);
    const b = z.object({ tasks: z.array(z.object({ title: z.string().trim().min(1).max(300), estimateH: z.number().min(0).max(10000).nullable().optional() })).min(1).max(30) }).parse(req.body);
    const t = await ticketOf(id);
    let pos = (await pool.query('SELECT coalesce(max(position),0) AS p FROM work_items WHERE ticket_id=$1', [id])).rows[0].p as number;
    for (const x of b.tasks) await pool.query('INSERT INTO work_items (ticket_id, project_id, title, estimate_h, position, created_by) VALUES ($1,$2,$3,$4,$5,$6)', [id, t.project_id, x.title, x.estimateH ?? null, ++pos, req.user!.id]);
    await audit(req, 'ticket.work.add', { ticketId: id, count: b.tasks.length });
    return list(id);
  });

  /** A project's own standard tasks per ticket type. */
  const admin = need('admin.projects');
  app.get('/api/project/work-templates', { preHandler: admin }, async (req) => {
    const rows = (await pool.query('SELECT id, ticket_type_id AS "ticketTypeId", title, estimate_h::float AS "estimateH", position FROM work_item_templates WHERE project_id=$1 ORDER BY ticket_type_id, position', [req.user!.projectId])).rows;
    return { templates: rows, defaults: DEFAULT_TASKS };
  });
  app.put('/api/project/work-templates/:typeId', { preHandler: admin }, async (req) => {
    const { typeId } = z.object({ typeId: z.coerce.number().int().positive() }).parse(req.params);
    const b = z.object({ tasks: z.array(z.object({ title: z.string().trim().min(1).max(300), estimateH: z.number().min(0).max(10000).nullable().optional() })).max(30) }).parse(req.body);
    if (!(await pool.query('SELECT 1 FROM project_ticket_types WHERE project_id=$1 AND ticket_type_id=$2', [req.user!.projectId, typeId])).rowCount) throw new DocError('This project does not use that ticket type', 404);
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query('DELETE FROM work_item_templates WHERE project_id=$1 AND ticket_type_id=$2', [req.user!.projectId, typeId]);
      let pos = 0; for (const x of b.tasks) await c.query('INSERT INTO work_item_templates (project_id, ticket_type_id, title, estimate_h, position) VALUES ($1,$2,$3,$4,$5)', [req.user!.projectId, typeId, x.title, x.estimateH ?? null, ++pos]);
      await c.query('COMMIT');
    } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
    await audit(req, 'project.work_templates', { typeId, count: b.tasks.length });
    return { ok: true };
  });
}
