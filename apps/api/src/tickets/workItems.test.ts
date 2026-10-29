import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pool } from '../db.js';
import { buildApp } from '../app.js';
import { makeUser } from '../testAuth.js';

const llmOk = { complete: async () => 'Sure: [{"title":"Check the spool settings","estimateH":2},{"title":"Re-test printing","estimateH":null}]' };
const llmBad = { complete: async () => 'I cannot help with that' };
let llm: { complete: () => Promise<string> } | null = llmOk;
const app = buildApp({ workLlm: { complete: () => (llm ? llm.complete() : Promise.reject(new Error('no'))) } });
type U = Awaited<ReturnType<typeof makeUser>>;
let sup: U, pid: string, pa: U, lead: U, customer: U, incident: number;
const call = async (u: { cookie: string }, method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, payload?: unknown) => {
  const r = await app.inject({ method, url, payload: payload as any, headers: { cookie: u.cookie } });
  let body: any; try { body = r.json(); } catch { body = r.body; }
  return { status: r.statusCode, body };
};
const meta = { priority: 'P3 - Medium', impact: 'Single user', steps_to_reproduce: 'x' };
const mk = async (title = 'Printer') => (await call(pa, 'POST', '/api/tickets', { title, ticketTypeId: incident, dynamicMetadata: meta })).body.id as string;

beforeAll(async () => {
  await app.ready();
  sup = await makeUser('Admin');
  pid = (await call(sup, 'POST', '/api/platform/projects', { name: `Work ${Math.random().toString(36).slice(2, 7)}`, projectTypeId: (await pool.query("SELECT id FROM project_types WHERE key='support'")).rows[0].id })).body.id;
  pa = await makeUser('Project Admin', undefined, pid); lead = await makeUser('Lead', undefined, pid); customer = await makeUser('Customer', undefined, pid);
  incident = (await pool.query("SELECT id FROM ticket_types WHERE key='incident'")).rows[0].id;
});
afterAll(async () => { await app.close(); await pool.end(); });

describe('breaking a ticket into work', () => {
  it('adds the standard tasks once, tracks progress, and keeps the list away from customers', async () => {
    const id = await mk();
    const t = await call(pa, 'POST', `/api/tickets/${id}/work/from-template`);
    expect(t.body.items.map((i: any) => i.title)).toContain('Reproduce and confirm the problem');
    expect(t.body.progress).toEqual({ done: 0, total: 5 });
    expect((await call(pa, 'POST', `/api/tickets/${id}/work/from-template`)).status).toBe(409);
    const first = t.body.items[0].id;
    const done = await call(pa, 'PATCH', `/api/work/${first}`, { state: 'done', actualH: 1.5, estimateH: 1 });
    expect(done.body.progress).toEqual({ done: 1, total: 5 }); expect(done.body.actualH).toBe(1.5);
    expect(done.body.items[0].doneAt).toBeTruthy();
    expect((await call(customer, 'GET', `/api/tickets/${id}/work`)).status).toBe(404);
    expect((await call(lead, 'GET', `/api/tickets/${id}/work`)).status).toBe(200);
    const list = (await call(pa, 'GET', '/api/tickets')).body.find((x: any) => x.id === id);
    expect(list).toMatchObject({ work_total: 5, work_done: 1 });
  });

  it('a task waits for the tasks it depends on, and cannot depend on itself or on another ticket’s task', async () => {
    const id = await mk('Deps'); const other = await mk('Other');
    const a = (await call(pa, 'POST', `/api/tickets/${id}/work`, { title: 'Build' })).body.id as string;
    const b = (await call(pa, 'POST', `/api/tickets/${id}/work`, { title: 'Test' })).body.id as string;
    const o = (await call(pa, 'POST', `/api/tickets/${other}/work`, { title: 'Elsewhere' })).body.id as string;
    expect((await call(pa, 'PATCH', `/api/work/${b}`, { dependsOn: [b] })).status).toBe(400);
    expect((await call(pa, 'PATCH', `/api/work/${b}`, { dependsOn: [o] })).status).toBe(400);
    expect((await call(pa, 'PATCH', `/api/work/${b}`, { dependsOn: [a] })).status).toBe(200);
    const blocked = await call(pa, 'PATCH', `/api/work/${b}`, { state: 'doing' });
    expect(blocked.status).toBe(409); expect(blocked.body.error).toMatch(/waits for: Build/);
    await call(pa, 'PATCH', `/api/work/${a}`, { state: 'done' });
    expect((await call(pa, 'PATCH', `/api/work/${b}`, { state: 'doing' })).status).toBe(200);
    expect((await call(pa, 'DELETE', `/api/work/${a}`)).body.items[0].dependsOn).toEqual([]);         // deleting a task frees what waited for it
  });

  it('suggests a breakdown (AI when available, standard tasks otherwise) without saving anything', async () => {
    const id = await mk('Suggest');
    expect((await call(pa, 'POST', `/api/tickets/${id}/work/suggest`)).body).toMatchObject({ by: 'ai', tasks: [{ title: 'Check the spool settings', estimateH: 2 }, { title: 'Re-test printing' }] });
    llm = llmBad; expect((await call(pa, 'POST', `/api/tickets/${id}/work/suggest`)).body.by).toBe('standard');
    llm = null; expect((await call(pa, 'POST', `/api/tickets/${id}/work/suggest`)).body.by).toBe('standard'); llm = llmOk;
    expect((await call(pa, 'GET', `/api/tickets/${id}/work`)).body.items).toEqual([]);
    const added = await call(pa, 'POST', `/api/tickets/${id}/work/bulk`, { tasks: [{ title: 'One' }, { title: 'Two', estimateH: 3 }] });
    expect(added.body.progress.total).toBe(2);
  });

  it('a project can set its own standard tasks, and open work can be made to block closing', async () => {
    const types = (await call(pa, 'GET', '/api/project/work-templates')).body;
    expect(types.defaults.incident.length).toBeGreaterThan(0);
    expect((await call(pa, 'PUT', `/api/project/work-templates/${incident}`, { tasks: [{ title: 'Ring the customer', estimateH: 0.5 }, { title: 'Fix it' }] })).status).toBe(200);
    const id = await mk('Templated');
    expect((await call(pa, 'POST', `/api/tickets/${id}/work/from-template`)).body.items.map((i: any) => i.title)).toEqual(['Ring the customer', 'Fix it']);
    expect((await call(lead, 'PUT', `/api/project/work-templates/${incident}`, { tasks: [] })).status).toBe(403);
    // closing is blocked by open work only when the project asks for it
    await call(sup, 'PATCH', `/api/platform/projects/${pid}`, { modeOverrides: { work_gate: true } });
    await pool.query("INSERT INTO approval_requests (ticket_id, kind, version_number, workflow_name, levels, status, completed_at) VALUES ($1,'TUT',1,'t','[]','approved',now())", [id]);
    for (const to of ['Triage', 'In Progress', 'Resolved']) await call(pa, 'POST', `/api/tickets/${id}/transition`, { to });
    const blocked = await call(pa, 'POST', `/api/tickets/${id}/transition`, { to: 'Closed' });
    expect(blocked.status).toBe(409); expect(blocked.body.error).toMatch(/2 work items are not done/);
    for (const w of (await call(pa, 'GET', `/api/tickets/${id}/work`)).body.items) await call(pa, 'PATCH', `/api/work/${w.id}`, { state: 'done' });
    expect((await call(pa, 'POST', `/api/tickets/${id}/transition`, { to: 'Closed' })).status).toBe(200);
  });
});
