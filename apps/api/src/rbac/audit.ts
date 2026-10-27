import type { FastifyRequest } from 'fastify';
import { pool } from '../db.js';

/** Writes an audit entry attributed to the signed-in user. `projectId` ties it to a project's activity log (null = platform-level). */
export const audit = (req: FastifyRequest, action: string, detail: Record<string, unknown>, projectId: string | null = req.user?.projectId ?? null) =>
  pool.query('INSERT INTO audit_log (actor_id, action, detail, project_id) VALUES ($1,$2,$3,$4)', [req.user!.id, action, JSON.stringify(detail), projectId]);
