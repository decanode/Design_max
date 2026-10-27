import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pool } from '../db.js';
import { buildApp } from '../app.js';
import { HashEmbedder } from '../etl/vectorize.js';
import { TemplateGenerator } from '../docs/generator.js';
import { makeUser } from '../testAuth.js';
import { createTicket } from '../tickets.js';
import { ReportDefinition } from './engine.js';
import { signSession } from '../rbac/auth.js';

const app = buildApp({ generator: new TemplateGenerator(), embedder: new HashEmbedder() });
type U = Awaited<ReturnType<typeof makeUser>>;
let admin: U, lead: U, lead2: U, consultant: U, customer: U, scoped: U;
let projectId: string;

const call = async (u: U | null, method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, payload?: unknown) => {
  const r = await app.inject({ method, url: path, payload: payload as any, headers: u ? { cookie: u.cookie } : {} });
  let body: any; try { body = r.json(); } catch { body = r.body; }
  return { status: r.statusCode, body, headers: r.headers };
};
const def = (o: Record<string, unknown> = {}) => ({ dataset: 'tickets', measure: 'count', groupBy: 'state', filters: { projectIds: [projectId] }, sort: 'natural', limit: 12, chart: 'column', ...o });
const preview = (u: U, o: Record<string, unknown> = {}) => call(u, 'POST', '/api/reports/preview', { definition: def(o) });
const rowsOf = (r: { body: any }) => Object.fromEntries(r.body.rows.map((x: any) => [x.label, x.value]));

beforeAll(async () => {
  await app.ready();
  [admin, lead, lead2, consultant, customer] = await Promise.all(['Admin', 'Lead', 'Lead', 'Consultant', 'Customer'].map((r) => makeUser(r)));
  projectId = (await pool.query("INSERT INTO projects(name) VALUES('reports') RETURNING id")).rows[0].id;
  // A custom role that may view reports but only sees its own tickets.
  const role = (await pool.query("INSERT INTO roles(name) VALUES('Scoped viewer') RETURNING id")).rows[0].id;
  await pool.query("INSERT INTO role_permissions(role_id, permission) SELECT $1, unnest(ARRAY['report.view','board.view','ticket.view_own'])", [role]);
  const id = (await pool.query("INSERT INTO users(email, display_name, role_id) VALUES('scoped@test.dev','Scoped',$1) RETURNING id", [role])).rows[0].id;
  scoped = { id, email: 'scoped@test.dev', cookie: `dm_session=${signSession(id)}` };

  // Fixture: 2 in Requirement Verified, 1 FS Drafted, 1 Deployed (scoped's own).
  const mk = async (title: string, state?: string, o: { consultant?: string; customer?: string; created?: string } = {}) => {
    const t = await createTicket(projectId, title);
    await pool.query('UPDATE tickets SET consultant_id=$2, customer_id=$3, created_at=COALESCE($4::timestamptz, created_at) WHERE id=$1', [t.id, o.consultant ?? null, o.customer ?? null, o.created ?? null]);
    if (state) await pool.query('ALTER TABLE tickets DISABLE TRIGGER tickets_state_guard').then(() => pool.query('UPDATE tickets SET current_state=$2 WHERE id=$1', [t.id, state])).then(() => pool.query('ALTER TABLE tickets ENABLE TRIGGER tickets_state_guard'));
    return t.id as string;
  };
  await mk('r1', undefined, { created: '2024-01-15T10:00:00Z', consultant: consultant.id });
  await mk('r2', undefined, { created: '2024-03-10T10:00:00Z' });
  await mk('r3', 'FS Drafted', { created: '2024-03-20T10:00:00Z', consultant: consultant.id });
  await mk('r4', 'Deployed', { created: '2024-03-25T10:00:00Z', customer: scoped.id });
});
afterAll(async () => { await app.close(); await pool.end(); });

describe('built-in reports', () => {
  it('every seeded definition is valid and runs', async () => {
    const list = (await call(lead, 'GET', '/api/reports')).body as any[];
    const system = list.filter((r) => r.isSystem);
    expect(system.length).toBeGreaterThanOrEqual(9);
    for (const r of system) {
      expect(ReportDefinition.safeParse(r.definition).success, r.name).toBe(true);
      expect((await call(lead, 'GET', `/api/reports/${r.id}/data`)).status, r.name).toBe(200);
    }
    const dash = (await call(lead, 'GET', '/api/dashboards')).body.find((d: any) => d.isSystem);
    expect(dash.name).toBe('Delivery overview');
    const full = (await call(lead, 'GET', `/api/dashboards/${dash.id}`)).body;
    expect(full.widgets.length).toBe(dash.widgets);
  });
});

