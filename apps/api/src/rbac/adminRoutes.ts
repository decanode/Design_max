import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { pool } from '../db.js';
import { need, needAny } from './auth.js';
import { ADMIN_ROLE, ALL_KEYS, CATALOG, isKnownKey } from './permissions.js';

async function setStacks(c: import('pg').PoolClient, projectId: string, stackIds: number[]) {
  const ids = [...new Set(stackIds)];
  if (ids.length && (await c.query('SELECT count(*)::int n FROM tech_stacks WHERE id = ANY($1)', [ids])).rows[0].n !== ids.length) throw new AdminError('Unknown technology stack');
  await c.query('DELETE FROM project_stacks WHERE project_id=$1', [projectId]);
  if (ids.length) await c.query('INSERT INTO project_stacks (project_id, stack_id) SELECT $1, unnest($2::int[])', [projectId, ids]);
}

class AdminError extends Error { constructor(m: string, public status = 400) { super(m); } }

const audit = (req: FastifyRequest, action: string, detail: Record<string, unknown>) =>
  pool.query('INSERT INTO audit_log (actor_id, action, detail) VALUES ($1,$2,$3)', [req.user!.id, action, JSON.stringify(detail)]);

async function roleRow(id: number) {
  const r = (await pool.query('SELECT * FROM roles WHERE id=$1', [id])).rows[0];
  if (!r) throw new AdminError('Role not found', 404);
  return r;
}

/** Never lets the system end up with no active Admin. Call inside the same request after the change is staged. */
async function assertAdminRemains(exceptUserId?: string, willStayAdmin = false) {
  if (willStayAdmin) return;
  const n = (await pool.query(
    `SELECT count(*)::int c FROM users u JOIN roles r ON r.id=u.role_id WHERE r.name=$1 AND u.active AND ($2::uuid IS NULL OR u.id <> $2)`, [ADMIN_ROLE, exceptUserId ?? null])).rows[0].c;
  if (n < 1) throw new AdminError('At least one active Admin must remain');
}

const KEYWORDS = z.array(z.string().trim().min(1).max(40)).max(60);
const projectRows = async () => (await pool.query(
  `SELECT p.id, p.name, p.created_at,
          COALESCE((SELECT json_agg(json_build_object('id', s.id, 'name', s.name) ORDER BY s.name) FROM project_stacks ps JOIN tech_stacks s ON s.id = ps.stack_id WHERE ps.project_id = p.id), '[]') AS stacks,
          (SELECT count(*)::int FROM tickets t WHERE t.project_id = p.id) AS tickets
   FROM projects p ORDER BY p.created_at`)).rows;

