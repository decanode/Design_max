import { describe, it, expect, afterAll } from 'vitest';
import { pool } from './db.js';
import { createTicket, transitionTicket } from './tickets.js';

afterAll(() => pool.end());

const WATERFALL = ['Requirement Verified', 'FS Drafted', 'FS Approved', 'TS Drafted', 'TS Approved', 'Development', 'QA', 'UAT', 'Deployed'];

describe('ticket lifecycle (DB-enforced)', () => {
  it('walks the original lifecycle in a default project and logs transitions', async () => {
    const p = await pool.query("INSERT INTO projects(name) VALUES('t') RETURNING id");
    const t = await createTicket(p.rows[0].id, 'lifecycle');
    expect(t.current_state).toBe(WATERFALL[0]);
    for (const s of WATERFALL.slice(1)) await transitionTicket(t.id, s, undefined, { internal: true });
    const log = await pool.query('SELECT count(*)::int c FROM ticket_transitions WHERE ticket_id=$1', [t.id]);
    expect(log.rows[0].c).toBe(WATERFALL.length);
  });
  it('rejects skipping states at the database level', async () => {
    const p = await pool.query("INSERT INTO projects(name) VALUES('t') RETURNING id");
    const t = await createTicket(p.rows[0].id, 'skip');
    await expect(pool.query("UPDATE tickets SET current_state='Deployed' WHERE id=$1", [t.id])).rejects.toThrow(/Illegal state transition/);
  });
});