describe('access', () => {
  it('needs report.view; building needs report.build', async () => {
    expect((await call(null, 'GET', '/api/reports')).status).toBe(401);
    expect((await call(customer, 'GET', '/api/reports')).status).toBe(403);
    expect((await call(consultant, 'GET', '/api/reports')).status).toBe(200);
    expect((await call(consultant, 'POST', '/api/reports', { name: 'x', definition: def() })).status).toBe(403);
    expect((await call(consultant, 'POST', '/api/reports/preview', { definition: def() })).status).toBe(403);
    expect((await call(lead, 'POST', '/api/dashboards', { name: 'mine' })).status).toBe(201);
  });
  it('numbers only cover tickets the viewer may see', async () => {
    expect(Object.values(rowsOf(await preview(lead))).reduce((a: any, b: any) => a + b, 0)).toBe(4);   // zero-filled phases add nothing
    const mine = await call(scoped, 'POST', '/api/reports/preview', { definition: def() });
    expect(mine.status).toBe(403);                                   // viewers cannot run ad-hoc definitions
    const rep = (await call(lead, 'POST', '/api/reports', { name: 'Scoped check', definition: def(), visibility: 'shared' })).body.id;
    expect(rowsOf(await call(scoped, 'GET', `/api/reports/${rep}/data`))).toMatchObject({ Deployed: 1, 'Requirement Verified': 0, 'FS Drafted': 0 });
    expect(rowsOf(await call(lead, 'GET', `/api/reports/${rep}/data`))).toMatchObject({ 'Requirement Verified': 2, 'FS Drafted': 1, Deployed: 1 });
  });
});

describe('engine', () => {
  it('groups by phase in lifecycle order and counts correctly', async () => {
    const r = await preview(lead);
    expect(r.body.rows.map((x: any) => x.label)).toEqual(['Requirement Verified', 'FS Drafted', 'FS Approved', 'TS Drafted', 'TS Approved', 'Development', 'QA', 'UAT', 'Deployed']);
    expect(rowsOf(r)).toMatchObject({ 'Requirement Verified': 2, 'FS Drafted': 1, 'FS Approved': 0, QA: 0, Deployed: 1 });
    expect(r.body.measure).toMatchObject({ unit: 'tickets' }); expect(r.body.dimension.label).toBe('Phase');
  });
  it('single number tiles, filters and sorting', async () => {
    expect((await preview(lead, { groupBy: null, chart: 'kpi', filters: { projectIds: [projectId], openOnly: true } })).body.rows[0].value).toBe(3);
    expect((await preview(lead, { groupBy: null, chart: 'kpi', filters: { projectIds: [projectId], states: ['Deployed'] } })).body.rows[0].value).toBe(1);
    const c = await preview(lead, { groupBy: 'consultant', sort: 'value_desc', chart: 'bar' });
    expect(c.body.rows.map((x: any) => x.value)).toEqual([2, 2]);
    expect(c.body.rows.map((x: any) => x.label)).toEqual([...c.body.rows.map((x: any) => x.label)].sort());   // tie broken by name
    expect(c.body.rows.map((x: any) => x.label)).toContain('Unassigned');
    expect((await preview(lead, { groupBy: 'consultant', chart: 'bar', filters: { projectIds: [projectId], consultantIds: ['unassigned'] } })).body.rows).toEqual([{ label: 'Unassigned', value: 2 }]);
  });
  it('time series are oldest-first with empty months filled as zero', async () => {
    const r = await preview(lead, { groupBy: 'created_month', chart: 'line' });
    expect(r.body.rows).toEqual([{ label: '2024-01', value: 1 }, { label: '2024-02', value: 0 }, { label: '2024-03', value: 3 }]);
    expect((await preview(lead, { groupBy: 'created_month', chart: 'line', filters: { projectIds: [projectId], range: '7d' } })).body.rows).toEqual([]);
  });
  it('folds the long tail of counts into "Other" and honours the limit', async () => {
    const r = await preview(lead, { groupBy: 'state', sort: 'value_desc', limit: 1, chart: 'bar' });
    expect(r.body.rows).toEqual([{ label: 'Requirement Verified', value: 2 }, { label: 'Other (2)', value: 2 }]);
    expect(r.body.truncated).toBe(true);
  });
  it('average age and approvals measures', async () => {
    const age = (await preview(lead, { measure: 'avg_age_days', groupBy: null, chart: 'kpi' })).body.rows[0].value;
    expect(age).toBeGreaterThan(300);
    const t = await createTicket(projectId, 'appr');
    const u = (await pool.query("SELECT id FROM users LIMIT 1")).rows[0].id;
    await pool.query(`INSERT INTO approvals (ticket_id, approver_id, kind, status, requested_at, decided_at) VALUES ($1,$2,'FS','approved', now() - interval '5 hours', now() - interval '1 hour')`, [t.id, u]);
    const a = await call(lead, 'POST', '/api/reports/preview', { definition: { dataset: 'approvals', measure: 'avg_decision_hours', groupBy: null, filters: { projectIds: [projectId] }, chart: 'kpi' } });
    expect(a.body.rows[0].value).toBe(4);
    const s = await call(lead, 'POST', '/api/reports/preview', { definition: { dataset: 'approvals', measure: 'count', groupBy: 'status', filters: { projectIds: [projectId] }, chart: 'share' } });
    expect(rowsOf(s)).toEqual({ approved: 1 });
  });
  it('phase-change throughput', async () => {
    const r = await call(lead, 'POST', '/api/reports/preview', { definition: { dataset: 'transitions', measure: 'count', groupBy: 'to_state', filters: { projectIds: [projectId] }, chart: 'bar' } });
    expect(rowsOf(r)['Requirement Verified']).toBeGreaterThanOrEqual(5);   // every ticket's creation is logged
  });
});

