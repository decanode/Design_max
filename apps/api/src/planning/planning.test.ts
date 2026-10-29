import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pool } from '../db.js';
import { buildApp } from '../app.js';
import { makeUser, makeCustomUser } from '../testAuth.js';
import { OfflinePlanningAi, PlanningAiError, type Charter, type PlanningAi, type WbsPlan } from './ai.js';
import { allowGeneration } from './routes.js';

class FakeAi implements PlanningAi {
  readonly provider = 'gemini' as const; readonly model = 'fake-model';
  calls: { kind: string; arg: unknown; ctx: unknown }[] = [];
  fail: Error | null = null;
  async draftCharter(i: unknown, ctx: unknown): Promise<Charter> {
    this.calls.push({ kind: 'charter', arg: i, ctx }); if (this.fail) throw this.fail;
    return { executiveSummary: 'Vendors are paid late and it hurts supply.', objectives: ['Pay on time', 'Cut disputes'], scope: ['Payment run', 'Vendor portal'], outOfScope: ['Payroll'],
      stakeholders: [{ name: 'Sue Sponsor', role: 'Sponsor', interest: 'Cash' }], milestones: [{ name: 'Kick-off', timing: 'Week 1' }], risks: [{ risk: 'Data quality', impact: 'High', mitigation: 'Cleanse' }] };
  }
  async generateWbs(text: string, ctx: unknown): Promise<WbsPlan> {
    this.calls.push({ kind: 'wbs', arg: text, ctx }); if (this.fail) throw this.fail;
    return { phases: [
      { title: 'Design', description: 'Design it', deliverables: [{ title: 'Blueprint', description: '', workPackages: [{ title: 'Workshop', description: 'Run it', effortDays: 2 }, { title: 'Write blueprint', description: '', effortDays: 3 }] }] },
      { title: 'Build', description: '', deliverables: [{ title: 'Payment run', description: '', workPackages: [{ title: 'Configure payment run', description: 'Config', effortDays: 5 }] }, { title: 'Vendor portal', description: '', workPackages: [{ title: 'Build portal', description: '', effortDays: 8 }] }] }] };
  }
}
const fake = new FakeAi();
const app = buildApp({ planningAi: fake });
let sup: Awaited<ReturnType<typeof makeUser>>;
beforeAll(async () => { await app.ready(); sup = await makeUser('Admin'); });
afterAll(async () => { await app.close(); await pool.end(); });

const call = async (who: { cookie: string }, method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, payload?: unknown) => {
  const r = await app.inject({ method, url, payload: payload as any, headers: { cookie: who.cookie } });
  return { status: r.statusCode, body: r.json() as any };
};
const intake = { problem: 'Vendors are paid late and complain.', sponsor: 'Sue Sponsor, CFO', goals: 'Pay 95% of invoices on time', constraints: 'Go-live before year end' };

/** A project with a Project Admin (super admin acting) and a Project Manager; the module stays off until the test turns it on. */
async function newProject(type = 'implementation') {
  const typeId = (await pool.query('SELECT id FROM project_types WHERE key=$1', [type])).rows[0].id;
  const r = await call(sup, 'POST', '/api/platform/projects', { name: `Plan ${Math.random().toString(36).slice(2, 8)}`, projectTypeId: typeId });
  const pid = r.body.id as string;
  return { pid, admin: await makeUser('Admin', undefined, pid), pm: await makeUser('Project Manager', undefined, pid), cons: await makeUser('Consultant', undefined, pid) };
}
const enable = (admin: { cookie: string }, on = true) => call(admin, 'PUT', '/api/project/modules', { key: 'planning_module', enabled: on });

