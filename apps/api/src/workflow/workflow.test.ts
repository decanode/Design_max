import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pool } from '../db.js';
import { buildApp } from '../app.js';
import { makeUser, makeCustomUser } from '../testAuth.js';

const app = buildApp();
let sup: Awaited<ReturnType<typeof makeUser>>;
beforeAll(async () => { await app.ready(); sup = await makeUser('Admin'); });
afterAll(async () => { await app.close(); await pool.end(); });

const call = async (who: { cookie: string }, method: 'GET' | 'POST' | 'PUT' | 'PATCH', url: string, payload?: unknown) => {
  const r = await app.inject({ method, url, payload: payload as any, headers: { cookie: who.cookie } });
  return { status: r.statusCode, body: r.json() as any };
};
const id = async (table: string, key: string) => (await pool.query(`SELECT id FROM ${table} WHERE key=$1`, [key])).rows[0].id as number;
const newProject = async (type?: string, template?: string) => {
  const r = await call(sup, 'POST', '/api/platform/projects', { name: `WF ${Math.random().toString(36).slice(2, 8)}`, ...(type ? { projectTypeId: await id('project_types', type) } : {}), ...(template ? { templateTypeId: await id('template_types', template) } : {}) });
  expect(r.status).toBe(201);
  const admin = await makeUser('Admin', undefined, r.body.id);
  return { pid: r.body.id as string, admin };
};
const typeOf = async (key: string) => id('ticket_types', key);
const move = (who: { cookie: string }, tid: string, to: string) => call(who, 'POST', `/api/tickets/${tid}/transition`, { to });

describe('defaults keep the original lifecycle', () => {
  it('a project created without choices is Implementation + Waterfall with Requirements only and the nine original phases', async () => {
    const { admin } = await newProject();
    const wf = (await call(admin, 'GET', '/api/workflow')).body;
    expect(wf.template.key).toBe('waterfall'); expect(wf.projectType.key).toBe('implementation');
    expect(wf.phases.filter((p: any) => p.enabled).map((p: any) => p.name)).toEqual(['Requirement Verified', 'FS Drafted', 'FS Approved', 'TS Drafted', 'TS Approved', 'Development', 'QA', 'UAT', 'Deployed']);
    expect(wf.ticketTypes.filter((t: any) => t.enabled).map((t: any) => t.key)).toEqual(['requirement']);
    const t = (await call(admin, 'POST', '/api/tickets', { title: 'Plain' })).body;
    expect(t.current_state).toBe('Requirement Verified');
  });
});

