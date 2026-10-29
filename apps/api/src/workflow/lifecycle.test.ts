import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pool } from '../db.js';
import { buildApp } from '../app.js';
import { makeUser } from '../testAuth.js';

const app = buildApp();
let sup: Awaited<ReturnType<typeof makeUser>>;
beforeAll(async () => { await app.ready(); sup = await makeUser('Admin'); });
afterAll(async () => { await app.close(); await pool.end(); });

const call = async (who: { cookie: string }, method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: unknown) => {
  const r = await app.inject({ method, url, payload: payload as any, headers: { cookie: who.cookie } });
  return { status: r.statusCode, body: r.json() as any };
};
const id = async (table: string, key: string) => (await pool.query(`SELECT id FROM ${table} WHERE key=$1`, [key])).rows[0].id as number;
async function project(type: string) {
  const r = await call(sup, 'POST', '/api/platform/projects', { name: `LC ${Math.random().toString(36).slice(2, 8)}`, projectTypeId: await id('project_types', type) });
  expect(r.status).toBe(201);
  const pa = await makeUser('Project Admin', undefined, r.body.id);
  return { pid: r.body.id as string, pa };
}
const phaseId = async (name: string) => (await pool.query('SELECT id FROM phases WHERE name=$1', [name])).rows[0].id as number;
const incident = (who: { cookie: string }, ty: number) => call(who, 'POST', '/api/tickets', { title: 'Printer down', ticketTypeId: ty, dynamicMetadata: { priority: 'P3 - Medium', impact: 'Single user', steps_to_reproduce: 'Press print' } });
const lifecycles = async (who: { cookie: string }) => (await call(who, 'GET', '/api/project/lifecycles')).body;

describe('standard lifecycle is shown as it stands', () => {
  it('ITIL incident: New → Triage → In Progress ⇄ Pending → Resolved → Closed, not customised', async () => {
    const { pa } = await project('support');
    const inc = (await lifecycles(pa)).lifecycles.find((l: any) => l.key === 'incident');
    expect(inc.custom).toBe(false);
    expect(inc.statuses.map((s: any) => s.name)).toEqual(['New', 'Triage', 'In Progress', 'Pending', 'Resolved', 'Closed']);
    expect(inc.edges.find((e: any) => e.from === null).to).toBe(await phaseId('New'));
  });
  it('customers cannot read or change lifecycles', async () => {
    const { pid } = await project('support');
    const cust = await makeUser('Customer', undefined, pid);
    expect((await call(cust, 'GET', '/api/project/lifecycles')).status).toBe(403);
    expect((await call(cust, 'POST', '/api/project/statuses', { name: 'Nope', tone: 'build' })).status).toBe(403);
  });
});

