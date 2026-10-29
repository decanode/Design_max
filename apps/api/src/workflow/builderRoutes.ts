import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool } from '../db.js';
import { need } from '../rbac/auth.js';
import { audit } from '../rbac/audit.js';
import { DocError } from '../errors.js';
import { typeFields } from './service.js';

/** Everything the template builder needs to render: the catalogue of methodologies, project types and ticket types, plus this project's choices. */
export async function builderCatalog() {
  const [pt, tt, ty, ph, tp, ttt, ptd, ppd, ptt, edges] = await Promise.all([
    pool.query('SELECT id, key, name, description FROM project_types ORDER BY sort'),
    pool.query('SELECT id, key, name, description FROM template_types ORDER BY sort'),
    pool.query('SELECT id, key, name, short, description FROM ticket_types ORDER BY sort'),
    pool.query('SELECT id, name, tone FROM phases WHERE project_id IS NULL'),
    pool.query('SELECT template_type_id, phase_id, position, default_on FROM template_phases ORDER BY position'),
    pool.query('SELECT template_type_id, ticket_type_id FROM template_ticket_types'),
    pool.query('SELECT project_type_id, ticket_type_id, default_on, is_default FROM project_type_ticket_defaults'),
    pool.query('SELECT project_type_id, phase_id, enabled FROM project_type_phase_defaults'),
    pool.query('SELECT project_type_id, template_type_id FROM project_type_template_defaults'),
    pool.query('SELECT template_type_id, ticket_type_id, from_phase_id, to_phase_id, gated_reason FROM workflow_transitions'),
  ]);
  const phases = new Map(ph.rows.map((p) => [p.id as number, p]));
  const fields = await typeFields();
  const docRows = (await pool.query('SELECT ticket_type_id, kind, mode FROM ticket_type_documents')).rows;
  const docsOf = (id: number) => Object.fromEntries(['FS', 'TS', 'TUT', 'CRC'].map((k) => [k, docRows.find((r) => r.ticket_type_id === id && r.kind === k)?.mode ?? 'optional']));
  return {
    projectTypes: pt.rows.map((p) => ({
      ...p, defaultTemplateId: ptt.rows.find((x) => x.project_type_id === p.id)?.template_type_id ?? null,
      ticketDefaults: ptd.rows.filter((x) => x.project_type_id === p.id).map((x) => ({ ticketTypeId: x.ticket_type_id, on: x.default_on, isDefault: x.is_default })),
      phaseDefaults: ppd.rows.filter((x) => x.project_type_id === p.id).map((x) => ({ phaseId: x.phase_id, enabled: x.enabled })),
    })),
    templates: tt.rows.map((t) => {
      const e = edges.rows.filter((x) => x.template_type_id === t.id);
      const gated = new Set(e.filter((x) => x.gated_reason).flatMap((x) => [x.from_phase_id, x.to_phase_id]));
      return {
        ...t,
        phases: tp.rows.filter((x) => x.template_type_id === t.id).map((x) => ({ id: x.phase_id, name: phases.get(x.phase_id)!.name, tone: phases.get(x.phase_id)!.tone, position: x.position, defaultOn: x.default_on, locked: gated.has(x.phase_id) })),
        ticketTypeIds: ttt.rows.filter((x) => x.template_type_id === t.id).map((x) => x.ticket_type_id),
        edges: e.map((x) => ({ ticketTypeId: x.ticket_type_id, from: x.from_phase_id, to: x.to_phase_id, gated: x.gated_reason })),
      };
    }),
    ticketTypes: ty.rows.map((t) => ({ ...t, fields: fields.get(t.id) ?? [], documents: docsOf(t.id) })),
  };
}

