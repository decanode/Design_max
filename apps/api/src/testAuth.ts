import { pool } from './db.js';
import { signSession } from './rbac/auth.js';

/** Creates a user with the given role and returns their id and a ready-to-send session cookie. */
export async function makeUser(role: string, tag = Math.random().toString(36).slice(2, 8)) {
  const email = `${role.toLowerCase().replace(/\W/g, '')}-${tag}@test.dev`;
  const { rows } = await pool.query(
    `INSERT INTO users (email, display_name, role_id) VALUES ($1,$2,(SELECT id FROM roles WHERE name=$3)) RETURNING id`, [email, `${role} ${tag}`, role]);
  return { id: rows[0].id as string, email, cookie: `dm_session=${signSession(rows[0].id)}` };
}

export interface TestLevel { name?: string; rule?: 'any' | 'all'; users?: string[]; roles?: string[] }

/** Inserts an approval workflow directly (tests need precise control over who approves). Returns its id. */
export async function makeWorkflow(o: { name?: string; projectId: string | null; kinds?: string[]; levels: TestLevel[]; active?: boolean }) {
  const id = (await pool.query('INSERT INTO approval_workflows (name, kinds, project_id, active) VALUES ($1,$2,$3,$4) RETURNING id',
    [o.name ?? `wf-${Math.random().toString(36).slice(2, 7)}`, o.kinds ?? ['FS', 'TS'], o.projectId, o.active ?? true])).rows[0].id as string;
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