describe('Support project with ITIL phases', () => {
  let admin: any, pid: string;
  beforeAll(async () => { ({ admin, pid } = await newProject('support')); });

  it('is configured from its type: ITIL phases, only Incident and Change Request switched on', async () => {
    const wf = (await call(admin, 'GET', '/api/workflow')).body;
    expect(wf.template.key).toBe('itil');
    expect(wf.phases.map((p: any) => p.name)).toEqual(['New', 'Triage', 'Assessment', 'Change Approved', 'Implementation', 'In Progress', 'Pending', 'Review', 'Resolved', 'Closed']);
    expect(wf.ticketTypes.filter((t: any) => t.enabled).map((t: any) => t.key).sort()).toEqual(['change', 'incident']);
    const inc = wf.ticketTypes.find((t: any) => t.key === 'incident').id, chg = wf.ticketTypes.find((t: any) => t.key === 'change').id;
    expect(wf.moves[inc]['New']).toEqual([{ to: 'Triage', gated: null }]);            // what the board offers per ticket type and phase
    expect(wf.moves[chg]['New']).toEqual([{ to: 'Assessment', gated: null }]);
    expect(wf.moves[inc]['Resolved'].map((m: any) => m.to).sort()).toEqual(['Closed', 'In Progress']);
    expect(wf.ticketTypes.map((t: any) => t.key).sort()).toEqual(['change', 'incident', 'problem', 'ritm']);   // WRICEF etc. are not offered in ITIL
  });

  it('only allowed ticket types can be created, and their form is enforced', async () => {
    const problem = await call(admin, 'POST', '/api/tickets', { title: 'x', ticketTypeId: await typeOf('problem') });
    expect(problem.status).toBe(400); expect(problem.body.error).toMatch(/does not allow/);
    const wricef = await call(admin, 'POST', '/api/tickets', { title: 'x', ticketTypeId: await typeOf('wricef') });
    expect(wricef.status).toBe(400);
    const missing = await call(admin, 'POST', '/api/tickets', { title: 'Printer down', ticketTypeId: await typeOf('incident'), dynamicMetadata: { impact: 'Single user' } });
    expect(missing.status).toBe(400); expect(Object.keys(missing.body.fieldErrors).sort()).toEqual(['priority', 'steps_to_reproduce']);
    const bad = await call(admin, 'POST', '/api/tickets', { title: 'x', ticketTypeId: await typeOf('incident'), dynamicMetadata: { priority: 'P9', impact: 'Single user', steps_to_reproduce: 'x' } });
    expect(bad.status).toBe(400); expect(bad.body.fieldErrors.priority).toMatch(/Choose one of/);
    const unknown = await call(admin, 'POST', '/api/tickets', { title: 'x', ticketTypeId: await typeOf('incident'), dynamicMetadata: { priority: 'P1 - Critical', impact: 'Single user', steps_to_reproduce: 'x', evil: 1 } });
    expect(unknown.status).toBe(400);
  });

  it('an Incident starts in New and walks the support lifecycle; skipping is refused', async () => {
    const t = await call(admin, 'POST', '/api/tickets', { title: 'Printer down', ticketTypeId: await typeOf('incident'), dynamicMetadata: { priority: 'P2 - High', impact: 'Department', steps_to_reproduce: 'Print anything' } });
    expect(t.status).toBe(201); expect(t.body.current_state).toBe('New');
    expect(t.body.dynamic_metadata).toEqual({ priority: 'P2 - High', impact: 'Department', steps_to_reproduce: 'Print anything' });
    const next = (await call(admin, 'GET', `/api/tickets/${t.body.id}/next`)).body;
    expect(next.options).toEqual([{ to: 'Triage', gated: null }]);
    const skip = await move(admin, t.body.id, 'Closed');
    expect(skip.status).toBe(409); expect(skip.body.error).toMatch(/Illegal transition: New -> Closed/);
    for (const to of ['Triage', 'In Progress', 'Pending', 'In Progress', 'Resolved', 'In Progress', 'Resolved', 'Closed']) expect((await move(admin, t.body.id, to)).status).toBe(200);
    expect((await move(admin, t.body.id, 'Triage')).status).toBe(409);     // Closed is final
    expect((await pool.query('SELECT count(*)::int c FROM ticket_transitions WHERE ticket_id=$1', [t.body.id])).rows[0].c).toBe(9);
  });

  it('a Change Request follows its own controlled flow', async () => {
    const t = (await call(admin, 'POST', '/api/tickets', { title: 'Patch', ticketTypeId: await typeOf('change'), dynamicMetadata: { change_type: 'Normal', risk: 'Low', implementation_plan: 'Apply', rollback_plan: 'Revert' } })).body;
    expect(t.current_state).toBe('New');
    expect((await move(admin, t.id, 'Triage')).status).toBe(409);        // incidents triage; changes are assessed
    for (const to of ['Assessment', 'Change Approved', 'Implementation', 'Review', 'Closed']) expect((await move(admin, t.id, to)).status).toBe(200);
  });

  it('the database refuses an illegal move even when the application is bypassed', async () => {
    const t = (await call(admin, 'POST', '/api/tickets', { title: 'Direct', ticketTypeId: await typeOf('incident'), dynamicMetadata: { priority: 'P3 - Medium', impact: 'Single user', steps_to_reproduce: 'x' } })).body;
    await expect(pool.query("UPDATE tickets SET current_state='Closed' WHERE id=$1", [t.id])).rejects.toThrow(/Illegal state transition/);
    await expect(pool.query("UPDATE tickets SET current_state='Triage' WHERE id=$1", [t.id])).resolves.toBeTruthy();
  });

  it('dashboards and reports follow the project phases', async () => {
    const d = (await call(admin, 'GET', '/api/dashboard/portfolio')).body.byState.map((s: any) => s.state);
    expect(d).toContain('Triage'); expect(d).not.toContain('FS Drafted');
    // a document is simply not available where the methodology has no such phase
    const t = (await call(admin, 'POST', '/api/tickets', { title: 'No docs', ticketTypeId: await typeOf('incident'), dynamicMetadata: { priority: 'P3 - Medium', impact: 'Single user', steps_to_reproduce: 'x' } })).body;
    expect((await call(admin, 'POST', `/api/tickets/${t.id}/documents/generate`, { kind: 'FS' })).status).toBe(409);
  });
});

