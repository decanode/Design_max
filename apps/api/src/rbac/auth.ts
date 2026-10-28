import { createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { pool, runWithContext, type DbContext } from '../db.js';
import { ALL_KEYS, PROJECT_ADMIN_ROLE } from './permissions.js';
import { effectiveFields, effectivePerms } from './effective.js';
import { ALL_WRITE, resolveFieldAccess, type FieldAccess } from '../tickets/fields.js';

/**
 * The signed-in person AS SEEN FROM ONE PROJECT. Everything (permissions, ticket-field access, which rows are
 * visible) is computed for `projectId`; switching project switches all of it. `roleName` is the role in that project.
 */
export interface SessionUser {
  id: string; email: string; name: string;
  isSuper: boolean;
  projectId: string | null; projectName: string | null;
  roleId: number | null; roleName: string;
  canCreateRoles: boolean;                                // may create roles of their own for the project (Super Admins always; a Project Admin when a Super Admin allowed it)
  perms: Set<string>; fields: FieldAccess;
}
declare module 'fastify' { interface FastifyRequest { user: SessionUser | null } }

export const COOKIE = 'dm_session';
export const PROJECT_COOKIE = 'dm_project';
const TTL_SECONDS = 8 * 3600;

function secret() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  if (process.env.NODE_ENV === 'production') throw new Error('SESSION_SECRET is required in production');
  return 'dev-only-session-secret';
}
const mac = (body: string) => createHmac('sha256', secret()).update(body).digest('base64url');

export function signSession(userId: string, nowMs = Date.now()) {
  const body = `${userId}.${Math.floor(nowMs / 1000) + TTL_SECONDS}`;
  return `${body}.${mac(body)}`;
}

/** Returns the user id if the token is authentic and unexpired. */
export function verifySession(token: string | undefined, nowMs = Date.now()): string | null {
  const parts = token?.split('.');
  if (!parts || parts.length !== 3) return null;
  const [id, exp, sig] = parts;
  const want = Buffer.from(mac(`${id}.${exp}`)), got = Buffer.from(sig);
  if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
  return Number(exp) * 1000 > nowMs ? id : null;
}

export const sessionCookie = (token: string | null) =>
  `${COOKIE}=${token ?? ''}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${token ? TTL_SECONDS : 0}${process.env.NODE_ENV === 'production' ? '; Secure' : ''}`;
/** Which project the person is working in. Not a credential: it is re-checked against their memberships on every request. */
export const projectCookie = (projectId: string | null) =>
  `${PROJECT_COOKIE}=${projectId ?? ''}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${projectId ? 30 * 24 * 3600 : 0}${process.env.NODE_ENV === 'production' ? '; Secure' : ''}`;

export function readCookie(header: string | undefined, name = COOKIE) {
  return header?.split(';').map((c) => c.trim().split('=')).find(([k]) => k === name)?.[1];
}

const UUID = /^[0-9a-f-]{36}$/;

export interface Membership { projectId: string; projectName: string; roleId: number; roleName: string; canCreateRoles: boolean }
export async function membershipsOf(userId: string): Promise<Membership[]> {
  return (await pool.query(
    `SELECT pm.project_id, p.name AS project_name, pm.role_id, r.name AS role_name, pm.can_create_roles FROM project_members pm
     JOIN projects p ON p.id = pm.project_id AND p.status = 'active' JOIN roles r ON r.id = pm.role_id WHERE pm.user_id = $1 ORDER BY p.name`, [userId]))
    .rows.map((m) => ({ projectId: m.project_id, projectName: m.project_name, roleId: m.role_id, roleName: m.role_name, canCreateRoles: m.can_create_roles }));
}

/**
 * Loads an active user and works out their access for one project: the requested one if they are a member
 * (Super Admins may request any active project), otherwise their only/first membership.
 */
export async function loadUser(id: string, requestedProject?: string): Promise<SessionUser | null> {
  if (!UUID.test(id)) return null;
  const u = (await pool.query('SELECT id, email, display_name, is_super_admin FROM users WHERE id = $1 AND active', [id])).rows[0];
  if (!u) return null;
  const ms = await membershipsOf(id);
  const want = requestedProject && UUID.test(requestedProject) ? requestedProject : undefined;
  let member = ms.find((m) => m.projectId === want);
  let projectId: string | null = member?.projectId ?? null;
  let projectName: string | null = member?.projectName ?? null;

  if (!member && u.is_super_admin && want) {           // a Super Admin may step into any active project
    const p = (await pool.query(`SELECT id, name FROM projects WHERE id=$1 AND status='active'`, [want])).rows[0];
    if (p) { projectId = p.id; projectName = p.name; }
  }
  if (!projectId && ms.length) { member = ms[0]; projectId = member.projectId; projectName = member.projectName; }   // default: first membership

  const base = { id: u.id, email: u.email, name: u.display_name, isSuper: !!u.is_super_admin, projectId, projectName };
  if (u.is_super_admin) return { ...base, roleId: member?.roleId ?? null, roleName: member?.roleName ?? 'Super Admin', canCreateRoles: true, perms: new Set(ALL_KEYS), fields: ALL_WRITE };
  if (!member) return { ...base, roleId: null, roleName: 'No project', canCreateRoles: false, perms: new Set(), fields: resolveFieldAccess([]) };
  const [perms, fields] = await Promise.all([
    effectivePerms(pool, member.projectId, member.roleId, member.roleName),
    effectiveFields(pool, member.projectId, member.roleId, member.roleName),
  ]);
  return { ...base, roleId: member.roleId, roleName: member.roleName, canCreateRoles: member.canCreateRoles && member.roleName === PROJECT_ADMIN_ROLE, perms: new Set(perms), fields };
}

