import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { pool } from '../db.js';
import { buildApp } from '../app.js';
import { TemplateGenerator } from '../docs/generator.js';
import { HashEmbedder } from '../etl/vectorize.js';
import { createTicket } from '../tickets.js';
import { addMember, makeProject, makeUser, makeWorkflow, tokenSentTo } from '../testAuth.js';

const app = buildApp({ generator: new TemplateGenerator(), embedder: new HashEmbedder() });
type U = Awaited<ReturnType<typeof makeUser>>;
let admin: U, requester: U, a: U, b: U, c: U, outsider: U;
let cur = '';          // the project every call is made from; each scenario below builds its own project and moves here
const call = async (u: U, method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, payload?: unknown) => {
  const r = await app.inject({ method, url: path, payload: payload as any, headers: { cookie: u.cookieIn(cur) } });
  let body: any; try { body = r.json(); } catch { body = r.body; }
  return { status: r.statusCode, body };
};
const anon = async (path: string, payload?: unknown) => { const r = await app.inject({ method: payload ? 'POST' : 'GET', url: path, payload: payload as any }); return { status: r.statusCode, body: r.json() as any }; };

/** A fresh project with its own workflow and a ticket whose FS is ready for approval. */
async function setup(levels: Parameters<typeof makeWorkflow>[0]['levels'], title = `T${Math.random().toString(36).slice(2, 7)}`) {
  const projectId = await makeProject(`P-${title}`);
  for (const [u, role] of [[requester, 'Consultant'], [a, 'Manager'], [b, 'Manager'], [c, 'Lead'], [outsider, 'Consultant']] as const) await addMember(projectId, u.id, role);
  cur = projectId;
  const wf = await makeWorkflow({ projectId, levels });
  const t = await createTicket(projectId, title);
  await pool.query('UPDATE tickets SET consultant_id=$2 WHERE id=$1', [t.id, requester.id]);
  await call(requester, 'POST', `/api/tickets/${t.id}/documents/generate`, { kind: 'FS' });
  return { id: t.id as string, title, projectId, wf };
}
const state = async (id: string) => (await pool.query('SELECT current_state s FROM tickets WHERE id=$1', [id])).rows[0].s;
const tasks = async (id: string, level?: number) => (await pool.query(`SELECT a.status, a.level, a.level_name, u.email FROM approvals a JOIN users u ON u.id=a.approver_id WHERE a.ticket_id=$1 ${level ? `AND a.level=${level}` : ''} ORDER BY a.id`, [id])).rows;
const decide = async (u: U, ticket: { id: string; title: string }, d: 'approved' | 'rejected', comment?: string) => {
  const token = await tokenSentTo(u.email, ticket.title);
  return anon(`/api/approvals/${token}/decision`, { decision: d, comment });
};

beforeAll(async () => {
  await app.ready();
  [admin, requester, a, b, c, outsider] = await Promise.all([makeUser('Admin'), makeUser('Consultant'), makeUser('Manager'), makeUser('Manager'), makeUser('Lead'), makeUser('Consultant')]);
});
afterAll(async () => { await app.close(); await pool.end(); });