export function registerAdminRoutes(app: FastifyInstance) {
  // ---- technology stacks: what the AI is allowed to talk about, per project
  app.get('/api/admin/stacks', { preHandler: need('admin.projects') }, async () =>
    (await pool.query(`SELECT s.*, (SELECT count(*)::int FROM project_stacks ps WHERE ps.stack_id = s.id) AS projects FROM tech_stacks s ORDER BY s.name`)).rows);

  app.post('/api/admin/stacks', { preHandler: need('admin.projects') }, async (req, reply) => {
    const b = z.object({ name: z.string().trim().min(1).max(40), description: z.string().max(400).default(''), keywords: KEYWORDS.default([]) }).parse(req.body);
    if ((await pool.query('SELECT 1 FROM tech_stacks WHERE lower(name)=lower($1)', [b.name])).rowCount) throw new AdminError('A stack with that name already exists', 409);
    const id = (await pool.query('INSERT INTO tech_stacks (name, description, keywords) VALUES ($1,$2,$3) RETURNING id', [b.name, b.description, b.keywords])).rows[0].id;
    await audit(req, 'stack.create', { id, name: b.name });
    return reply.code(201).send({ id });
  });

  app.patch('/api/admin/stacks/:id', { preHandler: need('admin.projects') }, async (req) => {
    const { id } = z.object({ id: z.coerce.number().int() }).parse(req.params);
    const b = z.object({ description: z.string().max(400).optional(), keywords: KEYWORDS.optional() }).parse(req.body);
    const r = await pool.query('UPDATE tech_stacks SET description=COALESCE($2,description), keywords=COALESCE($3,keywords) WHERE id=$1 RETURNING name', [id, b.description ?? null, b.keywords ?? null]);
    if (!r.rowCount) throw new AdminError('Stack not found', 404);
    await audit(req, 'stack.update', { id, name: r.rows[0].name });
    return { ok: true };
  });

  app.delete('/api/admin/stacks/:id', { preHandler: need('admin.projects') }, async (req) => {
    const { id } = z.object({ id: z.coerce.number().int() }).parse(req.params);
    if ((await pool.query('SELECT 1 FROM project_stacks WHERE stack_id=$1', [id])).rowCount) throw new AdminError('Remove this stack from its projects first', 409);
    const r = await pool.query('DELETE FROM tech_stacks WHERE id=$1 RETURNING name', [id]);
    if (!r.rowCount) throw new AdminError('Stack not found', 404);
    await audit(req, 'stack.delete', { id, name: r.rows[0].name });
    return { ok: true };
  });

  // ---- projects and their allowed stacks
  app.get('/api/admin/projects', { preHandler: need('admin.projects') }, async () => projectRows());

  app.post('/api/admin/projects', { preHandler: need('admin.projects') }, async (req, reply) => {
    const b = z.object({ name: z.string().trim().min(2).max(80), stackIds: z.array(z.number().int()).default([]) }).parse(req.body);
    if ((await pool.query('SELECT 1 FROM projects WHERE lower(name)=lower($1)', [b.name])).rowCount) throw new AdminError('A project with that name already exists', 409);
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      const id = (await c.query('INSERT INTO projects (name) VALUES ($1) RETURNING id', [b.name])).rows[0].id as string;
      await setStacks(c, id, b.stackIds);
      await c.query('COMMIT');
      await audit(req, 'project.create', { id, name: b.name, stackIds: b.stackIds });
      return reply.code(201).send({ id });
    } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
  });

  app.put('/api/admin/projects/:id/stacks', { preHandler: need('admin.projects') }, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const { stackIds } = z.object({ stackIds: z.array(z.number().int()) }).parse(req.body);
    const p = (await pool.query('SELECT name FROM projects WHERE id=$1', [id])).rows[0];
    if (!p) throw new AdminError('Project not found', 404);
    const c = await pool.connect();
    try { await c.query('BEGIN'); await setStacks(c, id, stackIds); await c.query('COMMIT'); }
    catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
    await audit(req, 'project.stacks', { id, name: p.name, stackIds });
    return { ok: true };
  });

  app.get('/api/admin/catalog', { preHandler: needAny('admin.roles', 'admin.users', 'admin.projects', 'admin.workflows') }, async () => CATALOG);

  app.get('/api/admin/roles', { preHandler: needAny('admin.roles', 'admin.users', 'admin.projects', 'admin.workflows') }, async () => {
    const roles = (await pool.query(
      `SELECT r.id, r.name, r.description, r.is_system,
              (SELECT count(*)::int FROM users u WHERE u.role_id = r.id AND u.active) AS users,
              COALESCE((SELECT array_agg(permission ORDER BY permission) FROM role_permissions p WHERE p.role_id = r.id), '{}') AS permissions
       FROM roles r ORDER BY r.is_system DESC, r.id`)).rows;
    return roles.map((r) => ({ ...r, locked: r.name === ADMIN_ROLE, permissions: r.name === ADMIN_ROLE ? ALL_KEYS : r.permissions }));
  });

  app.post('/api/admin/roles', { preHandler: need('admin.roles') }, async (req, reply) => {
    const b = z.object({ name: z.string().trim().min(2).max(40), description: z.string().max(300).default(''), copyFromRoleId: z.number().int().optional() }).parse(req.body);
    if ((await pool.query('SELECT 1 FROM roles WHERE lower(name)=lower($1)', [b.name])).rowCount) throw new AdminError('A role with that name already exists', 409);
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      const id = (await c.query('INSERT INTO roles (name, description) VALUES ($1,$2) RETURNING id', [b.name, b.description])).rows[0].id as number;
      if (b.copyFromRoleId) {
        const src = await roleRow(b.copyFromRoleId);
        if (src.name === ADMIN_ROLE) await c.query('INSERT INTO role_permissions (role_id, permission) SELECT $1, unnest($2::text[])', [id, ALL_KEYS]);
        else await c.query('INSERT INTO role_permissions (role_id, permission) SELECT $1, permission FROM role_permissions WHERE role_id=$2', [id, b.copyFromRoleId]);
      }
      await c.query('COMMIT');
      await audit(req, 'role.create', { id, name: b.name, copyFrom: b.copyFromRoleId ?? null });
      return reply.code(201).send({ id });
    } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
  });

  app.patch('/api/admin/roles/:id', { preHandler: need('admin.roles') }, async (req) => {
    const { id } = z.object({ id: z.coerce.number().int() }).parse(req.params);
    const b = z.object({ name: z.string().trim().min(2).max(40).optional(), description: z.string().max(300).optional() }).parse(req.body);
    const r = await roleRow(id);
    if (b.name && r.is_system && b.name !== r.name) throw new AdminError('Built-in roles cannot be renamed');
    if (b.name && (await pool.query('SELECT 1 FROM roles WHERE lower(name)=lower($1) AND id<>$2', [b.name, id])).rowCount) throw new AdminError('A role with that name already exists', 409);
    await pool.query('UPDATE roles SET name=COALESCE($2,name), description=COALESCE($3,description) WHERE id=$1', [id, b.name ?? null, b.description ?? null]);
    await audit(req, 'role.update', { id, ...b });
    return { ok: true };
  });

  /** Replaces a role's permission set. */
  app.put('/api/admin/roles/:id/permissions', { preHandler: need('admin.roles') }, async (req) => {
    const { id } = z.object({ id: z.coerce.number().int() }).parse(req.params);
    const { permissions } = z.object({ permissions: z.array(z.string()) }).parse(req.body);
    const r = await roleRow(id);
    if (r.name === ADMIN_ROLE) throw new AdminError('The Admin role always has every permission');
    const unknown = permissions.filter((p) => !isKnownKey(p));
    if (unknown.length) throw new AdminError(`Unknown permissions: ${unknown.join(', ')}`);
    const before = (await pool.query('SELECT permission FROM role_permissions WHERE role_id=$1', [id])).rows.map((x) => x.permission as string);
    const next = [...new Set(permissions)];
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query('DELETE FROM role_permissions WHERE role_id=$1', [id]);
      if (next.length) await c.query('INSERT INTO role_permissions (role_id, permission) SELECT $1, unnest($2::text[])', [id, next]);
      await c.query('COMMIT');
    } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
    await audit(req, 'role.permissions', { id, name: r.name, added: next.filter((p) => !before.includes(p)), removed: before.filter((p) => !next.includes(p)) });
    return { permissions: next };
  });

  app.delete('/api/admin/roles/:id', { preHandler: need('admin.roles') }, async (req) => {
    const { id } = z.object({ id: z.coerce.number().int() }).parse(req.params);
    const r = await roleRow(id);
    if (r.is_system) throw new AdminError('Built-in roles cannot be deleted');
    if ((await pool.query('SELECT 1 FROM users WHERE role_id=$1', [id])).rowCount) throw new AdminError('Reassign this role\'s users first', 409);
    if ((await pool.query('SELECT 1 FROM approval_level_approvers WHERE role_id=$1', [id])).rowCount) throw new AdminError('This role is used in an approval workflow. Change the workflow first', 409);
    await pool.query('DELETE FROM roles WHERE id=$1', [id]);
    await audit(req, 'role.delete', { id, name: r.name });
    return { ok: true };
  });

  app.get('/api/admin/users', { preHandler: need('admin.users') }, async () =>
    (await pool.query(`SELECT u.id, u.email, u.display_name AS name, u.active, u.role_id, r.name AS role, u.created_at FROM users u JOIN roles r ON r.id=u.role_id ORDER BY u.active DESC, u.display_name`)).rows);

  app.post('/api/admin/users', { preHandler: need('admin.users') }, async (req, reply) => {
    const b = z.object({ email: z.string().email(), name: z.string().trim().min(1).max(80), roleId: z.number().int() }).parse(req.body);
    await roleRow(b.roleId);
    const email = b.email.toLowerCase();
    if ((await pool.query('SELECT 1 FROM users WHERE email=$1', [email])).rowCount) throw new AdminError('A user with that email already exists', 409);
    const id = (await pool.query('INSERT INTO users (email, display_name, role_id) VALUES ($1,$2,$3) RETURNING id', [email, b.name, b.roleId])).rows[0].id;
    await audit(req, 'user.create', { id, email, roleId: b.roleId });
    return reply.code(201).send({ id });
  });

  app.patch('/api/admin/users/:id', { preHandler: need('admin.users') }, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const b = z.object({ roleId: z.number().int().optional(), active: z.boolean().optional(), name: z.string().trim().min(1).max(80).optional() }).parse(req.body);
    const u = (await pool.query('SELECT u.*, r.name AS role_name FROM users u JOIN roles r ON r.id=u.role_id WHERE u.id=$1', [id])).rows[0];
    if (!u) throw new AdminError('User not found', 404);
    const newRole = b.roleId ? await roleRow(b.roleId) : null;
    const stillAdmin = (newRole ? newRole.name : u.role_name) === ADMIN_ROLE && (b.active ?? u.active);
    if (u.role_name === ADMIN_ROLE && u.active) await assertAdminRemains(id, stillAdmin);
    await pool.query('UPDATE users SET role_id=COALESCE($2,role_id), active=COALESCE($3,active), display_name=COALESCE($4,display_name) WHERE id=$1', [id, b.roleId ?? null, b.active ?? null, b.name ?? null]);
    await audit(req, 'user.update', { id, email: u.email, ...b, from: u.role_name });
    return { ok: true };
  });

  app.get('/api/admin/audit', { preHandler: needAny('admin.roles', 'admin.users', 'admin.projects', 'admin.workflows') }, async () =>
    (await pool.query(`SELECT a.id, a.action, a.detail, a.created_at, u.display_name AS actor FROM audit_log a LEFT JOIN users u ON u.id=a.actor_id ORDER BY a.id DESC LIMIT 100`)).rows);

}
export { AdminError };