describe('a project customises the Incident lifecycle', () => {
  let pa: any, pid: string, incType: number, awaiting: number;
  const names = ['New', 'Triage', 'In Progress', 'Awaiting Vendor', 'Resolved', 'Closed'];
  beforeAll(async () => { ({ pa, pid } = await project('support')); incType = await id('ticket_types', 'incident'); });

  it('creates its own status', async () => {
    const r = await call(pa, 'POST', '/api/project/statuses', { name: `Awaiting Vendor`, tone: 'build' });
    expect([200, 201]).toContain(r.status); awaiting = r.body.id;
    expect((await call(pa, 'POST', '/api/project/statuses', { name: 'Triage', tone: 'build' })).body).toMatchObject({ existing: true });   // standard names are reused
  });

  it('rejects lifecycles that cannot work, saying why', async () => {
    const ids = await Promise.all(names.map((n) => (n === 'Awaiting Vendor' ? awaiting : phaseId(n))));
    const [n, t, ip, av, rs, cl] = ids;
    const put = (statuses: number[], edges: [number | null, number][]) => call(pa, 'PUT', `/api/project/lifecycles/${incType}`, { statuses, edges: edges.map(([from, to]) => ({ from, to })) });
    expect((await put(ids, [[n, t], [t, ip], [ip, av], [av, ip], [ip, rs], [rs, cl]])).body.error).toMatch(/where a new ticket starts/);
    expect((await put(ids, [[null, n], [n, t], [t, ip], [ip, rs], [rs, cl]])).body.error).toMatch(/Awaiting Vendor can never be reached/);
    expect((await put(ids, [[null, n], [n, t], [t, ip], [ip, av], [ip, rs], [rs, cl]])).body.error).toMatch(/Awaiting Vendor is a dead end/);
    expect((await put([n, t, ip], [[null, n], [n, t], [t, ip], [ip, n]])).body.error).toMatch(/finishing status/);
    expect((await put(ids, [[null, n], [n, 99999999]])).status).toBe(400);
  });

  it('saves a valid one; new incidents follow it and the board offers its moves', async () => {
    const ids = await Promise.all(names.map((n) => (n === 'Awaiting Vendor' ? awaiting : phaseId(n))));
    const [n, t, ip, av, rs, cl] = ids;
    const edges = [[null, n], [n, t], [t, ip], [ip, av], [av, ip], [ip, rs], [rs, ip], [rs, cl]].map(([from, to]) => ({ from, to }));
    expect((await call(pa, 'PUT', `/api/project/lifecycles/${incType}`, { statuses: ids, edges })).status).toBe(200);

    const lc = (await lifecycles(pa)).lifecycles.find((l: any) => l.key === 'incident');
    expect(lc.custom).toBe(true); expect(lc.statuses.map((s: any) => s.name)).toEqual(names);

    const wf = (await call(pa, 'GET', '/api/workflow')).body;
    expect(wf.phases.map((p: any) => p.name)).toContain('Awaiting Vendor');
    expect(wf.moves[incType]['In Progress'].map((m: any) => m.to).sort()).toEqual(['Awaiting Vendor', 'Resolved']);
    expect((await call(pa, 'GET', '/api/states')).body).toContain('Awaiting Vendor');

    const tk = (await incident(pa, incType)).body;
    expect(tk.current_state).toBe('New');
    const move = (to: string) => call(pa, 'POST', `/api/tickets/${tk.id}/transition`, { to });
    expect((await move('Resolved')).status).toBeGreaterThanOrEqual(400);       // not allowed from New
    expect((await move('Triage')).status).toBe(200);
    expect((await move('In Progress')).status).toBe(200);
    expect((await move('Awaiting Vendor')).status).toBe(200);
    expect((await move('Pending')).status).toBeGreaterThanOrEqual(400);        // the standard status is not part of this lifecycle
    expect((await move('In Progress')).status).toBe(200);
  });

  it('other ticket types keep the standard lifecycle', async () => {
    const lcs = (await lifecycles(pa)).lifecycles;
    expect(lcs.find((l: any) => l.key === 'change').custom).toBe(false);
  });

  it('will not drop a status that holds tickets, and will not reset while tickets sit in a custom status', async () => {
    const tk = (await incident(pa, incType)).body;
    for (const to of ['Triage', 'In Progress', 'Awaiting Vendor']) await call(pa, 'POST', `/api/tickets/${tk.id}/transition`, { to });
    const keep = (await lifecycles(pa)).lifecycles.find((l: any) => l.key === 'incident');
    const without = keep.statuses.filter((s: any) => s.name !== 'Awaiting Vendor');
    const r = await call(pa, 'PUT', `/api/project/lifecycles/${incType}`, { statuses: without.map((s: any) => s.id), edges: keep.edges.filter((e: any) => e.from !== awaiting && e.to !== awaiting).map((e: any) => ({ from: e.from, to: e.to })) });
    expect(r.status).toBe(409); expect(r.body.error).toMatch(/Awaiting Vendor/);
    const reset = await call(pa, 'DELETE', `/api/project/lifecycles/${incType}`);
    expect(reset.status).toBe(409);
    expect((await call(pa, 'DELETE', `/api/project/statuses/${awaiting}`)).status).toBe(409);   // in use
    await call(pa, 'POST', `/api/tickets/${tk.id}/transition`, { to: 'In Progress' });
    await pool.query("UPDATE tickets SET current_state='In Progress' WHERE project_id=$1 AND current_state='Awaiting Vendor'", [pid]);
  });

  it('changing methodology is blocked while a lifecycle is customised', async () => {
    const t = (await call(pa, 'GET', '/api/project/template')).body;
    const other = t.catalog.templates.find((x: any) => x.id !== t.templateTypeId);
    const r = await call(pa, 'PUT', '/api/project/template', { projectTypeId: t.projectTypeId, templateTypeId: other.id, phases: other.phases.map((p: any) => ({ phaseId: p.id, enabled: true })), ticketTypes: [{ ticketTypeId: other.ticketTypeIds[0], enabled: true }], defaultTicketTypeId: other.ticketTypeIds[0] });
    expect(r.status).toBe(409); expect(r.body.error).toMatch(/customised lifecycle/);
  });

  it('restores the standard lifecycle once nothing is stranded; only unused statuses can be deleted', async () => {
    const r = await call(pa, 'DELETE', `/api/project/lifecycles/${incType}`);
    expect(r.status).toBe(200);
    const lc = (await lifecycles(pa)).lifecycles.find((l: any) => l.key === 'incident');
    expect(lc.custom).toBe(false); expect(lc.statuses.map((s: any) => s.name)).not.toContain('Awaiting Vendor');
    expect((await call(pa, 'DELETE', `/api/project/statuses/${awaiting}`)).status).toBe(409);      // tickets passed through it: its history stays readable
    const spare = (await call(pa, 'POST', '/api/project/statuses', { name: `Spare ${Math.random().toString(36).slice(2, 6)}`, tone: 'review' })).body;
    expect((await call(pa, 'DELETE', `/api/project/statuses/${spare.id}`)).status).toBe(200);
  });
});