describe('levels run in order', () => {
  it('L2 is only asked after L1 is done, and the ticket moves only when the last level approves', async () => {
    const t = await setup([{ users: [a.id] }, { users: [b.id] }, { users: [c.id] }]);
    const plan = (await call(requester, 'GET', `/api/tickets/${t.id}/approval-plan?kind=FS`)).body;
    expect(plan.levels.map((l: any) => [l.name, l.approvers.length])).toEqual([['L1', 1], ['L2', 1], ['L3', 1]]);

    expect((await call(requester, 'POST', `/api/tickets/${t.id}/approvals`, { kind: 'FS' })).body).toMatchObject({ level: 'L1', levels: 3 });
    expect((await tasks(t.id)).map((x) => [x.level_name, x.email])).toEqual([['L1', a.email]]);
    expect(await tokenSentTo(b.email, t.title)).toBeNull();                 // L2 has not been told yet

    expect((await decide(a, t, 'approved')).status).toBe(200);
    expect(await state(t.id)).toBe('FS Drafted');
    expect((await tasks(t.id, 2)).map((x) => x.email)).toEqual([b.email]);
    expect(await tokenSentTo(c.email, t.title)).toBeNull();

    expect((await decide(b, t, 'approved')).status).toBe(200);
    expect(await state(t.id)).toBe('FS Drafted');
    expect((await decide(c, t, 'approved')).status).toBe(200);
    expect(await state(t.id)).toBe('FS Approved');

    const o = (await call(requester, 'GET', `/api/tickets/${t.id}`)).body.requests[0];
    expect(o.status).toBe('approved');
    expect(o.levels.map((l: any) => l.state)).toEqual(['done', 'done', 'done']);
    const notice = (await pool.query(`SELECT subject FROM email_outbox WHERE to_email=$1 AND subject LIKE $2`, [requester.email, `Approved:%${t.title}`])).rowCount;
    expect(notice).toBe(1);                                                   // requester told when fully approved
  });

  it('a rejection at any level ends the request with the reason, and the document can be re-submitted', async () => {
    const t = await setup([{ users: [a.id] }, { users: [b.id] }]);
    await call(requester, 'POST', `/api/tickets/${t.id}/approvals`, { kind: 'FS' });
    await decide(a, t, 'approved');
    expect((await decide(b, t, 'rejected')).status).toBe(400);                // reason required
    expect((await decide(b, t, 'rejected', 'Scope is unclear')).status).toBe(200);
    expect(await state(t.id)).toBe('FS Drafted');
    const o = (await call(requester, 'GET', `/api/tickets/${t.id}`)).body.requests[0];
    expect(o.status).toBe('rejected'); expect(o.levels.map((l: any) => l.state)).toEqual(['done', 'rejected']);
    const mail = (await pool.query(`SELECT body FROM email_outbox WHERE to_email=$1 AND subject LIKE $2`, [requester.email, `Rejected at L2:%${t.title}`])).rows[0];
    expect(mail.body).toContain('Scope is unclear');
    expect((await call(requester, 'POST', `/api/tickets/${t.id}/approvals`, { kind: 'FS' })).status).toBe(201);   // starts again at L1
    expect((await tasks(t.id)).filter((x) => x.status === 'pending').map((x) => x.level_name)).toEqual(['L1']);
  });
});

describe('level rules', () => {
  it('"all": everyone at the level must approve before the next level starts', async () => {
    const t = await setup([{ rule: 'all', users: [a.id, b.id] }, { users: [c.id] }]);
    await call(requester, 'POST', `/api/tickets/${t.id}/approvals`, { kind: 'FS' });
    expect((await tasks(t.id, 1)).map((x) => x.status)).toEqual(['pending', 'pending']);
    await decide(a, t, 'approved');
    expect(await tokenSentTo(c.email, t.title)).toBeNull();                   // still waiting on b
    expect((await tasks(t.id, 2))).toHaveLength(0);
    await decide(b, t, 'approved');
    expect((await tasks(t.id, 2)).map((x) => x.email)).toEqual([c.email]);
  });

  it('"any": the first approval completes the level and releases the others', async () => {
    const t = await setup([{ rule: 'any', users: [a.id, b.id] }]);
    await call(requester, 'POST', `/api/tickets/${t.id}/approvals`, { kind: 'FS' });
    await decide(b, t, 'approved');
    expect(await state(t.id)).toBe('FS Approved');
    const by = Object.fromEntries((await tasks(t.id)).map((x) => [x.email === a.email ? 'a' : 'b', x.status]));
    expect(by).toEqual({ a: 'skipped', b: 'approved' });
    expect((await decide(a, t, 'approved')).status).toBe(410);                // a's link no longer works
  });

  it('two people deciding at the same instant never advance a level twice', async () => {
    const t = await setup([{ rule: 'any', users: [a.id, b.id] }, { users: [c.id] }]);
    await call(requester, 'POST', `/api/tickets/${t.id}/approvals`, { kind: 'FS' });
    const rs = await Promise.all([decide(a, t, 'approved'), decide(b, t, 'approved')]);
    expect(rs.map((r) => r.status).sort()).toEqual([200, 410]);
    expect((await tasks(t.id, 2))).toHaveLength(1);                           // exactly one L2 task
  });

  it('a role as approver means every active member of it', async () => {
    const t = await setup([{ roles: ['Manager'] }]);
    await call(requester, 'POST', `/api/tickets/${t.id}/approvals`, { kind: 'FS' });
    const who = (await tasks(t.id)).map((x) => x.email);
    expect(who).toEqual(expect.arrayContaining([a.email, b.email]));
    await pool.query('UPDATE users SET active=false WHERE id=$1', [b.id]);
    const t2 = await setup([{ roles: ['Manager'] }]);
    await call(requester, 'POST', `/api/tickets/${t2.id}/approvals`, { kind: 'FS' });
    expect((await tasks(t2.id)).map((x) => x.email)).not.toContain(b.email);  // deactivated people are not asked
    await pool.query('UPDATE users SET active=true WHERE id=$1', [b.id]);
  });
});

