import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool } from '../db.js';
import { need, ticketVisible } from '../rbac/auth.js';
import { audit } from '../rbac/audit.js';
import { DocError } from '../errors.js';
import { OutboxMailer, type Mailer } from '../docs/mailer.js';
import { enqueueEvent } from '../integrations/writeback.js';

const Id = z.object({ id: z.string().uuid() });
const STATE_LABEL: Record<string, string> = { approved: 'approved', rejected: 'rejected', in_progress: 'is waiting for approval', cancelled: 'was withdrawn', superseded: 'was replaced' };
const KIND_LABEL: Record<string, string> = { FS: 'the Functional Specification', TS: 'the Technical Specification', TUT: 'the Unit Test', CRC: 'the Code Review Checklist', TICKET: 'the ticket' };

/** The conversation on a ticket, the customer's sign-off, and the timeline that ties them to the phase moves and approvals. */
export function registerTicketWorkRoutes(app: FastifyInstance, deps: { mailer?: Mailer; appUrl?: string } = {}) {
  const mailer = deps.mailer ?? new OutboxMailer();
  const appUrl = deps.appUrl ?? process.env.APP_URL ?? 'http://localhost:3000';
  const visible = async (req: import('fastify').FastifyRequest, id: string) => { if (!(await ticketVisible(req.user!, id))) throw new DocError('Ticket not found', 404); };
  const isStaff = (perms: Set<string>) => perms.has('ticket.view_all') || perms.has('ticket.advance') || perms.has('ticket.claim');

  /** Everything that happened, oldest first. A customer does not see internal notes. */
  app.get('/api/tickets/:id/activity', { preHandler: need('board.view') }, async (req) => {
    const { id } = Id.parse(req.params); await visible(req, id);
    const staff = isStaff(req.user!.perms);
    const t = (await pool.query('SELECT created_at, customer_id, consultant_id FROM tickets WHERE id=$1', [id])).rows[0];
    const [tr, notes, so, ap] = await Promise.all([
      pool.query(`SELECT x.id, x.from_state, x.to_state, x.created_at AS at, u.display_name AS actor FROM ticket_transitions x LEFT JOIN users u ON u.id = x.actor_id WHERE x.ticket_id=$1`, [id]),
      pool.query(`SELECT n.id, n.body, n.internal, n.created_at AS at, u.display_name AS actor, n.author_id FROM ticket_notes n LEFT JOIN users u ON u.id = n.author_id WHERE n.ticket_id=$1 ${staff ? '' : 'AND NOT n.internal'}`, [id]),
      pool.query(`SELECT s.id, s.status, s.requested_at, s.decided_at, s.comment, c.display_name AS customer, r.display_name AS requester FROM ticket_signoffs s JOIN users c ON c.id = s.customer_id LEFT JOIN users r ON r.id = s.requested_by WHERE s.ticket_id=$1`, [id]),
      pool.query(`SELECT r.id, r.kind, r.status, r.workflow_name, r.requested_at, r.completed_at, u.display_name AS requester FROM approval_requests r LEFT JOIN users u ON u.id = r.requested_by WHERE r.ticket_id=$1`, [id]),
    ]);
    const items: { id: string; type: string; at: string; actor: string | null; text: string; detail?: string | null; internal?: boolean }[] = [];
    items.push({ id: 'created', type: 'created', at: t.created_at, actor: null, text: 'Ticket created' });
    for (const x of tr.rows) if (x.from_state) items.push({ id: `t${x.id}`, type: 'move', at: x.at, actor: x.actor, text: `Moved from ${x.from_state} to ${x.to_state}` });
    for (const n of notes.rows) items.push({ id: `n${n.id}`, type: 'note', at: n.at, actor: n.actor, text: n.body, internal: n.internal });
    for (const s of so.rows) {
      items.push({ id: `s${s.id}`, type: 'signoff', at: s.requested_at, actor: s.requester, text: `Asked ${s.customer} to confirm the resolution` });
      if (s.decided_at) items.push({ id: `s${s.id}d`, type: 'signoff', at: s.decided_at, actor: s.customer, text: s.status === 'approved' ? 'Confirmed the ticket is resolved' : s.status === 'rejected' ? 'Said it is not resolved' : 'Request withdrawn', detail: s.comment });
    }
    for (const a of ap.rows) {
      items.push({ id: `a${a.id}`, type: 'approval', at: a.requested_at, actor: a.requester, text: `Approval of ${KIND_LABEL[a.kind] ?? a.kind} requested (${a.workflow_name})` });
      if (a.completed_at) items.push({ id: `a${a.id}d`, type: 'approval', at: a.completed_at, actor: null, text: `Approval of ${KIND_LABEL[a.kind] ?? a.kind} ${STATE_LABEL[a.status] ?? a.status}` });
    }
    return items.sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());
  });

  app.post('/api/tickets/:id/notes', { preHandler: need('board.view') }, async (req, reply) => {
    const { id } = Id.parse(req.params); await visible(req, id);
    const b = z.object({ body: z.string().trim().min(1).max(5000), internal: z.boolean().default(false) }).parse(req.body);
    const internal = b.internal && isStaff(req.user!.perms);       // a customer cannot write a team-only note
    const t = (await pool.query('SELECT project_id FROM tickets WHERE id=$1', [id])).rows[0];
    const n = (await pool.query('INSERT INTO ticket_notes (ticket_id, project_id, author_id, body, internal) VALUES ($1,$2,$3,$4,$5) RETURNING id', [id, t.project_id, req.user!.id, b.body, internal])).rows[0];
    await pool.query('UPDATE tickets SET updated_at = now() WHERE id=$1', [id]);
    return reply.code(201).send({ id: n.id });
  });

  /** The team asks the customer who raised the ticket to confirm it is resolved. */
  app.post('/api/tickets/:id/signoff/request', { preHandler: need('ticket.advance') }, async (req, reply) => {
    const { id } = Id.parse(req.params); await visible(req, id);
    const t = (await pool.query('SELECT t.id, t.title, t.project_id, t.customer_id, t.legacy_id, u.email, u.display_name FROM tickets t LEFT JOIN users u ON u.id = t.customer_id WHERE t.id=$1', [id])).rows[0];
    if (!t.customer_id || t.legacy_id) throw new DocError('This ticket was not raised by a customer, so it needs no customer sign-off.', 409);
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query('SELECT 1 FROM tickets WHERE id=$1 FOR UPDATE', [id]);
      const last = (await c.query('SELECT status FROM ticket_signoffs WHERE ticket_id=$1 ORDER BY requested_at DESC LIMIT 1', [id])).rows[0]?.status;
      if (last === 'pending') throw new DocError('The customer has already been asked and has not answered yet.', 409);
      if (last === 'approved') throw new DocError('The customer has already confirmed this ticket.', 409);
      await c.query('INSERT INTO ticket_signoffs (ticket_id, project_id, customer_id, requested_by) VALUES ($1,$2,$3,$4)', [id, t.project_id, t.customer_id, req.user!.id]);
      await c.query('UPDATE tickets SET updated_at = now() WHERE id=$1', [id]);
      await c.query('COMMIT');
    } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
    await mailer.send({ to: t.email, subject: `Please confirm: ${t.title}`, body: `${req.user!.name} believes your request “${t.title}” is resolved.\\n\\nPlease open it and confirm that it works for you, or tell us what is still wrong:\\n\\n${appUrl}/tickets/${id}\\n\\nThe ticket stays open until you confirm.` });
    await audit(req, 'ticket.signoff.request', { ticketId: id });
    return reply.code(201).send({ ok: true });
  });

  /** Only the customer who raised the ticket can confirm or refuse. A refusal needs a reason and keeps the ticket open. */
  app.post('/api/tickets/:id/signoff/decision', { preHandler: need('board.view') }, async (req) => {
    const { id } = Id.parse(req.params); await visible(req, id);
    const b = z.object({ decision: z.enum(['approved', 'rejected']), comment: z.string().trim().max(2000).optional() }).parse(req.body);
    const t = (await pool.query('SELECT customer_id, project_id FROM tickets WHERE id=$1', [id])).rows[0];
    if (t.customer_id !== req.user!.id) throw new DocError('Only the customer who raised this ticket can answer.', 403);
    if (b.decision === 'rejected' && !b.comment) throw new DocError('Please say what is still wrong.', 400);
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      const s = (await c.query(`SELECT id FROM ticket_signoffs WHERE ticket_id=$1 AND status='pending' FOR UPDATE`, [id])).rows[0];
      if (!s) throw new DocError('Nobody has asked for your confirmation yet, or you already answered.', 409);
      await c.query('UPDATE ticket_signoffs SET status=$2, decided_at=now(), comment=$3 WHERE id=$1', [s.id, b.decision, b.comment ?? null]);
      if (b.comment) await c.query('INSERT INTO ticket_notes (ticket_id, project_id, author_id, body) VALUES ($1,$2,$3,$4)', [id, t.project_id, req.user!.id, b.comment]);
      await c.query('UPDATE tickets SET updated_at = now() WHERE id=$1', [id]);
      if (b.decision === 'approved') await enqueueEvent(c, { type: 'signoff_approved', ticketId: id, eventKey: `s${s.id}`, actorId: req.user!.id });
      await c.query('COMMIT');
    } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
    await audit(req, 'ticket.signoff.decision', { ticketId: id, decision: b.decision });
    return { ok: true };
  });

  /** The team withdraws a request that is still waiting. */
  app.post('/api/tickets/:id/signoff/cancel', { preHandler: need('ticket.advance') }, async (req) => {
    const { id } = Id.parse(req.params); await visible(req, id);
    const r = await pool.query(`UPDATE ticket_signoffs SET status='cancelled', decided_at=now() WHERE ticket_id=$1 AND status='pending'`, [id]);
    if (!r.rowCount) throw new DocError('There is no waiting request to withdraw.', 404);
    return { ok: true };
  });
}
