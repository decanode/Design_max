import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type pg from 'pg';
import { pool } from '../db.js';
import { needSuper } from '../rbac/auth.js';
import { audit } from '../rbac/audit.js';
import { DocError } from '../errors.js';

const Key = z.string().regex(/^[a-z][a-z0-9_]{1,30}$/, 'Use lower-case letters, digits and underscores');
const PhaseName = z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9 .&/()-]{0,58}$/, 'Plain words only, up to 60 characters');
const Tone = z.enum(['intake', 'spec', 'build', 'review', 'done']);

const FieldDef = z.object({
  key: z.string().regex(/^[a-z][a-z0-9_]{0,40}$/, 'Field keys are lower-case letters, digits and underscores'),
  label: z.string().trim().min(1).max(80), kind: z.enum(['text', 'textarea', 'select', 'number', 'date', 'checkbox']),
  options: z.array(z.string().trim().min(1).max(80)).max(40).default([]), required: z.boolean().default(false), help: z.string().max(200).default(''),
}).superRefine((f, ctx) => {
  if (f.kind === 'select' && !f.options.length) ctx.addIssue({ code: 'custom', message: `${f.label}: a choice field needs at least one option` });
  if (f.kind === 'select' && new Set(f.options).size !== f.options.length) ctx.addIssue({ code: 'custom', message: `${f.label}: options must be different` });
});
const TypeShape = z.object({ key: Key.optional(), name: z.string().trim().min(2).max(60), short: z.string().trim().min(2).max(6).transform((s) => s.toUpperCase()), description: z.string().trim().max(300).default(''), fields: z.array(FieldDef).max(30).default([]) });
const uniqueKeys = (b: { fields: { key: string }[] }, ctx: z.RefinementCtx) => { if (new Set(b.fields.map((f) => f.key)).size !== b.fields.length) ctx.addIssue({ code: 'custom', message: 'Two fields share a key' }); };
const TypeBody = TypeShape.superRefine(uniqueKeys);

async function replaceFields(c: pg.PoolClient, typeId: number, fields: z.infer<typeof FieldDef>[]) {
  await c.query('DELETE FROM ticket_type_fields WHERE ticket_type_id=$1', [typeId]);
  let i = 0;
  for (const f of fields) await c.query('INSERT INTO ticket_type_fields (ticket_type_id, key, label, kind, options, required, help, position) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)', [typeId, f.key, f.label, f.kind, JSON.stringify(f.options), f.required, f.help, ++i]);
}
const tx = async <T>(fn: (c: pg.PoolClient) => Promise<T>) => {
  const c = await pool.connect();
  try { await c.query('BEGIN'); const r = await fn(c); await c.query('COMMIT'); return r; } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
};

