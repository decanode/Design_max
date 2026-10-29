import type pg from 'pg';
import { pool } from './db.js';
import { qaGateProblem } from './docs/settings.js';
import { DocError } from './errors.js';
import { findTicketWorkflow, openTicketApproval } from './approvals/engine.js';
import { assertCap, projectMode } from './rbac/modes.js';
import { enqueueEvent } from './integrations/writeback.js';
import { OutboxMailer, type Mail, type Mailer } from './docs/mailer.js';
import { nextPhases, resolveTicketType, typeFields, validateMetadata } from './workflow/service.js';

/** A phase name. Which phases exist, and which moves are legal, is configured per project (see workflow/service.ts). */
export type TicketState = string;

/** The priority an incident's own "P1 - Critical" style field implies for the ticket's priority. */
export const priorityFromMeta = (meta: Record<string, unknown>): 'Low' | 'Medium' | 'High' | 'Critical' | null => {
  const m = /^P([1-4])\b/.exec(String(meta.priority ?? ''));
  return m ? (['Critical', 'High', 'Medium', 'Low'] as const)[Number(m[1]) - 1] : null;
};

export interface CreateOpts { ticketTypeId?: number; dynamicMetadata?: unknown; requesterId?: string | null; mailer?: Mailer; appUrl?: string; via?: 'planning' }

/**
 * Creates a ticket. If the project has an approval workflow for this kind of ticket, the ticket and its approval request are created
 * together and the ticket waits (approval_status 'pending') until every level signs off.
 */
export async function createTicket(projectId: string, title: string, aiSummary?: string, opts: CreateOpts = {}) {
  await assertCap(projectId, opts.via === 'planning' ? 'planning_convert' : 'native_ticket_create');   // tickets come from the source system in Connected and Mirror projects
  const type = await resolveTicketType(projectId, opts.ticketTypeId);
  if (!(await nextPhases(projectId, type.id, null)).length) throw new DocError(`${type.name} tickets have no starting phase in this project's workflow`, 409);
  const metadata = validateMetadata((await typeFields()).get(type.id) ?? [], opts.dynamicMetadata ?? {});   // checked against the type's form definition
  const insert = 'INSERT INTO tickets (project_id, title, ai_summary, ticket_type_id, dynamic_metadata, priority) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *';
  const args = [projectId, title, aiSummary ?? null, type.id, JSON.stringify(metadata), priorityFromMeta(metadata) ?? 'Medium'];   // the starting phase is the type's entry phase (database default)
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

/** Does this move finish the ticket (into a Done phase from one that is not)? */
async function closes(db: Pick<pg.Pool, 'query'>, from: string, to: string) {
  const tones = (await db.query('SELECT name, tone FROM phases WHERE name = ANY($1)', [[from, to]])).rows as { name: string; tone: string }[];
  return tones.find((t) => t.name === to)?.tone === 'done' && tones.find((t) => t.name === from)?.tone !== 'done';
}

const DOC_NAME: Record<string, string> = { FS: 'Functional Specification', TS: 'Technical Specification', TUT: 'Unit Test', CRC: 'Code Review Checklist' };

/**
 * Finishing a ticket (moving it into a Done phase from a phase that is not) needs two things: every document its type requires
 * is approved, and the customer who raised it has confirmed the resolution.
 */
export async function closingProblem(db: Pick<pg.Pool, 'query'>, ticketId: string, from: string, to: string): Promise<string | null> {
  const tones = (await db.query('SELECT name, tone FROM phases WHERE name = ANY($1)', [[from, to]])).rows as { name: string; tone: string }[];
  if (tones.find((t) => t.name === to)?.tone !== 'done' || tones.find((t) => t.name === from)?.tone === 'done') return null;
  const t = (await db.query('SELECT ticket_type_id, customer_id, legacy_id, project_id FROM tickets WHERE id=$1', [ticketId])).rows[0];
  if (!t) return null;
  const { caps } = await projectMode(t.project_id, db);
  const need = !caps.closing_gates ? [] : (await db.query(
    `SELECT d.kind FROM ticket_type_documents d WHERE d.ticket_type_id = $1 AND d.mode = 'required'
       AND NOT EXISTS (SELECT 1 FROM approval_requests r WHERE r.ticket_id = $2 AND r.kind = d.kind AND r.status = 'approved') ORDER BY d.kind`, [t.ticket_type_id, ticketId])).rows.map((r) => DOC_NAME[r.kind as string]);
  if (need.length) return `This ticket cannot be closed yet: ${need.join(', ')} must be approved first.`;
  if (caps.work_gate) {
    const open = (await db.query(`SELECT count(*)::int n FROM work_items WHERE ticket_id=$1 AND state <> 'done'`, [ticketId])).rows[0].n as number;
    if (open) return `This ticket cannot be closed yet: ${open} work item${open === 1 ? ' is' : 's are'} not done.`;
  }
  if (caps.customer_signoff && t.customer_id && !t.legacy_id) {
    const s = (await db.query('SELECT status FROM ticket_signoffs WHERE ticket_id=$1 ORDER BY requested_at DESC LIMIT 1', [ticketId])).rows[0]?.status;
    if (s !== 'approved') return s === 'pending' ? 'This ticket cannot be closed yet: the customer has been asked to confirm it and has not answered.'
      : 'This ticket cannot be closed without the approval of the customer who raised it. Ask them to confirm the resolution from the ticket page.';
  }
  return null;
}
async function assertMayClose(db: Pick<pg.Pool, 'query'>, ticketId: string, from: string, to: string) {
  const p = await closingProblem(db, ticketId, from, to);
  if (p) throw new TransitionError(p);
}

/** Locks the ticket and moves it along one legal step of its project's workflow. Callers own the transaction. */
export async function applyTransition(client: pg.PoolClient, id: string, to: TicketState, actorId?: string) {
  const cur = await client.query('SELECT current_state, project_id, ticket_type_id, approval_status FROM tickets WHERE id=$1 FOR UPDATE', [id]);
  if (!cur.rowCount) throw new TransitionError('Ticket not found');
  const { current_state: from, project_id, ticket_type_id, approval_status } = cur.rows[0];
  if (approval_status === 'pending' || approval_status === 'rejected') throw new TransitionError(approval_status === 'pending' ? 'This ticket is waiting for approval' : 'This ticket was not approved. Send it for approval again first');
  if (!(await nextPhases(project_id, ticket_type_id, from, client)).some((n) => n.to === to)) throw new TransitionError(`Illegal transition: ${from} -> ${to}`);
  await assertMayClose(client, id, from, to);
  const { rows } = await client.query('UPDATE tickets SET current_state=$2 WHERE id=$1 RETURNING *', [id, to]);   // the database checks the same rule
  const tid = (await client.query('SELECT max(id) AS id FROM ticket_transitions WHERE ticket_id=$1', [id])).rows[0].id;
  await enqueueEvent(client, { type: 'phase_entered', ticketId: id, phase: to, eventKey: `t${tid}`, actorId });
  if (await closes(client, from, to)) await enqueueEvent(client, { type: 'ticket_closed', ticketId: id, phase: to, eventKey: `c${tid}`, actorId });
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
