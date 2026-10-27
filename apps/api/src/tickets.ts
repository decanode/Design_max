import { pool } from './db.js';
import { canTransition, type TicketState } from './stateMachine.js';

export async function createTicket(projectId: string, title: string, aiSummary?: string) {
  const { rows } = await pool.query(
    'INSERT INTO tickets (project_id, title, ai_summary) VALUES ($1,$2,$3) RETURNING *',
    [projectId, title, aiSummary ?? null],
  );
  return rows[0];
}

export class TransitionError extends Error {}

export async function transitionTicket(id: string, to: TicketState, actorId?: string) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const cur = await client.query('SELECT current_state FROM tickets WHERE id=$1 FOR UPDATE', [id]);
    if (!cur.rowCount) throw new TransitionError('Ticket not found');
    if (!canTransition(cur.rows[0].current_state, to))
      throw new TransitionError(`Illegal transition: ${cur.rows[0].current_state} -> ${to}`);
    const { rows } = await client.query('UPDATE tickets SET current_state=$2 WHERE id=$1 RETURNING *', [id, to]);
    if (actorId) await client.query(
      'UPDATE ticket_transitions SET actor_id=$2 WHERE id=(SELECT max(id) FROM ticket_transitions WHERE ticket_id=$1)', [id, actorId]);
    await client.query('COMMIT');
    return rows[0];
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}