describe('separation of duties', () => {
  it('requesters never approve their own work, and the chain must be satisfiable without them', async () => {
    const t = await setup([{ users: [requester.id] }]);
    const r = await call(requester, 'POST', `/api/tickets/${t.id}/approvals`, { kind: 'FS' });
    expect(r.status).toBe(409); expect(r.body.error).toMatch(/own request/);
    const t2 = await setup([{ users: [requester.id, a.id] }]);
    await call(requester, 'POST', `/api/tickets/${t2.id}/approvals`, { kind: 'FS' });
    expect((await tasks(t2.id)).map((x) => x.email)).toEqual([a.email]);
  });

  it('someone who already approved at an earlier level is not asked again', async () => {
    const t = await setup([{ users: [a.id] }, { users: [a.id] }, { users: [b.id] }]);
    await call(requester, 'POST', `/api/tickets/${t.id}/approvals`, { kind: 'FS' });
    await decide(a, t, 'approved');
    expect((await tasks(t.id)).filter((x) => x.status === 'pending').map((x) => [x.level_name, x.email])).toEqual([['L3', b.email]]);   // L2 passed automatically
    const o = (await call(requester, 'GET', `/api/tickets/${t.id}`)).body.requests[0];
    expect(o.levels.map((l: any) => l.state)).toEqual(['done', 'auto', 'active']);
  });

  it('only the addressed person can decide in the app, and in-app decisions do not depend on the emailed link expiring', async () => {
    const t = await setup([{ users: [a.id] }]);
    await call(requester, 'POST', `/api/tickets/${t.id}/approvals`, { kind: 'FS' });
    const task = (await call(a, 'GET', '/api/my/approvals')).body.find((x: any) => x.ticket_id === t.id);
    expect(task).toMatchObject({ level_name: 'L1' });
    expect((await call(outsider, 'POST', `/api/my/approvals/${task.id}/decision`, { decision: 'approved' })).status).toBe(403);
    await pool.query(`UPDATE approvals SET expires_at = now() - interval '1 day' WHERE ticket_id=$1`, [t.id]);
    expect((await decide(a, t, 'approved')).status).toBe(410);                 // the emailed link has expired…
    expect((await call(a, 'POST', `/api/my/approvals/${task.id}/decision`, { decision: 'approved' })).status).toBe(200);   // …the signed-in user is fine
    expect(await state(t.id)).toBe('FS Approved');
  });
});

