import type pg from 'pg';
import { pool } from './db.js';
import { qaGateProblem } from './docs/settings.js';
import { DocError } from './errors.js';
import { findTicketWorkflow, openTicketApproval } from './approvals/engine.js';
import { OutboxMailer, type Mail, type Mailer } from './docs/mailer.js';
import { nextPhases, resolveTicketType, typeFields, validateMetadata } from './workflow/service.js';

/** A phase name. Which phases exist, and which moves are legal, is configured per project (see workflow/service.ts). */
export type TicketState = string;

export interface CreateOpts { ticketTypeId?: number; dynamicMetadata?: unknown; requesterId?: string | null; mailer?: Mailer; appUrl?: string }

/**
 * Creates a ticket. If the project has an approval workflow for this kind of ticket, the ticket and its approval request are created
 * together and the ticket waits (approval_status 'pending') until every level signs off.
 */
export async function createTicket(projectId: string, title: string, aiSummary?: string, opts: CreateOpts = {}) {
  const type = await resolveTicketType(projectId, opts.ticketTypeId);
  if (!(await nextPhases(projectId, type.id, null)).length) throw new DocError(`${type.name} tickets have no starting phase in this project's workflow`, 409);
  const metadata = validateMetadata((await typeFields()).get(type.id) ?? [], opts.dynamicMetadata ?? {});   // checked against the type's form definition
  const insert = 'INSERT INTO tickets (project_id, title, ai_summary, ticket_type_id, dynamic_metadata) VALUES ($1,$2,$3,$4,$5) RETURNING *';
  const args = [projectId, title, aiSummary ?? null, type.id, JSON.stringify(metadata)];   // the starting phase is the type's entry phase (database default)
  if (!(await findTicketWorkflow(pool, projectId, type.id))) return (await pool.query(insert, args)).rows[0];

  const c = await pool.connect();
  let mails: Mail[] = [];
  try {
    await c.query('BEGIN');
    const wf = await findTicketWorkflow(c, projectId, type.id);
    let ticket = (await c.query(insert, args)).rows[0];
    if (wf) {
      mails = (await openTicketApproval(c, ticket, wf, opts.requesterId ?? null, opts.appUrl ?? process.env.APP_URL ?? 'http://localhost:3000')).mails;
      ticket = (await c.query('SELECT * FROM tickets WHERE id=$1', [ticket.id])).rows[0];
    }
    await c.query('COMMIT');
    for (const m of mails) await (opts.mailer ?? new OutboxMailer()).send(m);
    return ticket;
  } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
}

export class TransitionError extends Error {}

/** Locks the ticket and moves it along one legal step of its project's workflow. Callers own the transaction. */
export async function applyTransition(client: pg.PoolClient, id: string, to: TicketState, actorId?: string) {
  const cur = await client.query('SELECT current_state, project_id, ticket_type_id, approval_status FROM tickets WHERE id=$1 FOR UPDATE', [id]);
  if (!cur.rowCount) throw new TransitionError('Ticket not found');
  const { current_state: from, project_id, ticket_type_id, approval_status } = cur.rows[0];
  if (approval_status === 'pending' || approval_status === 'rejected') throw new TransitionError(approval_status === 'pending' ? 'This ticket is waiting for approval' : 'This ticket was not approved. Send it for approval again first');
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