describe('validation and safety', () => {
  const bad = async (o: Record<string, unknown>) => (await preview(lead, o)).status;
  it('rejects nonsense combinations', async () => {
    expect(await bad({ measure: 'nope' })).toBe(400);
    expect(await bad({ groupBy: 'nope' })).toBe(400);
    expect(await bad({ groupBy: 'state', chart: 'line' })).toBe(400);          // line needs time
    expect(await bad({ groupBy: 'state', chart: 'kpi' })).toBe(400);           // kpi cannot be grouped
    expect(await bad({ groupBy: null, chart: 'bar' })).toBe(400);              // bar needs grouping
    expect(await bad({ measure: 'avg_age_days', chart: 'share' })).toBe(400);  // share only for counts
    expect(await bad({ filters: { statuses: ['approved'] } })).toBe(400);      // filter not for tickets
    expect(await bad({ limit: 500 })).toBe(400);
    expect(await bad({ dataset: 'users' })).toBe(400);
  });
  it('cannot be used to smuggle SQL', async () => {
    expect(await bad({ groupBy: "state; DROP TABLE tickets;--" })).toBe(400);
    expect(await bad({ filters: { projectIds: ["x' OR '1'='1"] } })).toBe(400);
    expect(await bad({ filters: { states: ["Deployed'; --"] } })).toBe(400);
    expect(await bad({ filters: { range: "7d' OR true --" } })).toBe(400);
    expect((await pool.query('SELECT count(*)::int c FROM tickets')).rows[0].c).toBeGreaterThan(0);
  });
  it('CSV downloads neutralise spreadsheet formulas and name the file', async () => {
    const evil = await makeUser('Consultant', 'evil');
    await pool.query("UPDATE users SET display_name='=HYPERLINK(\"http://x\")' WHERE id=$1", [evil.id]);
    const t = await createTicket(projectId, 'csv'); await pool.query('UPDATE tickets SET consultant_id=$2 WHERE id=$1', [t.id, evil.id]);
    const rep = (await call(lead, 'POST', '/api/reports', { name: 'CSV: check', definition: def({ groupBy: 'consultant', chart: 'bar' }), visibility: 'shared' })).body.id;
    const r = await call(lead, 'GET', `/api/reports/${rep}/csv`);
    expect(r.headers['content-type']).toMatch(/text\/csv/);
    expect(r.headers['content-disposition']).toContain('csv-check.csv');
    expect(r.body).toContain("\"'=HYPERLINK(");
    expect(r.body.split('\r\n')[0]).toBe('Consultant,Number of tickets');
  });
});

