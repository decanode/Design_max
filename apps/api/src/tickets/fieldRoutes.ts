import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool } from '../db.js';
import { need } from '../rbac/auth.js';
import { ADMIN_ROLE } from '../rbac/permissions.js';
import { DocError } from '../errors.js';
import { ALL_WRITE, FIELDS, LEVELS, resolveFieldAccess, validateFieldAccess } from './fields.js';

/** Admin API for the field-access grid (fields down, roles across). Same permission as managing roles. */
export function registerFieldAdminRoutes(app: FastifyInstance) {
  const admin = need('admin.roles');

  app.get('/api/admin/ticket-fields', { preHandler: admin }, async () => {
    const roles = (await pool.query('SELECT id, name, is_system FROM roles ORDER BY is_system DESC, id')).rows;
    const rows = (await pool.query('SELECT role_id, field, access FROM ticket_field_access')).rows;
    return {
      levels: LEVELS,
      fields: FIELDS.map(({ key, label, description, writable, min }) => ({ key, label, description, writable, min })),
      roles: roles.map((r) => ({
        id: r.id, name: r.name, isSystem: r.is_system, locked: r.name === ADMIN_ROLE,
        access: r.name === ADMIN_ROLE ? ALL_WRITE : resolveFieldAccess(rows.filter((x) => x.role_id === r.id)),
      })),
    };
  });

  /** Sets some or all fields for one role; fields not mentioned are left as they are. */
  app.put('/api/admin/roles/:id/ticket-fields', { preHandler: admin }, async (req) => {
    const { id } = z.object({ id: z.coerce.number().int() }).parse(req.params);
    const { access } = z.object({ access: z.record(z.string(), z.string()) }).parse(req.body);
    const role = (await pool.query('SELECT name FROM roles WHERE id=$1', [id])).rows[0];
    if (!role) throw new DocError('Role not found', 404);
    if (role.name === ADMIN_ROLE) throw new DocError('The Admin role always has full access to every field', 400);
    const problem = validateFieldAccess(access);
    if (problem) throw new DocError(problem, 400);
    const before = resolveFieldAccess((await pool.query('SELECT field, access FROM ticket_field_access WHERE role_id=$1', [id])).rows);
    for (const [field, level] of Object.entries(access))
      await pool.query(`INSERT INTO ticket_field_access (role_id, field, access) VALUES ($1,$2,$3) ON CONFLICT (role_id, field) DO UPDATE SET access = EXCLUDED.access`, [id, field, level]);
    const changed = Object.entries(access).filter(([f, l]) => before[f] !== l).map(([f, l]) => ({ field: f, from: before[f], to: l }));
    if (changed.length) await pool.query('INSERT INTO audit_log (actor_id, action, detail) VALUES ($1,$2,$3)', [req.user!.id, 'role.ticket-fields', JSON.stringify({ id, name: role.name, changed })]);
    return { ok: true, changed: changed.length };
  });
}
