import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type pg from 'pg';
import { pool } from '../db.js';
import { need } from '../rbac/auth.js';
import { audit } from '../rbac/audit.js';
import { DocError } from '../errors.js';

const Tone = z.enum(['intake', 'spec', 'build', 'review', 'done']);
const StatusName = z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9 .&/()-]{0,58}$/, 'Plain words only, up to 60 characters');

interface Status { id: number; name: string; tone: string; own: boolean; tickets: number }
interface Edge { from: number | null; to: number; gated: string | null }
export interface Lifecycle { ticketTypeId: number; custom: boolean; statuses: Status[]; edges: Edge[] }

/**
 * The lifecycle a ticket type really follows in this project: its own, when the project customised it, otherwise the methodology's flow
 * as it stands with the project's switched-off phases bypassed (read through the same database function that enforces it).
 */
export async function effectiveLifecycle(db: Pick<pg.Pool, 'query'>, projectId: string, typeId: number): Promise<Lifecycle> {
  const custom = !!(await db.query('SELECT 1 FROM project_flows WHERE project_id=$1 AND ticket_type_id=$2', [projectId, typeId])).rowCount;
  const counts = new Map<string, number>((await db.query('SELECT current_state, count(*)::int n FROM tickets WHERE project_id=$1 AND ticket_type_id=$2 GROUP BY 1', [projectId, typeId])).rows.map((r) => [r.current_state, r.n]));
  const phases = new Map<string, { id: number; tone: string; own: boolean }>((await db.query('SELECT id, name, tone, project_id FROM phases WHERE project_id IS NULL OR project_id=$1', [projectId])).rows.map((r) => [r.name, { id: r.id, tone: r.tone, own: r.project_id !== null }]));
  const info = (name: string): Status => { const p = phases.get(name)!; return { id: p.id, name, tone: p.tone, own: p.own, tickets: counts.get(name) ?? 0 }; };
  if (custom) {
    const st = (await db.query('SELECT ph.name FROM project_flow_phases fp JOIN phases ph ON ph.id=fp.phase_id WHERE fp.project_id=$1 AND fp.ticket_type_id=$2 ORDER BY fp.position', [projectId, typeId])).rows.map((r) => r.name as string);
    const edges = (await db.query('SELECT from_phase_id AS "from", to_phase_id AS "to", gated_reason AS gated FROM project_flow_edges WHERE project_id=$1 AND ticket_type_id=$2', [projectId, typeId])).rows as Edge[];
    return { ticketTypeId: typeId, custom, statuses: st.map(info), edges };
  }
  const order = (await db.query('SELECT ph.name FROM project_phases pp JOIN phases ph ON ph.id=pp.phase_id WHERE pp.project_id=$1 AND pp.enabled ORDER BY pp.position', [projectId])).rows.map((r) => r.name as string);
  const next = async (from: string | null) => (await db.query('SELECT to_phase, gated_reason FROM next_phases($1,$2,$3)', [projectId, typeId, from])).rows as { to_phase: string; gated_reason: string | null }[];
  const edges: Edge[] = []; const seen = new Set<string>(); const queue: (string | null)[] = [null];
  while (queue.length) {
    const f = queue.shift()!;
    for (const n of await next(f)) {
      if (!phases.has(n.to_phase)) continue;
      edges.push({ from: f === null ? null : phases.get(f)!.id, to: phases.get(n.to_phase)!.id, gated: n.gated_reason });
      if (!seen.has(n.to_phase)) { seen.add(n.to_phase); queue.push(n.to_phase); }
    }
  }
  const names = [...seen].sort((a, b) => order.indexOf(a) - order.indexOf(b));
  return { ticketTypeId: typeId, custom, statuses: names.map(info), edges };
}

const Body = z.object({
  statuses: z.array(z.number().int()).min(2).max(40),
  edges: z.array(z.object({ from: z.number().int().nullable(), to: z.number().int() })).max(400),
});

/** A lifecycle must be usable: tickets can start, every status can be reached, and nothing is a dead end unless it is a finishing status. */
function checkShape(statuses: Status[], edges: Edge[]) {
  const ids = new Set(statuses.map((s) => s.id));
  const name = (id: number) => statuses.find((s) => s.id === id)?.name ?? '';
  if (!edges.some((e) => e.from === null)) throw new DocError('Choose where a new ticket starts', 400);
  const reach = new Set<number>(); const queue = edges.filter((e) => e.from === null).map((e) => e.to);
  while (queue.length) { const t = queue.shift()!; if (reach.has(t)) continue; reach.add(t); queue.push(...edges.filter((e) => e.from === t).map((e) => e.to)); }
  const lost = statuses.filter((s) => !reach.has(s.id));
  if (lost.length) throw new DocError(`${lost.map((s) => s.name).join(', ')} can never be reached. Add a move into ${lost.length > 1 ? 'them' : 'it'}, or remove ${lost.length > 1 ? 'them' : 'it'}.`, 400);
  const stuck = statuses.filter((s) => s.tone !== 'done' && !edges.some((e) => e.from === s.id));
  if (stuck.length) throw new DocError(`${stuck.map((s) => s.name).join(', ')} ${stuck.length > 1 ? 'are dead ends' : 'is a dead end'}: add a move out of ${stuck.length > 1 ? 'them' : 'it'}, or make ${stuck.length > 1 ? 'them' : 'it'} a finishing status.`, 400);
  if (!statuses.some((s) => s.tone === 'done')) throw new DocError('A lifecycle needs at least one finishing status, so tickets can be completed', 400);
  for (const e of edges) if (e.from !== null && !ids.has(e.from) || !ids.has(e.to) || e.from === e.to) throw new DocError(`Invalid move involving ${name(e.to)}`, 400);
}