describe('Implementation project and WRICEF details', () => {
  let admin: any;
  beforeAll(async () => { ({ admin } = await newProject('implementation')); });

  it('offers WRICEF and Epic by default and stores type-specific fields in dynamic_metadata', async () => {
    const wf = (await call(admin, 'GET', '/api/workflow')).body;
    expect(wf.ticketTypes.filter((t: any) => t.enabled).map((t: any) => t.key).sort()).toEqual(['epic', 'requirement', 'wricef']);
    const wr = wf.ticketTypes.find((t: any) => t.key === 'wricef');
    expect(wr.fields.map((f: any) => f.key)).toEqual(['ricef_category', 'sap_module', 'business_value']);
    const bad = await call(admin, 'POST', '/api/tickets', { title: 'Report', ticketTypeId: wr.id, dynamicMetadata: { ricef_category: 'Report' } });
    expect(bad.status).toBe(400); expect(bad.body.fieldErrors.sap_module).toBeTruthy();
    const t = await call(admin, 'POST', '/api/tickets', { title: 'Vendor report', ticketTypeId: wr.id, dynamicMetadata: { ricef_category: 'Report', sap_module: 'MM', business_value: 'Fewer errors' } });
    expect(t.status).toBe(201);
    expect((await pool.query('SELECT dynamic_metadata FROM tickets WHERE id=$1', [t.body.id])).rows[0].dynamic_metadata).toEqual({ ricef_category: 'Report', sap_module: 'MM', business_value: 'Fewer errors' });
    const view = (await call(admin, 'GET', `/api/tickets/${t.body.id}`)).body;
    expect(view.ticketType.key).toBe('wricef'); expect(view.ticket.dynamic_metadata.sap_module).toBe('MM');
    // edit, validated against the same definition
    expect((await call(admin, 'PATCH', `/api/tickets/${t.body.id}`, { dynamicMetadata: { ricef_category: 'Interface', sap_module: 'XX' } })).status).toBe(400);
    const ok = await call(admin, 'PATCH', `/api/tickets/${t.body.id}`, { dynamicMetadata: { ricef_category: 'Interface', sap_module: 'SD' } });
    expect(ok.status).toBe(200); expect(ok.body.dynamic_metadata).toEqual({ ricef_category: 'Interface', sap_module: 'SD' });
  });

  it('keeps the original waterfall lifecycle, including the document gates', async () => {
    const t = (await call(admin, 'POST', '/api/tickets', { title: 'Gated' })).body;
    const r = await move(admin, t.id, 'FS Drafted');
    expect(r.status).toBe(409); expect(r.body.error).toMatch(/Generate the Functional Specification/);
    const next = (await call(admin, 'GET', `/api/tickets/${t.id}/next`)).body;
    expect(next.options).toEqual([{ to: 'FS Drafted', gated: 'Generate the Functional Specification to move forward' }]);
  });

  it('the type-specific details are covered by column-level security', async () => {
    const pid = admin.projectId as string;
    const wr = await typeOf('wricef');
    const t = (await call(admin, 'POST', '/api/tickets', { title: 'Hidden details', ticketTypeId: wr, dynamicMetadata: { ricef_category: 'Form', sap_module: 'FICO' } })).body;
    const viewer = await makeCustomUser(['board.view', 'ticket.view_all'], {}, pid);
    const row = (await call(viewer, 'GET', '/api/tickets')).body.find((x: any) => x.id === t.id);
    expect(row).toBeTruthy(); expect(row).not.toHaveProperty('dynamic_metadata'); expect(row.type_name).toBe('WRICEF');
    const reader = await makeCustomUser(['board.view', 'ticket.view_all'], { details: 'read' }, pid);
    expect((await call(reader, 'GET', '/api/tickets')).body.find((x: any) => x.id === t.id).dynamic_metadata.sap_module).toBe('FICO');
    expect((await call(reader, 'PATCH', `/api/tickets/${t.id}`, { dynamicMetadata: { ricef_category: 'Form', sap_module: 'SD' } })).status).toBe(403);
  });
});

