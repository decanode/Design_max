import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool } from '../db.js';
import { need } from '../rbac/auth.js';
import { DocError } from '../errors.js';
import { resolveLevel, type LevelSnap } from './engine.js';

const Approver = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('user'), id: z.string().uuid() }),
  z.object({ kind: z.literal('role'), id: z.number().int() }),
]);
const Level = z.object({
  name: z.string().trim().min(1).max(30),
  rule: z.enum(['any', 'all']),
  approvers: z.array(Approver).min(1).max(20),
});
const Workflow = z.object({
  name: z.string().trim().min(2).max(80),
  description: z.string().max(300).default(''),
  kinds: z.array(z.enum(['FS', 'TS'])).min(1).max(2),
  projectId: z.string().uuid().nullable().default(null),
  active: z.boolean().default(true),
  levels: z.array(Level).min(1).max(10),
});
type WorkflowIn = z.infer<typeof Workflow>;

/** Full workflow with approver names and how many active people each level currently resolves to. */
async function loadAll(id?: string) {
  const wfs = (await pool.query(
    `SELECT w.*, p.name AS project FROM approval_workflows w LEFT JOIN projects p ON p.id = w.project_id ${id ? 'WHERE w.id = $1' : ''} ORDER BY w.is_system DESC, w.created_at`, id ? [id] : [])).rows;
  const out = [];
  for (const w of wfs) {
    const levels = (await pool.query(
      `SELECT l.position, l.name, l.rule,
              COALESCE(json_agg(json_build_object('kind', a.kind, 'id', COALESCE(a.user_id::text, a.role_id::text), 'name', COALESCE(u.display_name, r.name)) ORDER BY a.id) FILTER (WHERE a.id IS NOT NULL), '[]') AS approvers
       FROM approval_levels l LEFT JOIN approval_level_approvers a ON a.level_id = l.id LEFT JOIN users u ON u.id = a.user_id LEFT JOIN roles r ON r.id = a.role_id
       WHERE l.workflow_id = $1 GROUP BY l.id ORDER BY l.position`, [w.id])).rows as LevelSnap[];
    for (const l of levels) { l.approvers.forEach((a) => { if (a.kind === 'role') a.id = Number(a.id); }); (l as any).eligible = (await resolveLevel(pool, l)).length; }
    out.push({ id: w.id, name: w.name, description: w.description, kinds: w.kinds, projectId: w.project_id, project: w.project, active: w.active, isSystem: w.is_system, levels });
  }
  return out;
}

async function validate(b: WorkflowIn, selfId?: string) {
  if (b.active) {
    const clash = (await pool.query(
      `SELECT name FROM approval_workflows WHERE active AND id IS DISTINCT FROM $1 AND project_id IS NOT DISTINCT FROM $2 AND kinds && $3::text[] LIMIT 1`, [selfId ?? null, b.projectId, b.kinds])).rows[0];
    if (clash) throw new DocError(`“${clash.name}” already covers ${b.kinds.join('/')} for ${b.projectId ? 'this project' : 'all projects'}. Turn it off or narrow one of them.`, 409);
  }
  if (b.projectId && !(await pool.query('SELECT 1 FROM projects WHERE id=$1', [b.projectId])).rowCount) throw new DocError('Project not found', 404);
  const users = b.levels.flatMap((l) => l.approvers).filter((a) => a.kind === 'user').map((a) => String(a.id));
  const roles = b.levels.flatMap((l) => l.approvers).filter((a) => a.kind === 'role').map((a) => Number(a.id));
  if (users.length && (await pool.query('SELECT count(*)::int n FROM users WHERE active AND id = ANY($1::uuid[])', [[...new Set(users)]])).rows[0].n !== new Set(users).size) throw new DocError('One of the chosen people is not an active user', 400);
  if (roles.length && (await pool.query('SELECT count(*)::int n FROM roles WHERE id = ANY($1::int[])', [[...new Set(roles)]])).rows[0].n !== new Set(roles).size) throw new DocError('One of the chosen roles does not exist', 400);
  const names = b.levels.map((l) => l.name.toLowerCase());
  if (new Set(names).size !== names.length) throw new DocError('Each level needs its own name', 400);
}

