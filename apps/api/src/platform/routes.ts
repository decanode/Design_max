import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool } from '../db.js';
import { needSuper } from '../rbac/auth.js';
import { audit } from '../rbac/audit.js';
import { CATALOG, PROJECT_ADMIN_ROLE, PROJECT_KEYS, isKnownKey } from '../rbac/permissions.js';
import { DocError } from '../errors.js';
import { ALL_WRITE, FIELDS, FIELD_KEYS, LEVELS, resolveFieldAccess, validateFieldAccess } from '../tickets/fields.js';
import { builderCatalog } from '../workflow/builderRoutes.js';
import { setProjectStacks } from '../stacks.js';
import { PlatformDefaults, platformDefaults, savePlatformDefaults, FONTS, STACK_SETS } from '../docs/settings.js';
import { validateTemplate, MAX_TEMPLATE_BYTES, TOKENS } from '../docgen/templateLibrary.js';
import { KINDS } from '../docs/kinds.js';

/**
 * Super Admin console API: projects, every user, the standard role catalog (templates every project starts from),
 * the technology-stack catalog, and the platform audit trail.
 */
const KEYWORDS = z.array(z.string().trim().min(1).max(40)).max(60);

/** Gives a new project its own copy of each template workflow (e.g. "Standard approval"). */
export async function copyTemplateWorkflows(c: import('pg').PoolClient, projectId: string) {
  const templates = (await c.query('SELECT * FROM approval_workflows WHERE is_template AND active')).rows;
  for (const w of templates) {
    const nw = (await c.query('INSERT INTO approval_workflows (name, description, kinds, project_id, active) VALUES ($1,$2,$3,$4,true) RETURNING id', [w.name, w.description, w.kinds, projectId])).rows[0].id;
    for (const l of (await c.query('SELECT * FROM approval_levels WHERE workflow_id=$1 ORDER BY position', [w.id])).rows) {
      const nl = (await c.query('INSERT INTO approval_levels (workflow_id, position, name, rule) VALUES ($1,$2,$3,$4) RETURNING id', [nw, l.position, l.name, l.rule])).rows[0].id;
      await c.query('INSERT INTO approval_level_approvers (level_id, kind, user_id, role_id) SELECT $1, kind, user_id, role_id FROM approval_level_approvers WHERE level_id=$2', [nl, l.id]);
    }
  }
}

/** Finds the user by email or creates them. New accounts start with no project access at all. */
export async function findOrCreateUser(c: Pick<import('pg').Pool, 'query'>, email: string, name?: string) {
  const e = email.trim().toLowerCase();
  const found = (await c.query('SELECT id, active FROM users WHERE email=$1', [e])).rows[0];
  if (found) { if (!found.active) throw new DocError('That account is deactivated', 409); return { id: found.id as string, created: false }; }
  const id = (await c.query('INSERT INTO users (email, display_name) VALUES ($1,$2) RETURNING id', [e, (name ?? e.split('@')[0]).trim() || e])).rows[0].id as string;
  return { id, created: true };
}

async function assertSuperRemains(exceptUserId: string) {
  const n = (await pool.query('SELECT count(*)::int c FROM users WHERE is_super_admin AND active AND id <> $1', [exceptUserId])).rows[0].c;
  if (n < 1) throw new DocError('At least one active Super Admin must remain', 409);
}
const roleRow = async (id: number) => { const r = (await pool.query('SELECT * FROM roles WHERE id=$1 AND project_id IS NULL', [id])).rows[0]; if (!r) throw new DocError('Role not found', 404); return r; };

