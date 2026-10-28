import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { io as client } from 'socket.io-client';
import type { AddressInfo } from 'node:net';
import { pool } from '../db.js';
import { buildApp } from '../app.js';
import { attachChat } from '../chat/socket.js';
import { ScriptedChatAgent } from '../chat/agent.js';
import { TemplateGenerator } from '../docs/generator.js';
import { HashEmbedder, similar, storeEmbeddings } from '../etl/vectorize.js';
import { createConversation } from '../chat/service.js';
import { createTicket } from '../tickets.js';
import { loadRecord } from '../etl/load.js';
import { addMember, makeProject, makeUser, makeWorkflow, tokenSentTo, type TestUser } from '../testAuth.js';
import { PROJECT_COOKIE, signSession } from '../rbac/auth.js';

const app = buildApp({ generator: new TemplateGenerator(), embedder: new HashEmbedder() });
let url: string;
let superAdmin: TestUser, alpha: string, beta: string;
let paA: TestUser, paB: TestUser, consA: TestUser, custA: TestUser, mgrA: TestUser, custB: TestUser, mgrB: TestUser, shared: TestUser;
let ticketA: string, ticketB: string;

/** Calls as `u`, working in `project` (default: the user's own). */
const call = async (u: TestUser, method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', path: string, payload?: unknown, project?: string) => {
  const r = await app.inject({ method, url: path, payload: payload as any, headers: { cookie: u.cookieIn(project ?? u.projectId) } });
  let body: any; try { body = r.json(); } catch { body = r.body; }
  return { status: r.statusCode, body, headers: r.headers };
};
const roleId = async (name: string) => (await pool.query('SELECT id FROM roles WHERE name=$1', [name])).rows[0].id as number;

beforeAll(async () => {
  await app.ready(); attachChat(app.server, new ScriptedChatAgent()); await app.listen({ port: 0 });
  url = `http://localhost:${(app.server.address() as AddressInfo).port}`;
  alpha = await makeProject('Alpha'); beta = await makeProject('Beta');
  superAdmin = await makeUser('Super Admin', undefined, alpha);
  paA = await makeUser('Project Admin', undefined, alpha); paB = await makeUser('Project Admin', undefined, beta);
  consA = await makeUser('Consultant', undefined, alpha); custA = await makeUser('Customer', undefined, alpha); mgrA = await makeUser('Manager', undefined, alpha);
  custB = await makeUser('Customer', undefined, beta); mgrB = await makeUser('Manager', undefined, beta);
  shared = await makeUser('Consultant', undefined, alpha); await addMember(beta, shared.id, 'Customer');   // Consultant in Alpha, Customer in Beta
  ticketA = (await createTicket(alpha, 'Alpha ticket')).id; ticketB = (await createTicket(beta, 'Beta ticket')).id;
  await pool.query("UPDATE tickets SET customer_id=$2, consultant_id=$3, ai_summary='ALPHA-SECRET', resolution_notes='ALPHA-NOTES' WHERE id=$1", [ticketA, custA.id, consA.id]);
  await pool.query("UPDATE tickets SET customer_id=$2, ai_summary='BETA-SECRET' WHERE id=$1", [ticketB, custB.id]);
  await makeWorkflow({ projectId: alpha, levels: [{ roles: ['Manager'] }] }); await makeWorkflow({ projectId: beta, levels: [{ roles: ['Manager'] }] });
});
afterAll(async () => { await app.close(); await pool.end(); });