describe('creating and changing reports and dashboards', () => {
  it('private until shared; only owners (or managers) edit; built-ins are copied, not edited', async () => {
    const id = (await call(lead, 'POST', '/api/reports', { name: 'Mine', definition: def() })).body.id;
    expect((await call(lead2, 'GET', `/api/reports/${id}`)).status).toBe(404);
    expect(((await call(lead2, 'GET', '/api/reports')).body as any[]).some((r) => r.id === id)).toBe(false);
    expect((await call(lead, 'PUT', `/api/reports/${id}`, { visibility: 'shared', name: 'Mine v2' })).status).toBe(200);
    expect((await call(lead2, 'GET', `/api/reports/${id}`)).body.name).toBe('Mine v2');
    expect((await call(lead2, 'PUT', `/api/reports/${id}`, { name: 'hijack' })).status).toBe(403);
    expect((await call(lead2, 'DELETE', `/api/reports/${id}`)).status).toBe(403);
    expect((await call(admin, 'PUT', `/api/reports/${id}`, { name: 'Admin edit' })).status).toBe(200);

    const sys = ((await call(lead, 'GET', '/api/reports')).body as any[]).find((r) => r.isSystem);
    expect((await call(lead, 'PUT', `/api/reports/${sys.id}`, { name: 'x' })).status).toBe(403);
    const copy = (await call(lead, 'POST', `/api/reports/${sys.id}/duplicate`)).body.id;
    expect((await call(lead, 'PUT', `/api/reports/${copy}`, { name: 'My version', definition: { ...sys.definition, chart: 'table' } })).status).toBe(200);
    expect((await call(admin, 'PUT', `/api/reports/${sys.id}`, { description: sys.description })).status).toBe(200);
    expect((await call(lead, 'PUT', `/api/reports/${copy}`, { definition: def({ chart: 'line' }) })).status).toBe(400);   // invalid change is refused
  });

  it('dashboards: add, resize, reorder, share, copy, and deleting a report removes its widgets', async () => {
    const r1 = (await call(lead, 'POST', '/api/reports', { name: 'A', definition: def() })).body.id;
    const r2 = (await call(lead, 'POST', '/api/reports', { name: 'B', definition: def({ groupBy: null, chart: 'kpi' }) })).body.id;
    const w = (reportId: string, size: 1 | 2 | 3) => ({ id: crypto.randomUUID(), reportId, size });
    const layout = [w(r1, 2), w(r2, 1)];
    const dash = (await call(lead, 'POST', '/api/dashboards', { name: 'Team view', layout })).body.id;
    expect((await call(lead, 'POST', '/api/dashboards', { name: 'bad', layout: [w(crypto.randomUUID(), 1)] })).status).toBe(400);
    expect((await call(lead, 'POST', '/api/dashboards', { name: 'bad', layout: [{ ...w(r1, 1), size: 7 }] })).status).toBe(400);

    // private dashboard: invisible to others, and so is its private report's data
    expect((await call(lead2, 'GET', `/api/dashboards/${dash}`)).status).toBe(404);
    expect((await call(lead2, 'GET', `/api/reports/${r1}/data`)).status).toBe(404);

    // sharing the dashboard lets viewers see it and run its widgets, though the reports themselves are private
    expect((await call(lead, 'PUT', `/api/dashboards/${dash}`, { visibility: 'shared', layout: [layout[1], { ...layout[0], size: 3 }] })).status).toBe(200);
    const seen = (await call(lead2, 'GET', `/api/dashboards/${dash}`)).body;
    expect(seen.widgets.map((x: any) => [x.report.name, x.size])).toEqual([['B', 1], ['A', 3]]);
    expect((await call(lead2, 'GET', `/api/reports/${r1}/data`)).status).toBe(200);
    expect((await call(consultant, 'GET', `/api/reports/${r1}/data`)).status).toBe(200);
    expect((await call(lead2, 'PUT', `/api/dashboards/${dash}`, { name: 'hijack' })).status).toBe(403);

    const copy = (await call(lead2, 'POST', `/api/dashboards/${dash}/duplicate`)).body.id;
    const cw = (await call(lead2, 'GET', `/api/dashboards/${copy}`)).body.widgets;
    expect(cw).toHaveLength(2);
    expect(cw.map((x: any) => x.id)).not.toEqual(seen.widgets.map((x: any) => x.id));

    expect((await call(lead, 'DELETE', `/api/reports/${r1}`)).status).toBe(200);
    expect((await call(lead, 'GET', `/api/dashboards/${dash}`)).body.widgets.map((x: any) => x.report.name)).toEqual(['B']);
    expect((await call(lead, 'DELETE', `/api/dashboards/${dash}`)).status).toBe(200);
    expect((await call(lead, 'GET', `/api/dashboards/${dash}`)).status).toBe(404);
  });
});
