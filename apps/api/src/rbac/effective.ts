import type pg from 'pg';
import { PROJECT_ADMIN_ROLE, PROJECT_KEYS } from './permissions.js';
import { ALL_WRITE, resolveFieldAccess, type FieldAccess } from '../tickets/fields.js';

type Db = Pick<pg.Pool, 'query'>;

/**
 * What a role means INSIDE a project: the role's standard template, unless the Project Admin has tuned it for this
 * project (then the project's own rows replace the template entirely). Only project-scope permissions can ever apply.
 */
export async function overrideFlags(db: Db, projectId: string, roleId: number) {
  const o = (await db.query('SELECT perms, fields FROM project_role_overrides WHERE project_id=$1 AND role_id=$2', [projectId, roleId])).rows[0];
  return { perms: !!o?.perms, fields: !!o?.fields };
}

export async function effectivePerms(db: Db, projectId: string, roleId: number, roleName: string): Promise<string[]> {
  if (roleName === PROJECT_ADMIN_ROLE) return PROJECT_KEYS;                                  // implicit: everything in their project
  const { perms } = await overrideFlags(db, projectId, roleId);
  const rows = perms
    ? (await db.query('SELECT permission FROM project_role_permissions WHERE project_id=$1 AND role_id=$2', [projectId, roleId])).rows
    : (await db.query('SELECT permission FROM role_permissions WHERE role_id=$1', [roleId])).rows;
  return rows.map((r) => r.permission as string).filter((k) => PROJECT_KEYS.includes(k));
}

export async function effectiveFields(db: Db, projectId: string, roleId: number, roleName: string): Promise<FieldAccess> {
  if (roleName === PROJECT_ADMIN_ROLE) return ALL_WRITE;
  const { fields } = await overrideFlags(db, projectId, roleId);
  const rows = fields
    ? (await db.query('SELECT field, access FROM project_ticket_field_access WHERE project_id=$1 AND role_id=$2', [projectId, roleId])).rows
    : (await db.query('SELECT field, access FROM ticket_field_access WHERE role_id=$1', [roleId])).rows;
  return resolveFieldAccess(rows);
}

/**
 * Ids of the roles that hold `permission` in this project (Project Admin always does). Used to answer
 * "who in this project can claim tickets?" without loading each member.
 */
export async function rolesWithPermission(db: Db, projectId: string, permission: string): Promise<number[]> {
  return (await db.query(
    `SELECT r.id FROM roles r WHERE r.name = $3
        OR EXISTS (SELECT 1 FROM role_permissions rp WHERE rp.role_id = r.id AND rp.permission = $2
                   AND NOT COALESCE((SELECT o.perms FROM project_role_overrides o WHERE o.project_id = $1 AND o.role_id = r.id), false))
        OR EXISTS (SELECT 1 FROM project_role_permissions pp WHERE pp.project_id = $1 AND pp.role_id = r.id AND pp.permission = $2)`,
    [projectId, permission, PROJECT_ADMIN_ROLE])).rows.map((r) => r.id as number);
}

/** Active members of the project whose role holds `permission`. */
export async function membersWithPermission(db: Db, projectId: string, permission: string) {
  const roles = await rolesWithPermission(db, projectId, permission);
  return (await db.query(
    `SELECT u.id, u.display_name AS name, r.name AS role FROM project_members pm JOIN users u ON u.id = pm.user_id JOIN roles r ON r.id = pm.role_id
     WHERE pm.project_id = $1 AND u.active AND pm.role_id = ANY($2::int[]) ORDER BY u.display_name`, [projectId, roles])).rows as { id: string; name: string; role: string }[];
}