describe('Planning parts are switched separately', () => {
  it('each part has its own switch, depends on the one before it, and gates its own routes', async () => {
    const { pm, admin } = await newProject();
    const put = (key: string, enabled: boolean) => call(admin, 'PUT', '/api/project/modules', { key, enabled });
    expect((await put('wbs', true)).status).toBe(409);                                  // needs the charter first
    expect((await put('project_charter', true)).body.modules).toMatchObject({ planning_module: true, project_charter: true, wbs: false, ritm_prep: false });
    expect((await call(pm, 'GET', '/api/planning')).status).toBe(200);
    expect((await call(pm, 'POST', '/api/planning/wbs', { parentId: null, title: 'Phase' })).status).toBe(403);      // WBS is still off
    expect((await put('ritm_prep', true)).status).toBe(409);
    expect((await put('wbs', true)).status).toBe(200);
    expect((await call(pm, 'POST', '/api/planning/wbs', { parentId: null, title: 'Phase' })).status).toBe(201);
    expect((await call(pm, 'POST', '/api/planning/convert', {})).status).toBe(403);                                  // RITM preparation is off
    expect((await put('project_charter', false)).status).toBe(409);                      // WBS is built from it
    expect((await put('wbs', false)).status).toBe(200);
    expect((await put('project_charter', false)).body.modules.planning_module).toBe(false);   // no part left: Planning is off
    expect((await call(pm, 'GET', '/api/planning')).status).toBe(403);
  });
  it('the Coming soon modules can be chosen and are remembered, without affecting Planning', async () => {
    const { admin } = await newProject();
    const r = await call(admin, 'PUT', '/api/project/modules', { key: 'risks', enabled: true });
    expect(r.body.modules).toEqual({ risks: true });
    expect((await call(admin, 'GET', '/api/project/modules')).body.modules.risks).toBe(true);
  });
});

describe('module flag and access', () => {
  it('is off by default: planning routes refuse, and the PM is told why', async () => {
    const { pm, admin } = await newProject();
    const r = await call(pm, 'GET', '/api/planning');
    expect(r.status).toBe(403); expect(r.body.code).toBe('MODULE_DISABLED');
    expect((await call(admin, 'GET', '/api/planning')).status).toBe(403);               // even an admin: the project has not switched it on
    expect((await call(pm, 'GET', '/api/auth/me')).body.project.modules).toEqual({});
  });

  it('a Project Admin switches it on (and off); the session then reports it; others cannot toggle', async () => {
    const { pm, admin, cons } = await newProject();
    expect((await call(pm, 'PUT', '/api/project/modules', { key: 'planning_module', enabled: true })).status).toBe(403);
    expect((await call(admin, 'PUT', '/api/project/modules', { key: 'finance_tracking', enabled: true })).status).toBe(400);   // unknown modules are refused
    expect((await enable(admin)).body.modules).toEqual({ planning_module: true, project_charter: true, wbs: true, ritm_prep: true });   // the older single switch turns on all three parts
    expect((await call(pm, 'GET', '/api/auth/me')).body.project.modules.planning_module).toBe(true);
    expect((await call(pm, 'GET', '/api/planning')).status).toBe(200);
    expect((await call(cons, 'GET', '/api/planning')).status).toBe(403);               // a Consultant lacks the permission
    expect((await enable(admin, false)).body.modules.planning_module).toBe(false);
    expect((await call(pm, 'GET', '/api/planning')).status).toBe(403);
    expect((await pool.query(`SELECT 1 FROM audit_log WHERE action='project.module' AND project_id=$1`, [admin.projectId])).rowCount).toBe(2);
  });

  it('one project’s flag and plan never reach another', async () => {
    const a = await newProject(), b = await newProject();
    await enable(a.admin); await enable(b.admin);
    await call(a.pm, 'POST', '/api/planning/charter/generate', intake);
    expect((await call(b.pm, 'GET', '/api/planning')).body.charter).toBeNull();
    await enable(b.admin, false);
    expect((await call(a.pm, 'GET', '/api/planning')).status).toBe(200);                // a's flag is its own
  });
});

