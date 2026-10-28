import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pool } from '../db.js';
import { buildApp } from '../app.js';
import { makeUser, makeCustomUser } from '../testAuth.js';

const app = buildApp();
let sup: Awaited<ReturnType<typeof makeUser>>;
beforeAll(async () => { await app.ready(); sup = await makeUser('Admin'); });
afterAll(async () => { await app.close(); await pool.end(); });

const call = async (who: { cookie: string }, method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, payload?: unknown) => {
  const r = await app.inject({ method, url, payload: payload as any, headers: { cookie: who.cookie } });
  return { status: r.statusCode, body: r.json() as any };
};
const roleId = async (name: string) => (await pool.query('SELECT id FROM roles WHERE name=$1', [name])).rows[0].id as number;
const uniq = () => Math.random().toString(36).slice(2, 8);
async function newProject() {
  const r = await call(sup, 'POST', '/api/platform/projects', { name: `People ${uniq()}` });
  return { pid: r.body.id as string, admin: await makeUser('Admin', undefined, r.body.id) };
}
const add = (admin: any, o: Record<string, unknown> = {}) => call(admin, 'POST', '/api/project/members', { email: `p${uniq()}@corp.com`, firstName: 'Priya', lastName: 'Nair', roleId: undefined, ...o });

describe('member profiles', () => {
  it('creates a person with the full profile, derives names and a user ID, and lists everything the table needs', async () => {
    const { admin } = await newProject();
    const r = await add(admin, { email: `Priya.Nair${uniq()}@Corp.com`, firstName: 'Priya', lastName: 'Nair', userId: `pnair${uniq()}`, phone: '+91 98765 43210', mobile: '+91 91234 56789', jobTitle: 'SAP MM Consultant', department: 'Procurement',
      company: 'Acme', location: 'Chennai', employeeId: 'E-1042', costCenter: 'CC-77', timeZone: 'Asia/Kolkata', language: 'en-GB', notes: 'Joins in March', roleId: await roleId('Consultant') });
    expect(r.status).toBe(201); expect(r.body.created).toBe(true);
    const list = (await call(admin, 'GET', '/api/project/members')).body as any[];
    const m = list.find((x) => x.id === r.body.userId);
    expect(m).toMatchObject({ first_name: 'Priya', last_name: 'Nair', name: 'Priya Nair', phone: '+91 98765 43210', job_title: 'SAP MM Consultant', department: 'Procurement', location: 'Chennai', time_zone: 'Asia/Kolkata', role: 'Consultant', teams: [], open_tickets: 0, projects: 1 });
    expect(m.email).toMatch(/@corp\.com$/); expect(m.email).toBe(m.email.toLowerCase());
    const detail = (await call(admin, 'GET', `/api/project/members/${r.body.userId}`)).body;
    expect(detail).toMatchObject({ notes: 'Joins in March', canEditIdentity: true, employee_id: 'E-1042' });
    // the old shape still works: just an email, a name and a role
    const old = await call(admin, 'POST', '/api/project/members', { email: `old${uniq()}@corp.com`, name: 'Olga Old Person', roleId: await roleId('Lead') });
    expect(old.status).toBe(201);
    const o = ((await call(admin, 'GET', '/api/project/members')).body as any[]).find((x) => x.id === old.body.userId);
    expect(o).toMatchObject({ first_name: 'Olga', last_name: 'Old Person', name: 'Olga Old Person' }); expect(o.user_id).toMatch(/^old/);
  });

  it('validates the fields and keeps user IDs and emails unique', async () => {
    const { admin } = await newProject();
    const role = await roleId('Consultant');
    const bad = async (o: Record<string, unknown>, field?: string) => { const r = await add(admin, { roleId: role, ...o }); expect(r.status).toBe(400); if (field) expect(JSON.stringify(r.body.details)).toContain(field); };
    await bad({ firstName: '' }, 'firstName');
    await bad({ phone: 'call me' }, 'phone'); await bad({ timeZone: 'Mars/Olympus' }, 'timeZone'); await bad({ language: 'English' }, 'language'); await bad({ userId: 'a b' }, 'userId'); await bad({ email: 'nope' }, 'email');
    const id = `dup${uniq()}`;
    expect((await add(admin, { roleId: role, userId: id })).status).toBe(201);
    const clash = await add(admin, { roleId: role, userId: id.toUpperCase() });          // case-insensitive
    expect(clash.status).toBe(409); expect(clash.body.error).toMatch(/user ID is already taken/);
    const email = `same${uniq()}@corp.com`;
    await add(admin, { roleId: role, email });
    expect((await add(admin, { roleId: role, email })).status).toBe(409);               // already in this project
  });

  it('edits a profile, composes the display name, clears fields, and logs which fields (not values) changed', async () => {
    const { admin, pid } = await newProject();
    const id = (await add(admin, { roleId: await roleId('Consultant') })).body.userId;
    const mgr = (await add(admin, { roleId: await roleId('Lead'), firstName: 'Mo', lastName: 'Manager' })).body.userId;
    const r = await call(admin, 'PATCH', `/api/project/members/${id}`, { firstName: 'Priyanka', phone: '+44 20 7946 0000', jobTitle: 'Lead Consultant', managerId: mgr, timeZone: 'Europe/London' });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ name: 'Priyanka Nair', first_name: 'Priyanka', job_title: 'Lead Consultant', manager_name: 'Mo Manager' });
    expect((await call(admin, 'PATCH', `/api/project/members/${id}`, { jobTitle: '', phone: '' })).body).toMatchObject({ job_title: null, phone: null });
    expect((await call(admin, 'PATCH', `/api/project/members/${id}`, { managerId: id })).status).toBe(400);                     // not their own manager
    const stranger = (await makeUser('Consultant', undefined, (await newProject()).pid)).id;
    expect((await call(admin, 'PATCH', `/api/project/members/${id}`, { managerId: stranger })).status).toBe(400);               // must be in this project
    expect((await call(admin, 'PATCH', `/api/project/members/${id}`, { isSuperAdmin: true })).status).toBe(400);                  // unknown fields are refused
    const log = (await pool.query(`SELECT detail FROM audit_log WHERE project_id=$1 AND action='member.update' ORDER BY id`, [pid])).rows.map((r) => r.detail);
    expect(JSON.stringify(log)).toContain('phone'); expect(JSON.stringify(log)).not.toContain('44 20');
  });

  it('protects identity: email and user ID of a person in several projects can only change by a Super Admin', async () => {
    const a = await newProject(), b = await newProject();
    const role = await roleId('Consultant');
    const shared = `shared${uniq()}@corp.com`;
    const id = (await add(a.admin, { email: shared, roleId: role })).body.userId;
    await call(b.admin, 'POST', '/api/project/members', { email: shared, roleId: role });          // the same person joins a second project
    const pa = await makeUser('Project Admin', undefined, a.pid);
    const detail = (await call(pa, 'GET', `/api/project/members/${id}`)).body;
    expect(detail).toMatchObject({ projects: 2, canEditIdentity: false });
    expect((await call(pa, 'PATCH', `/api/project/members/${id}`, { email: `new${uniq()}@corp.com` })).status).toBe(403);
    expect((await call(pa, 'PATCH', `/api/project/members/${id}`, { jobTitle: 'Architect' })).status).toBe(200);                 // other details are fine
    expect((await call({ cookie: sup.cookieIn(a.pid) }, 'PATCH', `/api/project/members/${id}`, { userId: `renamed${uniq()}` })).status).toBe(200);
    // someone in only this project can have it changed by their project admin
    const solo = (await add(a.admin, { roleId: role })).body.userId;
    expect((await call(pa, 'PATCH', `/api/project/members/${solo}`, { userId: `solo${uniq()}` })).status).toBe(200);
    // an existing account joining does not get its profile overwritten by the admin who adds it
    const keep = `keep${uniq()}@corp.com`;
    const k = (await add(a.admin, { email: keep, roleId: role, firstName: 'Original', lastName: 'Name' })).body.userId;
    await call(b.admin, 'POST', '/api/project/members', { email: keep, roleId: role, firstName: 'Hijack', lastName: 'Attempt' });
    expect(((await call(a.admin, 'GET', `/api/project/members/${k}`)).body).name).toBe('Original Name');
  });

  it('keeps one Project Admin and is limited to people who may manage members, within the project', async () => {
    const { admin, pid } = await newProject();
    const pa = await makeUser('Project Admin', undefined, pid);
    const plain = await makeCustomUser(['board.view'], {}, pid);
    expect((await call(plain, 'GET', '/api/project/members')).status).toBe(403);
    expect((await call(admin, 'PATCH', `/api/project/members/${pa.id}`, { roleId: await roleId('Consultant') })).status).toBe(409);      // the last Project Admin cannot be demoted
    expect((await call(admin, 'DELETE', `/api/project/members/${pa.id}`)).status).toBe(409);
    const other = await newProject();
    expect((await call(other.admin, 'GET', `/api/project/members/${pa.id}`)).status).toBe(404);                                           // not in that project
  });
});

