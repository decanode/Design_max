import type pg from 'pg';
import { pool } from './db.js';
import { qaGateProblem } from './docs/settings.js';
import { DocError } from './errors.js';
import { nextPhases, resolveTicketType, typeFields, validateMetadata } from './workflow/service.js';

/** A phase name. Which phases exist, and which moves are legal, is configured per project (see workflow/service.ts). */
export type TicketState = string;

export async function createTicket(projectId: string, title: string, aiSummary?: string, opts: { ticketTypeId?: number; dynamicMetadata?: unknown } = {}) {
  const type = await resolveTicketType(projectId, opts.ticketTypeId);
  if (!(await nextPhases(projectId, type.id, null)).length) throw new DocError(`${type.name} tickets have no starting phase in this project's workflow`, 409);
  const metadata = validateMetadata((await typeFields()).get(type.id) ?? [], opts.dynamicMetadata ?? {});   // checked against the type's form definition
  const { rows } = await pool.query(
    'INSERT INTO tickets (project_id, title, ai_summary, ticket_type_id, dynamic_metadata) VALUES ($1,$2,$3,$4,$5) RETURNING *',
    [projectId, title, aiSummary ?? null, type.id, JSON.stringify(metadata)],   // the starting phase is the type's entry phase (database default)
  );
  return rows[0];
}

export class TransitionError extends Error {}

/** Locks the ticket and moves it along one legal step of its project's workflow. Callers own the transaction. */
export async function applyTransition(client: pg.PoolClient, id: string, to: TicketState, actorId?: string) {
  const cur = await client.query('SELECT current_state, project_id, ticket_type_id FROM tickets WHERE id=$1 FOR UPDATE', [id]);
  if (!cur.rowCount) throw new TransitionError('Ticket not found');
  const { current_state: from, project_id, ticket_type_id } = cur.rows[0];
  if (!(await nextPhases(project_id, ticket_type_id, from, client)).some((n) => n.to === to)) throw new TransitionError(`Illegal transition: ${from} -> ${to}`);
  const { rows } = await client.query('UPDATE tickets SET current_state=$2 WHERE id=$1 RETURNING *', [id, to]);   // the database checks the same rule
  if (actorId) await client.query(
    'UPDATE ticket_transitions SET actor_id=$2 WHERE id=(SELECT max(id) FROM ticket_transitions WHERE ticket_id=$1)', [id, actorId]);
  return rows[0];
}

export async function transitionTicket(id: string, to: TicketState, actorId?: string, opts: { internal?: boolean } = {}) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (!opts.internal) {
      const cur = await client.query('SELECT current_state, project_id, ticket_type_id FROM tickets WHERE id=$1', [id]);
      if (cur.rowCount) {
        const { current_state: from, project_id, ticket_type_id } = cur.rows[0];
        const step = (await nextPhases(project_id, ticket_type_id, from, client)).find((n) => n.to === to);
        if (step?.gated) throw new TransitionError(step.gated);      // steps that only the document / approval flow may take
        if (from === 'Development' && to === 'QA') { const p = await qaGateProblem(client, id); if (p) throw new TransitionError(p); }
      }
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