describe('projects are walled off from each other', () => {
  it('tickets: lists, details, edits, phase changes, claims and assignments never cross', async () => {
    const aList = (await call(paA, 'GET', '/api/tickets')).body.map((t: any) => t.title);
    expect(aList).toContain('Alpha ticket'); expect(aList).not.toContain('Beta ticket');
    expect((await call(paA, 'GET', `/api/tickets/${ticketB}`)).status).toBe(404);              // a guessed id reveals nothing
    expect((await call(paA, 'PATCH', `/api/tickets/${ticketB}`, { title: 'hijack' })).status).toBe(404);
    expect((await call(paA, 'POST', `/api/tickets/${ticketB}/transition`, { to: 'FS Drafted' })).status).toBe(404);
    expect((await call(paA, 'POST', `/api/tickets/${ticketB}/claim`)).status).toBe(404);
    expect((await call(paA, 'POST', `/api/tickets/${ticketB}/assign`, { consultantId: consA.id })).status).toBe(404);
    expect((await call(paA, 'POST', `/api/tickets/${ticketB}/documents/generate`, { kind: 'FS' })).status).toBe(404);
    expect((await pool.query('SELECT title FROM tickets WHERE id=$1', [ticketB])).rows[0].title).toBe('Beta ticket');
    // a Super Admin standing in Alpha is held to the same wall
    expect((await call(superAdmin, 'GET', `/api/tickets/${ticketB}`, undefined, alpha)).status).toBe(404);
    expect((await call(superAdmin, 'GET', `/api/tickets/${ticketB}`, undefined, beta)).status).toBe(200);
  });

  it('new tickets always land in the project you are working in, whatever the request says', async () => {
    const r = await call(paA, 'POST', '/api/tickets', { title: 'made in A', projectId: beta });
    expect(r.status).toBe(201);
    expect((await pool.query('SELECT project_id FROM tickets WHERE title=$1', ['made in A'])).rows[0].project_id).toBe(alpha);
  });

  it('chat: conversations, messages and drafts of another project do not exist for you', async () => {
    const convB = (await createConversation(beta, undefined, custB.id)).id as string;
    expect((await call(paA, 'GET', `/api/conversations/${convB}`)).status).toBe(404);
    expect((await call(paA, 'GET', '/api/conversations')).body.map((c: any) => c.id)).not.toContain(convB);
    const s = client(url, { extraHeaders: { cookie: paA.cookie }, reconnection: false });
    await new Promise<void>((r) => s.once('connect', () => r()));
    const ack = (ev: string, data: unknown) => new Promise<any>((r) => s.emit(ev, data, r));
    expect((await ack('join', { conversationId: convB })).error).toBeTruthy();
    expect((await ack('message', { conversationId: convB, body: 'hi' })).error).toBeTruthy();
    expect((await ack('verify', { conversationId: convB })).error).toBeTruthy();
    s.close();
  });

  it('people: assignable lists, team dashboard and member lists show only this project', async () => {
    const assignable = (await call(paA, 'GET', '/api/users/assignable')).body.map((u: any) => u.id);
    expect(assignable).toContain(consA.id); expect(assignable).not.toContain(paB.id);
    expect((await call(paA, 'POST', `/api/tickets/${ticketA}/assign`, { consultantId: paB.id })).status).toBe(400);   // a Beta person cannot own an Alpha ticket
    const members = (await call(paA, 'GET', '/api/project/members')).body.map((m: any) => m.id);
    expect(members).toEqual(expect.arrayContaining([paA.id, consA.id])); expect(members).not.toContain(paB.id); expect(members).not.toContain(custB.id);
    const team = (await call(paA, 'GET', '/api/dashboard/team')).body;
    expect(team.consultants.map((c: any) => c.id)).not.toContain(paB.id);
  });

  it('reports and dashboards: built-ins show each project its own numbers; custom ones never cross', async () => {
    const open = (u: TestUser) => call(u, 'GET', '/api/reports').then((r) => (r.body as any[]).find((x) => x.name === 'Open tickets')!.id);
    const idA = await open(paA);
    const countFor = async (u: TestUser) => (await call(u, 'GET', `/api/reports/${idA}/data`)).body.rows[0].value;
    expect(await countFor(paB)).toBe(1);                                          // Beta's one ticket
    expect(await countFor(paA)).toBeGreaterThanOrEqual(2);                        // Alpha's own
    const def = { dataset: 'tickets', measure: 'count', groupBy: 'state', filters: {}, sort: 'natural', limit: 12, chart: 'column' };
    const mine = (await call(paA, 'POST', '/api/reports', { name: 'Alpha only', definition: def, visibility: 'shared' })).body.id;
    expect((await call(paB, 'GET', `/api/reports/${mine}`)).status).toBe(404);
    expect((await call(paB, 'GET', `/api/reports/${mine}/data`)).status).toBe(404);
    expect(((await call(paB, 'GET', '/api/reports')).body as any[]).map((r) => r.name)).not.toContain('Alpha only');
    const bDash = (await call(paB, 'POST', '/api/dashboards', { name: 'B board', layout: [] })).body.id;
    expect((await call(paB, 'PUT', `/api/dashboards/${bDash}`, { layout: [{ id: crypto.randomUUID(), reportId: mine, size: 1 }] })).status).toBe(400);   // cannot embed A's report
    expect((await call(paB, 'GET', `/api/dashboards/${bDash}`, undefined, beta)).status).toBe(200);
    expect((await call(paA, 'GET', `/api/dashboards/${bDash}`)).status).toBe(404);
  });

  it('knowledge: a project is only offered its own knowledge plus shared platform knowledge', async () => {
    const emb = new HashEmbedder(); const tag = `kb${Date.now()}`;
    await storeEmbeddings(pool, emb, [
      { sourceType: 'kb_doc', sourceRef: `${tag}:a`, content: `${tag} reconcile ledger`, projectId: alpha },
      { sourceType: 'kb_doc', sourceRef: `${tag}:b`, content: `${tag} reconcile ledger`, projectId: beta },
      { sourceType: 'kb_doc', sourceRef: `${tag}:shared`, content: `${tag} reconcile ledger` },
    ]);
    const refs = async (p: string | null) => (await similar(pool, emb, `${tag} reconcile ledger`, 20, undefined, p)).map((r) => r.source_ref).filter((r: string) => r.startsWith(tag)).sort();
    expect(await refs(alpha)).toEqual([`${tag}:a`, `${tag}:shared`]);
    expect(await refs(beta)).toEqual([`${tag}:b`, `${tag}:shared`]);
    expect(await refs(null)).toEqual([`${tag}:shared`]);                               // no project: shared knowledge only
    await storeEmbeddings(pool, emb, [{ sourceType: 'kb_doc', sourceRef: `${tag}:a`, content: 'changed', projectId: beta }]);   // same ref in another project is a different item
    expect((await pool.query('SELECT count(*)::int n FROM embeddings WHERE source_ref=$1', [`${tag}:a`])).rows[0].n).toBe(2);
  });

  it('approvals: a role means THIS project\'s members, and tasks are decided in their own project', async () => {
    const t = (await createTicket(alpha, 'approval isolation')).id as string;
    await pool.query('UPDATE tickets SET consultant_id=$2 WHERE id=$1', [t, consA.id]);
    await call(consA, 'POST', `/api/tickets/${t}/documents/generate`, { kind: 'FS' });
    expect((await call(consA, 'POST', `/api/tickets/${t}/approvals`, { kind: 'FS' })).status).toBe(201);
    expect(await tokenSentTo(mgrA.email, 'approval isolation')).toBeTruthy();
    expect(await tokenSentTo(mgrB.email, 'approval isolation')).toBeNull();         // Beta's Manager is not asked
    const task = (await call(mgrA, 'GET', '/api/my/approvals')).body.find((x: any) => x.ticket_id === t);
    expect(task).toBeTruthy();
    expect((await call(mgrB, 'GET', '/api/my/approvals')).body.map((x: any) => x.ticket_id)).not.toContain(t);
    // a person in both projects only sees and decides a task while working in its project
    await addMember(beta, mgrA.id, 'Customer');
    expect((await call(mgrA, 'GET', '/api/my/approvals', undefined, beta)).body.map((x: any) => x.ticket_id)).not.toContain(t);
    expect((await call(mgrA, 'POST', `/api/my/approvals/${task.id}/decision`, { decision: 'approved' }, beta)).status).toBe(404);   // from Beta that approval does not exist at all
    expect((await call(mgrA, 'POST', `/api/my/approvals/${task.id}/decision`, { decision: 'approved' }, alpha)).status).toBe(200);
  });

  it('legacy imports: people become Customers of the importing project only, and the same Jira key can exist in two projects', async () => {
    const rec = (key: string) => ({ source: 'jira' as const, legacyId: key, type: 'Story', title: `legacy ${key}`, status: 'Done', reporter: { legacyId: 'acc-77', email: 'imported@corp.com', name: 'Imported' }, comments: [], attachments: [] });
    await loadRecord(pool, alpha, rec('PROJ-1')); await loadRecord(pool, beta, rec('PROJ-1'));
    expect((await pool.query("SELECT count(*)::int n FROM tickets WHERE legacy_id='PROJ-1' AND project_id = ANY($1)", [[alpha, beta]])).rows[0].n).toBe(2);
    const u = (await pool.query("SELECT id FROM users WHERE email='imported@corp.com'")).rows[0].id;
    const roles = (await pool.query('SELECT p.name, r.name AS role FROM project_members m JOIN projects p ON p.id=m.project_id JOIN roles r ON r.id=m.role_id WHERE m.user_id=$1 ORDER BY p.name', [u])).rows;
    expect(roles).toEqual([{ name: 'Alpha', role: 'Customer' }, { name: 'Beta', role: 'Customer' }]);
  });

  it('the dev mailbox spans every project, so only a Super Admin may read it', async () => {
    expect((await call(superAdmin, 'GET', '/api/dev/outbox')).status).toBe(200);
    expect((await call(paA, 'GET', '/api/dev/outbox')).status).toBe(403);
  });
});

