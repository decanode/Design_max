import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pool } from '../db.js';
import { buildApp } from '../app.js';
import { CAPABILITIES, MODES, OVERRIDABLE, capabilitiesOf, removedPermissions, validateOverrides } from './modes.js';
import { createTicket, closingProblem } from '../tickets.js';
import { makeUser } from '../testAuth.js';

describe('the capability matrix', () => {
  it('Full is everything Design Max has always done', () => {
    const c = capabilitiesOf('full');
    expect(Object.entries(c).filter(([, v]) => !v).map(([k]) => k).sort()).toEqual(['work_gate', 'writeback']);
    expect(removedPermissions(c).size).toBe(0);
  });
  it('Connected pulls tickets in, cannot create its own, and may write back', () => {
    const c = capabilitiesOf('connected');
    expect(c).toMatchObject({ native_ticket_create: false, customer_intake: false, ticket_creation_approval: false, writeback: true, connector: true, closing_gates: true, customer_signoff: true });
    expect([...removedPermissions(c)].sort()).toEqual(['chat.as_customer', 'chat.verify', 'ticket.create']);
  });
  it('Mirror never writes back and has no closing gates by default', () => {
    expect(capabilitiesOf('mirror')).toMatchObject({ writeback: false, closing_gates: false, customer_signoff: false, native_ticket_create: false });
  });
  it('a Super Admin can adjust only the capabilities that are safe to adjust', () => {
    expect(capabilitiesOf('mirror', { customer_signoff: true }).customer_signoff).toBe(true);
    expect(capabilitiesOf('mirror', { writeback: true } as never).writeback).toBe(false);                         // never overridable
    expect(capabilitiesOf('connected', { native_ticket_create: true } as never).native_ticket_create).toBe(false);
    expect(validateOverrides({ closing_gates: false })).toEqual({ closing_gates: false });
    expect(() => validateOverrides({ writeback: true })).toThrow(/cannot be changed/);
    expect(() => validateOverrides({ closing_gates: 'yes' })).toThrow(/on or off/);
    expect(() => validateOverrides([])).toThrow();
    expect(OVERRIDABLE.every((k) => (CAPABILITIES as readonly string[]).includes(k))).toBe(true);
    expect(MODES).toEqual(['full', 'connected', 'mirror']);
  });
});

const app = buildApp();
let sup: Awaited<ReturnType<typeof makeUser>>;
beforeAll(async () => { await app.ready(); sup = await makeUser('Admin'); });
afterAll(async () => { await app.close(); await pool.end(); });
const call = async (u: { cookie: string }, method: 'GET' | 'POST' | 'PATCH', url: string, payload?: unknown) => {
  const r = await app.inject({ method, url, payload: payload as any, headers: { cookie: u.cookie } });
  let body: any; try { body = r.json(); } catch { body = r.body; }
  return { status: r.statusCode, body };
};
async function project(mode?: string) {
  const r = await call(sup, 'POST', '/api/platform/projects', { name: `Mode ${Math.random().toString(36).slice(2, 7)}`, ...(mode ? { operatingMode: mode } : {}) });
  expect(r.status).toBe(201);
  const pa = await makeUser('Project Admin', undefined, r.body.id);
  return { pid: r.body.id as string, pa };
}

describe('modes in a running project', () => {
  it('a new project is Full unless the Super Admin says otherwise; only a Super Admin can change it; changes are audited', async () => {
    const { pid, pa } = await project();
    expect((await call(sup, 'GET', '/api/platform/projects')).body.find((p: any) => p.id === pid).operatingMode).toBe('full');
    expect((await call(pa, 'PATCH', `/api/platform/projects/${pid}`, { operatingMode: 'mirror' })).status).toBe(403);
    expect((await call(sup, 'PATCH', `/api/platform/projects/${pid}`, { operatingMode: 'bogus' })).status).toBe(400);
    expect((await call(sup, 'PATCH', `/api/platform/projects/${pid}`, { modeOverrides: { writeback: true } })).status).toBe(400);
    expect((await call(sup, 'PATCH', `/api/platform/projects/${pid}`, { operatingMode: 'connected' })).status).toBe(200);
    const me = (await call(pa, 'GET', '/api/auth/me')).body.project;
    expect(me.operatingMode).toBe('connected'); expect(me.caps.writeback).toBe(true); expect(me.caps.native_ticket_create).toBe(false);
    expect((await pool.query(`SELECT detail FROM audit_log WHERE action='project.mode' AND project_id=$1`, [pid])).rows[0].detail).toMatchObject({ from: 'full', to: 'connected' });
  });

  it('in Connected and Mirror projects nobody can create tickets, whichever way they try', async () => {
    for (const mode of ['connected', 'mirror']) {
      const { pid, pa } = await project(mode);
      expect((await call(pa, 'GET', '/api/auth/me')).body.permissions).not.toContain('ticket.create');
      expect((await call(pa, 'POST', '/api/tickets', { title: 'Nope' })).status).toBe(403);                              // the route guard
      await expect(createTicket(pid, 'Direct')).rejects.toMatchObject({ status: 409 });                                    // the function itself (chat, import of ideas, scripts)
      expect((await pool.query('SELECT count(*)::int n FROM tickets WHERE project_id=$1', [pid])).rows[0].n).toBe(0);
    }
  });

  it('turning a project back to Full gives creation back, and an override lets Mirror keep closing gates', async () => {
    const { pid, pa } = await project('mirror');
    await call(sup, 'PATCH', `/api/platform/projects/${pid}`, { operatingMode: 'full' });
    expect((await call(pa, 'POST', '/api/tickets', { title: 'Back to normal' })).status).toBe(201);
    await call(sup, 'PATCH', `/api/platform/projects/${pid}`, { operatingMode: 'mirror', modeOverrides: { closing_gates: true } });
    expect((await call(pa, 'GET', '/api/auth/me')).body.project.caps).toMatchObject({ closing_gates: true, customer_signoff: false });
  });

  it('closingProblem skips documents and sign-off when the mode turns them off', async () => {
    const incident = (await pool.query("SELECT id FROM ticket_types WHERE key='incident'")).rows[0].id;
    // a project whose phases include Resolved/Closed: use the Support template
    const mk = async (mode: string) => {
      const r = await call(sup, 'POST', '/api/platform/projects', { name: `Close ${mode} ${Math.random().toString(36).slice(2, 6)}`, operatingMode: mode, projectTypeId: (await pool.query("SELECT id FROM project_types WHERE key='support'")).rows[0].id });
      return r.body.id as string;
    };
    const f = await mk('full'), m = await mk('mirror');
    const tf = (await pool.query(`INSERT INTO tickets (project_id, title, ticket_type_id) VALUES ($1,'x',$2) RETURNING id`, [f, incident])).rows[0].id;
    const tm = (await pool.query(`INSERT INTO tickets (project_id, title, ticket_type_id) VALUES ($1,'x',$2) RETURNING id`, [m, incident])).rows[0].id;
    expect(await closingProblem(pool, tf, 'Resolved', 'Closed')).toMatch(/Unit Test must be approved/);
    expect(await closingProblem(pool, tm, 'Resolved', 'Closed')).toBeNull();
  });
});