describe('template builder', () => {
  it('switching a phase off bypasses it; switching it on restores it; phases tied to documents cannot be switched off', async () => {
    const { admin, pid } = await newProject('implementation');
    const cfg = (await call(admin, 'GET', '/api/project/template')).body;
    const phaseId = (n: string) => cfg.catalog.templates.find((t: any) => t.id === cfg.templateTypeId).phases.find((p: any) => p.name === n).id as number;
    const save = (off: string[], extra: Record<string, unknown> = {}) => call(admin, 'PUT', '/api/project/template', {
      projectTypeId: cfg.projectTypeId, templateTypeId: cfg.templateTypeId,
      phases: cfg.catalog.templates.find((t: any) => t.id === cfg.templateTypeId).phases.map((p: any) => ({ phaseId: p.id, enabled: !off.includes(p.name) && true })),
      ticketTypes: cfg.ticketTypes.map((t: any) => ({ ticketTypeId: t.ticketTypeId, enabled: t.enabled })), defaultTicketTypeId: cfg.ticketTypes.find((t: any) => t.isDefault).ticketTypeId, ...extra });

    // Implementation defaults: Hypercare and Closed are on
    const late = (await pool.query("INSERT INTO tickets (project_id, title, current_state) VALUES ($1,'Late','Deployed') RETURNING id", [pid])).rows[0].id;
    expect((await call(admin, 'GET', `/api/tickets/${late}/next`)).body.options.map((o: any) => o.to)).toEqual(['Hypercare']);

    expect((await save(['Hypercare'])).status).toBe(200);                       // Hypercare off -> Deployed goes straight to Closed
    expect((await call(admin, 'GET', `/api/tickets/${late}/next`)).body.options.map((o: any) => o.to)).toEqual(['Closed']);
    expect((await save(['Hypercare', 'Closed'])).status).toBe(200);             // both off -> Deployed is final
    expect((await call(admin, 'GET', `/api/tickets/${late}/next`)).body.options).toEqual([]);
    expect((await save([])).status).toBe(200);
    expect((await call(admin, 'GET', `/api/tickets/${late}/next`)).body.options.map((o: any) => o.to)).toEqual(['Hypercare']);

    const locked = await save(['FS Approved']);
    expect(locked.status).toBe(409); expect(locked.body.error).toMatch(/FS Approved cannot be switched off/);
    expect(phaseId('FS Approved')).toBeGreaterThan(0);
  });

  it('validates ticket types, defaults and methodology changes', async () => {
    const { admin } = await newProject('implementation');
    const cfg = (await call(admin, 'GET', '/api/project/template')).body;
    const tpl = cfg.catalog.templates.find((t: any) => t.id === cfg.templateTypeId);
    const body = (o: Record<string, unknown>) => ({ projectTypeId: cfg.projectTypeId, templateTypeId: cfg.templateTypeId, phases: tpl.phases.map((p: any) => ({ phaseId: p.id, enabled: true })),
      ticketTypes: cfg.ticketTypes.map((t: any) => ({ ticketTypeId: t.ticketTypeId, enabled: t.enabled })), defaultTicketTypeId: cfg.ticketTypes.find((t: any) => t.isDefault).ticketTypeId, ...o });
    expect((await call(admin, 'PUT', '/api/project/template', body({ ticketTypes: cfg.ticketTypes.map((t: any) => ({ ticketTypeId: t.ticketTypeId, enabled: false })) }))).status).toBe(400);
    expect((await call(admin, 'PUT', '/api/project/template', body({ ticketTypes: [{ ticketTypeId: await typeOf('incident'), enabled: true }], defaultTicketTypeId: await typeOf('incident') }))).status).toBe(400);   // not in Waterfall
    expect((await call(admin, 'PUT', '/api/project/template', body({ defaultTicketTypeId: await typeOf('bug') }))).status).toBe(400);   // not switched on
    // an existing ticket in a Waterfall phase blocks a switch to ITIL
    await call(admin, 'POST', '/api/tickets', { title: 'Existing' });
    const itil = cfg.catalog.templates.find((t: any) => t.key === 'itil');
    const sw = await call(admin, 'PUT', '/api/project/template', { projectTypeId: await id('project_types', 'support'), templateTypeId: itil.id, phases: itil.phases.map((p: any) => ({ phaseId: p.id, enabled: true })),
      ticketTypes: [{ ticketTypeId: await typeOf('incident'), enabled: true }], defaultTicketTypeId: await typeOf('incident') });
    expect(sw.status).toBe(409); expect(sw.body.error).toMatch(/Requirement Verified/);
  });

  it('is reserved for project admins and only ever touches the caller’s own project', async () => {
    const a = await newProject('implementation'), b = await newProject('support');
    const plain = await makeCustomUser(['board.view'], {}, a.pid);
    expect((await call(plain, 'GET', '/api/project/template')).status).toBe(403);
    expect((await call(a.admin, 'GET', '/api/project/template')).body.templateTypeId).not.toBe((await call(b.admin, 'GET', '/api/project/template')).body.templateTypeId);
    // a Support project's tickets are invisible and unreachable from the other project
    const inc = (await call(b.admin, 'POST', '/api/tickets', { title: 'Theirs', ticketTypeId: await typeOf('incident'), dynamicMetadata: { priority: 'P4 - Low', impact: 'Single user', steps_to_reproduce: 'x' } })).body;
    expect((await call(a.admin, 'GET', `/api/tickets/${inc.id}/next`)).status).toBe(404);
    expect((await move(a.admin, inc.id, 'Triage')).status).toBe(404);
  });
});

