import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pool } from '../db.js';
import { buildApp } from '../app.js';
import { makeUser } from '../testAuth.js';

const app = buildApp();
let sup: Awaited<ReturnType<typeof makeUser>>;
beforeAll(async () => { await app.ready(); sup = await makeUser('Admin'); });
afterAll(async () => { await app.close(); await pool.end(); });

const call = async (who: { cookie: string }, method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, payload?: unknown) => {
  const r = await app.inject({ method, url, payload: payload as any, headers: { cookie: who.cookie } });
  return { status: r.statusCode, body: r.json() as any };
};
const uniq = () => Math.random().toString(36).slice(2, 7);
async function newProject() {
  const r = await call(sup, 'POST', '/api/platform/projects', { name: `Roles ${uniq()}` });
  const pid = r.body.id as string;
  return { pid, pa: await makeUser('Project Admin', undefined, pid), sup: { cookie: sup.cookieIn(pid) } };
}
const allow = (pid: string, userId: string, enabled = true) => call(sup, 'PUT', `/api/platform/projects/${pid}/admins/${userId}/role-creation`, { enabled });
const rolesOf = async (who: { cookie: string }) => (await call(who, 'GET', '/api/project/roles')).body;
const stdId = async (name: string) => (await pool.query('SELECT id FROM roles WHERE name=$1 AND project_id IS NULL', [name])).rows[0].id as number;