describe('one person, different roles in different projects', () => {
  it('permissions, visible tickets and field access follow the project you are in', async () => {
    const tShared = (await createTicket(alpha, 'unassigned in alpha')).id as string;
    const inAlpha = (await call(shared, 'GET', '/api/tickets', undefined, alpha)).body.map((t: any) => t.title);
    expect(inAlpha).toContain('unassigned in alpha');                                // Consultant: sees the intake queue
    expect((await call(shared, 'POST', `/api/tickets/${tShared}/claim`, undefined, alpha)).status).toBe(200);
    const inBeta = (await call(shared, 'GET', '/api/tickets', undefined, beta)).body.map((t: any) => t.title);
    expect(inBeta).not.toContain('Beta ticket');                                     // Customer in Beta: only their own tickets
    expect((await call(shared, 'POST', `/api/tickets/${ticketB}/claim`, undefined, beta)).status).toBe(403);   // as a Customer in Beta they cannot claim anything
    const meA = (await call(shared, 'GET', '/api/auth/me', undefined, alpha)).body, meB = (await call(shared, 'GET', '/api/auth/me', undefined, beta)).body;
    expect(meA.user.role).toBe('Consultant'); expect(meB.user.role).toBe('Customer');
    expect(meA.permissions).toContain('ticket.claim'); expect(meB.permissions).not.toContain('ticket.claim');
    expect(meA.projects.map((p: any) => [p.name, p.role]).sort()).toEqual([['Alpha', 'Consultant'], ['Beta', 'Customer']]);
  });

  it('the project switcher sets the working project, refuses projects you are not in, and ignores a forged cookie', async () => {
    const sw = await app.inject({ method: 'POST', url: '/api/auth/project', payload: { projectId: beta }, headers: { cookie: `dm_session=${signSession(shared.id)}` } });
    expect(sw.statusCode).toBe(200);
    expect(String(sw.headers['set-cookie'])).toContain(`${PROJECT_COOKIE}=${beta}`);
    const denied = await app.inject({ method: 'POST', url: '/api/auth/project', payload: { projectId: beta }, headers: { cookie: `dm_session=${signSession(consA.id)}` } });
    expect(denied.statusCode).toBe(403);
    // a hand-written project cookie for a project you are not in changes nothing: you stay in your own
    const forged = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: `dm_session=${signSession(consA.id)}; ${PROJECT_COOKIE}=${beta}` } });
    expect(forged.json().project.id).toBe(alpha);
    const garbage = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: `dm_session=${signSession(consA.id)}; ${PROJECT_COOKIE}=not-a-uuid` } });
    expect(garbage.json().project.id).toBe(alpha);
  });

  it('a person with no project can sign in but reach nothing, and is told to choose a project', async () => {
    const loner = (await pool.query("INSERT INTO users (email, display_name) VALUES ('loner@t.dev','Loner') RETURNING id")).rows[0].id as string;
    const cookie = `dm_session=${signSession(loner)}`;
    const me = (await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } })).json();
    expect(me.project).toBeNull(); expect(me.permissions).toEqual([]);
    const r = await app.inject({ method: 'GET', url: '/api/tickets', headers: { cookie } });
    expect(r.statusCode).toBe(409); expect(r.json().code).toBe('NO_PROJECT');
  });
});