describe('platform management of the masters', () => {
  const put = (path: string, method: 'POST' | 'PUT' | 'DELETE', body?: unknown) => call(sup, method as any, `/api/platform/workflow/${path}`, body);

  it('is Super Admin only', async () => {
    const { admin, pid } = await newProject();
    const pa = await makeCustomUser(['admin.projects'], {}, pid);
    expect((await call(pa, 'POST', '/api/platform/workflow/phases', { name: 'X1', tone: 'build' })).status).toBe(403);
    expect((await call(pa, 'GET', '/api/platform/workflow/catalog')).status).toBe(403);
    void admin;
  });

  it('adds a ticket type with its own fields, validated, and a project can then use it', async () => {
    const key = `risk_${Math.random().toString(36).slice(2, 6)}`;
    expect((await put('ticket-types', 'POST', { key, name: 'Risk', short: 'rsk', fields: [{ key: 'likelihood', label: 'Likelihood', kind: 'select', options: [] }] })).status).toBe(400);   // a choice needs options
    const made = await put('ticket-types', 'POST', { key, name: 'Risk', short: 'rsk', description: 'Something that could go wrong', fields: [
      { key: 'likelihood', label: 'Likelihood', kind: 'select', options: ['Low', 'High'], required: true }, { key: 'mitigation', label: 'Mitigation', kind: 'textarea' }] });
    expect(made.status).toBe(201);
    expect((await put('ticket-types', 'POST', { key, name: 'Dup', short: 'dup' })).status).toBe(409);
    const cat = (await call(sup, 'GET', '/api/platform/workflow/catalog')).body;
    expect(cat.ticketTypes.find((t: any) => t.key === key)).toMatchObject({ short: 'RSK' });
    // make it available in Agile, then a DevOps project can allow it
    const agile = cat.templates.find((t: any) => t.key === 'agile');
    const graph = (extraType: number[], edges: any[]) => ({ name: agile.name, description: agile.description, phases: agile.phases.map((p: any) => ({ phaseId: p.id, defaultOn: p.defaultOn })), ticketTypeIds: [...agile.ticketTypeIds, ...extraType], edges });
    const keep = agile.edges.filter((e: any) => !e.gated).map((e: any) => ({ ticketTypeId: e.ticketTypeId, from: e.from, to: e.to }));
    expect((await put(`templates/${agile.id}`, 'PUT', graph([made.body.id], keep))).status).toBe(200);    // general flow covers the new type
    const { admin } = await newProject('devops');
    const tpl = (await call(admin, 'GET', '/api/project/template')).body;
    expect(tpl.catalog.templates.find((t: any) => t.id === agile.id).ticketTypeIds).toContain(made.body.id);
    // change the definition: fields are replaced
    expect((await put(`ticket-types/${made.body.id}`, 'PUT', { name: 'Risk', short: 'RSK', fields: [{ key: 'impact', label: 'Impact', kind: 'number' }] })).status).toBe(200);
    expect((await call(sup, 'GET', '/api/platform/workflow/catalog')).body.ticketTypes.find((t: any) => t.key === key).fields.map((f: any) => f.key)).toEqual(['impact']);
    // a type nobody uses can be removed again
    expect((await put(`templates/${agile.id}`, 'PUT', graph([], keep))).status).toBe(200);
    expect((await put(`ticket-types/${made.body.id}`, 'DELETE')).status).toBe(200);
  });

  it('creates a methodology by copying one, edits its transitions, and projects follow', async () => {
    const key = `lean_${Math.random().toString(36).slice(2, 6)}`;
    const agile = (await call(sup, 'GET', '/api/platform/workflow/catalog')).body.templates.find((t: any) => t.key === 'agile');
    const made = await put('templates', 'POST', { key, name: 'Lean', description: 'Pull-based', copyFrom: agile.id });
    expect(made.status).toBe(201);
    const lean = (await call(sup, 'GET', '/api/platform/workflow/catalog')).body.templates.find((t: any) => t.id === made.body.id);
    expect(lean.phases.map((p: any) => p.name)).toEqual(agile.phases.map((p: any) => p.name));
    // a transition into a phase that is not part of the methodology is refused
    const review = lean.phases.find((p: any) => p.name === 'In Review').id, done = lean.phases.find((p: any) => p.name === 'Done').id;
    const base = { name: 'Lean', description: '', phases: lean.phases.map((p: any) => ({ phaseId: p.id, defaultOn: p.defaultOn })), ticketTypeIds: lean.ticketTypeIds };
    const edges = lean.edges.map((e: any) => ({ ticketTypeId: e.ticketTypeId, from: e.from, to: e.to }));
    expect((await put(`templates/${made.body.id}`, 'PUT', { ...base, edges: [...edges, { ticketTypeId: null, from: review, to: 999999 }] })).status).toBe(400);
    // no starting phase for the types: refused
    expect((await put(`templates/${made.body.id}`, 'PUT', { ...base, edges: edges.filter((e: any) => e.from !== null) })).status).toBe(400);
    // a shortcut Ready -> Done is accepted, and a project on Lean then gets that move
    const ready = lean.phases.find((p: any) => p.name === 'Ready').id;
    expect((await put(`templates/${made.body.id}`, 'PUT', { ...base, edges: [...edges, { ticketTypeId: null, from: ready, to: done }] })).status).toBe(200);
    const r = await call(sup, 'POST', '/api/platform/projects', { name: `Lean ${Math.random().toString(36).slice(2, 7)}`, templateTypeId: made.body.id });
    expect(r.status).toBe(201);
    const a = await makeUser('Admin', undefined, r.body.id);
    const wf = (await call(a, 'GET', '/api/workflow')).body;
    const featureId = (await id('ticket_types', 'feature'));
    expect(wf.template.key).toBe(key);
    expect(wf.moves[featureId]['Ready'].map((m: any) => m.to).sort()).toEqual(['Backlog', 'Done', 'In Progress']);
    // cannot delete a methodology that a project uses
    expect((await put(`templates/${made.body.id}`, 'DELETE')).status).toBe(409);
  });

  it('adds and removes phases, and keeps the document-driven steps of Waterfall intact', async () => {
    const name = `Phase ${Math.random().toString(36).slice(2, 6)}`;
    expect((await put('phases', 'POST', { name: 'bad;name', tone: 'build' })).status).toBe(400);
    const p = await put('phases', 'POST', { name, tone: 'review' });
    expect(p.status).toBe(201);
    expect((await put('phases', 'POST', { name, tone: 'review' })).status).toBe(409);
    expect((await put(`phases/${p.body.id}`, 'DELETE')).status).toBe(200);
    const wf = (await call(sup, 'GET', '/api/platform/workflow/catalog')).body.templates.find((t: any) => t.key === 'waterfall');
    const noGate = { name: wf.name, description: wf.description, phases: wf.phases.filter((x: any) => x.name !== 'FS Approved').map((x: any) => ({ phaseId: x.id, defaultOn: x.defaultOn })), ticketTypeIds: wf.ticketTypeIds,
      edges: wf.edges.filter((e: any) => !e.gated).map((e: any) => ({ ticketTypeId: e.ticketTypeId, from: e.from, to: e.to })) };
    const r = await put(`templates/${wf.id}`, 'PUT', noGate);
    expect(r.status).toBe(409); expect(r.body.error).toMatch(/documents and approvals/);
  });
});

describe('platform usage figures', () => {
  it('says how much each building block is used, and refuses to delete a used project type', async () => {
    const r = await call(sup, 'GET', '/api/platform/workflow/usage');
    expect(r.status).toBe(200);
    const incident = await id('ticket_types', 'incident'); const itil = await id('template_types', 'itil'); const support = await id('project_types', 'support');
    expect(r.body.ticketTypes[incident]).toMatchObject({ projects: expect.any(Number), tickets: expect.any(Number) });
    expect(r.body.templates[itil].projects).toBeGreaterThanOrEqual(0);
    expect(r.body.phases).toBeTruthy();
    await newProject('support');
    expect((await call(sup, 'GET', '/api/platform/workflow/usage')).body.projectTypes[support].projects).toBeGreaterThan(0);
    const del = await app.inject({ method: 'DELETE', url: `/api/platform/workflow/project-types/${support}`, headers: { cookie: sup.cookie } });
    expect(del.statusCode).toBe(409);
    expect((await app.inject({ method: 'GET', url: '/api/platform/workflow/usage', headers: { cookie: (await makeUser('Consultant')).cookie } })).statusCode).toBe(403);
  });
});
