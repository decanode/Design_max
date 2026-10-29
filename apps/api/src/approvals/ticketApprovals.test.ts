import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pool } from '../db.js';
import { buildApp } from '../app.js';
import { makeUser, tokenSentTo } from '../testAuth.js';

const app = buildApp();
type U = Awaited<ReturnType<typeof makeUser>>;
let sup: U, pid: string, pa: U, manager: U, consultant: U, incident: number, change: number;
const call = async (u: { cookie: string }, method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: unknown) => {
  const r = await app.inject({ method, url, payload: payload as any, headers: { cookie: u.cookie } });
  let body: any; try { body = r.json(); } catch { body = r.body; }
  return { status: r.statusCode, body };
};
const anon = async (url: string, payload?: unknown) => { const r = await app.inject({ method: payload ? 'POST' : 'GET', url, payload: payload as any }); return { status: r.statusCode, body: r.json() as any }; };
const ty = async (key: string) => (await pool.query('SELECT id FROM ticket_types WHERE key=$1', [key])).rows[0].id as number;
const meta = { priority: 'P3 - Medium', impact: 'Single user', steps_to_reproduce: 'Click print' };
const raise = (u: U, title: string, type = incident) => call(u, 'POST', '/api/tickets', { title, ticketTypeId: type, dynamicMetadata: type === incident ? meta : { change_type: 'Standard', risk: 'Low', implementation_plan: 'Swap file', rollback_plan: 'Swap back' } });
const approvalOf = async (id: string) => (await pool.query('SELECT approval_status s, current_state FROM tickets WHERE id=$1', [id])).rows[0];

beforeAll(async () => {
  await app.ready();
  sup = await makeUser('Admin');
  const r = await call(sup, 'POST', '/api/platform/projects', { name: `TA ${Math.random().toString(36).slice(2, 7)}`, projectTypeId: (await pool.query("SELECT id FROM project_types WHERE key='support'")).rows[0].id });
  pid = r.body.id;
  pa = await makeUser('Project Admin', undefined, pid);
  manager = await makeUser('Manager', undefined, pid);
  consultant = await makeUser('Lead', undefined, pid);
  incident = await ty('incident'); change = await ty('change');
});
afterAll(async () => { await app.close(); await pool.end(); });