export function registerBuilderRoutes(app: FastifyInstance) {
  const admin = need('admin.projects');

  app.get('/api/project/template', { preHandler: admin }, async (req) => {
    const pid = req.user!.projectId!;
    const cfg = (await pool.query('SELECT project_type_id, template_type_id FROM projects WHERE id=$1', [pid])).rows[0];
    const phases = (await pool.query(
      `SELECT pp.phase_id AS "phaseId", pp.enabled, pp.position, (SELECT count(*)::int FROM tickets t WHERE t.project_id = pp.project_id AND t.current_state = ph.name) AS tickets
       FROM project_phases pp JOIN phases ph ON ph.id = pp.phase_id WHERE pp.project_id = $1 ORDER BY pp.position`, [pid])).rows;
    const types = (await pool.query(
      `SELECT pt.ticket_type_id AS "ticketTypeId", pt.enabled, pt.is_default AS "isDefault", (SELECT count(*)::int FROM tickets t WHERE t.project_id = pt.project_id AND t.ticket_type_id = pt.ticket_type_id) AS tickets
       FROM project_ticket_types pt WHERE pt.project_id = $1`, [pid])).rows;
    return { projectTypeId: cfg.project_type_id, templateTypeId: cfg.template_type_id, phases, ticketTypes: types, catalog: await builderCatalog() };
  });

  const Body = z.object({
    projectTypeId: z.number().int().positive(), templateTypeId: z.number().int().positive(),
    phases: z.array(z.object({ phaseId: z.number().int(), enabled: z.boolean() })).min(1).max(60),
    ticketTypes: z.array(z.object({ ticketTypeId: z.number().int(), enabled: z.boolean() })).min(1).max(40),
    defaultTicketTypeId: z.number().int(),
  });

  app.put('/api/project/template', { preHandler: admin }, async (req) => {
    const pid = req.user!.projectId!;
    const b = Body.parse(req.body);
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      if (!(await c.query('SELECT 1 FROM project_types WHERE id=$1', [b.projectTypeId])).rowCount) throw new DocError('Unknown project type', 400);
      if (!(await c.query('SELECT 1 FROM template_types WHERE id=$1', [b.templateTypeId])).rowCount) throw new DocError('Unknown methodology', 400);
      const tplPhases = (await c.query('SELECT tp.phase_id, tp.position, ph.name FROM template_phases tp JOIN phases ph ON ph.id=tp.phase_id WHERE tp.template_type_id=$1', [b.templateTypeId])).rows;
      const tplTypes = new Set((await c.query('SELECT ticket_type_id FROM template_ticket_types WHERE template_type_id=$1', [b.templateTypeId])).rows.map((r) => r.ticket_type_id as number));
      const bad = b.phases.find((p) => !tplPhases.some((t) => t.phase_id === p.phaseId));
      if (bad) throw new DocError('One of the phases does not belong to this methodology', 400);
      if (new Set(b.phases.map((p) => p.phaseId)).size !== tplPhases.length) throw new DocError('Every phase of the methodology must be listed as on or off', 400);
      if (b.ticketTypes.some((t) => !tplTypes.has(t.ticketTypeId))) throw new DocError('One of the ticket types is not available in this methodology', 400);
      const enabledTypes = b.ticketTypes.filter((t) => t.enabled);
      if (!enabledTypes.length) throw new DocError('Switch on at least one ticket type', 400);
      if (!enabledTypes.some((t) => t.ticketTypeId === b.defaultTicketTypeId)) throw new DocError('The default ticket type must be one that is switched on', 400);

      // Phases that carry document or approval steps cannot be switched off: the lifecycle would lose its sign-offs.
      const locked = (await c.query(
        `SELECT DISTINCT ph.id, ph.name FROM workflow_transitions w JOIN phases ph ON ph.id IN (w.from_phase_id, w.to_phase_id) WHERE w.template_type_id=$1 AND w.gated_reason IS NOT NULL`, [b.templateTypeId])).rows;
      const off = locked.filter((l) => b.phases.some((p) => p.phaseId === l.id && !p.enabled));
      if (off.length) throw new DocError(`${off.map((o) => o.name).join(', ')} cannot be switched off: documents and approvals depend on ${off.length > 1 ? 'them' : 'it'}`, 409);

      // Existing tickets must still make sense under the new methodology.
      const cur = (await c.query('SELECT template_type_id FROM projects WHERE id=$1', [pid])).rows[0];
      if (cur.template_type_id !== b.templateTypeId) {
        const custom = (await c.query('SELECT t.name FROM project_flows f JOIN ticket_types t ON t.id=f.ticket_type_id WHERE f.project_id=$1', [pid])).rows.map((r) => r.name as string);
        if (custom.length) throw new DocError(`${custom.join(', ')} ${custom.length > 1 ? 'have' : 'has'} a customised lifecycle. Restore ${custom.length > 1 ? 'them' : 'it'} to the standard one under Lifecycles before changing the methodology.`, 409);
        const names = new Set(tplPhases.map((t) => t.name as string));
        const stranded = (await c.query('SELECT DISTINCT current_state FROM tickets WHERE project_id=$1', [pid])).rows.map((r) => r.current_state as string).filter((s) => !names.has(s));
        if (stranded.length) throw new DocError(`Tickets are currently in ${stranded.join(', ')}, which the new methodology does not have. Move them on or close them first.`, 409, { stranded });
        const types = (await c.query('SELECT DISTINCT ticket_type_id FROM tickets WHERE project_id=$1', [pid])).rows.map((r) => r.ticket_type_id as number);
        if (types.some((t) => !tplTypes.has(t))) throw new DocError('This project has tickets of a kind the new methodology cannot carry.', 409);
      }

      await c.query('UPDATE projects SET project_type_id=$2, template_type_id=$3 WHERE id=$1', [pid, b.projectTypeId, b.templateTypeId]);
      await c.query('DELETE FROM project_phases WHERE project_id=$1', [pid]);
      for (const p of b.phases) await c.query('INSERT INTO project_phases (project_id, phase_id, position, enabled) VALUES ($1,$2,$3,$4)', [pid, p.phaseId, tplPhases.find((t) => t.phase_id === p.phaseId)!.position, p.enabled]);
      // keep rows for types that still have tickets, even when switched off, so they remain readable
      await c.query('DELETE FROM project_ticket_types WHERE project_id=$1', [pid]);
      for (const t of b.ticketTypes) await c.query('INSERT INTO project_ticket_types (project_id, ticket_type_id, enabled, is_default) VALUES ($1,$2,$3,$4)', [pid, t.ticketTypeId, t.enabled, t.enabled && t.ticketTypeId === b.defaultTicketTypeId]);

      // Every ticket type the project allows must have a place to start.
      for (const t of enabledTypes) {
        if (!(await c.query('SELECT 1 FROM next_phases($1,$2,NULL)', [pid, t.ticketTypeId])).rowCount) {
          const n = (await c.query('SELECT name FROM ticket_types WHERE id=$1', [t.ticketTypeId])).rows[0].name;
          throw new DocError(`${n} tickets would have no starting phase with these phases switched on`, 400);
        }
      }
      await c.query('COMMIT');
    } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
    await audit(req, 'project.template', { projectTypeId: b.projectTypeId, templateTypeId: b.templateTypeId, phasesOff: b.phases.filter((p) => !p.enabled).map((p) => p.phaseId), ticketTypes: b.ticketTypes.filter((t) => t.enabled).map((t) => t.ticketTypeId) });
    return { ok: true };
  });
}
