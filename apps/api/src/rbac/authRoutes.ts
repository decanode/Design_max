import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool } from '../db.js';
import { loadUser, sessionCookie, signSession } from './auth.js';

export const devLoginEnabled = () => process.env.NODE_ENV !== 'production' && process.env.DEV_LOGIN !== 'off';

const DEMO = [
  { name: 'Ada Admin', email: 'ada@designmax.dev', role: 'Admin' },
  { name: 'Leo Lead', email: 'leo@designmax.dev', role: 'Lead' },
  { name: 'Mia Manager', email: 'mia@designmax.dev', role: 'Manager' },
  { name: 'Sam Consultant', email: 'sam@designmax.dev', role: 'Consultant' },
  { name: 'Cleo Customer', email: 'cleo@designmax.dev', role: 'Customer' },
];

export function registerAuthRoutes(app: FastifyInstance) {
  const devOnly = async (_: unknown, reply: any) => { if (!devLoginEnabled()) return reply.code(404).send({ error: 'Not found' }); };

  app.get('/api/auth/me', async (req, reply) => {
    if (!req.user) return reply.code(401).send({ error: 'Sign in required' });
    const u = req.user;
    return { user: { id: u.id, email: u.email, name: u.name, roleId: u.roleId, role: u.roleName }, permissions: [...u.perms].sort() };
  });

  app.post('/api/auth/logout', async (_req, reply) => reply.header('set-cookie', sessionCookie(null)).send({ ok: true }));

  // Development sign-in, standing in for Entra ID SSO (Sprint 4). Disabled in production.
  app.get('/api/auth/dev-users', { preHandler: devOnly }, async () =>
    (await pool.query(`SELECT u.id, u.display_name AS name, u.email, r.name AS role FROM users u JOIN roles r ON r.id=u.role_id WHERE u.active AND r.name <> 'Approver' ORDER BY r.id, u.display_name`)).rows); // Approvers act by emailed link only

  app.post('/api/auth/dev-login', { preHandler: devOnly }, async (req, reply) => {
    const { userId } = z.object({ userId: z.string().uuid() }).parse(req.body);
    if (!(await loadUser(userId))) return reply.code(404).send({ error: 'No such active user' });
    return reply.header('set-cookie', sessionCookie(signSession(userId))).send({ ok: true });
  });

  /** One-click demo accounts, only while the system has no users at all. */
  app.post('/api/auth/bootstrap-demo', { preHandler: devOnly }, async (_req, reply) => {
    if ((await pool.query('SELECT 1 FROM users LIMIT 1')).rowCount) return reply.code(409).send({ error: 'Users already exist' });
    for (const d of DEMO)
      await pool.query(`INSERT INTO users (email, display_name, role_id) VALUES ($1,$2,(SELECT id FROM roles WHERE name=$3))`, [d.email, d.name, d.role]);
    if (!(await pool.query('SELECT 1 FROM projects LIMIT 1')).rowCount) await pool.query("INSERT INTO projects (name) VALUES ('Default')");
    return reply.code(201).send({ created: DEMO.length });
  });

  /** First-run: create the initial Admin when no users exist. */
  app.post('/api/auth/bootstrap-admin', { preHandler: devOnly }, async (req, reply) => {
    const b = z.object({ email: z.string().email(), name: z.string().min(1).max(80) }).parse(req.body);
    if ((await pool.query('SELECT 1 FROM users LIMIT 1')).rowCount) return reply.code(409).send({ error: 'Users already exist' });
    await pool.query(`INSERT INTO users (email, display_name, role_id) VALUES ($1,$2,(SELECT id FROM roles WHERE name='Admin'))`, [b.email.toLowerCase(), b.name]);
    return reply.code(201).send({ created: 1 });
  });
}