export function registerPlatformRoutes(app: FastifyInstance) {
  const sup = needSuper();

  // ---------------- projects
  // ---------------- document defaults and template library
  app.get('/api/platform/doc-defaults', { preHandler: sup }, async () => ({ settings: await platformDefaults(), fonts: FONTS }));
  app.put('/api/platform/doc-defaults', { preHandler: sup }, async (req) => {
    const patch = PlatformDefaults.strict().parse(req.body);
    const out = await savePlatformDefaults(patch, req.user!.id);
    await audit(req, 'platform.doc_defaults', patch, null);
    return { settings: out };
  });

  app.get('/api/platform/doc-templates', { preHandler: sup }, async () => ({
    templates: (await pool.query(`SELECT t.id, t.stack, t.doc_type AS "docType", t.name, t.version, t.active, t.created_at AS "createdAt", u.display_name AS "createdBy", length(t.docx) AS bytes
      FROM doc_templates t LEFT JOIN users u ON u.id=t.created_by ORDER BY t.doc_type, t.stack NULLS FIRST, t.version DESC`)).rows,
    tokens: TOKENS, stacks: STACK_SETS,
  }));
  app.post('/api/platform/doc-templates', { preHandler: sup, bodyLimit: Math.ceil(MAX_TEMPLATE_BYTES * 1.4) + 4096 }, async (req, reply) => {
    const b = z.object({ stack: z.enum(STACK_SETS).nullable(), docType: z.enum(KINDS), name: z.string().trim().min(2).max(120), docxBase64: z.string().min(100) }).parse(req.body);
    const buf = Buffer.from(b.docxBase64, 'base64');
    const check = validateTemplate(buf);
    const stack = b.stack === 'generic' ? null : b.stack;
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      const v = (await c.query('SELECT coalesce(max(version),0)+1 v FROM doc_templates WHERE stack IS NOT DISTINCT FROM $1 AND doc_type=$2', [stack, b.docType])).rows[0].v as number;
      await c.query('UPDATE doc_templates SET active=false WHERE stack IS NOT DISTINCT FROM $1 AND doc_type=$2 AND active', [stack, b.docType]);
      const row = (await c.query('INSERT INTO doc_templates (stack, doc_type, name, version, docx, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, version', [stack, b.docType, b.name, v, buf, req.user!.id])).rows[0];
      await c.query('COMMIT');
      await audit(req, 'platform.doc_template', { stack, docType: b.docType, version: row.version }, null);
      return reply.code(201).send({ id: row.id, version: row.version, unknownTokens: check.unknownTokens });
    } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
  });
  app.get('/api/platform/doc-templates/:id/download', { preHandler: sup }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const r = (await pool.query('SELECT docx, doc_type, stack, version FROM doc_templates WHERE id=$1', [id])).rows[0];
    if (!r) throw new DocError('Template not found', 404);
    return reply.header('content-type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document').header('content-disposition', `attachment; filename="${r.stack ?? 'generic'}_${r.doc_type}_template_v${r.version}.docx"`).send(r.docx);
  });
  app.post('/api/platform/doc-templates/:id/activate', { preHandler: sup }, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const r = (await pool.query('SELECT stack, doc_type FROM doc_templates WHERE id=$1', [id])).rows[0];
    if (!r) throw new DocError('Template not found', 404);
    const c = await pool.connect();
    try {      // one active version per stack and type: switch off the others first (the unique index checks row by row)
      await c.query('BEGIN');
      await c.query('UPDATE doc_templates SET active=false WHERE stack IS NOT DISTINCT FROM $1 AND doc_type=$2 AND active', [r.stack, r.doc_type]);
      await c.query('UPDATE doc_templates SET active=true WHERE id=$1', [id]);
      await c.query('COMMIT');
    } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
    return { ok: true };
  });
  app.delete('/api/platform/doc-templates/:id', { preHandler: sup }, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    await pool.query('UPDATE doc_templates SET active=false WHERE id=$1', [id]);   // never lost: it can be activated again
    return { ok: true };
  });

  /** Methodologies, project types and ticket types, for choosing a project's setup. */
  app.get('/api/platform/workflow/catalog', { preHandler: sup }, async () => builderCatalog());

  app.get('/api/platform/projects', { preHandler: sup }, async () =>
    (await pool.query(
      `SELECT p.id, p.name, p.status, p.created_at,
              (SELECT count(*)::int FROM project_members m WHERE m.project_id = p.id) AS members,
              (SELECT count(*)::int FROM tickets t WHERE t.project_id = p.id) AS tickets,
              COALESCE((SELECT json_agg(json_build_object('id', u.id, 'name', u.display_name, 'canCreateRoles', m.can_create_roles) ORDER BY u.display_name) FROM project_members m JOIN users u ON u.id = m.user_id JOIN roles r ON r.id = m.role_id
                        WHERE m.project_id = p.id AND r.name = $1), '[]') AS admins,
              COALESCE((SELECT array_agg(s.name ORDER BY s.name) FROM project_stacks ps JOIN tech_stacks s ON s.id = ps.stack_id WHERE ps.project_id = p.id), '{}') AS stacks
       FROM projects p ORDER BY p.status, p.name`, [PROJECT_ADMIN_ROLE])).rows);

  app.post('/api/platform/projects', { preHandler: sup }, async (req, reply) => {
    const b = z.object({
      name: z.string().trim().min(2).max(80), stackIds: z.array(z.number().int()).default([]), projectTypeId: z.number().int().positive().optional(), templateTypeId: z.number().int().positive().optional(),
      admin: z.object({ email: z.string().email(), name: z.string().trim().max(80).optional() }).optional(),
    }).parse(req.body);
    if ((await pool.query('SELECT 1 FROM projects WHERE lower(name)=lower($1)', [b.name])).rowCount) throw new DocError('A project with that name already exists', 409);
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      const id = (await c.query('INSERT INTO projects (name, created_by) VALUES ($1,$2) RETURNING id', [b.name, req.user!.id])).rows[0].id as string;
      if (b.projectTypeId || b.templateTypeId) {       // the project starts with its type's methodology, phases and ticket types
        const tt = b.templateTypeId ?? (b.projectTypeId ? (await c.query('SELECT template_type_id FROM project_type_template_defaults WHERE project_type_id=$1', [b.projectTypeId])).rows[0]?.template_type_id : null);
        if (!tt) throw new DocError('Unknown project type or methodology', 400);
        try { await c.query('SELECT seed_project_workflow($1,$2,$3)', [id, b.projectTypeId ?? null, tt]); } catch { throw new DocError('Unknown project type or methodology', 400); }
      }
      try { await setProjectStacks(c, id, b.stackIds); } catch { throw new DocError('Unknown technology stack', 400); }
      await copyTemplateWorkflows(c, id);
      let adminId: string | null = null;
      if (b.admin) {
        adminId = (await findOrCreateUser(c, b.admin.email, b.admin.name)).id;
        await c.query(`INSERT INTO project_members (project_id, user_id, role_id, added_by) SELECT $1,$2,id,$3 FROM roles WHERE name=$4`, [id, adminId, req.user!.id, PROJECT_ADMIN_ROLE]);
      }
      await c.query('COMMIT');
      await audit(req, 'project.create', { id, name: b.name, admin: b.admin?.email ?? null }, id);
      return reply.code(201).send({ id, adminId });
    } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
  });

  /** Lets a Project Admin create roles of their own in their project (or takes that back). */
  app.put('/api/platform/projects/:id/admins/:userId/role-creation', { preHandler: sup }, async (req) => {
    const { id, userId } = z.object({ id: z.string().uuid(), userId: z.string().uuid() }).parse(req.params);
    const { enabled } = z.object({ enabled: z.boolean() }).parse(req.body);
    const m = (await pool.query(`SELECT u.display_name, r.name FROM project_members pm JOIN users u ON u.id = pm.user_id JOIN roles r ON r.id = pm.role_id WHERE pm.project_id=$1 AND pm.user_id=$2`, [id, userId])).rows[0];
    if (!m || m.name !== PROJECT_ADMIN_ROLE) throw new DocError('That person is not a Project Admin of this project', 404);
    await pool.query('UPDATE project_members SET can_create_roles=$3 WHERE project_id=$1 AND user_id=$2', [id, userId, enabled]);
    await audit(req, 'project.role_creation', { admin: m.display_name, enabled }, id);
    return { ok: true };
  });

  app.patch('/api/platform/projects/:id', { preHandler: sup }, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const b = z.object({ name: z.string().trim().min(2).max(80).optional(), status: z.enum(['active', 'archived']).optional() }).parse(req.body);
    if (b.name && (await pool.query('SELECT 1 FROM projects WHERE lower(name)=lower($1) AND id<>$2', [b.name, id])).rowCount) throw new DocError('A project with that name already exists', 409);
    const r = await pool.query('UPDATE projects SET name=COALESCE($2,name), status=COALESCE($3,status) WHERE id=$1 RETURNING name', [id, b.name ?? null, b.status ?? null]);
    if (!r.rowCount) throw new DocError('Project not found', 404);
    await audit(req, 'project.update', { id, ...b }, id);
    return { ok: true };
  });

  /** Appoint (or promote to) Project Admin by email; creates the account when the person is new. */
  app.post('/api/platform/projects/:id/admins', { preHandler: sup }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const b = z.object({ email: z.string().email(), name: z.string().trim().max(80).optional() }).parse(req.body);
    if (!(await pool.query('SELECT 1 FROM projects WHERE id=$1', [id])).rowCount) throw new DocError('Project not found', 404);
    const u = await findOrCreateUser(pool, b.email, b.name);
    await pool.query(
      `INSERT INTO project_members (project_id, user_id, role_id, added_by) SELECT $1,$2,id,$3 FROM roles WHERE name=$4
       ON CONFLICT (project_id, user_id) DO UPDATE SET role_id = EXCLUDED.role_id`, [id, u.id, req.user!.id, PROJECT_ADMIN_ROLE]);
    await audit(req, 'project.admin', { id, email: b.email.toLowerCase() }, id);
    return reply.code(201).send({ userId: u.id, created: u.created });
  });

  // ---------------- users (everyone on the platform)
  app.get('/api/platform/users', { preHandler: sup }, async () =>
    (await pool.query(
      `SELECT u.id, u.email, u.display_name AS name, u.active, u.is_super_admin AS "isSuperAdmin", u.created_at,
              COALESCE((SELECT json_agg(json_build_object('id', p.id, 'name', p.name, 'role', r.name) ORDER BY p.name) FROM project_members m JOIN projects p ON p.id = m.project_id JOIN roles r ON r.id = m.role_id WHERE m.user_id = u.id), '[]') AS projects
       FROM users u ORDER BY u.active DESC, u.display_name`)).rows);

  /**
   * Browse users at scale: filtered, sorted and paged on the server. `project` is a project id, "none" (no project) or "super".
   * The membership list of each returned user is complete, whatever project filter is used.
   */
  app.get('/api/platform/users/search', { preHandler: sup }, async (req) => {
    const q = z.object({
      q: z.string().trim().max(100).optional(), status: z.enum(['all', 'active', 'inactive']).default('all'),
      project: z.union([z.string().uuid(), z.literal('none'), z.literal('super')]).optional(),
      sort: z.enum(['name', 'newest', 'projects']).default('name'), page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(25),
    }).parse(req.query);
    const where: string[] = []; const args: unknown[] = [];
    const arg = (v: unknown) => { args.push(v); return `$${args.length}`; };
    if (q.q) { const l = arg(`%${q.q.replace(/[%_\\]/g, (c) => `\\${c}`)}%`); where.push(`(u.display_name ILIKE ${l} OR u.email ILIKE ${l})`); }
    if (q.status !== 'all') where.push(`u.active = ${q.status === 'active'}`);
    if (q.project === 'none') where.push('NOT EXISTS (SELECT 1 FROM project_members m WHERE m.user_id = u.id)');
    else if (q.project === 'super') where.push('u.is_super_admin');
    else if (q.project) where.push(`EXISTS (SELECT 1 FROM project_members m WHERE m.user_id = u.id AND m.project_id = ${arg(q.project)})`);
    const cond = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const order = q.sort === 'newest' ? 'u.created_at DESC, u.display_name' : q.sort === 'projects' ? '(SELECT count(*) FROM project_members m WHERE m.user_id = u.id) DESC, u.display_name' : 'u.display_name, u.email';
    const total = (await pool.query(`SELECT count(*)::int n FROM users u ${cond}`, args)).rows[0].n as number;
    const rows = (await pool.query(
      `SELECT u.id, u.email, u.display_name AS name, u.active, u.is_super_admin AS "isSuperAdmin", u.created_at,
              COALESCE((SELECT json_agg(json_build_object('id', p.id, 'name', p.name, 'role', r.name, 'archived', p.status = 'archived') ORDER BY p.name) FROM project_members m JOIN projects p ON p.id = m.project_id JOIN roles r ON r.id = m.role_id WHERE m.user_id = u.id), '[]') AS projects
       FROM users u ${cond} ORDER BY ${order} LIMIT ${q.pageSize} OFFSET ${(q.page - 1) * q.pageSize}`, args)).rows;
    return { rows, total, page: q.page, pageSize: q.pageSize };
  });

  /** The numbers behind the browse rail: how many users overall, and in each project. */
  app.get('/api/platform/users/facets', { preHandler: sup }, async () => {
    const c = (await pool.query(
      `SELECT count(*)::int AS "all", count(*) FILTER (WHERE active)::int AS active, count(*) FILTER (WHERE NOT active)::int AS inactive,
              count(*) FILTER (WHERE is_super_admin)::int AS super, count(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM project_members m WHERE m.user_id = users.id))::int AS "noProject" FROM users`)).rows[0];
    const projects = (await pool.query(
      `SELECT p.id, p.name, p.status, count(m.user_id)::int AS users FROM projects p LEFT JOIN project_members m ON m.project_id = p.id GROUP BY p.id ORDER BY p.status, p.name`)).rows;
    return { counts: c, projects };
  });

  app.get('/api/platform/users/:id', { preHandler: sup }, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const u = (await pool.query(
      `SELECT u.id, u.email, u.display_name AS name, u.active, u.is_super_admin AS "isSuperAdmin", u.created_at,
              COALESCE((SELECT json_agg(json_build_object('id', p.id, 'name', p.name, 'role', r.name, 'archived', p.status = 'archived') ORDER BY p.name) FROM project_members m JOIN projects p ON p.id = m.project_id JOIN roles r ON r.id = m.role_id WHERE m.user_id = u.id), '[]') AS projects
       FROM users u WHERE u.id = $1`, [id])).rows[0];
    if (!u) throw new DocError('User not found', 404);
    return u;
  });

  app.post('/api/platform/users', { preHandler: sup }, async (req, reply) => {
    const b = z.object({ email: z.string().email(), name: z.string().trim().min(1).max(80), isSuperAdmin: z.boolean().default(false) }).parse(req.body);
    if ((await pool.query('SELECT 1 FROM users WHERE email=$1', [b.email.toLowerCase()])).rowCount) throw new DocError('A user with that email already exists', 409);
    const id = (await pool.query('INSERT INTO users (email, display_name, is_super_admin) VALUES ($1,$2,$3) RETURNING id', [b.email.toLowerCase(), b.name, b.isSuperAdmin])).rows[0].id;
    await audit(req, 'user.create', { id, email: b.email.toLowerCase(), isSuperAdmin: b.isSuperAdmin }, null);
    return reply.code(201).send({ id });
  });

  app.patch('/api/platform/users/:id', { preHandler: sup }, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const b = z.object({ name: z.string().trim().min(1).max(80).optional(), active: z.boolean().optional(), isSuperAdmin: z.boolean().optional() }).parse(req.body);
    const u = (await pool.query('SELECT * FROM users WHERE id=$1', [id])).rows[0];
    if (!u) throw new DocError('User not found', 404);
    const staysSuper = (b.isSuperAdmin ?? u.is_super_admin) && (b.active ?? u.active);
    if (u.is_super_admin && u.active && !staysSuper) await assertSuperRemains(id);
    await pool.query('UPDATE users SET display_name=COALESCE($2,display_name), active=COALESCE($3,active), is_super_admin=COALESCE($4,is_super_admin) WHERE id=$1', [id, b.name ?? null, b.active ?? null, b.isSuperAdmin ?? null]);
    await audit(req, 'user.update', { id, email: u.email, ...b }, null);
    return { ok: true };
  });

  // ---------------- the standard role catalog (templates; each project may tune its own copy)
  app.get('/api/platform/catalog', { preHandler: sup }, async () => CATALOG.map((f) => ({ ...f, permissions: f.permissions.map((p) => ({ ...p, scope: p.scope ?? 'project' })) })));

  app.get('/api/platform/roles', { preHandler: sup }, async () => {
    const roles = (await pool.query(
      `SELECT r.id, r.name, r.description, r.is_system,
              (SELECT count(*)::int FROM project_members m WHERE m.role_id = r.id) AS members,
              COALESCE((SELECT array_agg(permission ORDER BY permission) FROM role_permissions p WHERE p.role_id = r.id), '{}') AS permissions
       FROM roles r WHERE r.project_id IS NULL ORDER BY r.is_system DESC, r.id`)).rows;
    const fa = (await pool.query('SELECT role_id, field, access FROM ticket_field_access')).rows;
    return roles.map((r) => {
      const locked = r.name === PROJECT_ADMIN_ROLE;
      return { ...r, locked, permissions: locked ? PROJECT_KEYS : r.permissions, fieldAccess: locked ? null : resolveFieldAccess(fa.filter((x) => x.role_id === r.id)) };
    });
  });

  app.post('/api/platform/roles', { preHandler: sup }, async (req, reply) => {
    const b = z.object({ name: z.string().trim().min(2).max(40), description: z.string().max(300).default(''), copyFromRoleId: z.number().int().optional() }).parse(req.body);
    if ((await pool.query('SELECT 1 FROM roles WHERE lower(name)=lower($1)', [b.name])).rowCount) throw new DocError('A role with that name already exists', 409);
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      const id = (await c.query('INSERT INTO roles (name, description) VALUES ($1,$2) RETURNING id', [b.name, b.description])).rows[0].id as number;
      if (b.copyFromRoleId) {
        const src = await roleRow(b.copyFromRoleId);
        if (src.name === PROJECT_ADMIN_ROLE) {
          await c.query('INSERT INTO role_permissions (role_id, permission) SELECT $1, unnest($2::text[])', [id, PROJECT_KEYS]);
          await c.query(`INSERT INTO ticket_field_access (role_id, field, access) SELECT $1, f, CASE WHEN f IN ('customer','project','legacy') THEN 'read' ELSE 'write' END FROM unnest($2::text[]) f`, [id, FIELD_KEYS]);
        } else {
          await c.query('INSERT INTO role_permissions (role_id, permission) SELECT $1, permission FROM role_permissions WHERE role_id=$2', [id, b.copyFromRoleId]);
          await c.query('INSERT INTO ticket_field_access (role_id, field, access) SELECT $1, field, access FROM ticket_field_access WHERE role_id=$2', [id, b.copyFromRoleId]);
        }
      }
      await c.query('COMMIT');
      await audit(req, 'role.create', { id, name: b.name, copyFrom: b.copyFromRoleId ?? null }, null);
      return reply.code(201).send({ id });
    } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
  });

  app.patch('/api/platform/roles/:id', { preHandler: sup }, async (req) => {
    const { id } = z.object({ id: z.coerce.number().int() }).parse(req.params);
    const b = z.object({ name: z.string().trim().min(2).max(40).optional(), description: z.string().max(300).optional() }).parse(req.body);
    const r = await roleRow(id);
    if (b.name && r.is_system && b.name !== r.name) throw new DocError('Built-in roles cannot be renamed', 400);
    if (b.name && (await pool.query('SELECT 1 FROM roles WHERE lower(name)=lower($1) AND id<>$2', [b.name, id])).rowCount) throw new DocError('A role with that name already exists', 409);
    await pool.query('UPDATE roles SET name=COALESCE($2,name), description=COALESCE($3,description) WHERE id=$1', [id, b.name ?? null, b.description ?? null]);
    await audit(req, 'role.update', { id, ...b }, null);
    return { ok: true };
  });

  app.put('/api/platform/roles/:id/permissions', { preHandler: sup }, async (req) => {
    const { id } = z.object({ id: z.coerce.number().int() }).parse(req.params);
    const { permissions } = z.object({ permissions: z.array(z.string()) }).parse(req.body);
    const r = await roleRow(id);
    if (r.name === PROJECT_ADMIN_ROLE) throw new DocError('Project Admin always has every project permission', 400);
    const bad = permissions.filter((p) => !isKnownKey(p) || !PROJECT_KEYS.includes(p));
    if (bad.length) throw new DocError(`Not a project permission: ${bad.join(', ')}`, 400);
    const before = (await pool.query('SELECT permission FROM role_permissions WHERE role_id=$1', [id])).rows.map((x) => x.permission as string);
    const next = [...new Set(permissions)];
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query('DELETE FROM role_permissions WHERE role_id=$1', [id]);
      if (next.length) await c.query('INSERT INTO role_permissions (role_id, permission) SELECT $1, unnest($2::text[])', [id, next]);
      await c.query('COMMIT');
    } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
    await audit(req, 'role.permissions', { id, name: r.name, added: next.filter((p) => !before.includes(p)), removed: before.filter((p) => !next.includes(p)) }, null);
    return { permissions: next };
  });

  /** The standard (template) field access per role: what every project starts from. Same shape as a project's grid. */
  app.get('/api/platform/ticket-fields', { preHandler: sup }, async () => {
    const rs = (await pool.query('SELECT id, name, is_system FROM roles WHERE project_id IS NULL ORDER BY is_system DESC, id')).rows;
    const rows = (await pool.query('SELECT role_id, field, access FROM ticket_field_access')).rows;
    return {
      levels: LEVELS,
      fields: FIELDS.map(({ key, label, description, writable, min }) => ({ key, label, description, writable, min })),
      roles: rs.map((r) => ({ id: r.id, name: r.name, isSystem: r.is_system, locked: r.name === PROJECT_ADMIN_ROLE, tuned: false, access: r.name === PROJECT_ADMIN_ROLE ? ALL_WRITE : resolveFieldAccess(rows.filter((x) => x.role_id === r.id)) })),
    };
  });

  app.put('/api/platform/roles/:id/ticket-fields', { preHandler: sup }, async (req) => {
    const { id } = z.object({ id: z.coerce.number().int() }).parse(req.params);
    const { access } = z.object({ access: z.record(z.string(), z.string()) }).parse(req.body);
    const r = await roleRow(id);
    if (r.name === PROJECT_ADMIN_ROLE) throw new DocError('Project Admin always has full access to every field', 400);
    const problem = validateFieldAccess(access);
    if (problem) throw new DocError(problem, 400);
    for (const [field, level] of Object.entries(access))
      await pool.query(`INSERT INTO ticket_field_access (role_id, field, access) VALUES ($1,$2,$3) ON CONFLICT (role_id, field) DO UPDATE SET access = EXCLUDED.access`, [id, field, level]);
    await audit(req, 'role.ticket-fields', { id, name: r.name, access }, null);
    return { ok: true };
  });

  app.delete('/api/platform/roles/:id', { preHandler: sup }, async (req) => {
    const { id } = z.object({ id: z.coerce.number().int() }).parse(req.params);
    const r = await roleRow(id);
    if (r.is_system) throw new DocError('Built-in roles cannot be deleted', 400);
    if ((await pool.query('SELECT 1 FROM project_members WHERE role_id=$1', [id])).rowCount) throw new DocError('People in projects still hold this role. Change their role first', 409);
    if ((await pool.query('SELECT 1 FROM approval_level_approvers WHERE role_id=$1', [id])).rowCount) throw new DocError('This role is used in an approval workflow. Change the workflow first', 409);
    await pool.query('DELETE FROM roles WHERE id=$1', [id]);
    await audit(req, 'role.delete', { id, name: r.name }, null);
    return { ok: true };
  });

  // ---------------- technology stack catalog
  app.get('/api/platform/stacks', { preHandler: sup }, async () =>
    (await pool.query(`SELECT s.*, (SELECT count(*)::int FROM project_stacks ps WHERE ps.stack_id = s.id) AS projects FROM tech_stacks s ORDER BY s.name`)).rows);

  app.post('/api/platform/stacks', { preHandler: sup }, async (req, reply) => {
    const b = z.object({ name: z.string().trim().min(1).max(40), description: z.string().max(400).default(''), keywords: KEYWORDS.default([]) }).parse(req.body);
    if ((await pool.query('SELECT 1 FROM tech_stacks WHERE lower(name)=lower($1)', [b.name])).rowCount) throw new DocError('A stack with that name already exists', 409);
    const id = (await pool.query('INSERT INTO tech_stacks (name, description, keywords) VALUES ($1,$2,$3) RETURNING id', [b.name, b.description, b.keywords])).rows[0].id;
    await audit(req, 'stack.create', { id, name: b.name }, null);
    return reply.code(201).send({ id });
  });

  app.patch('/api/platform/stacks/:id', { preHandler: sup }, async (req) => {
    const { id } = z.object({ id: z.coerce.number().int() }).parse(req.params);
    const b = z.object({ description: z.string().max(400).optional(), keywords: KEYWORDS.optional() }).parse(req.body);
    const r = await pool.query('UPDATE tech_stacks SET description=COALESCE($2,description), keywords=COALESCE($3,keywords) WHERE id=$1 RETURNING name', [id, b.description ?? null, b.keywords ?? null]);
    if (!r.rowCount) throw new DocError('Stack not found', 404);
    await audit(req, 'stack.update', { id, name: r.rows[0].name }, null);
    return { ok: true };
  });

  app.delete('/api/platform/stacks/:id', { preHandler: sup }, async (req) => {
    const { id } = z.object({ id: z.coerce.number().int() }).parse(req.params);
    if ((await pool.query('SELECT 1 FROM project_stacks WHERE stack_id=$1', [id])).rowCount) throw new DocError('Remove this stack from its projects first', 409);
    const r = await pool.query('DELETE FROM tech_stacks WHERE id=$1 RETURNING name', [id]);
    if (!r.rowCount) throw new DocError('Stack not found', 404);
    await audit(req, 'stack.delete', { id, name: r.rows[0].name }, null);
    return { ok: true };
  });

  // ---------------- audit
  app.get('/api/platform/audit', { preHandler: sup }, async () =>
    (await pool.query(`SELECT a.id, a.action, a.detail, a.created_at, u.display_name AS actor, p.name AS project FROM audit_log a LEFT JOIN users u ON u.id = a.actor_id LEFT JOIN projects p ON p.id = a.project_id ORDER BY a.id DESC LIMIT 200`)).rows);
}