describe('charter', () => {
  it('turns the wizard answers into a draft via the AI, with the project’s technology scope, and stores it by section', async () => {
    const { pm, admin, pid } = await newProject(); await enable(admin);
    await pool.query(`INSERT INTO project_stacks (project_id, stack_id) SELECT $1, id FROM tech_stacks WHERE name ILIKE '%sap%' LIMIT 1`, [pid]);
    expect((await call(pm, 'POST', '/api/planning/charter/generate', { ...intake, problem: 'short' })).status).toBe(400);   // validated before the AI is called
    const before = fake.calls.length;
    const r = await call(pm, 'POST', '/api/planning/charter/generate', intake);
    expect(r.status).toBe(201);
    expect(fake.calls.length).toBe(before + 1);
    expect(fake.calls[before].arg).toMatchObject({ sponsor: 'Sue Sponsor, CFO' });
    expect((fake.calls[before].ctx as any).stacks?.length).toBeGreaterThan(0);
    expect(r.body.ai).toEqual({ provider: 'gemini', model: 'fake-model' });
    expect(r.body.charter).toMatchObject({ status: 'Draft', generatedBy: 'fake-model', hasContent: true });
    expect(r.body.charter.sections.executiveSummary).toMatch(/paid late/);
    expect(r.body.charter.sections.scope).toContain('Payment run');
    expect(r.body.charter.sections.risks).toMatch(/Data quality \| High \| Cleanse/);
    expect(r.body.charter.intake.sponsor).toBe('Sue Sponsor, CFO');
    // a second generation must be confirmed, because it replaces the draft
    const again = await call(pm, 'POST', '/api/planning/charter/generate', intake);
    expect(again.status).toBe(409); expect(again.body.exists).toBe(true);
    expect((await call(pm, 'POST', '/api/planning/charter/generate', { ...intake, replace: true })).status).toBe(201);
  });

  it('keeps edits (saved by section), approval locks it, reopening unlocks it', async () => {
    const { pm, admin } = await newProject(); await enable(admin);
    await call(pm, 'POST', '/api/planning/charter/generate', intake);
    const doc = { type: 'doc', content: [
      { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Project Charter' }] },
      { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Executive Summary' }] }, { type: 'paragraph', content: [{ type: 'text', text: 'Rewritten by the PM.' }] },
      { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Scope' }] }, { type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Only the payment run' }] }] }] }] };
    const saved = await call(pm, 'PUT', '/api/planning/charter', { content: doc });
    expect(saved.status).toBe(200);
    expect(saved.body.charter.sections.executiveSummary).toBe('Rewritten by the PM.');
    expect(saved.body.charter.sections.scope).toBe('- Only the payment run');
    expect(saved.body.charter.sections.risks).toBe('');                          // sections that were removed from the document are empty
    const ok = await call(pm, 'POST', '/api/planning/charter/approve');
    expect(ok.body.charter.status).toBe('Approved'); expect(ok.body.charter.approvedBy).toBeTruthy();
    expect((await call(pm, 'PUT', '/api/planning/charter', { content: doc })).status).toBe(409);
    expect((await call(pm, 'POST', '/api/planning/charter/generate', { ...intake, replace: true })).status).toBe(409);
    expect((await call(pm, 'POST', '/api/planning/charter/collab-token')).body.canEdit).toBe(false);
    expect((await call(pm, 'POST', '/api/planning/charter/reopen')).body.charter.status).toBe('Draft');
    expect((await call(pm, 'POST', '/api/planning/charter/collab-token')).body).toMatchObject({ canEdit: true, lock: null });
  });

  it('cannot approve an empty charter, and AI failures come back as plain messages without losing the input', async () => {
    const { pm, admin } = await newProject(); await enable(admin);
    expect((await call(pm, 'POST', '/api/planning/charter/approve')).status).toBe(404);
    fake.fail = new PlanningAiError('The AI service is busy or unavailable. Your input is kept; try again in a moment.', 503);
    const r = await call(pm, 'POST', '/api/planning/charter/generate', intake);
    fake.fail = null;
    expect(r.status).toBe(503); expect(r.body.error).toMatch(/busy or unavailable/);
    expect((await call(pm, 'GET', '/api/planning')).body.charter).toBeNull();     // nothing half-written
  });

  it('limits how many AI drafts one person can start in a window', () => {
    const t = 1_000_000;
    for (let i = 0; i < 3; i++) expect(allowGeneration('u-limit', 3, 60_000, t + i)).toBe(true);
    expect(allowGeneration('u-limit', 3, 60_000, t + 10)).toBe(false);
    expect(allowGeneration('u-limit', 3, 60_000, t + 61_000)).toBe(true);
  });
});

