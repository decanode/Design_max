import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type pg from 'pg';
import { pool } from '../db.js';
import { need, ticketVisible } from '../rbac/auth.js';
import { audit } from '../rbac/audit.js';
import { DocError } from '../errors.js';
import { PROJECT_ADMIN_ROLE } from '../rbac/permissions.js';
import { canWrite } from '../tickets/fields.js';

const pid = (req: { user: { projectId: string | null } | null }) => req.user!.projectId!;
/** A real time zone, including the common aliases (Asia/Kolkata) that Intl accepts but does not list. */
const knownZone = (v: string) => { try { new Intl.DateTimeFormat('en', { timeZone: v }); return true; } catch { return false; } };

/** An empty box means "nothing": it is stored as no value, so a field can be cleared. */
const opt = (max: number) => z.string().trim().max(max).transform((v) => (v === '' ? null : v)).nullable();
const Phone = z.string().trim().transform((v) => (v === '' ? null : v)).nullable().refine((v) => v === null || /^[+(\d][\d\s().-]{4,29}$/.test(v), 'Enter a phone number such as +91 98765 43210');
const Profile = z.object({
  firstName: z.string().trim().min(1, 'First name is needed').max(60), lastName: opt(60),
  userId: z.string().trim().regex(/^[A-Za-z0-9._-]{3,40}$/, 'A user ID is 3 to 40 letters, digits, dots, dashes or underscores'),
  email: z.string().trim().email(),
  employeeId: opt(40), phone: Phone, mobile: Phone, jobTitle: opt(120), department: opt(120), company: opt(120), location: opt(120), costCenter: opt(60),
  managerId: z.string().uuid().nullable(),
  timeZone: z.string().trim().transform((v) => (v === '' ? null : v)).nullable().refine((v) => v === null || knownZone(v), 'Choose a time zone from the list'),
  language: z.string().trim().transform((v) => (v === '' ? null : v)).nullable().refine((v) => v === null || /^[a-z]{2,3}(-[A-Z]{2})?$/.test(v), 'Use a language code such as en or en-GB'),
  notes: opt(2000),
});
type ProfileKey = keyof z.infer<typeof Profile>;
const COLUMN: Record<ProfileKey, string> = {
  firstName: 'first_name', lastName: 'last_name', userId: 'user_id', email: 'email', employeeId: 'employee_id', phone: 'phone', mobile: 'mobile', jobTitle: 'job_title',
  department: 'department', company: 'company', location: 'location', costCenter: 'cost_center', managerId: 'manager_id', timeZone: 'time_zone', language: 'language', notes: 'notes',
};
const IDENTITY: ProfileKey[] = ['email', 'userId'];

type Db = Pick<pg.Pool, 'query'>;

async function assertAdminRemains(projectId: string, exceptUserId: string) {
  const n = (await pool.query(
    `SELECT count(*)::int c FROM project_members m JOIN roles r ON r.id = m.role_id JOIN users u ON u.id = m.user_id WHERE m.project_id=$1 AND r.name=$2 AND u.active AND m.user_id <> $3`,
    [projectId, PROJECT_ADMIN_ROLE, exceptUserId])).rows[0].c;
  if (n < 1) throw new DocError('A project must keep at least one Project Admin', 409);
}

const SELECT_MEMBER = `
  u.id, u.user_id, u.first_name, u.last_name, u.display_name AS name, u.email, u.employee_id, u.phone, u.mobile, u.job_title, u.department, u.company, u.location, u.cost_center,
  u.manager_id, mg.display_name AS manager_name, u.time_zone, u.language, u.active, u.is_super_admin, r.id AS role_id, r.name AS role, m.created_at, adder.display_name AS added_by,
  COALESCE((SELECT json_agg(json_build_object('id', t.id, 'name', t.name) ORDER BY t.name) FROM team_members tm JOIN teams t ON t.id = tm.team_id WHERE tm.user_id = u.id AND tm.project_id = m.project_id), '[]') AS teams,
  (SELECT count(*)::int FROM tickets k WHERE k.project_id = m.project_id AND k.consultant_id = u.id AND k.current_state NOT IN (SELECT name FROM phases WHERE tone = 'done')) AS open_tickets,
  (SELECT count(*)::int FROM project_members x WHERE x.user_id = u.id) AS projects`;
const FROM_MEMBER = `FROM project_members m JOIN users u ON u.id = m.user_id JOIN roles r ON r.id = m.role_id LEFT JOIN users mg ON mg.id = u.manager_id LEFT JOIN users adder ON adder.id = m.added_by`;

export function registerPeopleRoutes(app: FastifyInstance) {
  const members = need('admin.users');

  const one = async (projectId: string, userId: string, db: Db = pool) => {
    const r = (await db.query(`SELECT ${SELECT_MEMBER}, u.notes ${FROM_MEMBER} WHERE m.project_id=$1 AND m.user_id=$2`, [projectId, userId])).rows[0];
    if (!r) throw new DocError('That person is not in this project', 404);
    return r;
  };
  const Id = z.object({ userId: z.string().uuid() });
  const TeamIds = z.array(z.string().uuid()).max(50);

  /** Teams must be this project's own. */
  async function setMemberTeams(c: Db, projectId: string, userId: string, teamIds: string[]) {
    const ids = [...new Set(teamIds)];
    if (ids.length && (await c.query('SELECT count(*)::int n FROM teams WHERE project_id=$1 AND id = ANY($2)', [projectId, ids])).rows[0].n !== ids.length) throw new DocError('One of those teams is not in this project', 400);
    await c.query('DELETE FROM team_members WHERE project_id=$1 AND user_id=$2 AND NOT (team_id = ANY($3))', [projectId, userId, ids]);
    for (const t of ids) await c.query('INSERT INTO team_members (team_id, user_id, project_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [t, userId, projectId]);
  }
  async function assertManager(projectId: string, managerId: string | null | undefined, selfId?: string) {
    if (!managerId) return;
    if (managerId === selfId) throw new DocError('Someone cannot be their own manager', 400);
    if (!(await pool.query('SELECT 1 FROM project_members WHERE project_id=$1 AND user_id=$2', [projectId, managerId])).rowCount) throw new DocError('The manager must be a member of this project', 400);
  }
  const unique = async (e: unknown) => { const c = (e as { code?: string; constraint?: string }); if (c.code === '23505') throw new DocError(c.constraint?.includes('user_id') ? 'That user ID is already taken' : 'That email address already has an account', 409); throw e; };

  // ------------------------------------------------------------ members
  app.get('/api/project/members', { preHandler: members }, async (req) =>
    (await pool.query(`SELECT ${SELECT_MEMBER} ${FROM_MEMBER} WHERE m.project_id = $1 ORDER BY u.active DESC, u.display_name`, [pid(req)])).rows);

  app.get('/api/project/members/:userId', { preHandler: members }, async (req) => {
    const { userId } = Id.parse(req.params);
    const m = await one(pid(req), userId);
    return { ...m, canEditIdentity: req.user!.isSuper || m.projects === 1 };
  });

  /** Add someone. A new email creates the person's account with the details given; an existing account just joins (their profile is theirs and is not overwritten here). */
  app.post('/api/project/members', { preHandler: members }, async (req, reply) => {
    const raw = req.body as Record<string, unknown>;
    const b = Profile.partial({ userId: true, firstName: true, lastName: true, employeeId: true, phone: true, mobile: true, jobTitle: true, department: true, company: true, location: true, costCenter: true, managerId: true, timeZone: true, language: true, notes: true })
      .extend({ roleId: z.number().int(), teamIds: TeamIds.default([]), name: z.string().trim().max(120).optional() }).parse(raw);
    const role = (await pool.query('SELECT id, name FROM roles WHERE id=$1 AND (project_id IS NULL OR project_id=$2)', [b.roleId, pid(req)])).rows[0];
    if (!role) throw new DocError('Role not found', 404);
    const email = b.email.toLowerCase();
    await assertManager(pid(req), b.managerId);
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      let user = (await c.query('SELECT id, active FROM users WHERE email=$1', [email])).rows[0] as { id: string; active: boolean } | undefined;
      let created = false;
      if (user) { if (!user.active) throw new DocError('That account is deactivated', 409); }
      else {
        const full = b.name ?? ([b.firstName, b.lastName].filter(Boolean).join(' ').trim() || email.split('@')[0]);
        const first = b.firstName ?? full.split(' ')[0], last = b.lastName ?? (full.split(' ').slice(1).join(' ') || null);
        try {
          user = (await c.query(
            `INSERT INTO users (email, display_name, first_name, last_name, user_id, employee_id, phone, mobile, job_title, department, company, location, cost_center, manager_id, time_zone, language, notes)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING id, active`,
            [email, [first, last].filter(Boolean).join(' '), first, last, b.userId ?? null, b.employeeId ?? null, b.phone ?? null, b.mobile ?? null, b.jobTitle ?? null, b.department ?? null, b.company ?? null, b.location ?? null,
              b.costCenter ?? null, b.managerId ?? null, b.timeZone ?? null, b.language ?? null, b.notes ?? null])).rows[0];
        } catch (e) { await unique(e); }
        created = true;
      }
      if ((await c.query('SELECT 1 FROM project_members WHERE project_id=$1 AND user_id=$2', [pid(req), user!.id])).rowCount) throw new DocError('That person is already in this project', 409);
      await c.query('INSERT INTO project_members (project_id, user_id, role_id, added_by) VALUES ($1,$2,$3,$4)', [pid(req), user!.id, b.roleId, req.user!.id]);
      await setMemberTeams(c, pid(req), user!.id, b.teamIds);
      await c.query('COMMIT');
      await audit(req, 'member.add', { email, role: role.name, newAccount: created, teams: b.teamIds.length });
      return reply.code(201).send({ userId: user!.id, created });
    } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
  });

  app.patch('/api/project/members/:userId', { preHandler: members }, async (req) => {
    const { userId } = Id.parse(req.params);
    const b = Profile.partial().extend({ roleId: z.number().int().optional(), teamIds: TeamIds.optional() }).strict().parse(req.body);
    const cur = await one(pid(req), userId);
    const canIdentity = req.user!.isSuper || cur.projects === 1;
    for (const k of IDENTITY) if (b[k] !== undefined && b[k] !== (k === 'email' ? cur.email : cur.user_id) && !canIdentity)
      throw new DocError('This person belongs to other projects too, so only a Super Admin can change their email or user ID', 403);
    await assertManager(pid(req), b.managerId, userId);

    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      if (b.roleId !== undefined && b.roleId !== cur.role_id) {
        const role = (await c.query('SELECT id, name FROM roles WHERE id=$1 AND (project_id IS NULL OR project_id=$2)', [b.roleId, pid(req)])).rows[0];
        if (!role) throw new DocError('Role not found', 404);
        if (cur.role === PROJECT_ADMIN_ROLE && role.name !== PROJECT_ADMIN_ROLE) await assertAdminRemains(pid(req), userId);
        await c.query('UPDATE project_members SET role_id=$3 WHERE project_id=$1 AND user_id=$2', [pid(req), userId, b.roleId]);
        await audit(req, 'member.role', { email: cur.email, from: cur.role, to: role.name });
      }
      const sets: string[] = [], vals: unknown[] = [userId];
      const changed: string[] = [];
      for (const [k, col] of Object.entries(COLUMN) as [ProfileKey, string][]) {
        const v = b[k]; if (v === undefined) continue;
        vals.push(k === 'email' ? String(v).toLowerCase() : v); sets.push(`${col} = $${vals.length}`); changed.push(k);
      }
      if (b.firstName !== undefined || b.lastName !== undefined) {         // the display name everyone sees follows the first and last name
        const first = b.firstName ?? cur.first_name, last = b.lastName !== undefined ? b.lastName : cur.last_name;
        vals.push([first, last].filter(Boolean).join(' ')); sets.push(`display_name = $${vals.length}`);
      }
      if (sets.length) { try { await c.query(`UPDATE users SET ${sets.join(', ')} WHERE id=$1`, vals); } catch (e) { await unique(e); } }
      if (b.teamIds) { await setMemberTeams(c, pid(req), userId, b.teamIds); changed.push('teams'); }
      await c.query('COMMIT');
      if (changed.length) await audit(req, 'member.update', { email: cur.email, fields: changed });      // which fields, never the values
    } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
    return one(pid(req), userId);
  });

  app.delete('/api/project/members/:userId', { preHandler: members }, async (req) => {
    const { userId } = Id.parse(req.params);
    const cur = await one(pid(req), userId);
    if (cur.role === PROJECT_ADMIN_ROLE) await assertAdminRemains(pid(req), userId);
    await pool.query('DELETE FROM project_members WHERE project_id=$1 AND user_id=$2', [pid(req), userId]);
    await audit(req, 'member.remove', { email: cur.email, role: cur.role });
    return { ok: true };
  });

  // ------------------------------------------------------------ teams
  const teamList = async (projectId: string) => (await pool.query(
    `SELECT t.id, t.name, t.description, t.lead_id, l.display_name AS lead_name, t.created_at,
            COALESCE((SELECT json_agg(json_build_object('id', u.id, 'name', u.display_name) ORDER BY u.display_name) FROM team_members tm JOIN users u ON u.id = tm.user_id WHERE tm.team_id = t.id), '[]') AS members,
            (SELECT count(*)::int FROM tickets k WHERE k.team_id = t.id) AS tickets
     FROM teams t LEFT JOIN users l ON l.id = t.lead_id WHERE t.project_id = $1 ORDER BY lower(t.name)`, [projectId])).rows;

  app.get('/api/project/teams', { preHandler: members }, async (req) => teamList(pid(req)));

  const TeamBody = z.object({ name: z.string().trim().min(1, 'Give the team a name').max(80), description: z.string().trim().max(300).default(''), leadId: z.string().uuid().nullable().default(null), memberIds: z.array(z.string().uuid()).max(500).default([]) });
  async function saveMembers(c: Db, projectId: string, teamId: string, ids: string[], leadId: string | null) {
    const all = [...new Set([...ids, ...(leadId ? [leadId] : [])])];
    if (all.length && (await c.query('SELECT count(*)::int n FROM project_members WHERE project_id=$1 AND user_id = ANY($2)', [projectId, all])).rows[0].n !== all.length) throw new DocError('Team members must be members of this project', 400);
    await c.query('DELETE FROM team_members WHERE team_id=$1 AND NOT (user_id = ANY($2))', [teamId, all]);
    for (const u of all) await c.query('INSERT INTO team_members (team_id, user_id, project_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [teamId, u, projectId]);
  }
  const dupTeam = (e: unknown) => { if ((e as { code?: string }).code === '23505') throw new DocError('This project already has a team with that name', 409); throw e; };

  app.post('/api/project/teams', { preHandler: members }, async (req, reply) => {
    const b = TeamBody.parse(req.body);
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      let id: string;
      try { id = (await c.query('INSERT INTO teams (project_id, name, description, lead_id) VALUES ($1,$2,$3,$4) RETURNING id', [pid(req), b.name, b.description, b.leadId])).rows[0].id; } catch (e) { dupTeam(e); throw e; }
      await saveMembers(c, pid(req), id, b.memberIds, b.leadId);
      await c.query('COMMIT');
      await audit(req, 'team.create', { name: b.name });
      return reply.code(201).send({ id, teams: await teamList(pid(req)) });
    } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
  });
  app.put('/api/project/teams/:id', { preHandler: members }, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const b = TeamBody.parse(req.body);
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      try { if (!(await c.query('UPDATE teams SET name=$3, description=$4, lead_id=$5 WHERE id=$1 AND project_id=$2 RETURNING 1', [id, pid(req), b.name, b.description, b.leadId])).rowCount) throw new DocError('Team not found', 404); } catch (e) { if (e instanceof DocError) throw e; dupTeam(e); }
      await saveMembers(c, pid(req), id, b.memberIds, b.leadId);
      await c.query('COMMIT');
      await audit(req, 'team.update', { name: b.name });
      return { teams: await teamList(pid(req)) };
    } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
  });
  app.delete('/api/project/teams/:id', { preHandler: members }, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const t = (await pool.query('SELECT name FROM teams WHERE id=$1 AND project_id=$2', [id, pid(req)])).rows[0];
    if (!t) throw new DocError('Team not found', 404);
    await pool.query('DELETE FROM teams WHERE id=$1', [id]);                  // tickets keep existing; they simply have no team any more
    await audit(req, 'team.delete', { name: t.name });
    return { teams: await teamList(pid(req)) };
  });

  // ------------------------------------------------------------ assigning a ticket to a team
  app.post('/api/tickets/:id/team', { preHandler: need('ticket.assign') }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const { teamId } = z.object({ teamId: z.string().uuid().nullable() }).parse(req.body);
    if (!canWrite(req.user!.fields, 'consultant')) return reply.code(403).send({ error: 'Your role cannot change who a ticket is assigned to' });
    if (!(await ticketVisible(req.user!, id))) return reply.code(404).send({ error: 'Ticket not found' });
    if (teamId && !(await pool.query('SELECT 1 FROM teams WHERE id=$1 AND project_id=$2', [teamId, pid(req)])).rowCount) return reply.code(400).send({ error: 'That team is not in this project' });
    await pool.query('UPDATE tickets SET team_id=$2 WHERE id=$1 AND project_id=$3', [id, teamId, pid(req)]);
    await audit(req, 'ticket.team', { ticketId: id, teamId });
    return { ok: true };
  });
  /** Teams a ticket can be given to (anyone who may assign tickets, not only member admins). */
  app.get('/api/project/team-options', { preHandler: need('ticket.assign') }, async (req) =>
    (await pool.query('SELECT id, name FROM teams WHERE project_id=$1 ORDER BY lower(name)', [pid(req)])).rows);
}
