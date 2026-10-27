import { pool } from './db.js';
import { signSession } from './rbac/auth.js';

/** Creates a user with the given role and returns their id and a ready-to-send session cookie. */
export async function makeUser(role: string, tag = Math.random().toString(36).slice(2, 8)) {
  const email = `${role.toLowerCase().replace(/\W/g, '')}-${tag}@test.dev`;
  const { rows } = await pool.query(
    `INSERT INTO users (email, display_name, role_id) VALUES ($1,$2,(SELECT id FROM roles WHERE name=$3)) RETURNING id`, [email, `${role} ${tag}`, role]);
  return { id: rows[0].id as string, email, cookie: `dm_session=${signSession(rows[0].id)}` };
}
