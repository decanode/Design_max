import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool } from '../db.js';
import { need } from '../rbac/auth.js';
import { audit } from '../rbac/audit.js';
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
  active: z.boolean().default(true),
  levels: z.array(Level).min(1).max(10),
});
type WorkflowIn = z.infer<typeof Workflow>;

/** This project's workflows, with approver names and how many active people each level currently resolves to. */
async function loadAll(projectId: string) {
  const wfs = (await pool.query(
    `SELECT w.* FROM approval_workflows w WHERE w.project_id = $1 AND NOT w.is_template ORDER BY w.created_at`, [projectId])).rows;
  const out = [];
  for (const w of wfs) {
    const levels = (await pool.query(
      `SELECT l.position, l.name, l.rule,
              COALESCE(json_agg(json_build_object('kind', a.kind, 'id', COALESCE(a.user_id::text, a.role_id::text), 'name', COALESCE(u.display_name, r.name)) ORDER BY a.id) FILTER (WHERE a.id IS NOT NULL), '[]') AS approvers
       FROM approval_levels l LEFT JOIN approval_level_approvers a ON a.level_id = l.id LEFT JOIN users u ON u.id = a.user_id LEFT JOIN roles r ON r.id = a.role_id
       WHERE l.workflow_id = $1 GROUP BY l.id ORDER BY l.position`, [w.id])).rows as LevelSnap[];
    for (const l of levels) { l.approvers.forEach((a) => { if (a.kind === 'role') a.id = Number(a.id); }); (l as any).eligible = (await resolveLevel(pool, l, projectId)).length; }
    out.push({ id: w.id, name: w.name, description: w.description, kinds: w.kinds, active: w.active, levels });
  }
  return out;
}

async function validate(b: WorkflowIn, projectId: string, selfId?: string) {
  if (b.active) {
    const clash = (await pool.query(
      `SELECT name FROM approval_workflows WHERE active AND NOT is_template AND id IS DISTINCT FROM $1 AND project_id = $2 AND kinds && $3::text[] LIMIT 1`, [selfId ?? null, projectId, b.kinds])).rows[0];
    if (clash) throw new DocError(`“${clash.name}” already covers ${b.kinds.join('/')} in this project. Turn it off or narrow one of them.`, 409);
  }
  const users = b.levels.flatMap((l) => l.approvers).filter((a) => a.kind === 'user').map((a) => String(a.id));
  const roles = b.levels.flatMap((l) => l.approvers).filter((a) => a.kind === 'role').map((a) => Number(a.id));
  if (users.length && (await pool.query('SELECT count(*)::int n FROM project_members m JOIN users u ON u.id = m.user_id WHERE m.project_id = $2 AND u.active AND m.user_id = ANY($1::uuid[])', [[...new Set(users)], projectId])).rows[0].n !== new Set(users).size) throw new DocError('Every chosen person must be an active member of this project', 400);
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

  app.get('/api/project/workflows', { preHandler: admin }, async (req) => loadAll(req.user!.projectId!));

  app.get('/api/project/workflows/options', { preHandler: admin }, async (req) => ({
    roles: (await pool.query('SELECT id, name FROM roles ORDER BY is_system DESC, id')).rows,
    users: (await pool.query(`SELECT u.id, u.display_name AS name, r.name AS role FROM project_members m JOIN users u ON u.id = m.user_id JOIN roles r ON r.id = m.role_id WHERE m.project_id = $1 AND u.active ORDER BY u.display_name`, [req.user!.projectId])).rows,
  }));

  app.post('/api/project/workflows', { preHandler: admin }, async (req, reply) => {
    const b = Workflow.parse(req.body);
    const projectId = req.user!.projectId!;
    await validate(b, projectId);
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      const id = (await c.query('INSERT INTO approval_workflows (name, description, kinds, project_id, active) VALUES ($1,$2,$3,$4,$5) RETURNING id', [b.name, b.description, b.kinds, projectId, b.active])).rows[0].id;
      await save(c, id, b);
      await c.query('COMMIT');
      await audit(req, 'workflow.create', { id, name: b.name, levels: b.levels.length });
      return reply.code(201).send({ id });
    } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
  });

  /** Replaces the whole definition. Requests already in flight keep the copy they started with. */
  app.put('/api/project/workflows/:id', { preHandler: admin }, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const b = Workflow.parse(req.body);
    const projectId = req.user!.projectId!;
    if (!(await pool.query('SELECT 1 FROM approval_workflows WHERE id=$1 AND project_id=$2 AND NOT is_template', [id, projectId])).rowCount) throw new DocError('Workflow not found', 404);
    await validate(b, projectId, id);
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query('UPDATE approval_workflows SET name=$2, description=$3, kinds=$4, active=$5, updated_at=now() WHERE id=$1', [id, b.name, b.description, b.kinds, b.active]);
      await save(c, id, b);
      await c.query('COMMIT');
      await audit(req, 'workflow.update', { id, name: b.name, levels: b.levels.length, active: b.active });
      return { ok: true };
    } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
  });

  app.delete('/api/project/workflows/:id', { preHandler: admin }, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const w = (await pool.query('SELECT name FROM approval_workflows WHERE id=$1 AND project_id=$2 AND NOT is_template', [id, req.user!.projectId])).rows[0];
    if (!w) throw new DocError('Workflow not found', 404);
    await pool.query('DELETE FROM approval_workflows WHERE id=$1', [id]);
    await audit(req, 'workflow.delete', { id, name: w.name });
    return { ok: true };
  });
}
