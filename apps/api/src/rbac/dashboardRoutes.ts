import type { FastifyInstance } from 'fastify';
import { pool } from '../db.js';
import { inProject, need } from './auth.js';
import { membersWithPermission } from './effective.js';
import { OPEN_SQL, projectPhaseNames } from '../workflow/service.js';
import { canRead } from '../tickets/fields.js';

export function registerDashboardRoutes(app: FastifyInstance) {
  /** Lead view: who in THIS project is carrying what, and what is waiting for an owner. */
  app.get('/api/dashboard/team', { preHandler: need('dashboard.team') }, async (req, reply) => {
    if (!canRead(req.user!.fields, 'consultant')) return reply.code(403).send({ error: 'Your role cannot see who tickets are assigned to' });
    const projectId = req.user!.projectId!;
    const people = await membersWithPermission(pool, projectId, 'ticket.claim');
    const counts = (await pool.query(
      `SELECT t.consultant_id AS id,
              count(*) FILTER (WHERE t.current_state NOT IN (SELECT name FROM phases WHERE tone = 'done'))::int AS open,
              count(*) FILTER (WHERE EXISTS (SELECT 1 FROM approvals a WHERE a.ticket_id = t.id AND a.status = 'pending'))::int AS awaiting_approval
       FROM tickets t WHERE t.project_id = $1 AND t.consultant_id IS NOT NULL GROUP BY t.consultant_id`, [projectId])).rows;
    const by = new Map(counts.map((c) => [c.id, c]));
    const consultants = people.map((p) => ({ ...p, open: by.get(p.id)?.open ?? 0, awaiting_approval: by.get(p.id)?.awaiting_approval ?? 0 }))
      .sort((a, b) => b.open - a.open || a.name.localeCompare(b.name));
    const unassigned = (await pool.query(`SELECT count(*)::int c FROM tickets WHERE project_id=$1 AND consultant_id IS NULL AND ${OPEN_SQL('tickets')}`, [projectId])).rows[0].c;
    return { consultants, unassigned };
  });

  /** Manager view: phase distribution plus approvals waiting on this user, for this project. */
  app.get('/api/dashboard/portfolio', { preHandler: need('dashboard.portfolio') }, async (req) => {
    const projectId = req.user!.projectId!;
    const counts = new Map((await pool.query('SELECT current_state, count(*)::int c FROM tickets WHERE project_id=$1 GROUP BY 1', [projectId])).rows.map((r) => [r.current_state, r.c]));
    return {
      byState: [...new Set([...(await projectPhaseNames(projectId)), ...counts.keys()])].map((s) => ({ state: s as string, count: counts.get(s) ?? 0 })),
      pendingApprovals: (await pool.query(`SELECT count(*)::int c FROM approvals a JOIN tickets t ON t.id=a.ticket_id WHERE a.status='pending' AND t.project_id=$1`, [projectId])).rows[0].c,
      mine: (await pool.query(`SELECT count(*)::int c FROM approvals a JOIN tickets t ON t.id=a.ticket_id WHERE a.status='pending' AND a.approver_id=$1 AND t.project_id=$2`, [req.user!.id, projectId])).rows[0].c,
    };
  });

  /** Approvals addressed to the signed-in user in the project they are working in. */
  app.get('/api/my/approvals', { preHandler: inProject() }, async (req) =>
    (await pool.query(
      `SELECT a.id, a.kind, a.version_number, a.requested_at, a.expires_at, a.level_name, r.workflow_name, t.id AS ticket_id, t.title
       FROM approvals a JOIN tickets t ON t.id = a.ticket_id LEFT JOIN approval_requests r ON r.id = a.request_id
       WHERE a.approver_id = $1 AND a.status = 'pending' AND t.project_id = $2 ORDER BY a.requested_at`, [req.user!.id, req.user!.projectId])).rows);
}
