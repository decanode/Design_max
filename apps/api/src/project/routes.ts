import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool } from '../db.js';
import { inProject, need, needAny } from '../rbac/auth.js';
import { audit } from '../rbac/audit.js';
import { CATALOG, PROJECT_ADMIN_ROLE, PROJECT_KEYS, isKnownKey } from '../rbac/permissions.js';
import { effectiveFields, effectivePerms, overrideFlags } from '../rbac/effective.js';
import { DocError } from '../errors.js';
import { FIELDS, FIELD_KEYS, LEVELS, validateFieldAccess } from '../tickets/fields.js';
import { setProjectStacks } from '../stacks.js';
import { findOrCreateUser } from '../platform/routes.js';

/**
 * Project Admin console API. Everything here acts on the caller's CURRENT project only (taken from the session,
 * never from the request), so a Project Admin cannot touch another project even by guessing ids.
 */
const pid = (req: { user: { projectId: string | null } | null }) => req.user!.projectId!;
const roleRow = async (id: number) => { const r = (await pool.query('SELECT * FROM roles WHERE id=$1', [id])).rows[0]; if (!r) throw new DocError('Role not found', 404); return r; };

async function assertAdminRemains(projectId: string, exceptUserId: string) {
  const n = (await pool.query(
    `SELECT count(*)::int c FROM project_members m JOIN roles r ON r.id = m.role_id JOIN users u ON u.id = m.user_id WHERE m.project_id=$1 AND r.name=$2 AND u.active AND m.user_id <> $3`,
    [projectId, PROJECT_ADMIN_ROLE, exceptUserId])).rows[0].c;
  if (n < 1) throw new DocError('A project must keep at least one Project Admin', 409);
}

