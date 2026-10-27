import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { io as client } from 'socket.io-client';
import type { AddressInfo } from 'node:net';
import { pool } from '../db.js';
import { buildApp } from '../app.js';
import { attachChat } from '../chat/socket.js';
import { RuleBasedObserver } from '../chat/observer.js';
import { TemplateGenerator } from '../docs/generator.js';
import { HashEmbedder } from '../etl/vectorize.js';
import { createConversation } from '../chat/service.js';
import { createTicket } from '../tickets.js';
import { makeUser } from '../testAuth.js';
import { signSession, verifySession } from './auth.js';
import { ALL_KEYS, CATALOG } from './permissions.js';

const app = buildApp({ generator: new TemplateGenerator(), embedder: new HashEmbedder() });
let url: string, projectId: string;
type U = Awaited<ReturnType<typeof makeUser>>;
let admin: U, lead: U, manager: U, consultant: U, consultant2: U, customer: U, customer2: U;

const call = async (u: U | null, method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', path: string, payload?: unknown) => {
  const r = await app.inject({ method, url: path, payload: payload as any, headers: u ? { cookie: u.cookie } : {} });
  return { status: r.statusCode, body: r.json() as any };
};
const ticketFor = async (o: { customer?: U; consultant?: U; title?: string } = {}) => {
  const t = await createTicket(projectId, o.title ?? 'T');
  await pool.query('UPDATE tickets SET customer_id=$2, consultant_id=$3 WHERE id=$1', [t.id, o.customer?.id ?? null, o.consultant?.id ?? null]);
  return t.id as string;
};
const roleId = async (name: string) => (await pool.query('SELECT id FROM roles WHERE name=$1', [name])).rows[0].id as number;

beforeAll(async () => {
  await app.ready(); attachChat(app.server, new RuleBasedObserver()); await app.listen({ port: 0 });
  url = `http://localhost:${(app.server.address() as AddressInfo).port}`;
  projectId = (await pool.query("INSERT INTO projects(name) VALUES('rbac') RETURNING id")).rows[0].id;
  [admin, lead, manager, consultant, consultant2, customer, customer2] = await Promise.all(
    ['Admin', 'Lead', 'Manager', 'Consultant', 'Consultant', 'Customer', 'Customer'].map((r) => makeUser(r)));
});
afterAll(async () => { await app.close(); await pool.end(); });

describe('sessions', () => {
  it('requires a valid signed session on /api, but not on public routes', async () => {
    expect((await call(null, 'GET', '/api/tickets')).status).toBe(401);
    expect((await call(null, 'GET', '/api/admin/roles')).status).toBe(401);
    expect((await call(null, 'GET', '/health')).status).toBe(200);
    expect((await call(null, 'GET', '/api/states')).status).toBe(200);
    expect((await call(null, 'GET', `/api/approvals/${'x'.repeat(30)}`)).status).toBe(404); // token route: reaches the handler
  });
  it('rejects tampered and expired tokens', () => {
    const good = signSession(customer.id);
    expect(verifySession(good)).toBe(customer.id);
    expect(verifySession(good.slice(0, -2) + 'xx')).toBeNull();
    expect(verifySession(good.replace(customer.id, admin.id))).toBeNull();
    expect(verifySession(signSession(customer.id, Date.now() - 9 * 3600 * 1000))).toBeNull();
    expect(verifySession(undefined)).toBeNull();
  });
  it('a deactivated user loses access immediately', async () => {
    const u = await makeUser('Customer');
    expect((await call(u, 'GET', '/api/tickets')).status).toBe(200);
    await pool.query('UPDATE users SET active=false WHERE id=$1', [u.id]);
    expect((await call(u, 'GET', '/api/tickets')).status).toBe(401);
  });
  it('/me reports role and permissions; Admin has the whole catalog', async () => {
    expect((await call(admin, 'GET', '/api/auth/me')).body.permissions).toEqual([...ALL_KEYS].sort());
    const me = (await call(customer, 'GET', '/api/auth/me')).body;
    expect(me.user.role).toBe('Customer');
    expect(me.permissions).toContain('chat.as_customer');
    expect(me.permissions).not.toContain('admin.roles');
  });
  it('seeded default permissions only use keys from the catalog', async () => {
    const keys = (await pool.query('SELECT DISTINCT permission FROM role_permissions')).rows.map((r) => r.permission);
    expect(keys.filter((k) => !ALL_KEYS.includes(k))).toEqual([]);
    expect(CATALOG.length).toBeGreaterThan(5);
  });
});