describe('running requests', () => {
  it('editing the document voids the request; the requester or an Admin can cancel; others cannot', async () => {
    const t = await setup([{ users: [a.id] }, { users: [b.id] }]);
    await call(requester, 'POST', `/api/tickets/${t.id}/approvals`, { kind: 'FS' });
    await call(requester, 'POST', `/api/tickets/${t.id}/documents/FS/versions`, { content: 'changed', baseVersion: 1 });
    expect((await decide(a, t, 'approved')).status).toBe(410);
    expect((await call(requester, 'GET', `/api/tickets/${t.id}`)).body.requests[0].status).toBe('superseded');

    await call(requester, 'POST', `/api/tickets/${t.id}/approvals`, { kind: 'FS' });
    expect((await call(outsider, 'POST', `/api/tickets/${t.id}/approvals/cancel`, { kind: 'FS' })).status).toBe(404);   // can't even see it
    const lead = await makeUser('Lead', undefined, cur);
    expect((await call(lead, 'POST', `/api/tickets/${t.id}/approvals/cancel`, { kind: 'FS' })).status).toBe(403);   // can see it, but did not request it
    expect((await call(requester, 'POST', `/api/tickets/${t.id}/approvals/cancel`, { kind: 'FS' })).status).toBe(200);
    expect((await call(requester, 'POST', `/api/tickets/${t.id}/approvals/cancel`, { kind: 'FS' })).status).toBe(404);   // nothing left to cancel
    expect((await tasks(t.id)).filter((x) => x.status === 'pending')).toHaveLength(0);
    await call(requester, 'POST', `/api/tickets/${t.id}/approvals`, { kind: 'FS' });
    expect((await call(admin, 'POST', `/api/tickets/${t.id}/approvals/cancel`, { kind: 'FS' })).status).toBe(200);   // Admin may cancel anyone's
  });

  it('changing a workflow does not change a request already under way', async () => {
    const t = await setup([{ users: [a.id] }, { users: [b.id] }]);
    await call(requester, 'POST', `/api/tickets/${t.id}/approvals`, { kind: 'FS' });
    await pool.query('DELETE FROM approval_levels WHERE workflow_id=$1 AND position=2', [t.wf]);   // someone trims the workflow to one level
    await decide(a, t, 'approved');
    expect(await state(t.id)).toBe('FS Drafted');                              // the frozen copy still needs L2
    expect((await tasks(t.id, 2)).map((x) => x.email)).toEqual([b.email]);
    await decide(b, t, 'approved');
    expect(await state(t.id)).toBe('FS Approved');
  });
});

describe('which workflow applies', () => {
  it('each project uses only its own workflow, and a project with none cannot send a document', async () => {
    const t = await setup([{ users: [b.id] }]);
    await call(requester, 'POST', `/api/tickets/${t.id}/approvals`, { kind: 'FS' });
    expect((await tasks(t.id)).map((x) => x.email)).toEqual([b.email]);        // not "every Manager in the firm"

    const t2 = await setup([{ users: [a.id] }]);
    await pool.query("UPDATE approval_workflows SET kinds=ARRAY['TS'] WHERE id=$1", [t2.wf]);   // this project's workflow now covers only TS
    const r = await call(requester, 'POST', `/api/tickets/${t2.id}/approvals`, { kind: 'FS' });
    expect(r.status).toBe(409); expect(r.body.error).toMatch(/No approval workflow/);
    expect((await call(requester, 'GET', `/api/tickets/${t2.id}/approval-plan?kind=FS`)).body.workflow).toBeNull();
  });

  it('a template (the platform default copied into new projects) never applies by itself', async () => {
    const t = await setup([{ users: [a.id] }]);
    await pool.query('UPDATE approval_workflows SET active=false WHERE id=$1', [t.wf]);
    const tpl = (await pool.query("SELECT count(*)::int n FROM approval_workflows WHERE is_template AND active")).rows[0].n;
    expect(tpl).toBeGreaterThan(0);
    expect((await call(requester, 'POST', `/api/tickets/${t.id}/approvals`, { kind: 'FS' })).status).toBe(409);
  });

  it('the specification kind picks the workflow (FS and TS can differ)', async () => {
    const projectId = await makeProject('kinds');
    for (const [u, role] of [[requester, 'Consultant'], [a, 'Manager'], [b, 'Manager'], [c, 'Lead']] as const) await addMember(projectId, u.id, role);
    cur = projectId;
    await makeWorkflow({ projectId, kinds: ['FS'], levels: [{ users: [a.id] }] });
    await makeWorkflow({ projectId, kinds: ['TS'], levels: [{ users: [b.id] }, { users: [c.id] }] });
    const t = await createTicket(projectId, `K${Date.now()}`);
    await pool.query('UPDATE tickets SET consultant_id=$2 WHERE id=$1', [t.id, requester.id]);
    expect((await call(requester, 'GET', `/api/tickets/${t.id}/approval-plan?kind=FS`)).body.levels).toHaveLength(1);
    expect((await call(requester, 'GET', `/api/tickets/${t.id}/approval-plan?kind=TS`)).body.levels).toHaveLength(2);
  });
});