describe('WBS', () => {
  async function approved() {
    const p = await newProject(); await enable(p.admin);
    await call(p.pm, 'POST', '/api/planning/charter/generate', intake);
    return p;
  }
  const byTitle = (wbs: any[], t: string) => wbs.find((e) => e.title === t);

  it('is generated only from an approved charter, as three levels, and replacing needs confirmation', async () => {
    const { pm } = await approved();
    expect((await call(pm, 'POST', '/api/planning/wbs/generate', {})).status).toBe(409);        // still a draft
    await call(pm, 'POST', '/api/planning/charter/approve');
    const before = fake.calls.length;
    const g = await call(pm, 'POST', '/api/planning/wbs/generate', {});
    expect(g.status).toBe(201);
    expect(String(fake.calls[before].arg)).toContain('## Scope');                                // the AI plans from the approved charter text
    const wbs = g.body.wbs as any[];
    expect(wbs.filter((e) => e.level === 1).map((e) => e.title)).toEqual(['Design', 'Build']);   // delivery order kept
    expect(wbs.filter((e) => e.level === 2)).toHaveLength(3); expect(wbs.filter((e) => e.level === 3)).toHaveLength(4);
    expect(byTitle(wbs, 'Configure payment run')).toMatchObject({ effort: 5, source: 'ai', level: 3 });
    const again = await call(pm, 'POST', '/api/planning/wbs/generate', {});
    expect(again.status).toBe(409); expect(again.body.exists).toBe(true);
    expect((await call(pm, 'POST', '/api/planning/wbs/generate', { replace: true })).status).toBe(201);
  });

  it('lets the PM add, edit and delete nodes; the database refuses a fourth level', async () => {
    const { pm } = await approved(); await call(pm, 'POST', '/api/planning/charter/approve');
    const ph = (await call(pm, 'POST', '/api/planning/wbs', { parentId: null, title: 'Mobilise' })).body.id;
    const dl = (await call(pm, 'POST', '/api/planning/wbs', { parentId: ph, title: 'Kick-off pack', description: 'Slides' })).body.id;
    const wp = (await call(pm, 'POST', '/api/planning/wbs', { parentId: dl, title: 'Draft slides', effort: 1.5 })).body.id;
    const tooDeep = await call(pm, 'POST', '/api/planning/wbs', { parentId: wp, title: 'Sub task' });
    expect(tooDeep.status).toBe(400); expect(tooDeep.body.error).toMatch(/three levels/);
    expect((await call(pm, 'POST', '/api/planning/wbs', { parentId: null, title: '   ' })).status).toBe(400);
    const edited = await call(pm, 'PATCH', `/api/planning/wbs/${wp}`, { title: 'Draft the slides', effort: 2, description: 'Ten slides' });
    expect(byTitle(edited.body.wbs, 'Draft the slides')).toMatchObject({ effort: 2, description: 'Ten slides', level: 3 });
    expect((await call(pm, 'PATCH', `/api/planning/wbs/${wp}`, { effort: -1 })).status).toBe(400);
    expect((await call(pm, 'PATCH', `/api/planning/wbs/${wp}`, { id: 'x' })).status).toBe(400);
    const del = await call(pm, 'DELETE', `/api/planning/wbs/${ph}`);                           // deleting a phase removes its subtree
    expect(del.body.wbs.find((e: any) => e.id === dl)).toBeUndefined();
  });

  it('moves work packages and deliverables, renumbers siblings, and refuses moves that break the shape', async () => {
    const { pm } = await approved(); await call(pm, 'POST', '/api/planning/charter/approve');
    let wbs = (await call(pm, 'POST', '/api/planning/wbs/generate', {})).body.wbs as any[];
    const design = byTitle(wbs, 'Design'), build = byTitle(wbs, 'Build'), blueprint = byTitle(wbs, 'Blueprint'), portal = byTitle(wbs, 'Vendor portal'), workshop = byTitle(wbs, 'Workshop'), cfg = byTitle(wbs, 'Configure payment run');
    // a work package to another deliverable, at the front
    wbs = (await call(pm, 'POST', `/api/planning/wbs/${workshop.id}/move`, { parentId: portal.id, index: 0 })).body.wbs;
    const inPortal = wbs.filter((e) => e.parentId === portal.id).sort((a, b) => a.order - b.order);
    expect(inPortal.map((e) => e.title)).toEqual(['Workshop', 'Build portal']); expect(inPortal.map((e) => e.order)).toEqual([0, 1]);
    expect(wbs.filter((e) => e.parentId === blueprint.id).map((e) => e.order)).toEqual([0]);   // the gap closed
    // a whole deliverable (with its children) to another phase
    wbs = (await call(pm, 'POST', `/api/planning/wbs/${blueprint.id}/move`, { parentId: build.id, index: 1 })).body.wbs;
    expect(byTitle(wbs, 'Blueprint')).toMatchObject({ parentId: build.id, level: 2 });
    expect(byTitle(wbs, 'Write blueprint')).toMatchObject({ level: 3 });
    // phases reorder
    wbs = (await call(pm, 'POST', `/api/planning/wbs/${build.id}/move`, { parentId: null, index: 0 })).body.wbs;
    expect(wbs.filter((e) => e.level === 1).sort((a, b) => a.order - b.order).map((e) => e.title)).toEqual(['Build', 'Design']);
    // refusals: a phase into a deliverable (4 levels), an element under itself/its descendant, a work package at the top
    expect((await call(pm, 'POST', `/api/planning/wbs/${build.id}/move`, { parentId: design.id, index: 0 })).status).toBe(400);   // a phase with its subtree would become level 4
    expect((await call(pm, 'POST', `/api/planning/wbs/${build.id}/move`, { parentId: build.id, index: 0 })).status).toBe(400);
    expect((await call(pm, 'POST', `/api/planning/wbs/${build.id}/move`, { parentId: cfg.id, index: 0 })).status).toBe(400);
    expect((await call(pm, 'POST', `/api/planning/wbs/${cfg.id}/move`, { parentId: null, index: 0 })).status).toBe(200);   // a work package may become a phase of its own, but then it is level 1
    expect(byTitle((await call(pm, 'GET', '/api/planning')).body.wbs, 'Configure payment run').level).toBe(1);
  });

  it('is isolated by project: another project cannot read or change it', async () => {
    const a = await approved(), b = await newProject(); await enable(b.admin);
    const id = (await call(a.pm, 'POST', '/api/planning/wbs', { parentId: null, title: 'Secret phase' })).body.id;
    expect((await call(b.pm, 'PATCH', `/api/planning/wbs/${id}`, { title: 'hijack' })).status).toBe(404);
    expect((await call(b.pm, 'DELETE', `/api/planning/wbs/${id}`)).status).toBe(404);
    expect((await call(b.pm, 'POST', `/api/planning/wbs/${id}/move`, { parentId: null, index: 0 })).status).toBe(404);
    expect((await call(b.pm, 'GET', '/api/planning')).body.wbs).toEqual([]);
    await expect(pool.query('INSERT INTO wbs_elements (project_id, parent_id, title) VALUES ($1,$2,$3)', [b.pid, id, 'cross-project child'])).rejects.toThrow(/same project/);
  });
});