describe('Customer', () => {
  it('sees only their own tickets and cannot create, advance or administer', async () => {
    const mine = await ticketFor({ customer, title: 'cust-mine' });
    const theirs = await ticketFor({ customer: customer2, title: 'cust-other' });
    const titles = (await call(customer, 'GET', '/api/tickets')).body.map((t: any) => t.title);
    expect(titles).toContain('cust-mine'); expect(titles).not.toContain('cust-other');
    expect((await call(customer, 'GET', `/api/tickets/${mine}`)).status).toBe(200);
    expect((await call(customer, 'GET', `/api/tickets/${theirs}`)).status).toBe(404);  // not even revealed
    expect((await call(customer, 'POST', '/api/tickets', { projectId, title: 'x' })).status).toBe(403);
    expect((await call(customer, 'POST', `/api/tickets/${mine}/transition`, { to: 'FS Drafted' })).status).toBe(403);
    expect((await call(customer, 'POST', `/api/tickets/${mine}/documents/generate`, { kind: 'FS' })).status).toBe(403);
    expect((await call(customer, 'GET', '/api/admin/roles')).status).toBe(403);
    expect((await call(customer, 'GET', '/api/dev/outbox')).status).toBe(403);
    expect((await call(customer, 'GET', '/api/dashboard/team')).status).toBe(403);
  });
});

describe('Consultant', () => {
  it('sees own + unassigned tickets, can claim once, and can draft specs on visible tickets', async () => {
    const unassigned = await ticketFor({ title: 'cons-unassigned' });
    const others = await ticketFor({ consultant: consultant2, title: 'cons-others' });
    const titles = (await call(consultant, 'GET', '/api/tickets')).body.map((t: any) => t.title);
    expect(titles).toContain('cons-unassigned'); expect(titles).not.toContain('cons-others');
    expect((await call(consultant, 'GET', `/api/tickets/${others}`)).status).toBe(404);

    expect((await call(consultant, 'POST', `/api/tickets/${unassigned}/claim`)).status).toBe(200);
    expect((await call(consultant2, 'POST', `/api/tickets/${unassigned}/claim`)).status).toBe(409);
    expect((await call(consultant2, 'GET', `/api/tickets/${unassigned}`)).status).toBe(404); // now someone else's
    expect((await call(consultant, 'POST', `/api/tickets/${unassigned}/documents/generate`, { kind: 'FS' })).status).toBe(201);
    expect((await call(consultant, 'POST', `/api/tickets/${others}/documents/generate`, { kind: 'FS' })).status).toBe(404);
    expect((await call(consultant, 'POST', `/api/tickets/${unassigned}/assign`, { consultantId: consultant2.id })).status).toBe(403);
    expect((await call(consultant, 'POST', `/api/tickets/${unassigned}/transition`, { to: 'FS Approved' })).status).toBe(403);
    expect((await call(consultant, 'PUT', '/api/admin/roles/1/permissions', { permissions: [] })).status).toBe(403);
  });
  it('the author of a saved version is the signed-in user, not a client-supplied name', async () => {
    const t = await ticketFor({ consultant, title: 'author' });
    await call(consultant, 'POST', `/api/tickets/${t}/documents/generate`, { kind: 'FS' });
    await call(consultant, 'POST', `/api/tickets/${t}/documents/FS/versions`, { content: 'new text', baseVersion: 1, author: 'Somebody Else' });
    const v = (await call(consultant, 'GET', `/api/tickets/${t}/documents/FS/versions/2`)).body;
    expect(v.author_name).toBe(`Consultant ${consultant.email.split('-')[1].split('@')[0]}`);
  });
});