export function registerProjectRoutes(app: FastifyInstance) {
  const members = need('admin.users'), roles = need('admin.roles'), settings = need('admin.projects');
  const anyAdmin = needAny('admin.users', 'admin.roles', 'admin.projects', 'admin.workflows');

  app.get('/api/project', { preHandler: inProject() }, async (req) => {
    const id = pid(req);
    const p = (await pool.query('SELECT id, name, status FROM projects WHERE id=$1', [id])).rows[0];
    const stacks = (await pool.query('SELECT s.id, s.name FROM project_stacks ps JOIN tech_stacks s ON s.id=ps.stack_id WHERE ps.project_id=$1 ORDER BY s.name', [id])).rows;
    return { ...p, stacks, role: req.user!.roleName, isSuperAdmin: req.user!.isSuper };
  });

  // ---------------- members
  app.get('/api/project/members', { preHandler: members }, async (req) =>
    (await pool.query(
      `SELECT u.id, u.email, u.display_name AS name, u.active, r.id AS role_id, r.name AS role, m.created_at
       FROM project_members m JOIN users u ON u.id = m.user_id JOIN roles r ON r.id = m.role_id WHERE m.project_id = $1 ORDER BY u.active DESC, u.display_name`, [pid(req)])).rows);

  /** Add someone to this project. An unknown email creates an account that can reach nothing else. */
  app.post('/api/project/members', { preHandler: members }, async (req, reply) => {
    const b = z.object({ email: z.string().email(), name: z.string().trim().max(80).optional(), roleId: z.number().int() }).parse(req.body);
    const role = await roleRow(b.roleId);
    const u = await findOrCreateUser(pool, b.email, b.name);
    if ((await pool.query('SELECT 1 FROM project_members WHERE project_id=$1 AND user_id=$2', [pid(req), u.id])).rowCount) throw new DocError('That person is already in this project', 409);
    await pool.query('INSERT INTO project_members (project_id, user_id, role_id, added_by) VALUES ($1,$2,$3,$4)', [pid(req), u.id, b.roleId, req.user!.id]);
    await audit(req, 'member.add', { email: b.email.toLowerCase(), role: role.name, newAccount: u.created });
    return reply.code(201).send({ userId: u.id, created: u.created });
  });

  app.patch('/api/project/members/:userId', { preHandler: members }, async (req) => {
    const { userId } = z.object({ userId: z.string().uuid() }).parse(req.params);
    const { roleId } = z.object({ roleId: z.number().int() }).parse(req.body);
    const role = await roleRow(roleId);
    const cur = (await pool.query('SELECT r.name, u.email FROM project_members m JOIN roles r ON r.id=m.role_id JOIN users u ON u.id=m.user_id WHERE m.project_id=$1 AND m.user_id=$2', [pid(req), userId])).rows[0];
    if (!cur) throw new DocError('That person is not in this project', 404);
    if (cur.name === PROJECT_ADMIN_ROLE && role.name !== PROJECT_ADMIN_ROLE) await assertAdminRemains(pid(req), userId);
    await pool.query('UPDATE project_members SET role_id=$3 WHERE project_id=$1 AND user_id=$2', [pid(req), userId, roleId]);
    await audit(req, 'member.role', { email: cur.email, from: cur.name, to: role.name });
    return { ok: true };
  });

  app.delete('/api/project/members/:userId', { preHandler: members }, async (req) => {
    const { userId } = z.object({ userId: z.string().uuid() }).parse(req.params);
    const cur = (await pool.query('SELECT r.name, u.email FROM project_members m JOIN roles r ON r.id=m.role_id JOIN users u ON u.id=m.user_id WHERE m.project_id=$1 AND m.user_id=$2', [pid(req), userId])).rows[0];
    if (!cur) throw new DocError('That person is not in this project', 404);
    if (cur.name === PROJECT_ADMIN_ROLE) await assertAdminRemains(pid(req), userId);
    await pool.query('DELETE FROM project_members WHERE project_id=$1 AND user_id=$2', [pid(req), userId]);
    await audit(req, 'member.remove', { email: cur.email, role: cur.name });
    return { ok: true };
  });

  // ---------------- role tuning (permissions)
  app.get('/api/project/roles', { preHandler: roles }, async (req) => {
    const id = pid(req);
    const all = (await pool.query(
      `SELECT r.id, r.name, r.description, r.is_system, (SELECT count(*)::int FROM project_members m WHERE m.project_id=$1 AND m.role_id=r.id) AS members FROM roles r ORDER BY r.is_system DESC, r.id`, [id])).rows;
    const out = [];
    for (const r of all) {
      const locked = r.name === PROJECT_ADMIN_ROLE;
      const flags = await overrideFlags(pool, id, r.id);
      out.push({ ...r, locked, tuned: flags.perms, fieldsTuned: flags.fields, permissions: await effectivePerms(pool, id, r.id, r.name) });
    }
    return { roles: out, catalog: CATALOG.map((f) => ({ ...f, permissions: f.permissions.filter((p) => p.scope !== 'platform') })).filter((f) => f.permissions.length) };
  });

  app.put('/api/project/roles/:id/permissions', { preHandler: roles }, async (req) => {
    const { id } = z.object({ id: z.coerce.number().int() }).parse(req.params);
    const { permissions } = z.object({ permissions: z.array(z.string()) }).parse(req.body);
    const r = await roleRow(id);
    if (r.name === PROJECT_ADMIN_ROLE) throw new DocError('Project Admin always has every project permission', 400);
    const bad = permissions.filter((p) => !isKnownKey(p) || !PROJECT_KEYS.includes(p));
    if (bad.length) throw new DocError(`Not a permission a project role can hold: ${bad.join(', ')}`, 400);
    const before = await effectivePerms(pool, pid(req), id, r.name);
    const next = [...new Set(permissions)];
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query('DELETE FROM project_role_permissions WHERE project_id=$1 AND role_id=$2', [pid(req), id]);
      if (next.length) await c.query('INSERT INTO project_role_permissions (project_id, role_id, permission) SELECT $1,$2,unnest($3::text[])', [pid(req), id, next]);
      await c.query(`INSERT INTO project_role_overrides (project_id, role_id, perms) VALUES ($1,$2,true) ON CONFLICT (project_id, role_id) DO UPDATE SET perms = true`, [pid(req), id]);
      await c.query('COMMIT');
    } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
    await audit(req, 'role.permissions', { name: r.name, added: next.filter((p) => !before.includes(p)), removed: before.filter((p) => !next.includes(p)) });
    return { permissions: next };
  });

  /** Back to the standard role: drops this project's tuning of the role's permissions. */
  app.delete('/api/project/roles/:id/permissions', { preHandler: roles }, async (req) => {
    const { id } = z.object({ id: z.coerce.number().int() }).parse(req.params);
    const r = await roleRow(id);
    await pool.query('DELETE FROM project_role_permissions WHERE project_id=$1 AND role_id=$2', [pid(req), id]);
    await pool.query('UPDATE project_role_overrides SET perms=false WHERE project_id=$1 AND role_id=$2', [pid(req), id]);
    await audit(req, 'role.reset', { name: r.name, what: 'permissions' });
    return { ok: true };
  });

  // ---------------- role tuning (ticket fields)
  app.get('/api/project/ticket-fields', { preHandler: roles }, async (req) => {
    const id = pid(req);
    const rs = (await pool.query('SELECT id, name, is_system FROM roles ORDER BY is_system DESC, id')).rows;
    const out = [];
    for (const r of rs) out.push({ id: r.id, name: r.name, isSystem: r.is_system, locked: r.name === PROJECT_ADMIN_ROLE, tuned: (await overrideFlags(pool, id, r.id)).fields, access: await effectiveFields(pool, id, r.id, r.name) });
    return { levels: LEVELS, fields: FIELDS.map(({ key, label, description, writable, min }) => ({ key, label, description, writable, min })), roles: out };
  });

  app.put('/api/project/roles/:id/ticket-fields', { preHandler: roles }, async (req) => {
    const { id } = z.object({ id: z.coerce.number().int() }).parse(req.params);
    const { access } = z.object({ access: z.record(z.string(), z.string()) }).parse(req.body);
    const r = await roleRow(id);
    if (r.name === PROJECT_ADMIN_ROLE) throw new DocError('Project Admin always has full access to every field', 400);
    const problem = validateFieldAccess(access);
    if (problem) throw new DocError(problem, 400);
    const before = await effectiveFields(pool, pid(req), id, r.name);
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      // The first tuning starts from the role's current (standard) access, so fields nobody touches keep their meaning.
      const base = (await overrideFlags(c, pid(req), id)).fields ? {} : before;
      const next = { ...base, ...access };
      for (const [field, level] of Object.entries(next))
        await c.query(`INSERT INTO project_ticket_field_access (project_id, role_id, field, access) VALUES ($1,$2,$3,$4)
                       ON CONFLICT (project_id, role_id, field) DO UPDATE SET access = EXCLUDED.access`, [pid(req), id, field, level]);
      await c.query(`INSERT INTO project_role_overrides (project_id, role_id, fields) VALUES ($1,$2,true) ON CONFLICT (project_id, role_id) DO UPDATE SET fields = true`, [pid(req), id]);
      await c.query('COMMIT');
    } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
    const changed = Object.entries(access).filter(([f, l]) => before[f] !== l).map(([f, l]) => ({ field: f, from: before[f], to: l }));
    if (changed.length) await audit(req, 'role.ticket-fields', { name: r.name, changed });
    return { ok: true, changed: changed.length };
  });

  app.delete('/api/project/roles/:id/ticket-fields', { preHandler: roles }, async (req) => {
    const { id } = z.object({ id: z.coerce.number().int() }).parse(req.params);
    const r = await roleRow(id);
    await pool.query('DELETE FROM project_ticket_field_access WHERE project_id=$1 AND role_id=$2', [pid(req), id]);
    await pool.query('UPDATE project_role_overrides SET fields=false WHERE project_id=$1 AND role_id=$2', [pid(req), id]);
    await audit(req, 'role.reset', { name: r.name, what: 'ticket fields' });
    return { ok: true };
  });

  // ---------------- technology
  app.get('/api/project/stacks', { preHandler: settings }, async (req) => ({
    catalog: (await pool.query('SELECT id, name, description FROM tech_stacks ORDER BY name')).rows,
    selected: (await pool.query('SELECT stack_id FROM project_stacks WHERE project_id=$1', [pid(req)])).rows.map((r) => r.stack_id as number),
  }));

  app.put('/api/project/stacks', { preHandler: settings }, async (req) => {
    const { stackIds } = z.object({ stackIds: z.array(z.number().int()) }).parse(req.body);
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      try { await setProjectStacks(c, pid(req), stackIds); } catch { throw new DocError('Unknown technology stack', 400); }
      await c.query('COMMIT');
    } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
    await audit(req, 'project.stacks', { stackIds });
    return { ok: true };
  });

  // ---------------- activity
  app.get('/api/project/audit', { preHandler: anyAdmin }, async (req) =>
    (await pool.query(`SELECT a.id, a.action, a.detail, a.created_at, u.display_name AS actor FROM audit_log a LEFT JOIN users u ON u.id = a.actor_id WHERE a.project_id = $1 ORDER BY a.id DESC LIMIT 100`, [pid(req)])).rows);
}