describe('approving ticket creation', () => {
  let wfId: string;
  it('a Project Admin sets one up for Incidents; scope and clashes are validated', async () => {
    const body = { name: 'Incident approval', kinds: [], ticketTypeIds: [incident], levels: [{ name: 'L1', rule: 'any', approvers: [{ kind: 'user', id: manager.id }] }] };
    const empty = await call(pa, 'POST', '/api/project/workflows', { ...body, ticketTypeIds: [] });
    expect(empty.status).toBe(400);
    const wrong = await call(pa, 'POST', '/api/project/workflows', { ...body, ticketTypeIds: [await ty('wricef')] });
    expect(wrong.status).toBe(400); expect(wrong.body.error).toMatch(/not used by this project/);
    const ok = await call(pa, 'POST', '/api/project/workflows', body);
    expect(ok.status).toBe(201); wfId = ok.body.id;
    expect((await call(pa, 'POST', '/api/project/workflows', { ...body, name: 'Second' })).body.error).toMatch(/already approves Incident/);
    const list = (await call(pa, 'GET', '/api/project/workflows')).body;
    expect(list.find((w: any) => w.id === wfId)).toMatchObject({ kinds: [], ticketTypeIds: [incident] });
    expect((await call(pa, 'GET', '/api/project/workflows/options')).body.ticketTypes.map((t: any) => t.name)).toContain('Incident');
  });

  it('an Incident waits for approval: no moves, then the approver signs off and work can start', async () => {
    const t = (await raise(consultant, 'Printer down')).body;
    expect(t.approval_status).toBe('pending');
    const plan = (await call(consultant, 'GET', `/api/tickets/${t.id}/approval-plan?kind=TICKET`)).body;
    expect(plan.workflow.name).toBe('Incident approval');
    const move = await call(pa, 'POST', `/api/tickets/${t.id}/transition`, { to: 'Triage' });
    expect(move.status).toBe(409); expect(move.body.error).toMatch(/waiting for approval/);
    await expect(pool.query("UPDATE tickets SET current_state='Triage' WHERE id=$1", [t.id])).rejects.toThrow(/waiting for approval/);   // the database refuses too

    const token = await tokenSentTo(manager.email, 'Printer down');
    expect(token).toBeTruthy();
    const view = (await anon(`/api/approvals/${token}`)).body;
    expect(view).toMatchObject({ kind: 'TICKET', ticketTitle: 'Printer down' });
    expect(view.content).toContain('Click print');
    expect((await anon(`/api/approvals/${token}/decision`, { decision: 'approved' })).status).toBe(200);
    expect((await approvalOf(t.id)).s).toBe('approved');
    expect((await call(pa, 'POST', `/api/tickets/${t.id}/transition`, { to: 'Triage' })).status).toBe(200);
  });

  it('a refusal parks the ticket; the requester can send it again, and a second sign-off frees it', async () => {
    const t = (await raise(consultant, 'Scanner broken')).body;
    const t1 = await tokenSentTo(manager.email, 'Scanner broken');
    expect((await anon(`/api/approvals/${t1}/decision`, { decision: 'rejected' })).status).toBe(400);   // a reason is required
    expect((await anon(`/api/approvals/${t1}/decision`, { decision: 'rejected', comment: 'Duplicate of the printer one' })).status).toBe(200);
    expect((await approvalOf(t.id)).s).toBe('rejected');
    expect((await call(pa, 'POST', `/api/tickets/${t.id}/transition`, { to: 'Triage' })).body.error).toMatch(/not approved/);
    await pool.query('UPDATE tickets SET consultant_id=$2 WHERE id=$1', [t.id, consultant.id]);
    const stranger = manager;
    expect((await call(stranger, 'POST', `/api/tickets/${t.id}/approvals/resubmit`)).status).toBe(403);
    expect((await call(consultant, 'POST', `/api/tickets/${t.id}/approvals/resubmit`)).status).toBe(200);
    expect((await approvalOf(t.id)).s).toBe('pending');
    const t2 = await tokenSentTo(manager.email, 'Scanner broken');
    expect(t2).not.toBe(t1);
    expect((await anon(`/api/approvals/${t2}/decision`, { decision: 'approved' })).status).toBe(200);
    expect((await approvalOf(t.id)).s).toBe('approved');
    expect((await call(consultant, 'POST', `/api/tickets/${t.id}/approvals/resubmit`)).status).toBe(409);   // nothing to resubmit
  });

  it('other ticket types are not affected', async () => {
    const t = (await raise(consultant, 'Change the logo', change)).body;
    expect(t.approval_status).toBe('none');
    expect((await call(pa, 'POST', `/api/tickets/${t.id}/transition`, { to: 'Assessment' })).status).toBe(200);
  });

  it('shows up for the approver in their tasks and counts as awaiting approval on the board', async () => {
    const t = (await raise(consultant, 'Mouse stuck')).body;
    const mine = (await call(manager, 'GET', '/api/my/approvals')).body;
    expect(mine.find((a: any) => a.ticket_id === t.id)).toMatchObject({ kind: 'TICKET' });
    const board = (await call(pa, 'GET', '/api/tickets')).body;
    expect(board.find((x: any) => x.id === t.id)).toMatchObject({ awaiting_approval: true, approval_status: 'pending' });
  });

  it('refuses to create a ticket nobody could approve (the requester is the only approver) and creates nothing', async () => {
    await pool.query("UPDATE approval_workflows SET active=false WHERE id=$1", [wfId]);
    const solo = await call(pa, 'POST', '/api/project/workflows', { name: 'Solo', kinds: [], ticketTypeIds: [incident], levels: [{ name: 'L1', rule: 'any', approvers: [{ kind: 'user', id: consultant.id }] }] });
    expect(solo.status).toBe(201);
    const before = (await pool.query('SELECT count(*)::int n FROM tickets WHERE project_id=$1', [pid])).rows[0].n;
    const r = await raise(consultant, 'My own incident');
    expect(r.status).toBe(409); expect(r.body.error).toMatch(/no eligible approvers/);
    expect((await pool.query('SELECT count(*)::int n FROM tickets WHERE project_id=$1', [pid])).rows[0].n).toBe(before);
    await call(pa, 'DELETE', `/api/project/workflows/${solo.body.id}`);
  });

  it('switching the workflow off means new tickets need no approval', async () => {
    await pool.query("UPDATE approval_workflows SET active=false WHERE project_id=$1", [pid]);
    expect((await raise(consultant, 'No approval now')).body.approval_status).toBe('none');
  });
});