describe('Lead and Manager', () => {
  it('Lead sees everything, assigns work and has the team dashboard but no admin', async () => {
    const t = await ticketFor({ title: 'lead-t' });
    expect((await call(lead, 'GET', `/api/tickets/${t}`)).status).toBe(200);
    expect((await call(lead, 'GET', '/api/users/assignable')).body.map((u: any) => u.id)).toContain(consultant.id);
    expect((await call(lead, 'POST', `/api/tickets/${t}/assign`, { consultantId: consultant.id })).status).toBe(200);
    expect((await call(consultant, 'GET', `/api/tickets/${t}`)).status).toBe(200);
    const team = (await call(lead, 'GET', '/api/dashboard/team')).body;
    expect(team.consultants.find((c: any) => c.id === consultant.id).open).toBeGreaterThanOrEqual(1);
    expect((await call(lead, 'POST', '/api/admin/users', { email: 'a@b.co', name: 'x', roleId: 1 })).status).toBe(403);
    expect((await call(manager, 'GET', '/api/dashboard/team')).status).toBe(403);
  });

  it('Manager decides approvals addressed to them, and only them', async () => {
    const t = await ticketFor({ consultant, title: 'mgr-approval' });
    await call(consultant, 'POST', `/api/tickets/${t}/documents/generate`, { kind: 'FS' });
    expect((await call(consultant, 'POST', `/api/tickets/${t}/approvals`, { kind: 'FS', approverEmail: manager.email })).status).toBe(201);

    const mine = (await call(manager, 'GET', '/api/my/approvals')).body;
    const a = mine.find((x: any) => x.ticket_id === t);
    expect(a).toBeTruthy();
    expect((await call(manager, 'GET', '/api/dashboard/portfolio')).body.mine).toBeGreaterThanOrEqual(1);

    const other = await makeUser('Manager');
    expect((await call(other, 'POST', `/api/my/approvals/${a.id}/decision`, { decision: 'approved' })).status).toBe(403);
    expect((await call(consultant, 'POST', `/api/my/approvals/${a.id}/decision`, { decision: 'approved' })).status).toBe(403); // lacks approval.decide
    expect((await call(manager, 'POST', `/api/my/approvals/${a.id}/decision`, { decision: 'approved' })).status).toBe(200);
    expect((await pool.query('SELECT current_state s FROM tickets WHERE id=$1', [t])).rows[0].s).toBe('FS Approved');
    expect((await call(manager, 'POST', `/api/my/approvals/${a.id}/decision`, { decision: 'approved' })).status).toBe(409);
    expect((await call(manager, 'POST', `/api/tickets/${t}/documents/generate`, { kind: 'TS' })).status).toBe(403); // approves, does not author
  });
});

describe('Admin: roles, permissions and users', () => {
  it('exposes the permission catalog and roles with their permissions', async () => {
    expect((await call(admin, 'GET', '/api/admin/catalog')).body.map((f: any) => f.feature)).toContain('Specifications');
    const roles = (await call(admin, 'GET', '/api/admin/roles')).body;
    expect(roles.map((r: any) => r.name)).toEqual(expect.arrayContaining(['Customer', 'Consultant', 'Lead', 'Manager', 'Admin']));
    const a = roles.find((r: any) => r.name === 'Admin');
    expect(a.locked).toBe(true); expect(a.permissions).toHaveLength(ALL_KEYS.length);
  });

  it('builds a custom role, assigns it, and permission changes apply immediately', async () => {
    const copy = await roleId('Consultant');
    const created = await call(admin, 'POST', '/api/admin/roles', { name: 'Solution Architect', description: 'Designs TS', copyFromRoleId: copy });
    expect(created.status).toBe(201);
    const rid = created.body.id;
    expect((await call(admin, 'POST', '/api/admin/roles', { name: 'solution architect' })).status).toBe(409);

    const mk = await call(admin, 'POST', '/api/admin/users', { email: `arch-${Date.now()}@test.dev`, name: 'Arch', roleId: rid });
    expect(mk.status).toBe(201);
    const arch = { id: mk.body.id, cookie: `dm_session=${signSession(mk.body.id)}` } as U;
    expect((await call(arch, 'GET', '/api/tickets')).status).toBe(200);          // inherited board.view
    expect((await call(arch, 'GET', '/api/dev/outbox')).status).toBe(403);

    const perms = (await call(admin, 'GET', '/api/admin/roles')).body.find((r: any) => r.id === rid).permissions;
    expect((await call(admin, 'PUT', `/api/admin/roles/${rid}/permissions`, { permissions: [...perms, 'mailbox.view'] })).status).toBe(200);
    expect((await call(arch, 'GET', '/api/dev/outbox')).status).toBe(200);        // granted, no re-login needed
    expect((await call(admin, 'PUT', `/api/admin/roles/${rid}/permissions`, { permissions: perms.filter((p: string) => p !== 'board.view') })).status).toBe(200);
    expect((await call(arch, 'GET', '/api/tickets')).status).toBe(403);           // revoked

    expect((await call(admin, 'PUT', `/api/admin/roles/${rid}/permissions`, { permissions: ['not.a.permission'] })).status).toBe(400);
    expect((await call(admin, 'DELETE', `/api/admin/roles/${rid}`)).status).toBe(409);   // has a user
    expect((await call(admin, 'PATCH', `/api/admin/users/${arch.id}`, { roleId: await roleId('Customer') })).status).toBe(200);
    expect((await call(admin, 'DELETE', `/api/admin/roles/${rid}`)).status).toBe(200);
  });

  it('protects built-in roles and the Admin role', async () => {
    const adminRole = await roleId('Admin'), cust = await roleId('Customer');
    expect((await call(admin, 'PUT', `/api/admin/roles/${adminRole}/permissions`, { permissions: [] })).status).toBe(400);
    expect((await call(admin, 'DELETE', `/api/admin/roles/${cust}`)).status).toBe(400);
    expect((await call(admin, 'PATCH', `/api/admin/roles/${cust}`, { name: 'Client' })).status).toBe(400);
    expect((await call(admin, 'PATCH', `/api/admin/roles/${cust}`, { description: 'Updated text' })).status).toBe(200);
  });

  it('a role can be given a feature it never had (e.g. Customer may view specs only after the Admin grants it)', async () => {
    const cust = await roleId('Customer');
    const before = (await call(admin, 'GET', '/api/admin/roles')).body.find((r: any) => r.id === cust).permissions as string[];
    await call(admin, 'PUT', `/api/admin/roles/${cust}/permissions`, { permissions: before.filter((p) => p !== 'spec.view') });
    const t = await ticketFor({ customer, title: 'spec-view' });
    expect((await call(customer, 'GET', `/api/tickets/${t}`)).body.docs).toEqual({ FS: null, TS: null });
    await call(admin, 'PUT', `/api/admin/roles/${cust}/permissions`, { permissions: before });
  });

  it('never leaves the system without an active Admin, and records changes in the audit log', async () => {
    const others = (await pool.query(`SELECT u.id FROM users u JOIN roles r ON r.id=u.role_id WHERE r.name='Admin' AND u.active AND u.id<>$1`, [admin.id])).rows.map((r) => r.id);
    await pool.query('UPDATE users SET active=false WHERE id = ANY($1)', [others]);
    try {
      expect((await call(admin, 'PATCH', `/api/admin/users/${admin.id}`, { active: false })).status).toBe(400);
      expect((await call(admin, 'PATCH', `/api/admin/users/${admin.id}`, { roleId: await roleId('Lead') })).status).toBe(400);
      expect((await call(admin, 'PATCH', `/api/admin/users/${admin.id}`, { name: 'Renamed Admin' })).status).toBe(200);
    } finally { await pool.query('UPDATE users SET active=true WHERE id = ANY($1)', [others]); }
    const log = (await call(admin, 'GET', '/api/admin/audit')).body;
    expect(log.map((l: any) => l.action)).toEqual(expect.arrayContaining(['role.create', 'role.permissions', 'user.create']));
  });
});

