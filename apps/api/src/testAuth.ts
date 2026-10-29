import { pool } from './db.js';
import { PROJECT_COOKIE, signSession } from './rbac/auth.js';

/** A project for tests: plain row, no template workflows (tests that need approvals add their own). One per test file by default. */
export async function makeProject(name = `P-${Math.random().toString(36).slice(2, 8)}`): Promise<string> {
  return (await pool.query('INSERT INTO projects (name) VALUES ($1) RETURNING id', [name])).rows[0].id as string;
}
let shared: Promise<string> | undefined;
/** The project every helper uses unless told otherwise (memoised per test file, since vitest isolates modules per file). */
export const testProject = () => (shared ??= makeProject(`Test ${Math.random().toString(36).slice(2, 6)}`));

export interface TestUser { id: string; email: string; cookie: string; projectId: string; cookieIn: (projectId: string) => string }
const cookieFor = (userId: string, projectId: string) => `dm_session=${signSession(userId)}; ${PROJECT_COOKIE}=${projectId}`;
const wrap = (id: string, email: string, projectId: string): TestUser => ({ id, email, projectId, cookie: cookieFor(id, projectId), cookieIn: (p) => cookieFor(id, p) });

/**
 * Creates a user. 'Admin' / 'Super Admin' makes a Super Admin (not a member of anything; acts inside `projectId`).
 * Any other role name makes a member of `projectId` (default: this file's test project) holding that role.
 */
export async function makeUser(role: string, tag = Math.random().toString(36).slice(2, 8), projectId?: string): Promise<TestUser> {
  const pid = projectId ?? (await testProject());
  const sup = role === 'Admin' || role === 'Super Admin';
  const email = `${role.toLowerCase().replace(/\W/g, '')}-${tag}@test.dev`;
  const id = (await pool.query('INSERT INTO users (email, display_name, is_super_admin) VALUES ($1,$2,$3) RETURNING id', [email, `${role} ${tag}`, sup])).rows[0].id as string;
  if (!sup) await addMember(pid, id, role);
  return wrap(id, email, pid);
}

export async function addMember(projectId: string, userId: string, role: string) {
  await pool.query(`INSERT INTO project_members (project_id, user_id, role_id) SELECT $1,$2,id FROM roles WHERE name=$3
                    ON CONFLICT (project_id, user_id) DO UPDATE SET role_id = EXCLUDED.role_id`, [projectId, userId, role]);
}

/** A member of `projectId` in a brand-new custom role with exactly these permissions and ticket-field access. */
export async function makeCustomUser(perms: string[], access: Record<string, 'hidden' | 'read' | 'write'> = {}, projectId?: string) {
  const pid = projectId ?? (await testProject());
  const rid = (await pool.query('INSERT INTO roles (name) VALUES ($1) RETURNING id', [`Custom ${Math.random().toString(36).slice(2, 8)}`])).rows[0].id as number;
  if (perms.length) await pool.query('INSERT INTO role_permissions (role_id, permission) SELECT $1, unnest($2::text[])', [rid, perms]);
  for (const [f, a] of Object.entries(access)) await pool.query('INSERT INTO ticket_field_access (role_id, field, access) VALUES ($1,$2,$3)', [rid, f, a]);
  const email = `c${Math.random().toString(36).slice(2, 8)}@t.dev`;
  const id = (await pool.query('INSERT INTO users (email, display_name) VALUES ($1,$2) RETURNING id', [email, 'Custom user'])).rows[0].id as string;
  await pool.query('INSERT INTO project_members (project_id, user_id, role_id) VALUES ($1,$2,$3)', [pid, id, rid]);
  return { ...wrap(id, email, pid), roleId: rid };
}

export interface TestLevel { name?: string; rule?: 'any' | 'all'; users?: string[]; roles?: string[] }

/** Inserts an approval workflow for a project directly (tests need precise control over who approves). Returns its id. */
export async function makeWorkflow(o: { name?: string; projectId: string; kinds?: string[]; ticketTypes?: 'all-enabled' | number[]; levels: TestLevel[]; active?: boolean }) {
  const types = o.ticketTypes === 'all-enabled'
    ? (await pool.query('SELECT ticket_type_id FROM project_ticket_types WHERE project_id=$1 AND enabled', [o.projectId])).rows.map((r) => r.ticket_type_id as number) : (o.ticketTypes ?? []);
  const id = (await pool.query('INSERT INTO approval_workflows (name, kinds, ticket_type_ids, project_id, active) VALUES ($1,$2,$3,$4,$5) RETURNING id',
    [o.name ?? `wf-${Math.random().toString(36).slice(2, 7)}`, o.kinds ?? ['FS', 'TS'], types, o.projectId, o.active ?? true])).rows[0].id as string;
  for (const [i, l] of o.levels.entries()) {
    const lid = (await pool.query('INSERT INTO approval_levels (workflow_id, position, name, rule) VALUES ($1,$2,$3,$4) RETURNING id', [id, i + 1, l.name ?? `L${i + 1}`, l.rule ?? 'any'])).rows[0].id;
    for (const u of l.users ?? []) await pool.query(`INSERT INTO approval_level_approvers (level_id, kind, user_id) VALUES ($1,'user',$2)`, [lid, u]);
    for (const r of l.roles ?? []) await pool.query(`INSERT INTO approval_level_approvers (level_id, kind, role_id) SELECT $1,'role',id FROM roles WHERE name=$2`, [lid, r]);
  }
  return id;
}

/** The emailed approval link token most recently sent to `email` whose subject mentions `titlePart`. */
export async function tokenSentTo(email: string, titlePart = '') {
  const m = (await pool.query(`SELECT body FROM email_outbox WHERE to_email=$1 AND subject LIKE $2 AND body LIKE '%/approve/%' ORDER BY id DESC LIMIT 1`, [email, `%${titlePart}%`])).rows[0];
  return m ? (m.body.match(/\/approve\/([\w-]+)/)![1] as string) : null;
}