export function registerFlowRoutes(app: FastifyInstance) {
  const admin = need('admin.projects');
  const tx = async <T>(fn: (c: pg.PoolClient) => Promise<T>) => {
    const c = await pool.connect();
    try { await c.query('BEGIN'); const r = await fn(c); await c.query('COMMIT'); return r; } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
  };
  const TypeP = z.object({ typeId: z.coerce.number().int().positive() });

  /** Every ticket type the project uses, with the lifecycle it follows, and the statuses that can be added to one. */
  app.get('/api/project/lifecycles', { preHandler: admin }, async (req) => {
    const pid = req.user!.projectId!;
    const types = (await pool.query(
      `SELECT t.id, t.key, t.name, t.short, pt.enabled FROM project_ticket_types pt JOIN ticket_types t ON t.id=pt.ticket_type_id
       WHERE pt.project_id=$1 AND (pt.enabled OR EXISTS (SELECT 1 FROM tickets k WHERE k.project_id=pt.project_id AND k.ticket_type_id=pt.ticket_type_id)) ORDER BY t.sort`, [pid])).rows;
    const lifecycles = await Promise.all(types.map(async (t) => ({ ...t, ...(await effectiveLifecycle(pool, pid, t.id)) })));
    const statuses = (await pool.query(
      `SELECT ph.id, ph.name, ph.tone, ph.project_id IS NOT NULL AS own,
              (ph.project_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM project_flow_phases f WHERE f.phase_id=ph.id)
                 AND NOT EXISTS (SELECT 1 FROM tickets k WHERE k.current_state=ph.name) AND NOT EXISTS (SELECT 1 FROM ticket_transitions x WHERE x.from_state=ph.name OR x.to_state=ph.name)) AS removable
       FROM phases ph WHERE ph.project_id IS NULL OR ph.project_id=$1 ORDER BY ph.project_id IS NOT NULL, ph.id`, [pid])).rows;
    const tpl = (await pool.query('SELECT tt.name FROM projects p JOIN template_types tt ON tt.id=p.template_type_id WHERE p.id=$1', [pid])).rows[0];
    return { methodology: tpl?.name ?? null, lifecycles, statuses };
  });

  /** Saves a customised lifecycle for one ticket type. */
  app.put('/api/project/lifecycles/:typeId', { preHandler: admin }, async (req) => {
    const pid = req.user!.projectId!; const { typeId } = TypeP.parse(req.params); const b = Body.parse(req.body);
    const out = await tx(async (c) => {
      const ty = (await c.query('SELECT t.name FROM project_ticket_types pt JOIN ticket_types t ON t.id=pt.ticket_type_id WHERE pt.project_id=$1 AND pt.ticket_type_id=$2', [pid, typeId])).rows[0];
      if (!ty) throw new DocError('This project does not use that ticket type', 404);
      if (new Set(b.statuses).size !== b.statuses.length) throw new DocError('A status is listed twice', 400);
      const rows = (await c.query('SELECT id, name, tone, project_id FROM phases WHERE id = ANY($1) AND (project_id IS NULL OR project_id=$2)', [b.statuses, pid])).rows;
      if (rows.length !== b.statuses.length) throw new DocError('Unknown status', 400);
      const statuses: Status[] = b.statuses.map((id) => { const r = rows.find((x) => x.id === id); return { id, name: r.name, tone: r.tone, own: r.project_id !== null, tickets: 0 }; });
      const dup = new Set(b.edges.map((e) => `${e.from ?? 0}>${e.to}`)); if (dup.size !== b.edges.length) throw new DocError('A move is listed twice', 400);
      // steps that belong to documents and approvals stay exactly as they are, so a customised lifecycle cannot skip a sign-off
      const before = await effectiveLifecycle(c, pid, typeId);
      const gated = before.edges.filter((e) => e.gated);
      const edges: Edge[] = b.edges.map((e) => ({ ...e, gated: gated.find((g) => g.from === e.from && g.to === e.to)?.gated ?? null }));
      for (const g of gated) {
        if (!b.statuses.includes(g.to) || (g.from !== null && !b.statuses.includes(g.from))) throw new DocError(`Statuses that carry documents and approvals cannot be removed (${before.statuses.filter((s) => s.id === g.to || s.id === g.from).map((s) => s.name).join(' → ')})`, 409);
        if (!edges.some((e) => e.from === g.from && e.to === g.to)) edges.push(g);
      }
      checkShape(statuses, edges);
      const names = statuses.map((s) => s.name);
      const stranded = (await c.query('SELECT DISTINCT current_state FROM tickets WHERE project_id=$1 AND ticket_type_id=$2', [pid, typeId])).rows.map((r) => r.current_state as string).filter((s) => !names.includes(s));
      if (stranded.length) throw new DocError(`${ty.name} tickets are currently in ${stranded.join(', ')}. Keep ${stranded.length > 1 ? 'those statuses' : 'that status'}, or move the tickets on first.`, 409, { stranded });
      await c.query('INSERT INTO project_flows (project_id, ticket_type_id) VALUES ($1,$2) ON CONFLICT (project_id, ticket_type_id) DO UPDATE SET updated_at=now()', [pid, typeId]);
      await c.query('DELETE FROM project_flow_edges WHERE project_id=$1 AND ticket_type_id=$2', [pid, typeId]);
      await c.query('DELETE FROM project_flow_phases WHERE project_id=$1 AND ticket_type_id=$2', [pid, typeId]);
      let pos = 0; for (const s of statuses) await c.query('INSERT INTO project_flow_phases (project_id, ticket_type_id, phase_id, position) VALUES ($1,$2,$3,$4)', [pid, typeId, s.id, ++pos]);
      for (const e of edges) await c.query('INSERT INTO project_flow_edges (project_id, ticket_type_id, from_phase_id, to_phase_id, gated_reason) VALUES ($1,$2,$3,$4,$5)', [pid, typeId, e.from, e.to, e.gated]);
      return { name: ty.name as string, statuses: names };
    });
    await audit(req, 'project.lifecycle', { ticketTypeId: typeId, type: out.name, statuses: out.statuses });
    return { ok: true };
  });

  /** Goes back to the methodology's standard lifecycle for this ticket type. */
  app.delete('/api/project/lifecycles/:typeId', { preHandler: admin }, async (req) => {
    const pid = req.user!.projectId!; const { typeId } = TypeP.parse(req.params);
    await tx(async (c) => {
      if (!(await c.query('SELECT 1 FROM project_flows WHERE project_id=$1 AND ticket_type_id=$2', [pid, typeId])).rowCount) throw new DocError('This ticket type already follows the standard lifecycle', 409);
      await c.query('DELETE FROM project_flows WHERE project_id=$1 AND ticket_type_id=$2', [pid, typeId]);
      const std = await effectiveLifecycle(c, pid, typeId);
      const names = std.statuses.map((s) => s.name);
      const stranded = (await c.query('SELECT DISTINCT current_state FROM tickets WHERE project_id=$1 AND ticket_type_id=$2', [pid, typeId])).rows.map((r) => r.current_state as string).filter((s) => !names.includes(s));
      if (stranded.length) throw new DocError(`Tickets are in ${stranded.join(', ')}, which the standard lifecycle does not have. Move them on first.`, 409, { stranded });
    });
    await audit(req, 'project.lifecycle.reset', { ticketTypeId: typeId });
    return { ok: true };
  });

  /** A status of the project's own (for example "Awaiting vendor"). An existing standard status of that name is simply reused. */
  app.post('/api/project/statuses', { preHandler: admin }, async (req, reply) => {
    const pid = req.user!.projectId!; const b = z.object({ name: StatusName, tone: Tone }).parse(req.body);
    const found = (await pool.query('SELECT id, name, tone, project_id FROM phases WHERE lower(name)=lower($1)', [b.name])).rows[0];
    if (found) {
      if (found.project_id === null || found.project_id === pid) return reply.code(200).send({ id: found.id, name: found.name, tone: found.tone, own: found.project_id !== null, existing: true });
      throw new DocError('That status name is taken. Choose a more specific name.', 409);
    }
    const id = (await pool.query('INSERT INTO phases (name, tone, project_id) VALUES ($1,$2,$3) RETURNING id', [b.name, b.tone, pid])).rows[0].id as number;
    await audit(req, 'project.status', { id, name: b.name });
    return reply.code(201).send({ id, name: b.name, tone: b.tone, own: true, existing: false });
  });
  app.delete('/api/project/statuses/:id', { preHandler: admin }, async (req) => {
    const pid = req.user!.projectId!; const { id } = z.object({ id: z.coerce.number().int().positive() }).parse(req.params);
    const s = (await pool.query('SELECT name FROM phases WHERE id=$1 AND project_id=$2', [id, pid])).rows[0];
    if (!s) throw new DocError('Status not found, or it belongs to the standard set', 404);
    const used = (await pool.query(
      `SELECT (EXISTS (SELECT 1 FROM project_flow_phases WHERE phase_id=$1) OR EXISTS (SELECT 1 FROM tickets WHERE current_state=$2) OR EXISTS (SELECT 1 FROM ticket_transitions WHERE from_state=$2 OR to_state=$2)) AS used`, [id, s.name])).rows[0].used;
    if (used) throw new DocError('This status is used by a lifecycle or by tickets, so it cannot be deleted', 409);
    await pool.query('DELETE FROM phases WHERE id=$1', [id]);
    await audit(req, 'project.status.delete', { id, name: s.name });
    return { ok: true };
  });
}