describe('chat access', () => {
  it('customers reach only their own conversations; consultants reach all; roles gate who can speak as whom', async () => {
    const convo = (await createConversation(projectId, undefined, customer.id)).id as string;
    const sock = (u: U) => client(url, { extraHeaders: { cookie: u.cookie }, reconnection: false });
    const emit = (s: ReturnType<typeof sock>, ev: string, data: unknown) => new Promise<any>((r) => s.emit(ev, data, r));
    const open = async (u: U) => { const s = sock(u); await new Promise<void>((r) => s.once('connect', () => r())); return s; };

    const mine = await open(customer), stranger = await open(customer2), staff = await open(consultant);
    expect((await emit(mine, 'join', { conversationId: convo })).messages).toBeDefined();
    expect((await emit(stranger, 'join', { conversationId: convo })).error).toBeTruthy();
    expect((await emit(staff, 'join', { conversationId: convo })).messages).toBeDefined();

    expect((await emit(mine, 'message', { conversationId: convo, role: 'consultant', body: 'pretend' })).error).toMatch(/cannot send/);
    expect((await emit(staff, 'message', { conversationId: convo, role: 'customer', body: 'pretend' })).error).toMatch(/cannot send/);
    expect((await emit(stranger, 'message', { conversationId: convo, body: 'hi' })).error).toBeTruthy();
    expect((await emit(mine, 'message', { conversationId: convo, body: 'We need to block vendor Acme' })).ok).toBe(true);
    expect((await emit(staff, 'message', { conversationId: convo, body: 'Sure' })).ok).toBe(true);
    expect((await emit(staff, 'verify', { conversationId: convo })).error).toMatch(/cannot verify/);
    [mine, stranger, staff].forEach((s) => s.close());

    const names = (await pool.query('SELECT sender_name FROM messages WHERE conversation_id=$1 ORDER BY id', [convo])).rows.map((r) => r.sender_name);
    expect(names[0]).toMatch(/^Customer /); expect(names[1]).toMatch(/^Consultant /);

    expect((await call(customer2, 'GET', `/api/conversations/${convo}`)).status).toBe(404);
    expect((await call(customer, 'GET', '/api/conversations')).body.map((c: any) => c.id)).toContain(convo);
    expect((await call(customer2, 'GET', '/api/conversations')).body.map((c: any) => c.id)).not.toContain(convo);
  });
  it('unauthenticated sockets are refused', async () => {
    const s = client(url, { reconnection: false });
    const err = await new Promise<Error>((r) => s.once('connect_error', r));
    expect(err.message).toMatch(/Sign in/);
    s.close();
  });
});