/** Resolves the session cookie (and the chosen-project cookie) from a raw Cookie header. */
export async function userFromCookie(header: string | undefined) {
  const id = verifySession(readCookie(header));
  return id ? loadUser(id, readCookie(header, PROJECT_COOKIE)) : null;
}

/** Routes under /api/ that work without a session. Approval-by-token carries its own credential. */
const PUBLIC = [/^\/api\/auth\//, /^\/api\/states$/, /^\/api\/approvals\/[^/]+(\/decision)?$/];

/**
 * Routes that legitimately span projects run as the platform: the Super Admin console (guarded by `needSuper`), sign-in and
 * project switching, and the public emailed-link approval (the link's token is its authority for exactly one approval).
 */
const PLATFORM_ROUTES = [/^\/api\/platform\//, /^\/api\/auth\//, /^\/api\/approvals\/[^/]+(\/decision)?$/, /^\/health\/db$/];

export function registerAuth(app: FastifyInstance) {
  app.decorateRequest('user', null);

  // 1. Work out who this is and which database context the rest of the request runs in. Everything after this hook
  //    (including the route handler) runs inside that context, so the database itself enforces the project wall.
  app.addHook('onRequest', (req, _reply, done) => {
    userFromCookie(req.headers.cookie).then((u) => {
      req.user = u;
      const path = req.url.split('?')[0];
      const ctx: DbContext = PLATFORM_ROUTES.some((p) => p.test(path)) ? { platform: true } : u?.projectId ? { projectId: u.projectId } : {};
      runWithContext(ctx, () => done());
    }, done);
  });

  // 2. Everything under /api needs a session, except the public routes.
  app.addHook('onRequest', async (req, reply) => {
    const path = req.url.split('?')[0];
    if (path.startsWith('/api/') && !req.user && !PUBLIC.some((p) => p.test(path)))
      return reply.code(401).send({ error: 'Sign in required' });
  });
}

const noProject = (reply: FastifyReply) => reply.code(409).send({ error: 'Choose a project first', code: 'NO_PROJECT' });

/** preHandler requiring ALL listed permissions, inside the person's current project. */
export const need = (...keys: string[]) => async (req: FastifyRequest, reply: FastifyReply) => {
  if (!req.user) return reply.code(401).send({ error: 'Sign in required' });
  if (!req.user.projectId) return noProject(reply);
  const missing = keys.filter((k) => !req.user!.perms.has(k));
  if (missing.length) return reply.code(403).send({ error: 'Your role does not allow this', missing });
};

/** preHandler requiring AT LEAST ONE of the listed permissions, inside the current project. */
export const needAny = (...keys: string[]) => async (req: FastifyRequest, reply: FastifyReply) => {
  if (!req.user) return reply.code(401).send({ error: 'Sign in required' });
  if (!req.user.projectId) return noProject(reply);
  if (!keys.some((k) => req.user!.perms.has(k))) return reply.code(403).send({ error: 'Your role does not allow this' });
};

/** Platform-level routes: Super Admins only, and no project needed. */
export const needSuper = () => async (req: FastifyRequest, reply: FastifyReply) => {
  if (!req.user) return reply.code(401).send({ error: 'Sign in required' });
  if (!req.user.isSuper) return reply.code(403).send({ error: 'Only a Super Admin can do this' });
};

/** Just needs someone signed in and working in a project (no particular permission). */
export const inProject = () => async (req: FastifyRequest, reply: FastifyReply) => {
  if (!req.user) return reply.code(401).send({ error: 'Sign in required' });
  if (!req.user.projectId) return noProject(reply);
};

/**
 * SQL predicate limiting tickets (alias t) to what the user may see: ONLY their current project, and within it
 * everything / their own / the unassigned queue depending on permissions. `p` is the next free $ placeholder index.
 */
export function ticketScope(u: SessionUser, p: number): { sql: string; params: unknown[] } {
  if (!u.projectId) return { sql: 'FALSE', params: [] };
  const params: unknown[] = [u.projectId];
  const inProj = `t.project_id = $${p}`;
  if (u.perms.has('ticket.view_all')) return { sql: inProj, params };
  const parts: string[] = [];
  const me = () => { if (params.length < 2) params.push(u.id); return `$${p + 1}`; };       // the person's id is passed once and reused
  if (u.perms.has('ticket.view_own')) parts.push(`(t.customer_id = ${me()} OR t.consultant_id = ${me()})`);
  if (u.perms.has('ticket.view_unassigned')) parts.push('t.consultant_id IS NULL');
  if (u.perms.has('ticket.team_access')) parts.push(`t.team_id IN (SELECT tm.team_id FROM team_members tm WHERE tm.user_id = ${me()})`);
  return { sql: parts.length ? `${inProj} AND (${parts.join(' OR ')})` : 'FALSE', params };
}

export async function ticketVisible(u: SessionUser, ticketId: string) {
  const s = ticketScope(u, 2);
  return !!(await pool.query(`SELECT 1 FROM tickets t WHERE t.id = $1 AND ${s.sql}`, [ticketId, ...s.params])).rowCount;
}
