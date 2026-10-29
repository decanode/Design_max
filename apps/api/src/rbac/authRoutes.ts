import { modulesOf } from '../planning/service.js';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool } from '../db.js';
import { loadUser, membershipsOf, projectCookie, sessionCookie, signSession } from './auth.js';
import { audit } from './audit.js';
import { PROJECT_ADMIN_ROLE } from './permissions.js';
import { copyTemplateWorkflows } from '../platform/routes.js';

export const devLoginEnabled = () => process.env.NODE_ENV !== 'production' && process.env.DEV_LOGIN !== 'off';

const DEMO = [
  { name: 'Ada Admin', email: 'ada@designmax.dev', role: null as string | null },          // Super Admin
  { name: 'Pia Project Admin', email: 'pia@designmax.dev', role: PROJECT_ADMIN_ROLE },
  { name: 'Leo Lead', email: 'leo@designmax.dev', role: 'Lead' },
  { name: 'Mia Manager', email: 'mia@designmax.dev', role: 'Manager' },
  { name: 'Pam Project Manager', email: 'pam@designmax.dev', role: 'Project Manager' },
  { name: 'Sam Consultant', email: 'sam@designmax.dev', role: 'Consultant' },
  { name: 'Cleo Customer', email: 'cleo@designmax.dev', role: 'Customer' },
];

export function registerAuthRoutes(app: FastifyInstance) {
  const devOnly = async (_: unknown, reply: any) => { if (!devLoginEnabled()) return reply.code(404).send({ error: 'Not found' }); };

  /** Who am I, which project am I in, what can I do there, and which other projects can I switch to. */
  app.get('/api/auth/me', async (req, reply) => {
    if (!req.user) return reply.code(401).send({ error: 'Sign in required' });
    const u = req.user;
    const projects = u.isSuper
      ? (await pool.query(`SELECT p.id, p.name, (SELECT r.name FROM project_members m JOIN roles r ON r.id=m.role_id WHERE m.project_id=p.id AND m.user_id=$1) AS role FROM projects p WHERE p.status='active' ORDER BY p.name`, [u.id])).rows
      : (await membershipsOf(u.id)).map((m) => ({ id: m.projectId, name: m.projectName, role: m.roleName }));
    return {
      user: { id: u.id, email: u.email, name: u.name, role: u.roleName, roleId: u.roleId, isSuperAdmin: u.isSuper },
      project: u.projectId ? { id: u.projectId, name: u.projectName, modules: await modulesOf(u.projectId), canCreateRoles: u.canCreateRoles, operatingMode: u.operatingMode, caps: u.caps } : null,
      projects, permissions: [...u.perms].sort(),
    };
  });

  /** Switch the project you are working in. Super Admins entering a project they do not belong to is recorded. */
  app.post('/api/auth/project', async (req, reply) => {
    if (!req.user) return reply.code(401).send({ error: 'Sign in required' });
    const { projectId } = z.object({ projectId: z.string().uuid() }).parse(req.body);
    const target = await loadUser(req.user.id, projectId);
    if (!target || target.projectId !== projectId) return reply.code(403).send({ error: 'You are not a member of that project' });
    const member = (await pool.query('SELECT 1 FROM project_members WHERE project_id=$1 AND user_id=$2', [projectId, req.user.id])).rowCount;
    if (req.user.isSuper && !member) await audit(req, 'project.enter', { project: target.projectName }, projectId);   // Super Admin looked inside: leave a trace
    return reply.header('set-cookie', projectCookie(projectId)).send({ ok: true });
  });

  app.post('/api/auth/logout', async (_req, reply) =>
    reply.header('set-cookie', [sessionCookie(null), projectCookie(null)]).send({ ok: true }));

  // Development sign-in, standing in for Entra ID SSO (Sprint 4). Disabled in production.
  app.get('/api/auth/dev-users', { preHandler: devOnly }, async () =>
    (await pool.query(
      `SELECT u.id, u.display_name AS name, u.email,
              CASE WHEN u.is_super_admin THEN 'Super Admin'
                   ELSE COALESCE((SELECT r.name FROM project_members m JOIN roles r ON r.id=m.role_id WHERE m.user_id=u.id ORDER BY (r.name = $1) DESC, r.id LIMIT 1), 'No project') END AS role
       FROM users u WHERE u.active ORDER BY u.is_super_admin DESC, 3, u.display_name`, [PROJECT_ADMIN_ROLE])).rows
      .filter((r) => r.role !== 'Approver'));          // external approvers act by emailed link only

  app.post('/api/auth/dev-login', { preHandler: devOnly }, async (req, reply) => {
    const { userId } = z.object({ userId: z.string().uuid() }).parse(req.body);
    if (!(await loadUser(userId))) return reply.code(404).send({ error: 'No such active user' });
    return reply.header('set-cookie', [sessionCookie(signSession(userId)), projectCookie(null)]).send({ ok: true });
  });

  /** One-click demo workspace, only while the system has no users at all. */
  app.post('/api/auth/bootstrap-demo', { preHandler: devOnly }, async (_req, reply) => {
    if ((await pool.query('SELECT 1 FROM users LIMIT 1')).rowCount) return reply.code(409).send({ error: 'Users already exist' });
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      const pid = (await c.query("INSERT INTO projects (name) VALUES ('Default') RETURNING id")).rows[0].id;
      await copyTemplateWorkflows(c, pid);
      for (const d of DEMO) {
        const id = (await c.query('INSERT INTO users (email, display_name, is_super_admin) VALUES ($1,$2,$3) RETURNING id', [d.email, d.name, d.role === null])).rows[0].id;
        if (d.role) await c.query('INSERT INTO project_members (project_id, user_id, role_id) SELECT $1,$2,id FROM roles WHERE name=$3', [pid, id, d.role]);
      }
      await c.query('COMMIT');
    } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
    return reply.code(201).send({ created: DEMO.length });
  });

  /** First run: create the initial Super Admin when no users exist. */
  app.post('/api/auth/bootstrap-admin', { preHandler: devOnly }, async (req, reply) => {
    const b = z.object({ email: z.string().email(), name: z.string().min(1).max(80) }).parse(req.body);
    if ((await pool.query('SELECT 1 FROM users LIMIT 1')).rowCount) return reply.code(409).send({ error: 'Users already exist' });
    await pool.query('INSERT INTO users (email, display_name, is_super_admin) VALUES ($1,$2,true)', [b.email.toLowerCase(), b.name]);
    return reply.code(201).send({ created: 1 });
  });
}