describe('teams and team-based ticket access', () => {
  it('creates teams, puts people in them from either side, and clears them when someone leaves', async () => {
    const { admin, pid } = await newProject();
    const role = await roleId('Consultant');
    const ann = (await add(admin, { roleId: role, firstName: 'Ann', lastName: 'A' })).body.userId, bob = (await add(admin, { roleId: role, firstName: 'Bob', lastName: 'B' })).body.userId;
    const t = await call(admin, 'POST', '/api/project/teams', { name: 'Finance', description: 'FICO team', leadId: ann, memberIds: [bob] });
    expect(t.status).toBe(201);
    const fin = t.body.teams.find((x: any) => x.name === 'Finance');
    expect(fin.members.map((m: any) => m.name)).toEqual(['Ann A', 'Bob B']);          // the lead is a member too
    expect(fin).toMatchObject({ lead_name: 'Ann A', tickets: 0 });
    expect((await call(admin, 'POST', '/api/project/teams', { name: 'finance' })).status).toBe(409);
    expect((await call(admin, 'POST', '/api/project/teams', { name: 'Ghosts', memberIds: [(await makeUser('Consultant', undefined, (await newProject()).pid)).id] })).status).toBe(400);
    // from the member's side
    const sales = (await call(admin, 'POST', '/api/project/teams', { name: 'Sales' })).body.id;
    const m = await call(admin, 'PATCH', `/api/project/members/${bob}`, { teamIds: [fin.id, sales] });
    expect(m.body.teams.map((x: any) => x.name)).toEqual(['Finance', 'Sales']);
    expect((await call(admin, 'PATCH', `/api/project/members/${bob}`, { teamIds: [(await call(admin, 'GET', '/api/project/teams')).body[0].id, '00000000-0000-4000-8000-000000000000'] })).status).toBe(400);
    // leaving the project means leaving the teams (and the lead seat)
    await call(admin, 'DELETE', `/api/project/members/${ann}`);
    const after = (await call(admin, 'GET', '/api/project/teams')).body.find((x: any) => x.name === 'Finance');
    expect(after.members.map((x: any) => x.name)).toEqual(['Bob B']); expect(after.lead_id).toBeNull();
    expect((await pool.query('SELECT count(*)::int n FROM team_members WHERE project_id=$1', [pid])).rows[0].n).toBe(2);
  });

  it('lets team members see and work the tickets of their team, and nobody else’s', async () => {
    const { admin, pid } = await newProject();
    const role = await roleId('Consultant');
    const insider = await makeUser('Consultant', 'in', pid), outsider = await makeUser('Consultant', 'out', pid);
    for (const u of [insider, outsider]) await pool.query('UPDATE project_members SET role_id=$3 WHERE project_id=$1 AND user_id=$2', [pid, u.id, role]);
    const team = (await call(admin, 'POST', '/api/project/teams', { name: 'Procurement', memberIds: [insider.id] })).body.id;
    const mk = async (title: string, teamId: string | null) => (await pool.query('INSERT INTO tickets (project_id, title, team_id) VALUES ($1,$2,$3) RETURNING id', [pid, title, teamId])).rows[0].id as string;
    const mine = await mk('Team ticket', team), other = await mk('Nobody’s ticket', null);
    await pool.query('UPDATE tickets SET consultant_id = NULL WHERE project_id=$1', [pid]);
    const titles = async (u: any) => ((await call(u, 'GET', '/api/tickets')).body as any[]).map((t) => t.title).sort();
    // the Consultant role also sees the unassigned queue, so give the others an owner to isolate the team rule
    const owner = await makeUser('Lead', 'own', pid);
    await pool.query('UPDATE tickets SET consultant_id=$2 WHERE project_id=$1', [pid, owner.id]);
    expect(await titles(insider)).toEqual(['Team ticket']);
    expect(await titles(outsider)).toEqual([]);
    expect((await call(outsider, 'GET', `/api/tickets/${mine}`)).status).toBe(404);
    expect((await call(insider, 'GET', `/api/tickets/${mine}`)).status).toBe(200);
    expect((await call(insider, 'GET', `/api/tickets/${other}`)).status).toBe(404);
    expect((await call(insider, 'PATCH', `/api/tickets/${mine}`, { aiSummary: 'Edited by the team' })).status).toBe(200);          // the role's field access still decides what may change
    expect((await call(outsider, 'PATCH', `/api/tickets/${mine}`, { aiSummary: 'x' })).status).toBe(404);
    // removing the permission removes the access, adding someone to the team grants it
    await pool.query(`DELETE FROM role_permissions WHERE role_id=$1 AND permission='ticket.team_access'`, [role]);
    expect(await titles(insider)).toEqual([]);
    await pool.query(`INSERT INTO role_permissions (role_id, permission) VALUES ($1,'ticket.team_access')`, [role]);
    await call(admin, 'PATCH', `/api/project/members/${outsider.id}`, { teamIds: [team] });
    expect(await titles(outsider)).toEqual(['Team ticket']);
  });

  it('assigns a ticket to a team (only a team of its own project) and shows the team on the board', async () => {
    const a = await newProject(), b = await newProject();
    const team = (await call(a.admin, 'POST', '/api/project/teams', { name: 'Support' })).body.id;
    const foreign = (await call(b.admin, 'POST', '/api/project/teams', { name: 'Foreign' })).body.id;
    const t = (await call(a.admin, 'POST', '/api/tickets', { title: 'Needs a team' })).body.id;
    expect((await call(a.admin, 'POST', `/api/tickets/${t}/team`, { teamId: foreign })).status).toBe(400);
    expect((await call(a.admin, 'POST', `/api/tickets/${t}/team`, { teamId: team })).status).toBe(200);
    expect(((await call(a.admin, 'GET', '/api/tickets')).body as any[]).find((x) => x.id === t).team_name).toBe('Support');
    expect((await call(a.admin, 'GET', `/api/tickets/${t}`)).body.ticket.team_name).toBe('Support');
    expect((await call(a.admin, 'GET', '/api/project/team-options')).body.map((x: any) => x.name)).toEqual(['Support']);
    await expect(pool.query('UPDATE tickets SET team_id=$2 WHERE id=$1', [t, foreign])).rejects.toThrow(/another project/);        // the database says so too
    expect((await call(a.admin, 'POST', `/api/tickets/${t}/team`, { teamId: null })).status).toBe(200);
    // deleting a team leaves its tickets, unassigned from it
    await call(a.admin, 'POST', `/api/tickets/${t}/team`, { teamId: team });
    expect((await call(a.admin, 'DELETE', `/api/project/teams/${team}`)).status).toBe(200);
    expect((await pool.query('SELECT team_id FROM tickets WHERE id=$1', [t])).rows[0].team_id).toBeNull();
  });
});