describe('project-owned roles', () => {
  it('a Project Admin cannot create roles until a Super Admin allows that person, and the switch is per person', async () => {
    const { pid, pa } = await newProject();
    const other = await makeUser('Project Admin', undefined, pid);
    expect((await rolesOf(pa)).canCreateRoles).toBe(false);
    expect((await call(pa, 'POST', '/api/project/roles', { name: 'Auditor' })).status).toBe(403);
    expect((await call(pa, 'GET', '/api/auth/me')).body.project.canCreateRoles).toBe(false);

    expect((await call(pa, 'PUT', `/api/platform/projects/${pid}/admins/${pa.id}/role-creation`, { enabled: true })).status).toBe(403);   // only a Super Admin can switch it
    expect((await allow(pid, pa.id)).status).toBe(200);
    expect((await call(pa, 'GET', '/api/auth/me')).body.project.canCreateRoles).toBe(true);
    expect((await call(pa, 'POST', '/api/project/roles', { name: 'Auditor' })).status).toBe(201);
    expect((await call(other, 'POST', '/api/project/roles', { name: 'Reviewer' })).status).toBe(403);                // the other admin was not allowed
    const platform = (await call(sup, 'GET', '/api/platform/projects')).body.find((p: any) => p.id === pid);
    expect(platform.admins.find((a: any) => a.id === pa.id).canCreateRoles).toBe(true);
    expect(platform.admins.find((a: any) => a.id === other.id).canCreateRoles).toBe(false);

    expect((await allow(pid, pa.id, false)).status).toBe(200);                                                      // taken back
    expect((await call(pa, 'POST', '/api/project/roles', { name: 'Second' })).status).toBe(403);
    const consultant = await makeUser('Consultant', undefined, pid);
    expect((await allow(pid, consultant.id)).status).toBe(404);                                                     // only Project Admins can be given it
    expect((await pool.query(`SELECT count(*)::int n FROM audit_log WHERE project_id=$1 AND action='project.role_creation'`, [pid])).rows[0].n).toBe(2);
  });

  it('creates a role (optionally copying one), keeps it private to the project, and the usual tuning works on it', async () => {
    const a = await newProject(), b = await newProject();
    await allow(a.pid, a.pa.id);
    const clash = await call(a.pa, 'POST', '/api/project/roles', { name: 'consultant' });
    expect(clash.status).toBe(409);                                                                                // standard names are taken, in any case
    expect((await call(a.pa, 'POST', '/api/project/roles', { name: 'x' })).status).toBe(400);
    const made = await call(a.pa, 'POST', '/api/project/roles', { name: 'Solution Architect', description: 'Designs the solution', copyFromRoleId: await stdId('Consultant') });
    expect(made.status).toBe(201);
    expect((await call(a.pa, 'POST', '/api/project/roles', { name: 'solution architect' })).status).toBe(409);

    const mine = (await rolesOf(a.pa)).roles.find((r: any) => r.name === 'Solution Architect');
    const consultant = (await rolesOf(a.pa)).roles.find((r: any) => r.name === 'Consultant');
    expect(mine).toMatchObject({ owned: true, members: 0, is_system: false, description: 'Designs the solution' });
    expect(mine.permissions.sort()).toEqual([...consultant.permissions].sort());                                    // started as a copy
    expect(mine.permissions.every((p: string) => !p.startsWith('platform.') && p !== 'mailbox.view')).toBe(true);
    const fields = (await call(a.pa, 'GET', '/api/project/ticket-fields')).body.roles.find((r: any) => r.name === 'Solution Architect');
    expect(fields.access).toEqual((await call(a.pa, 'GET', '/api/project/ticket-fields')).body.roles.find((r: any) => r.name === 'Consultant').access);

    // private to its project
    expect((await rolesOf(b.pa)).roles.some((r: any) => r.name === 'Solution Architect')).toBe(false);
    expect(((await call(sup, 'GET', '/api/platform/roles')).body as any[]).some((r) => r.name === 'Solution Architect')).toBe(false);
    expect((await call(b.pa, 'PUT', `/api/project/roles/${mine.id}/permissions`, { permissions: ['board.view'] })).status).toBe(404);
    expect((await call(b.pa, 'POST', '/api/project/members', { email: `x${uniq()}@corp.com`, roleId: mine.id })).status).toBe(404);
    expect((await call(b.pa, 'DELETE', `/api/project/roles/${mine.id}`)).status).toBe(403);                         // b is not allowed to create roles at all
    await allow(b.pid, b.pa.id);
    expect((await call(b.pa, 'DELETE', `/api/project/roles/${mine.id}`)).status).toBe(404);                         // and cannot touch a's role even when allowed
    expect((await call(b.pa, 'GET', '/api/project/workflows/options')).body.roles.some((r: any) => r.name === 'Solution Architect')).toBe(false);
    expect((await call(a.pa, 'GET', '/api/project/workflows/options')).body.roles.some((r: any) => r.name === 'Solution Architect')).toBe(true);
    expect((await call(sup, 'PUT', '/api/platform/roles/' + mine.id + '/permissions', { permissions: ['board.view'] })).status).toBe(404);   // the platform catalog does not manage project roles

    // the role works like any other: tune it, give it to someone, they get exactly that
    expect((await call(a.pa, 'PUT', `/api/project/roles/${mine.id}/permissions`, { permissions: ['board.view', 'ticket.view_all'] })).status).toBe(200);
    expect((await call(a.pa, 'PUT', `/api/project/roles/${mine.id}/permissions`, { permissions: ['platform.users'] })).status).toBe(400);     // platform powers can never be given
    const added = await call(a.pa, 'POST', '/api/project/members', { email: `arch${uniq()}@corp.com`, firstName: 'Ari', roleId: mine.id });
    expect(added.status).toBe(201);
    expect((await call(a.pa, 'GET', `/api/project/members/${added.body.userId}`)).body.role).toBe('Solution Architect');
  });

  it('can be renamed and deleted by its creator; deletion is refused while the role is in use; standard roles are not touched', async () => {
    const { pid, pa } = await newProject();
    await allow(pid, pa.id);
    const id = (await call(pa, 'POST', '/api/project/roles', { name: 'Tester' })).body.id as number;
    expect((await call(pa, 'PATCH', `/api/project/roles/${id}`, { name: 'QA Tester', description: 'Tests things' })).status).toBe(200);
    expect((await call(pa, 'PATCH', `/api/project/roles/${id}`, { name: 'Lead' })).status).toBe(409);
    expect((await rolesOf(pa)).roles.find((r: any) => r.id === id)).toMatchObject({ name: 'QA Tester', description: 'Tests things' });
    const std = await stdId('Consultant');
    for (const [m, u] of [['PATCH', `/api/project/roles/${std}`], ['DELETE', `/api/project/roles/${std}`]] as const) expect((await call(pa, m, u, m === 'PATCH' ? { name: 'Hacked' } : undefined)).status).toBe(400);

    const person = await call(pa, 'POST', '/api/project/members', { email: `t${uniq()}@corp.com`, firstName: 'Tess', roleId: id });
    const blocked = await call(pa, 'DELETE', `/api/project/roles/${id}`);
    expect(blocked.status).toBe(409); expect(blocked.body.error).toMatch(/holds this role/);
    await call(pa, 'PATCH', `/api/project/members/${person.body.userId}`, { roleId: std });
    expect((await call(pa, 'DELETE', `/api/project/roles/${id}`)).status).toBe(200);
    expect((await rolesOf(pa)).roles.some((r: any) => r.id === id)).toBe(false);
    expect((await pool.query('SELECT count(*)::int n FROM role_permissions WHERE role_id=$1', [id])).rows[0].n).toBe(0);
  });

  it('is removed with its project, and a role in an approval workflow cannot be deleted', async () => {
    const { pid, pa } = await newProject();
    await allow(pid, pa.id);
    const id = (await call(pa, 'POST', '/api/project/roles', { name: 'Signer' })).body.id as number;
    const wf = await call(pa, 'POST', '/api/project/workflows', { name: 'Sign-off', kinds: ['FS'], active: false, levels: [{ name: 'L1', rule: 'any', approvers: [{ kind: 'role', id }] }] });
    expect(wf.status).toBe(201);
    const blocked = await call(pa, 'DELETE', `/api/project/roles/${id}`);
    expect(blocked.status).toBe(409); expect(blocked.body.error).toMatch(/approval workflow/);
    await pool.query('DELETE FROM approval_workflows WHERE project_id=$1', [pid]);
    await pool.query('DELETE FROM projects WHERE id=$1', [pid]);
    expect((await pool.query('SELECT count(*)::int n FROM roles WHERE id=$1', [id])).rows[0].n).toBe(0);
  });
});