async function save(c: import('pg').PoolClient, id: string, b: WorkflowIn) {
  await c.query('DELETE FROM approval_levels WHERE workflow_id=$1', [id]);
  for (const [i, l] of b.levels.entries()) {
    const lid = (await c.query('INSERT INTO approval_levels (workflow_id, position, name, rule) VALUES ($1,$2,$3,$4) RETURNING id', [id, i + 1, l.name, l.rule])).rows[0].id;
    for (const a of l.approvers)
      await c.query('INSERT INTO approval_level_approvers (level_id, kind, user_id, role_id) VALUES ($1,$2,$3,$4)', [lid, a.kind, a.kind === 'user' ? a.id : null, a.kind === 'role' ? a.id : null]);
  }
}

export function registerWorkflowRoutes(app: FastifyInstance) {
  const admin = need('admin.workflows');

  app.get('/api/admin/workflows', { preHandler: admin }, async () => loadAll());

  app.get('/api/admin/workflows/options', { preHandler: admin }, async () => ({
    roles: (await pool.query('SELECT id, name FROM roles ORDER BY is_system DESC, id')).rows,
    users: (await pool.query(`SELECT u.id, u.display_name AS name, r.name AS role FROM users u JOIN roles r ON r.id = u.role_id WHERE u.active ORDER BY u.display_name`)).rows,
    projects: (await pool.query('SELECT id, name FROM projects ORDER BY name')).rows,
  }));

  app.post('/api/admin/workflows', { preHandler: admin }, async (req, reply) => {
    const b = Workflow.parse(req.body);
    await validate(b);
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      const id = (await c.query('INSERT INTO approval_workflows (name, description, kinds, project_id, active) VALUES ($1,$2,$3,$4,$5) RETURNING id', [b.name, b.description, b.kinds, b.projectId, b.active])).rows[0].id;
      await save(c, id, b);
      await c.query('COMMIT');
      await pool.query('INSERT INTO audit_log (actor_id, action, detail) VALUES ($1,$2,$3)', [req.user!.id, 'workflow.create', JSON.stringify({ id, name: b.name, levels: b.levels.length })]);
      return reply.code(201).send({ id });
    } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
  });

  /** Replaces the whole definition. Requests already in flight keep the copy they started with. */
  app.put('/api/admin/workflows/:id', { preHandler: admin }, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const b = Workflow.parse(req.body);
    if (!(await pool.query('SELECT 1 FROM approval_workflows WHERE id=$1', [id])).rowCount) throw new DocError('Workflow not found', 404);
    await validate(b, id);
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query('UPDATE approval_workflows SET name=$2, description=$3, kinds=$4, project_id=$5, active=$6, updated_at=now() WHERE id=$1', [id, b.name, b.description, b.kinds, b.projectId, b.active]);
      await save(c, id, b);
      await c.query('COMMIT');
      await pool.query('INSERT INTO audit_log (actor_id, action, detail) VALUES ($1,$2,$3)', [req.user!.id, 'workflow.update', JSON.stringify({ id, name: b.name, levels: b.levels.length, active: b.active })]);
      return { ok: true };
    } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
  });

  app.delete('/api/admin/workflows/:id', { preHandler: admin }, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const w = (await pool.query('SELECT name, is_system FROM approval_workflows WHERE id=$1', [id])).rows[0];
    if (!w) throw new DocError('Workflow not found', 404);
    if (w.is_system) throw new DocError('The built-in workflow can be edited or switched off, but not deleted', 400);
    await pool.query('DELETE FROM approval_workflows WHERE id=$1', [id]);
    await pool.query('INSERT INTO audit_log (actor_id, action, detail) VALUES ($1,$2,$3)', [req.user!.id, 'workflow.delete', JSON.stringify({ id, name: w.name })]);
    return { ok: true };
  });
}