describe('converting work packages into tickets', () => {
  async function planned(type = 'implementation') {
    const p = await newProject(type); await enable(p.admin);
    await call(p.pm, 'POST', '/api/planning/charter/generate', intake); await call(p.pm, 'POST', '/api/planning/charter/approve');
    const wbs = (await call(p.pm, 'POST', '/api/planning/wbs/generate', {})).body.wbs as any[];
    return { ...p, wbs };
  }

  it('creates tickets in the project’s default type, links them back, and is safe to repeat', async () => {
    const { pm, wbs, pid } = await planned();
    const wp = wbs.filter((e) => e.title === 'Configure payment run' || e.title === 'Build portal');
    const r = await call(pm, 'POST', '/api/planning/convert', { elementIds: wp.map((e) => e.id) });
    expect(r.status).toBe(201);
    expect(r.body.type.name).toBe('Requirement');                    // Implementation allows no Request Item: the default type is used
    expect(r.body.created).toHaveLength(2);
    const t = (await pool.query(`SELECT t.title, t.ai_summary, t.current_state FROM wbs_elements w JOIN tickets t ON t.id=w.ticket_id WHERE w.project_id=$1 ORDER BY t.title`, [pid])).rows;
    expect(t.map((x) => x.title)).toEqual(['Build portal', 'Configure payment run']);
    expect(t[1].ai_summary).toContain('Build › Payment run › Configure payment run'); expect(t[1].ai_summary).toContain('Estimated effort: 5 person-days');
    expect(t[1].current_state).toBe('Requirement Verified');
    const again = await call(pm, 'POST', '/api/planning/convert', { elementIds: wp.map((e) => e.id) });
    expect(again.body.created).toHaveLength(0); expect(again.body.skipped.map((s: any) => s.reason)).toEqual(['Already a ticket', 'Already a ticket']);
    expect(again.body.wbs.filter((e: any) => e.ticket).map((e: any) => e.ticket.title).sort()).toEqual(['Build portal', 'Configure payment run']);
    // phases and deliverables are not tickets
    const phase = wbs.find((e) => e.level === 1);
    expect((await call(pm, 'POST', '/api/planning/convert', { elementIds: [phase.id] })).body.skipped[0].reason).toMatch(/Only work packages/);
    // everything left in one go
    expect((await call(pm, 'POST', '/api/planning/convert', {})).body.created).toHaveLength(2);
    // converted branches are protected
    expect((await call(pm, 'DELETE', `/api/planning/wbs/${phase.id}`)).status).toBe(409);
    expect((await call(pm, 'POST', '/api/planning/wbs/generate', { replace: true })).status).toBe(409);
  });

  it('can make Request Items with their required fields filled once, using {title} per package', async () => {
    const { pm, pid, wbs } = await planned('support');
    const ritm = (await pool.query(`SELECT id FROM ticket_types WHERE key='ritm'`)).rows[0].id as number;
    await pool.query('UPDATE project_ticket_types SET enabled=true WHERE project_id=$1 AND ticket_type_id=$2', [pid, ritm]);
    const missing = await call(pm, 'POST', '/api/planning/convert', { ticketTypeId: ritm });          // RITM requires "requested for" and "catalogue item"
    expect(missing.status).toBe(400); expect(Object.keys(missing.body.fieldErrors).sort()).toEqual(['catalog_item', 'requested_for']);
    expect((await pool.query('SELECT count(*)::int n FROM tickets WHERE project_id=$1', [pid])).rows[0].n).toBe(0);   // nothing was created
    const r = await call(pm, 'POST', '/api/planning/convert', { ticketTypeId: ritm, fields: { requested_for: 'Project team', catalog_item: 'Plan: {title} ({phase})' } });
    expect(r.status).toBe(201); expect(r.body.type.name).toBe('Request Item');
    const rows = (await pool.query(`SELECT title, dynamic_metadata, current_state FROM tickets WHERE project_id=$1 ORDER BY title`, [pid])).rows;
    expect(rows).toHaveLength(wbs.filter((e: any) => e.level === 3).length);
    expect(rows.find((x) => x.title === 'Workshop')!.dynamic_metadata).toEqual({ requested_for: 'Project team', catalog_item: 'Plan: Workshop (Design)' });
    expect(rows[0].current_state).toBe('New');                       // the ITIL entry phase: the dynamic workflow decides where tickets start
  });

  it('needs the right to create tickets, and only offers types the project allows', async () => {
    const { pm, admin, pid } = await planned();
    const bug = (await pool.query(`SELECT id FROM ticket_types WHERE key='incident'`)).rows[0].id;
    expect((await call(pm, 'POST', '/api/planning/convert', { ticketTypeId: bug })).status).toBe(400);
    const planner = await makeCustomUser(['planning.manage', 'board.view'], {}, pid);               // may plan, may not create tickets
    expect((await call(planner, 'POST', '/api/planning/convert', {})).status).toBe(403);
    void admin;
  });
});

describe('offline fallback', () => {
  it('works end to end with the stand-in when no Gemini key is configured', async () => {
    const off = buildApp({ planningAi: new OfflinePlanningAi() }); await off.ready();
    const p = await newProject(); await enable(p.admin);
    const c = (m: string, u: string, b?: unknown) => off.inject({ method: m as any, url: u, payload: b as any, headers: { cookie: p.pm.cookie } }).then((r) => ({ status: r.statusCode, body: r.json() as any }));
    const g = await c('POST', '/api/planning/charter/generate', intake);
    expect(g.status).toBe(201); expect(g.body.ai.provider).toBe('offline'); expect(g.body.charter.generatedBy).toBe('offline template');
    await c('POST', '/api/planning/charter/approve');
    const w = await c('POST', '/api/planning/wbs/generate', {});
    expect(w.status).toBe(201); expect(w.body.wbs.filter((e: any) => e.level === 1).length).toBeGreaterThanOrEqual(3);
    await off.close();
  });
});