describe('the Super Admin (platform) tier', () => {
  it('only Super Admins reach the platform console; project roles can never carry platform powers', async () => {
    for (const [m, p] of [['GET', '/api/platform/projects'], ['GET', '/api/platform/users'], ['GET', '/api/platform/roles'], ['GET', '/api/platform/stacks'], ['GET', '/api/platform/audit']] as const) {
      expect((await call(paA, m, p)).status, p).toBe(403);
      expect((await call(superAdmin, m, p)).status, p).toBe(200);
    }
    const role = await roleId('Manager');
    expect((await call(paA, 'PUT', `/api/project/roles/${role}/permissions`, { permissions: ['platform.users'] })).status).toBe(400);
    expect((await call(superAdmin, 'PUT', `/api/platform/roles/${role}/permissions`, { permissions: ['platform.projects'] })).status).toBe(400);
  });

  it('creating a project: it gets its own default workflow and a first Project Admin, who can run it but nothing else', async () => {
    const adminEmail = `new-admin-${Date.now()}@corp.com`;
    const made = await call(superAdmin, 'POST', '/api/platform/projects', { name: `Gamma ${Date.now()}`, admin: { email: adminEmail, name: 'Gina Admin' } });
    expect(made.status).toBe(201);
    const gamma = made.body.id as string;
    expect((await call(superAdmin, 'POST', '/api/platform/projects', { name: 'alpha' })).status).toBe(409);        // names are unique
    const gina = { id: made.body.adminId, email: adminEmail, projectId: gamma, cookie: '', cookieIn: (p: string) => `dm_session=${signSession(made.body.adminId)}; ${PROJECT_COOKIE}=${p}` } as TestUser;
    const me = (await call(gina, 'GET', '/api/auth/me', undefined, gamma)).body;
    expect(me.user.role).toBe('Project Admin'); expect(me.projects).toHaveLength(1);
    const wfs = (await call(gina, 'GET', '/api/project/workflows', undefined, gamma)).body;
    expect(wfs.map((w: any) => w.name)).toEqual(['Standard approval']);            // a private copy of the template
    expect((await call(gina, 'GET', '/api/platform/projects', undefined, gamma)).status).toBe(403);
    expect((await call(gina, 'GET', `/api/tickets/${ticketA}`, undefined, gamma)).status).toBe(404);              // and cannot see other projects' work
    // her workflow edits stay in her project
    await call(gina, 'PUT', `/api/project/workflows/${wfs[0].id}`, { name: 'Gamma only', description: '', kinds: ['FS'], active: true, levels: [{ name: 'L1', rule: 'any', approvers: [{ kind: 'user', id: gina.id }] }] }, gamma);
    expect((await call(paA, 'GET', '/api/project/workflows')).body.map((w: any) => w.name)).not.toContain('Gamma only');
    expect((await pool.query("SELECT count(*)::int n FROM approval_workflows WHERE is_template AND name='Standard approval'")).rows[0].n).toBe(1);   // the template is untouched
    // archiving cuts everyone off at once
    expect((await call(superAdmin, 'PATCH', `/api/platform/projects/${gamma}`, { status: 'archived' })).status).toBe(200);
    expect((await call(gina, 'GET', '/api/auth/me', undefined, gamma)).body.project).toBeNull();
    expect((await call(gina, 'GET', '/api/tickets', undefined, gamma)).status).toBe(409);
  });

  it('appointing admins, managing every user, and never losing the last Super Admin', async () => {
    const emailNew = `appointed-${Date.now()}@corp.com`;
    const r = await call(superAdmin, 'POST', `/api/platform/projects/${beta}/admins`, { email: emailNew, name: 'Appointed' });
    expect(r.status).toBe(201); expect(r.body.created).toBe(true);
    expect((await call(superAdmin, 'GET', '/api/platform/users')).body.find((u: any) => u.email === emailNew).projects).toEqual([{ id: beta, name: 'Beta', role: 'Project Admin' }]);
    // deactivate the only other Super Admins to prove the guard
    const others = (await pool.query('SELECT id FROM users WHERE is_super_admin AND active AND id <> $1', [superAdmin.id])).rows.map((x) => x.id);
    await pool.query('UPDATE users SET active=false WHERE id = ANY($1)', [others]);
    try {
      expect((await call(superAdmin, 'PATCH', `/api/platform/users/${superAdmin.id}`, { isSuperAdmin: false })).status).toBe(409);
      expect((await call(superAdmin, 'PATCH', `/api/platform/users/${superAdmin.id}`, { active: false })).status).toBe(409);
      expect((await call(superAdmin, 'PATCH', `/api/platform/users/${superAdmin.id}`, { name: 'Renamed' })).status).toBe(200);
    } finally { await pool.query('UPDATE users SET active=true WHERE id = ANY($1)', [others]); }
  });

  it('a Super Admin may step into any project, and stepping into one they do not belong to is recorded', async () => {
    const before = (await pool.query("SELECT count(*)::int n FROM audit_log WHERE action='project.enter' AND actor_id=$1", [superAdmin.id])).rows[0].n;
    const sw = await app.inject({ method: 'POST', url: '/api/auth/project', payload: { projectId: beta }, headers: { cookie: `dm_session=${signSession(superAdmin.id)}` } });
    expect(sw.statusCode).toBe(200);
    const after = await pool.query("SELECT project_id, detail FROM audit_log WHERE action='project.enter' AND actor_id=$1 ORDER BY id DESC", [superAdmin.id]);
    expect(after.rowCount).toBe(before + 1); expect(after.rows[0].project_id).toBe(beta);
    expect((await call(paB, 'GET', '/api/project/audit')).body.map((a: any) => a.action)).toContain('project.enter');    // the project's own admin can see who looked
    // switching into a project you actually belong to is not an "entry" worth logging
    await addMember(alpha, superAdmin.id, 'Project Admin');
    await app.inject({ method: 'POST', url: '/api/auth/project', payload: { projectId: alpha }, headers: { cookie: `dm_session=${signSession(superAdmin.id)}` } });
    expect((await pool.query("SELECT count(*)::int n FROM audit_log WHERE action='project.enter' AND actor_id=$1 AND project_id=$2", [superAdmin.id, alpha])).rows[0].n).toBe(0);
    await pool.query('DELETE FROM project_members WHERE project_id=$1 AND user_id=$2', [alpha, superAdmin.id]);
  });
});