/** Super Admin management of the shared masters: what ticket types exist and what they ask for, which phases exist, and how methodologies move tickets between them. */
export function registerWorkflowAdminRoutes(app: FastifyInstance) {
  const sup = needSuper();
  const IdP = z.object({ id: z.coerce.number().int().positive() });

  // ------------------------------------------------------------ ticket types and their fields
  app.post('/api/platform/workflow/ticket-types', { preHandler: sup }, async (req, reply) => {
    const b = TypeShape.extend({ key: Key }).superRefine(uniqueKeys).parse(req.body);
    if ((await pool.query('SELECT 1 FROM ticket_types WHERE key=$1', [b.key])).rowCount) throw new DocError('A ticket type with that key already exists', 409);
    const id = await tx(async (c) => {
      const id = (await c.query('INSERT INTO ticket_types (key, name, short, description, sort) VALUES ($1,$2,$3,$4,(SELECT coalesce(max(sort),0)+1 FROM ticket_types)) RETURNING id', [b.key, b.name, b.short, b.description])).rows[0].id as number;
      await replaceFields(c, id, b.fields); return id;
    });
    await audit(req, 'platform.ticket_type', { id, key: b.key }, null);
    return reply.code(201).send({ id });
  });
  app.put('/api/platform/workflow/ticket-types/:id', { preHandler: sup }, async (req) => {
    const { id } = IdP.parse(req.params); const b = TypeBody.parse(req.body);
    await tx(async (c) => {
      if (!(await c.query('UPDATE ticket_types SET name=$2, short=$3, description=$4 WHERE id=$1', [id, b.name, b.short, b.description])).rowCount) throw new DocError('Ticket type not found', 404);
      await replaceFields(c, id, b.fields);
    });
    await audit(req, 'platform.ticket_type', { id }, null);
    return { ok: true };
  });
  app.delete('/api/platform/workflow/ticket-types/:id', { preHandler: sup }, async (req) => {
    const { id } = IdP.parse(req.params);
    if ((await pool.query('SELECT 1 FROM tickets WHERE ticket_type_id=$1 LIMIT 1', [id])).rowCount) throw new DocError('Tickets of this type exist, so it cannot be deleted', 409);
    await tx(async (c) => {
      await c.query('DELETE FROM project_ticket_types WHERE ticket_type_id=$1', [id]);
      await c.query('DELETE FROM ticket_types WHERE id=$1', [id]);
    });
    await audit(req, 'platform.ticket_type.delete', { id }, null);
    return { ok: true };
  });

  // ------------------------------------------------------------ phases
  app.get('/api/platform/workflow/phases', { preHandler: sup }, async () => (await pool.query('SELECT id, name, tone FROM phases ORDER BY id')).rows);
  app.post('/api/platform/workflow/phases', { preHandler: sup }, async (req, reply) => {
    const b = z.object({ name: PhaseName, tone: Tone }).parse(req.body);
    if ((await pool.query('SELECT 1 FROM phases WHERE lower(name)=lower($1)', [b.name])).rowCount) throw new DocError('A phase with that name already exists', 409);
    const id = (await pool.query('INSERT INTO phases (name, tone) VALUES ($1,$2) RETURNING id', [b.name, b.tone])).rows[0].id as number;
    await audit(req, 'platform.phase', { id, name: b.name }, null);
    return reply.code(201).send({ id });
  });
  app.delete('/api/platform/workflow/phases/:id', { preHandler: sup }, async (req) => {
    const { id } = IdP.parse(req.params);
    const used = (await pool.query('SELECT 1 FROM template_phases WHERE phase_id=$1 UNION ALL SELECT 1 FROM tickets t JOIN phases p ON p.name=t.current_state WHERE p.id=$1 LIMIT 1', [id])).rowCount;
    if (used) throw new DocError('This phase is used by a methodology or by tickets, so it cannot be deleted', 409);
    await pool.query('DELETE FROM phases WHERE id=$1', [id]);
    return { ok: true };
  });

  // ------------------------------------------------------------ methodologies (templates): phases, ticket types and transitions
  const Edge = z.object({ ticketTypeId: z.number().int().nullable(), from: z.number().int().nullable(), to: z.number().int() });
  const Graph = z.object({
    name: z.string().trim().min(2).max(60), description: z.string().trim().max(300).default(''),
    phases: z.array(z.object({ phaseId: z.number().int(), defaultOn: z.boolean() })).min(2).max(40),     // in board order
    ticketTypeIds: z.array(z.number().int()).max(40), edges: z.array(Edge).max(400),
  });

  async function applyGraph(c: pg.PoolClient, templateId: number, g: z.infer<typeof Graph>) {
    const ids = new Set(g.phases.map((p) => p.phaseId));
    if (ids.size !== g.phases.length) throw new DocError('A phase is listed twice', 400);
    if ((await c.query('SELECT count(*)::int n FROM phases WHERE id = ANY($1)', [[...ids]])).rows[0].n !== ids.size) throw new DocError('Unknown phase', 400);
    if ((await c.query('SELECT count(*)::int n FROM ticket_types WHERE id = ANY($1)', [g.ticketTypeIds])).rows[0].n !== new Set(g.ticketTypeIds).size) throw new DocError('Unknown ticket type', 400);
    const types = new Set(g.ticketTypeIds);
    for (const e of g.edges) {
      if (!ids.has(e.to) || (e.from !== null && !ids.has(e.from))) throw new DocError('A transition uses a phase that is not part of this methodology', 400);
      if (e.ticketTypeId !== null && !types.has(e.ticketTypeId)) throw new DocError('A transition is for a ticket type that is not part of this methodology', 400);
      if (e.from === e.to) throw new DocError('A transition must lead somewhere else', 400);
    }
    // document-driven steps are part of the product, not editable here: they stay as they are
    const gated = (await c.query('SELECT ticket_type_id, from_phase_id, to_phase_id, gated_reason FROM workflow_transitions WHERE template_type_id=$1 AND gated_reason IS NOT NULL', [templateId])).rows;
    for (const e of gated) if (!ids.has(e.from_phase_id) || !ids.has(e.to_phase_id)) throw new DocError('Phases that carry documents and approvals cannot be removed from this methodology', 409);
    // no ticket may be left in a phase the methodology drops
    const dropped = (await c.query(`SELECT DISTINCT t.current_state FROM tickets t JOIN projects p ON p.id=t.project_id WHERE p.template_type_id=$1 AND t.current_state NOT IN (SELECT name FROM phases WHERE id = ANY($2))`, [templateId, [...ids]])).rows.map((r) => r.current_state as string);
    if (dropped.length) throw new DocError(`Tickets are in ${dropped.join(', ')}, which this change would remove`, 409, { stranded: dropped });
    const dropTypes = (await c.query(`SELECT DISTINCT tt.name FROM tickets t JOIN projects p ON p.id=t.project_id JOIN ticket_types tt ON tt.id=t.ticket_type_id WHERE p.template_type_id=$1 AND NOT (t.ticket_type_id = ANY($2))`, [templateId, g.ticketTypeIds])).rows.map((r) => r.name as string);
    if (dropTypes.length) throw new DocError(`Tickets of type ${dropTypes.join(', ')} exist in projects using this methodology`, 409);

    await c.query('UPDATE template_types SET name=$2, description=$3 WHERE id=$1', [templateId, g.name, g.description]);
    await c.query('DELETE FROM template_phases WHERE template_type_id=$1', [templateId]);
    let pos = 0; for (const p of g.phases) await c.query('INSERT INTO template_phases (template_type_id, phase_id, position, default_on) VALUES ($1,$2,$3,$4)', [templateId, p.phaseId, ++pos, p.defaultOn]);
    await c.query('DELETE FROM template_ticket_types WHERE template_type_id=$1', [templateId]);
    for (const t of types) await c.query('INSERT INTO template_ticket_types (template_type_id, ticket_type_id) VALUES ($1,$2)', [templateId, t]);
    await c.query('DELETE FROM workflow_transitions WHERE template_type_id=$1 AND gated_reason IS NULL', [templateId]);
    for (const e of g.edges) await c.query(
      `INSERT INTO workflow_transitions (template_type_id, ticket_type_id, from_phase_id, to_phase_id) VALUES ($1,$2,$3,$4)
       ON CONFLICT (template_type_id, COALESCE(ticket_type_id, 0), COALESCE(from_phase_id, 0), to_phase_id) DO NOTHING`, [templateId, e.ticketTypeId, e.from, e.to]);
    // projects on this methodology follow: new phases appear (switched on or off by default), dropped ones go, board order updates
    await c.query('DELETE FROM project_phases pp USING projects p WHERE pp.project_id=p.id AND p.template_type_id=$1 AND pp.phase_id <> ALL($2)', [templateId, [...ids]]);
    await c.query(`INSERT INTO project_phases (project_id, phase_id, position, enabled) SELECT p.id, tp.phase_id, tp.position, tp.default_on FROM projects p JOIN template_phases tp ON tp.template_type_id=p.template_type_id
                   WHERE p.template_type_id=$1 ON CONFLICT (project_id, phase_id) DO UPDATE SET position = EXCLUDED.position`, [templateId]);
    await c.query('DELETE FROM project_ticket_types ptt USING projects p WHERE ptt.project_id=p.id AND p.template_type_id=$1 AND ptt.ticket_type_id <> ALL($2)', [templateId, g.ticketTypeIds]);
    // every ticket type needs a place to start: a transition from "new ticket", of its own or the methodology's general flow
    const noStart = (await c.query(
      `SELECT tt.name FROM template_ticket_types x JOIN ticket_types tt ON tt.id = x.ticket_type_id WHERE x.template_type_id = $1 AND NOT EXISTS (
         SELECT 1 FROM workflow_transitions w WHERE w.template_type_id = $1 AND w.from_phase_id IS NULL AND (w.ticket_type_id = x.ticket_type_id
           OR (w.ticket_type_id IS NULL AND NOT EXISTS (SELECT 1 FROM workflow_transitions o WHERE o.template_type_id = $1 AND o.ticket_type_id = x.ticket_type_id))))`, [templateId])).rows.map((r) => r.name as string);
    if (noStart.length) throw new DocError(`${noStart.join(', ')} needs a starting phase: add a transition from "new ticket"`, 400);
  }

  app.put('/api/platform/workflow/templates/:id', { preHandler: sup }, async (req) => {
    const { id } = IdP.parse(req.params); const g = Graph.parse(req.body);
    if (!(await pool.query('SELECT 1 FROM template_types WHERE id=$1', [id])).rowCount) throw new DocError('Methodology not found', 404);
    await tx((c) => applyGraph(c, id, g));
    await audit(req, 'platform.template', { id, phases: g.phases.length, edges: g.edges.length }, null);
    return { ok: true };
  });
  /** A new methodology, optionally starting as a copy of an existing one. */
  app.post('/api/platform/workflow/templates', { preHandler: sup }, async (req, reply) => {
    const b = z.object({ key: Key, name: z.string().trim().min(2).max(60), description: z.string().trim().max(300).default(''), copyFrom: z.number().int().optional() }).parse(req.body);
    if ((await pool.query('SELECT 1 FROM template_types WHERE key=$1', [b.key])).rowCount) throw new DocError('A methodology with that key already exists', 409);
    const id = await tx(async (c) => {
      const id = (await c.query('INSERT INTO template_types (key, name, description, sort) VALUES ($1,$2,$3,(SELECT coalesce(max(sort),0)+1 FROM template_types)) RETURNING id', [b.key, b.name, b.description])).rows[0].id as number;
      if (b.copyFrom) {
        if (!(await c.query('SELECT 1 FROM template_types WHERE id=$1', [b.copyFrom])).rowCount) throw new DocError('Methodology to copy not found', 404);
        await c.query('INSERT INTO template_phases SELECT $1, phase_id, position, default_on FROM template_phases WHERE template_type_id=$2', [id, b.copyFrom]);
        await c.query('INSERT INTO template_ticket_types SELECT $1, ticket_type_id FROM template_ticket_types WHERE template_type_id=$2', [id, b.copyFrom]);
        await c.query('INSERT INTO workflow_transitions (template_type_id, ticket_type_id, from_phase_id, to_phase_id, gated_reason) SELECT $1, ticket_type_id, from_phase_id, to_phase_id, gated_reason FROM workflow_transitions WHERE template_type_id=$2', [id, b.copyFrom]);
      }
      return id;
    });
    await audit(req, 'platform.template.create', { id, key: b.key }, null);
    return reply.code(201).send({ id });
  });
  app.delete('/api/platform/workflow/templates/:id', { preHandler: sup }, async (req) => {
    const { id } = IdP.parse(req.params);
    if ((await pool.query('SELECT 1 FROM projects WHERE template_type_id=$1 LIMIT 1', [id])).rowCount) throw new DocError('Projects use this methodology, so it cannot be deleted', 409);
    await pool.query('DELETE FROM template_types WHERE id=$1', [id]);
    return { ok: true };
  });

  // ------------------------------------------------------------ project types: what a new project of that kind starts with
  app.put('/api/platform/workflow/project-types/:id', { preHandler: sup }, async (req) => {
    const { id } = IdP.parse(req.params);
    const b = z.object({ name: z.string().trim().min(2).max(60), description: z.string().trim().max(300).default(''), templateTypeId: z.number().int(),
      ticketDefaults: z.array(z.object({ ticketTypeId: z.number().int(), on: z.boolean(), isDefault: z.boolean() })).max(40), phaseDefaults: z.array(z.object({ phaseId: z.number().int(), enabled: z.boolean() })).max(60) }).parse(req.body);
    await tx(async (c) => {
      if (!(await c.query('UPDATE project_types SET name=$2, description=$3 WHERE id=$1', [id, b.name, b.description])).rowCount) throw new DocError('Project type not found', 404);
      if (!(await c.query('SELECT 1 FROM template_types WHERE id=$1', [b.templateTypeId])).rowCount) throw new DocError('Unknown methodology', 400);
      await c.query('INSERT INTO project_type_template_defaults VALUES ($1,$2) ON CONFLICT (project_type_id) DO UPDATE SET template_type_id=$2', [id, b.templateTypeId]);
      await c.query('DELETE FROM project_type_ticket_defaults WHERE project_type_id=$1', [id]);
      for (const t of b.ticketDefaults) await c.query('INSERT INTO project_type_ticket_defaults VALUES ($1,$2,$3,$4)', [id, t.ticketTypeId, t.on, t.isDefault]);
      await c.query('DELETE FROM project_type_phase_defaults WHERE project_type_id=$1', [id]);
      for (const p of b.phaseDefaults) await c.query('INSERT INTO project_type_phase_defaults VALUES ($1,$2,$3)', [id, p.phaseId, p.enabled]);
    });
    await audit(req, 'platform.project_type', { id }, null);
    return { ok: true };
  });
  app.post('/api/platform/workflow/project-types', { preHandler: sup }, async (req, reply) => {
    const b = z.object({ key: Key, name: z.string().trim().min(2).max(60), description: z.string().trim().max(300).default(''), templateTypeId: z.number().int() }).parse(req.body);
    if ((await pool.query('SELECT 1 FROM project_types WHERE key=$1', [b.key])).rowCount) throw new DocError('A project type with that key already exists', 409);
    const id = await tx(async (c) => {
      const id = (await c.query('INSERT INTO project_types (key, name, description, sort) VALUES ($1,$2,$3,(SELECT coalesce(max(sort),0)+1 FROM project_types)) RETURNING id', [b.key, b.name, b.description])).rows[0].id as number;
      await c.query('INSERT INTO project_type_template_defaults VALUES ($1,$2)', [id, b.templateTypeId]);
      return id;
    });
    return reply.code(201).send({ id });
  });
}
