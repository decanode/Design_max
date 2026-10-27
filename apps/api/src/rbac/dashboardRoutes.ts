import type { FastifyInstance } from 'fastify';
import { pool } from '../db.js';
import { need } from './auth.js';
import { STATES } from '../stateMachine.js';
import { canRead } from '../tickets/fields.js';

export function registerDashboardRoutes(app: FastifyInstance) {
  /** Lead view: who is carrying what, and what is waiting for an owner. */
  app.get('/api/dashboard/team', { preHandler: need('dashboard.team') }, async (req, reply) => {
    if (!canRead(req.user!.fields, 'consultant')) return reply.code(403).send({ error: 'Your role cannot see who tickets are assigned to' });
    const consultants = (await pool.query(
      `SELECT u.id, u.display_name AS name, r.name AS role,
              count(t.id) FILTER (WHERE t.current_state <> 'Deployed')::int AS open,
              count(t.id) FILTER (WHERE EXISTS (SELECT 1 FROM approvals a WHERE a.ticket_id = t.id AND a.status = 'pending'))::int AS awaiting_approval
       FROM users u JOIN roles r ON r.id = u.role_id LEFT JOIN tickets t ON t.consultant_id = u.id
       WHERE u.active AND (r.name = 'Admin' OR EXISTS (SELECT 1 FROM role_permissions p WHERE p.role_id = r.id AND p.permission = 'ticket.claim'))
       GROUP BY u.id, r.name ORDER BY open DESC, u.display_name`)).rows;
    const unassigned = (await pool.query(`SELECT count(*)::int c FROM tickets WHERE consultant_id IS NULL AND current_state <> 'Deployed'`)).rows[0].c;
    return { consultants, unassigned };
  });

  /** Manager view: phase distribution plus approvals waiting on this user. */
  app.get('/api/dashboard/portfolio', { preHandler: need('dashboard.portfolio') }, async (req) => {
    const counts = new Map((await pool.query('SELECT current_state, count(*)::int c FROM tickets GROUP BY 1')).rows.map((r) => [r.current_state, r.c]));
    return {
      byState: STATES.map((s) => ({ state: s, count: counts.get(s) ?? 0 })),
      pendingApprovals: (await pool.query(`SELECT count(*)::int c FROM approvals WHERE status='pending'`)).rows[0].c,
      mine: (await pool.query(`SELECT count(*)::int c FROM approvals WHERE status='pending' AND approver_id=$1`, [req.user!.id])).rows[0].c,
    };
  });

  /** Approvals addressed to the signed-in user (being named in a workflow is the authority to decide). */
  app.get('/api/my/approvals', async (req) =>
    (await pool.query(
      `SELECT a.id, a.kind, a.version_number, a.requested_at, a.expires_at, a.level_name, r.workflow_name, t.id AS ticket_id, t.title
       FROM approvals a JOIN tickets t ON t.id = a.ticket_id LEFT JOIN approval_requests r ON r.id = a.request_id
       WHERE a.approver_id = $1 AND a.status = 'pending' ORDER BY a.requested_at`, [req.user!.id])).rows);
}