describe('administering workflows (a Project Admin\'s job, inside their own project)', () => {
  let pa: U, project: string, roles: { id: number; name: string }[];
  const body = (o: Record<string, unknown> = {}) => ({ name: `WF ${Math.random().toString(36).slice(2, 7)}`, kinds: ['FS'], active: false, levels: [{ name: 'L1', rule: 'any', approvers: [{ kind: 'role', id: roles[0].id }] }], ...o });

  beforeAll(async () => {
    project = await makeProject('wf-admin');
    pa = await makeUser('Project Admin', undefined, project);
    for (const [u, role] of [[requester, 'Consultant'], [a, 'Manager'], [c, 'Lead']] as const) await addMember(project, u.id, role);
    cur = project;
    roles = (await call(pa, 'GET', '/api/project/workflows/options')).body.roles;
  });
  beforeEach(() => { cur = project; });

  it('is limited to people with the workflow permission in that project', async () => {
    for (const [m, p] of [['GET', '/api/project/workflows'], ['POST', '/api/project/workflows'], ['GET', '/api/project/workflows/options']] as const)
      expect((await call(requester, m, p, body())).status).toBe(403);
    expect((await call(admin, 'GET', '/api/project/workflows')).status).toBe(200);        // a Super Admin may act in any project
  });

  it('lists only this project\'s workflows, and offers only this project\'s people as approvers', async () => {
    const opts = (await call(pa, 'GET', '/api/project/workflows/options')).body;
    expect(opts.users.map((u: any) => u.id)).toEqual(expect.arrayContaining([a.id, c.id, requester.id]));
    expect(opts.users.map((u: any) => u.id)).not.toContain(b.id);                          // b is not in this project
    const mine = await call(pa, 'POST', '/api/project/workflows', body({ name: 'Visible here' }));
    cur = await makeProject('elsewhere');
    expect((await call(admin, 'GET', '/api/project/workflows')).body.map((w: any) => w.name)).not.toContain('Visible here');
  });

  it('creates, edits and deletes with validation', async () => {
    const byName = (n: string) => roles.find((r) => r.name === n)!.id;
    const ok = body({ levels: [{ name: 'L1', rule: 'any', approvers: [{ kind: 'role', id: byName('Manager') }] }, { name: 'L2', rule: 'all', approvers: [{ kind: 'role', id: byName('Lead') }, { kind: 'user', id: a.id }] }] });
    const made = await call(pa, 'POST', '/api/project/workflows', ok);
    expect(made.status).toBe(201);
    const listed = (await call(pa, 'GET', '/api/project/workflows')).body.find((w: any) => w.id === made.body.id);
    expect(listed.levels.map((l: any) => [l.name, l.rule, l.approvers.length, l.eligible > 0])).toEqual([['L1', 'any', 1, true], ['L2', 'all', 2, true]]);

    const lvl = (o: object) => ({ name: 'L1', rule: 'any', approvers: [{ kind: 'role', id: byName('Manager') }], ...o });
    expect((await call(pa, 'POST', '/api/project/workflows', body({ levels: [] }))).status).toBe(400);
    expect((await call(pa, 'POST', '/api/project/workflows', body({ levels: Array.from({ length: 11 }, (_, i) => lvl({ name: `L${i}` })) }))).status).toBe(400);
    expect((await call(pa, 'POST', '/api/project/workflows', body({ levels: [lvl({ approvers: [] })] }))).status).toBe(400);
    expect((await call(pa, 'POST', '/api/project/workflows', body({ levels: [lvl({ name: 'X' }), lvl({ name: 'x' })] }))).status).toBe(400);
    expect((await call(pa, 'POST', '/api/project/workflows', body({ levels: [lvl({ approvers: [{ kind: 'user', id: '00000000-0000-4000-8000-000000000000' }] })] }))).status).toBe(400);
    expect((await call(pa, 'POST', '/api/project/workflows', body({ levels: [lvl({ approvers: [{ kind: 'user', id: b.id }] })] }))).status).toBe(400);   // not a member of this project
    expect((await call(pa, 'POST', '/api/project/workflows', body({ kinds: ['XX'] }))).status).toBe(400);

    expect((await call(pa, 'PUT', `/api/project/workflows/${made.body.id}`, { ...ok, name: 'Renamed', levels: [ok.levels[0]] })).status).toBe(200);
    expect((await call(pa, 'GET', '/api/project/workflows')).body.find((w: any) => w.id === made.body.id)).toMatchObject({ name: 'Renamed', levels: [{ name: 'L1' }] });
    expect((await call(pa, 'DELETE', `/api/project/workflows/${made.body.id}`)).status).toBe(200);
    expect((await call(pa, 'GET', '/api/project/audit')).body.map((x: any) => x.action)).toEqual(expect.arrayContaining(['workflow.create', 'workflow.update', 'workflow.delete']));
  });

  it('cannot reach another project\'s workflow, even by id', async () => {
    const other = await makeProject('other-wf');
    const theirs = await makeWorkflow({ projectId: other, levels: [{ users: [a.id] }] });
    expect((await call(pa, 'PUT', `/api/project/workflows/${theirs}`, body())).status).toBe(404);
    expect((await call(pa, 'DELETE', `/api/project/workflows/${theirs}`)).status).toBe(404);
    expect((await pool.query('SELECT 1 FROM approval_workflows WHERE id=$1', [theirs])).rowCount).toBe(1);
  });

  it('refuses two active workflows for the same document in one project, but the same document in another project is fine', async () => {
    expect((await call(pa, 'POST', '/api/project/workflows', body({ active: true }))).status).toBe(201);
    const clash = await call(pa, 'POST', '/api/project/workflows', body({ active: true, kinds: ['FS', 'TS'] }));
    expect(clash.status).toBe(409); expect(clash.body.error).toMatch(/already covers/);
    expect((await call(pa, 'POST', '/api/project/workflows', body({ active: true, kinds: ['TS'] }))).status).toBe(201);
    cur = await makeProject('second');
    const roles2 = (await call(admin, 'GET', '/api/project/workflows/options')).body.roles;
    expect((await call(admin, 'POST', '/api/project/workflows', { name: 'Same doc elsewhere', kinds: ['FS'], active: true, levels: [{ name: 'L1', rule: 'any', approvers: [{ kind: 'role', id: roles2[0].id }] }] })).status).toBe(201);
  });

  it('a role that approvers are drawn from cannot be deleted from the catalog', async () => {
    const role = (await call(admin, 'POST', '/api/platform/roles', { name: `Approvers ${Date.now()}` })).body.id;
    await call(pa, 'POST', '/api/project/workflows', body({ levels: [{ name: 'L1', rule: 'any', approvers: [{ kind: 'role', id: role }] }] }));
    const del = await call(admin, 'DELETE', `/api/platform/roles/${role}`);
    expect(del.status).toBe(409); expect(del.body.error).toMatch(/approval workflow/);
  });
});
