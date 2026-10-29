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
import { pickTemplate, stackKey } from '../docgen/templateLibrary.js';
import { sampleDocument } from '../docgen/sample.js';
import { KINDS } from '../docs/kinds.js';
import { DocSettings, FONTS, STACK_SETS, effectiveSettings, saveProjectSettings } from '../docs/settings.js';
import { KNOWN_MODULES, modulesOf, setModule } from '../planning/service.js';

/**
 * Project Admin console API. Everything here acts on the caller's CURRENT project only (taken from the session,
 * never from the request), so a Project Admin cannot touch another project even by guessing ids.
 */
const pid = (req: { user: { projectId: string | null } | null }) => req.user!.projectId!;
/** A role this project may use: a standard one, or one the project made itself. Another project's role does not exist as far as this project can tell. */
const roleRow = async (id: number, projectId: string) => { const r = (await pool.query('SELECT * FROM roles WHERE id=$1 AND (project_id IS NULL OR project_id=$2)', [id, projectId])).rows[0]; if (!r) throw new DocError('Role not found', 404); return r; };

export function registerProjectRoutes(app: FastifyInstance) {
  const roles = need('admin.roles'), settings = need('admin.projects');
  const anyAdmin = needAny('admin.users', 'admin.roles', 'admin.projects', 'admin.workflows');

  app.get('/api/project', { preHandler: inProject() }, async (req) => {
    const id = pid(req);
    const p = (await pool.query('SELECT id, name, status FROM projects WHERE id=$1', [id])).rows[0];
    const stacks = (await pool.query('SELECT s.id, s.name FROM project_stacks ps JOIN tech_stacks s ON s.id=ps.stack_id WHERE ps.project_id=$1 ORDER BY s.name', [id])).rows;
    return { ...p, stacks, role: req.user!.roleName, isSuperAdmin: req.user!.isSuper };
  });

  // ---------------- roles of the project's own (only where a Super Admin has allowed this Project Admin to make them)
  const mayCreateRoles = async (req: import('fastify').FastifyRequest, reply: import('fastify').FastifyReply) => {
    if (!req.user!.canCreateRoles) return reply.code(403).send({ error: 'A Super Admin has not allowed you to create roles for this project' });
  };
  const ownedRole = async (id: number, projectId: string) => {
    const r = await roleRow(id, projectId);
    if (r.project_id !== projectId) throw new DocError('This is a standard role. Standard roles are managed by a Super Admin in the Platform console; here you can tune what they may do in this project.', 400);
    return r;
  };
  const RoleBody = z.object({ name: z.string().trim().min(2, 'Give the role a name').max(40), description: z.string().trim().max(200).default('') });

  app.post('/api/project/roles', { preHandler: [roles, mayCreateRoles] }, async (req, reply) => {
    const b = RoleBody.extend({ copyFromRoleId: z.number().int().positive().optional() }).parse(req.body);
    if ((await pool.query('SELECT 1 FROM roles WHERE lower(name)=lower($1) AND (project_id IS NULL OR project_id=$2)', [b.name, pid(req)])).rowCount) throw new DocError('A role with that name already exists', 409);
    const src = b.copyFromRoleId ? await roleRow(b.copyFromRoleId, pid(req)) : null;
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      const id = (await c.query('INSERT INTO roles (name, description, project_id) VALUES ($1,$2,$3) RETURNING id', [b.name, b.description, pid(req)])).rows[0].id as number;
      if (src) {      // start from what the source role means in this project today, limited to what a project role may hold
        const perms = (await effectivePerms(pool, pid(req), src.id, src.name)).filter((p) => PROJECT_KEYS.includes(p));
        for (const p of perms) await c.query('INSERT INTO role_permissions (role_id, permission) VALUES ($1,$2)', [id, p]);
        const access = await effectiveFields(pool, pid(req), src.id, src.name);
        for (const [field, level] of Object.entries(access)) await c.query('INSERT INTO ticket_field_access (role_id, field, access) VALUES ($1,$2,$3)', [id, field, level]);
      }
      await c.query('COMMIT');
      await audit(req, 'role.create', { name: b.name, copiedFrom: src?.name ?? null });
      return reply.code(201).send({ id });
    } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
  });

  app.patch('/api/project/roles/:id', { preHandler: [roles, mayCreateRoles] }, async (req) => {
    const { id } = z.object({ id: z.coerce.number().int() }).parse(req.params);
    const b = RoleBody.partial().parse(req.body);
    const r = await ownedRole(id, pid(req));
    if (b.name && (await pool.query('SELECT 1 FROM roles WHERE lower(name)=lower($1) AND id<>$2 AND (project_id IS NULL OR project_id=$3)', [b.name, id, pid(req)])).rowCount) throw new DocError('A role with that name already exists', 409);
    await pool.query('UPDATE roles SET name=COALESCE($2,name), description=COALESCE($3,description) WHERE id=$1', [id, b.name ?? null, b.description ?? null]);
    await audit(req, 'role.update', { from: r.name, to: b.name ?? r.name });
    return { ok: true };
  });

  app.delete('/api/project/roles/:id', { preHandler: [roles, mayCreateRoles] }, async (req) => {
    const { id } = z.object({ id: z.coerce.number().int() }).parse(req.params);
    const r = await ownedRole(id, pid(req));
    const used = (await pool.query('SELECT (SELECT count(*)::int FROM project_members WHERE role_id=$1) AS members, (SELECT count(*)::int FROM approval_level_approvers WHERE role_id=$1) AS approvals', [id])).rows[0];
    if (used.members) throw new DocError(`${used.members} ${used.members > 1 ? 'people hold' : 'person holds'} this role. Give them another role first.`, 409);
    if (used.approvals) throw new DocError('An approval workflow asks this role to approve. Change the workflow first.', 409);
    await pool.query('DELETE FROM roles WHERE id=$1', [id]);                                           // its permissions and field access go with it
    await audit(req, 'role.delete', { name: r.name });
    return { ok: true };
  });

  // ---------------- role tuning (permissions)
  app.get('/api/project/roles', { preHandler: roles }, async (req) => {
    const id = pid(req);
    const all = (await pool.query(
      `SELECT r.id, r.name, r.description, r.is_system, (r.project_id IS NOT NULL) AS owned, (SELECT count(*)::int FROM project_members m WHERE m.project_id=$1 AND m.role_id=r.id) AS members FROM roles r WHERE r.project_id IS NULL OR r.project_id = $1 ORDER BY (r.project_id IS NOT NULL), r.is_system DESC, r.id`, [id])).rows;
    const out = [];
    for (const r of all) {
      const locked = r.name === PROJECT_ADMIN_ROLE;
      const flags = await overrideFlags(pool, id, r.id);
      out.push({ ...r, locked, tuned: flags.perms, fieldsTuned: flags.fields, permissions: await effectivePerms(pool, id, r.id, r.name) });
    }
    return { roles: out, canCreateRoles: req.user!.canCreateRoles, catalog: CATALOG.map((f) => ({ ...f, permissions: f.permissions.filter((p) => p.scope !== 'platform') })).filter((f) => f.permissions.length) };
  });

  app.put('/api/project/roles/:id/permissions', { preHandler: roles }, async (req) => {
    const { id } = z.object({ id: z.coerce.number().int() }).parse(req.params);
    const { permissions } = z.object({ permissions: z.array(z.string()) }).parse(req.body);
    const r = await roleRow(id, pid(req));
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
    const r = await roleRow(id, pid(req));
    await pool.query('DELETE FROM project_role_permissions WHERE project_id=$1 AND role_id=$2', [pid(req), id]);
    await pool.query('UPDATE project_role_overrides SET perms=false WHERE project_id=$1 AND role_id=$2', [pid(req), id]);
    await audit(req, 'role.reset', { name: r.name, what: 'permissions' });
    return { ok: true };
  });

  // ---------------- role tuning (ticket fields)
  app.get('/api/project/ticket-fields', { preHandler: roles }, async (req) => {
    const id = pid(req);
    const rs = (await pool.query('SELECT id, name, is_system FROM roles WHERE project_id IS NULL OR project_id = $1 ORDER BY (project_id IS NOT NULL), is_system DESC, id', [id])).rows;
    const out = [];
    for (const r of rs) out.push({ id: r.id, name: r.name, isSystem: r.is_system, locked: r.name === PROJECT_ADMIN_ROLE, tuned: (await overrideFlags(pool, id, r.id)).fields, access: await effectiveFields(pool, id, r.id, r.name) });
    return { levels: LEVELS, fields: FIELDS.map(({ key, label, description, writable, min }) => ({ key, label, description, writable, min })), roles: out };
  });

  app.put('/api/project/roles/:id/ticket-fields', { preHandler: roles }, async (req) => {
    const { id } = z.object({ id: z.coerce.number().int() }).parse(req.params);
    const { access } = z.object({ access: z.record(z.string(), z.string()) }).parse(req.body);
    const r = await roleRow(id, pid(req));
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
    const r = await roleRow(id, pid(req));
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
  // ---------------- module configuration (feature flags)
  app.get('/api/project/modules', { preHandler: settings }, async (req) => ({
    modules: await modulesOf(pid(req)),
    available: [],      // the screen lists the modules itself; this is kept for older clients
  }));
  app.put('/api/project/modules', { preHandler: settings }, async (req) => {
    const b = z.object({ key: z.enum(KNOWN_MODULES), enabled: z.boolean() }).parse(req.body);
    await setModule(pid(req), b.key, b.enabled);
    await audit(req, 'project.module', { module: b.key, enabled: b.enabled });
    return { modules: await modulesOf(pid(req)) };
  });

  // ---------------- document settings
  app.get('/api/project/doc-settings', { preHandler: settings }, async (req) => ({ settings: await effectiveSettings(pid(req)), fonts: FONTS, templateSets: STACK_SETS }));
  app.put('/api/project/doc-settings', { preHandler: settings }, async (req) => {
    const patch = DocSettings.partial().parse(req.body);
    const out = await saveProjectSettings(pid(req), patch, req.user!.id);
    await audit(req, 'project.doc_settings', patch);
    return { settings: out };
  });

  /** A sample Word file in the look the admin has on screen (saved settings plus any unsaved changes), so nothing is guessed. */
  app.post('/api/project/doc-settings/sample', { preHandler: settings }, async (req, reply) => {
    const b = z.object({ kind: z.enum(KINDS).default('FS'), settings: DocSettings.partial().default({}) }).parse(req.body ?? {});
    const cfg = { ...(await effectiveSettings(pid(req))), ...b.settings };
    const allowed = (await pool.query('SELECT s.name FROM project_stacks ps JOIN tech_stacks s ON s.id=ps.stack_id WHERE ps.project_id=$1 ORDER BY s.name', [pid(req)])).rows.map((x) => x.name as string);
    const tpl = await pickTemplate(cfg.templateStack ?? (allowed.length ? stackKey(allowed[0]) : null), b.kind);
    const r = sampleDocument(b.kind, cfg, req.user!.projectName ?? '', tpl.buffer);
    return reply.header('content-type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document').header('content-disposition', `attachment; filename="${r.filename}"`).send(r.buffer);
  });

  app.get('/api/project/audit', { preHandler: anyAdmin }, async (req) =>
    (await pool.query(`SELECT a.id, a.action, a.detail, a.created_at, u.display_name AS actor FROM audit_log a LEFT JOIN users u ON u.id = a.actor_id WHERE a.project_id = $1 ORDER BY a.id DESC LIMIT 100`, [pid(req)])).rows);
}
