import type pg from 'pg';
import { pool } from './db.js';
import { qaGateProblem } from './docs/settings.js';
import { canTransition, type TicketState } from './stateMachine.js';

export async function createTicket(projectId: string, title: string, aiSummary?: string) {
  const { rows } = await pool.query(
    'INSERT INTO tickets (project_id, title, ai_summary) VALUES ($1,$2,$3) RETURNING *',
    [projectId, title, aiSummary ?? null],
  );
  return rows[0];
}

export class TransitionError extends Error {}

/** Steps that may only happen through the document / approval flow, never the generic endpoint. */
const GATED: Record<string, string> = {
  'Requirement Verified->FS Drafted': 'Generate the Functional Specification to move forward',
  'FS Drafted->FS Approved': 'The Functional Specification needs an approval',
  'FS Approved->TS Drafted': 'Generate the Technical Specification to move forward',
  'TS Drafted->TS Approved': 'The Technical Specification needs an approval',
};

/** Locks the ticket and moves it exactly one step. Callers own the transaction. */
export async function applyTransition(client: pg.PoolClient, id: string, to: TicketState, actorId?: string) {
  const cur = await client.query('SELECT current_state FROM tickets WHERE id=$1 FOR UPDATE', [id]);
  if (!cur.rowCount) throw new TransitionError('Ticket not found');
  const from: TicketState = cur.rows[0].current_state;
  if (!canTransition(from, to)) throw new TransitionError(`Illegal transition: ${from} -> ${to}`);
  const { rows } = await client.query('UPDATE tickets SET current_state=$2 WHERE id=$1 RETURNING *', [id, to]);
  if (actorId) await client.query(
    'UPDATE ticket_transitions SET actor_id=$2 WHERE id=(SELECT max(id) FROM ticket_transitions WHERE ticket_id=$1)', [id, actorId]);
  return rows[0];
}

export async function transitionTicket(id: string, to: TicketState, actorId?: string, opts: { internal?: boolean } = {}) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (!opts.internal) {
      const cur = await client.query('SELECT current_state FROM tickets WHERE id=$1', [id]);
      const why = cur.rowCount && GATED[`${cur.rows[0].current_state}->${to}`];
      if (why) throw new TransitionError(why);
      if (cur.rowCount && cur.rows[0].current_state === 'Development' && to === 'QA') { const p = await qaGateProblem(client, id); if (p) throw new TransitionError(p); }
    }
    const t = await applyTransition(client, id, to, actorId);
    await client.query('COMMIT');
    return t;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}