describe('the Project Admin tier', () => {
  it('manages members of their own project only, and a project always keeps a Project Admin', async () => {
    const email = `invited-${Date.now()}@corp.com`;
    const cust = await roleId('Customer');
    const added = await call(paA, 'POST', '/api/project/members', { email, name: 'Invited', roleId: cust });
    expect(added.status).toBe(201); expect(added.body.created).toBe(true);
    expect((await call(paA, 'POST', '/api/project/members', { email, roleId: cust })).status).toBe(409);            // already in
    const invited = { id: added.body.userId, email, projectId: alpha, cookie: '', cookieIn: (p: string) => `dm_session=${signSession(added.body.userId)}; ${PROJECT_COOKIE}=${p}` } as TestUser;
    expect((await call(invited, 'GET', '/api/tickets', undefined, alpha)).status).toBe(200);                         // a Customer in Alpha…
    const asked = await call(invited, 'GET', '/api/tickets', undefined, beta);                                      // asking for Beta changes nothing:
    expect(asked.status).toBe(200); expect(asked.body.map((t: any) => t.title)).not.toContain('Beta ticket');         // they stay in Alpha and see no Beta data
    expect((await call(paA, 'PATCH', `/api/project/members/${invited.id}`, { roleId: await roleId('Lead') })).status).toBe(200);
    expect((await call(invited, 'GET', '/api/auth/me', undefined, alpha)).body.user.role).toBe('Lead');
    expect((await call(paA, 'PATCH', `/api/project/members/${custB.id}`, { roleId: cust })).status).toBe(404);       // Beta's people are out of reach
    expect((await call(paA, 'DELETE', `/api/project/members/${custB.id}`)).status).toBe(404);
    expect((await call(paA, 'DELETE', `/api/project/members/${invited.id}`)).status).toBe(200);
    expect((await call(invited, 'GET', '/api/tickets', undefined, alpha)).status).toBe(409);                         // removed: no project left

    expect((await call(paA, 'PATCH', `/api/project/members/${paA.id}`, { roleId: cust })).status).toBe(409);        // the last Project Admin cannot demote or remove themselves
    expect((await call(paA, 'DELETE', `/api/project/members/${paA.id}`)).status).toBe(409);
    expect((await call(consA, 'POST', '/api/project/members', { email: 'x@y.co', roleId: cust })).status).toBe(403);
  });

  it('tunes what a role can do in this project; the other project and the standard role are unaffected; reset restores it', async () => {
    const lead = await roleId('Lead');
    const leadA = await makeUser('Lead', undefined, alpha); const leadB = await makeUser('Lead', undefined, beta);
    const perms = async (p: TestUser) => (await call(p, 'GET', '/api/auth/me', undefined, p.projectId)).body.permissions as string[];
    expect(await perms(leadA)).toContain('ticket.create');
    const std = (await call(paA, 'GET', '/api/project/roles')).body.roles.find((r: any) => r.name === 'Lead');
    expect(std.tuned).toBe(false);
    expect((await call(paA, 'PUT', `/api/project/roles/${lead}/permissions`, { permissions: std.permissions.filter((p: string) => p !== 'ticket.create') })).status).toBe(200);
    expect(await perms(leadA)).not.toContain('ticket.create');                    // Alpha's Leads lost it…
    expect(await perms(leadB)).toContain('ticket.create');                        // …Beta's did not
    expect((await call(admin2(), 'GET', '/api/platform/roles')).body.find((r: any) => r.name === 'Lead').permissions).toContain('ticket.create');   // standard role intact
    expect((await call(leadA, 'POST', '/api/tickets', { title: 'x' })).status).toBe(403);
    expect((await call(paA, 'GET', '/api/project/roles')).body.roles.find((r: any) => r.name === 'Lead').tuned).toBe(true);
    // tuning changes who counts as "able to own tickets" in this project too
    const cust = await roleId('Customer');
    await call(paA, 'PUT', `/api/project/roles/${cust}/permissions`, { permissions: ['board.view', 'ticket.view_own', 'ticket.claim'] });
    expect((await call(paA, 'GET', '/api/users/assignable')).body.map((u: any) => u.id)).toContain(custA.id);
    expect((await call(paB, 'GET', '/api/users/assignable')).body.map((u: any) => u.id)).not.toContain(custB.id);
    expect((await call(paA, 'DELETE', `/api/project/roles/${lead}/permissions`)).status).toBe(200);
    expect((await call(paA, 'DELETE', `/api/project/roles/${cust}/permissions`)).status).toBe(200);
    expect(await perms(leadA)).toContain('ticket.create');
    expect((await call(paA, 'PUT', `/api/project/roles/${await roleId('Project Admin')}/permissions`, { permissions: [] })).status).toBe(400);
    function admin2() { return superAdmin; }
  });

  it('their activity log shows only their project; they cannot read the platform log', async () => {
    const mine = (await call(paA, 'GET', '/api/project/audit')).body;
    expect(mine.length).toBeGreaterThan(0);
    const rows = (await pool.query('SELECT project_id FROM audit_log WHERE id = ANY($1)', [mine.map((m: any) => m.id)])).rows;
    expect(rows.every((r) => r.project_id === alpha)).toBe(true);
    expect((await call(paA, 'GET', '/api/platform/audit')).status).toBe(403);
  });

  it('migration safety: no role template or project role can ever hold a platform permission', async () => {
    const bad = (await pool.query("SELECT permission FROM role_permissions WHERE permission LIKE 'platform.%' OR permission = 'mailbox.view'")).rows;
    expect(bad).toEqual([]);
    expect((await pool.query("SELECT permission FROM project_role_permissions WHERE permission LIKE 'platform.%' OR permission = 'mailbox.view'")).rows).toEqual([]);
  });
});
