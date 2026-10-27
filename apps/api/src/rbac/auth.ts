import { createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { pool } from '../db.js';
import { ADMIN_ROLE, ALL_KEYS } from './permissions.js';

export interface SessionUser { id: string; email: string; name: string; roleId: number; roleName: string; perms: Set<string> }
declare module 'fastify' { interface FastifyRequest { user: SessionUser | null } }

export const COOKIE = 'dm_session';
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

export function readCookie(header: string | undefined, name = COOKIE) {
  return header?.split(';').map((c) => c.trim().split('=')).find(([k]) => k === name)?.[1];
}

/** Loads an active user and their effective permissions (Admin always has every permission). */
export async function loadUser(id: string): Promise<SessionUser | null> {
  if (!/^[0-9a-f-]{36}$/.test(id)) return null;
  const u = (await pool.query(
    `SELECT u.id, u.email, u.display_name, u.role_id, r.name AS role_name FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = $1 AND u.active`, [id])).rows[0];
  if (!u) return null;
  const perms = u.role_name === ADMIN_ROLE
    ? ALL_KEYS
    : (await pool.query('SELECT permission FROM role_permissions WHERE role_id = $1', [u.role_id])).rows.map((r) => r.permission as string);
  return { id: u.id, email: u.email, name: u.display_name, roleId: u.role_id, roleName: u.role_name, perms: new Set(perms) };
}

export async function userFromCookie(header: string | undefined) {
  const id = verifySession(readCookie(header));
  return id ? loadUser(id) : null;
}

/** Routes under /api/ that work without a session. Approval-by-token carries its own credential. */
const PUBLIC = [/^\/api\/auth\//, /^\/api\/states$/, /^\/api\/approvals\/[^/]+(\/decision)?$/];

export function registerAuth(app: FastifyInstance) {
  app.decorateRequest('user', null);
  app.addHook('onRequest', async (req, reply) => {
    req.user = await userFromCookie(req.headers.cookie);
    const path = req.url.split('?')[0];
    if (path.startsWith('/api/') && !req.user && !PUBLIC.some((p) => p.test(path)))
      return reply.code(401).send({ error: 'Sign in required' });
  });
}

/** preHandler requiring ALL listed permissions. */
export const need = (...keys: string[]) => async (req: FastifyRequest, reply: FastifyReply) => {
  if (!req.user) return reply.code(401).send({ error: 'Sign in required' });
  const missing = keys.filter((k) => !req.user!.perms.has(k));
  if (missing.length) return reply.code(403).send({ error: 'Your role does not allow this', missing });
};

/** preHandler requiring AT LEAST ONE of the listed permissions. */
export const needAny = (...keys: string[]) => async (req: FastifyRequest, reply: FastifyReply) => {
  if (!req.user) return reply.code(401).send({ error: 'Sign in required' });
  if (!keys.some((k) => req.user!.perms.has(k))) return reply.code(403).send({ error: 'Your role does not allow this' });
};

/** SQL predicate limiting tickets (alias t) to what the user may see. `p` is the next free $ placeholder index. */
export function ticketScope(u: SessionUser, p: number): { sql: string; params: unknown[] } {
  if (u.perms.has('ticket.view_all')) return { sql: 'TRUE', params: [] };
  const parts: string[] = []; const params: unknown[] = [];
  if (u.perms.has('ticket.view_own')) { parts.push(`(t.customer_id = $${p} OR t.consultant_id = $${p})`); params.push(u.id); }
  if (u.perms.has('ticket.view_unassigned')) parts.push('t.consultant_id IS NULL');
  return { sql: parts.length ? `(${parts.join(' OR ')})` : 'FALSE', params };
}

export async function ticketVisible(u: SessionUser, ticketId: string) {
  const s = ticketScope(u, 2);
  return !!(await pool.query(`SELECT 1 FROM tickets t WHERE t.id = $1 AND ${s.sql}`, [ticketId, ...s.params])).rowCount;
}