describe('document-driven steps and isolation', () => {
  it('a Waterfall project cannot remove the statuses that carry documents and approvals, and keeps those steps gated', async () => {
    const { pa } = await project('implementation');
    const ty = await id('ticket_types', 'requirement');
    const lc = (await lifecycles(pa)).lifecycles.find((l: any) => l.key === 'requirement');
    const noFs = lc.statuses.filter((s: any) => s.name !== 'FS Approved');
    const r = await call(pa, 'PUT', `/api/project/lifecycles/${ty}`, { statuses: noFs.map((s: any) => s.id), edges: [] });
    expect(r.status).toBe(409); expect(r.body.error).toMatch(/documents and approvals/);
    // adding a status and a shortcut keeps the gated step: the saved flow still marks FS Drafted → FS Approved as gated
    const extra = (await call(pa, 'POST', '/api/project/statuses', { name: `Peer Review ${Math.random().toString(36).slice(2, 6)}`, tone: 'build' })).body;
    const edges = [...lc.edges.map((e: any) => ({ from: e.from, to: e.to })), { from: await phaseId('Development'), to: extra.id }, { from: extra.id, to: await phaseId('QA') }];
    const ok = await call(pa, 'PUT', `/api/project/lifecycles/${ty}`, { statuses: [...lc.statuses.map((s: any) => s.id), extra.id], edges });
    expect(ok.status).toBe(200);
    const saved = (await lifecycles(pa)).lifecycles.find((l: any) => l.key === 'requirement');
    expect(saved.edges.filter((e: any) => e.gated).length).toBe(lc.edges.filter((e: any) => e.gated).length);
  });

  it('one project’s own statuses are invisible to and unusable by another', async () => {
    const a = await project('support'); const b = await project('support');
    const name = `Secret ${Math.random().toString(36).slice(2, 7)}`;
    const mine = (await call(a.pa, 'POST', '/api/project/statuses', { name, tone: 'build' })).body;
    expect((await lifecycles(b.pa)).statuses.map((s: any) => s.name)).not.toContain(name);
    const ty = await id('ticket_types', 'incident');
    const lc = (await lifecycles(b.pa)).lifecycles.find((l: any) => l.key === 'incident');
    const r = await call(b.pa, 'PUT', `/api/project/lifecycles/${ty}`, { statuses: [...lc.statuses.map((s: any) => s.id), mine.id], edges: lc.edges.map((e: any) => ({ from: e.from, to: e.to })) });
    expect(r.status).toBe(400);
    expect((await call(b.pa, 'DELETE', `/api/project/statuses/${mine.id}`)).status).toBe(404);
    expect((await call(b.pa, 'POST', '/api/project/statuses', { name, tone: 'build' })).status).toBe(409);
  });

  it('a Super Admin working inside a project can customise it too', async () => {
    const { pid } = await project('support');
    const r = await app.inject({ method: 'GET', url: '/api/project/lifecycles', headers: { cookie: sup.cookieIn(pid) } });
    expect(r.statusCode).toBe(200);
  });
});
