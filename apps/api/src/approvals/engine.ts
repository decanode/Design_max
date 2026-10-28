import { createHash, randomBytes } from 'node:crypto';
import type pg from 'pg';
import { pool } from '../db.js';
import { applyTransition } from '../tickets.js';
import type { TicketState } from '../tickets.js';
import { DocError } from '../errors.js';
import type { Mail, Mailer } from '../docs/mailer.js';

/**
 * Multi-level approval engine. A request freezes a copy of the workflow (levels, rules, approvers).
 * Level N+1 only starts once level N is complete. A rejection anywhere ends the request.
 * Decisions are serialized by locking the request row, so concurrent approvers can never double-advance a level.
 */
import { RULES, LABEL, type DocKind } from '../docs/kinds.js';
export type Kind = DocKind;
export interface ApproverRef { kind: 'user' | 'role'; id: string | number; name: string }
export interface LevelSnap { position: number; name: string; rule: 'any' | 'all'; approvers: ApproverRef[] }
export interface Person { id: string; email: string; name: string }

const hash = (t: string) => createHash('sha256').update(t).digest('hex');
export const TOKEN_TTL_DAYS = 7;
const label = (k: Kind) => LABEL[k].replace(/ (Specification|Checklist|Test)$/, '');
type Db = Pick<pg.Pool, 'query'>;

/** The project's active workflow for this kind of document. Each project has its own; nothing is shared across projects. */
export async function findWorkflow(db: Db, projectId: string, kind: Kind) {
  const w = (await db.query(
    `SELECT id, name FROM approval_workflows WHERE active AND NOT is_template AND project_id = $1 AND $2 = ANY(kinds) ORDER BY created_at LIMIT 1`, [projectId, kind])).rows[0];
  if (!w) return null;
  const levels = (await db.query(
    `SELECT l.position, l.name, l.rule,
            COALESCE(json_agg(json_build_object('kind', a.kind, 'id', COALESCE(a.user_id::text, a.role_id::text), 'name', COALESCE(u.display_name, r.name)) ORDER BY a.id) FILTER (WHERE a.id IS NOT NULL), '[]') AS approvers
     FROM approval_levels l LEFT JOIN approval_level_approvers a ON a.level_id = l.id LEFT JOIN users u ON u.id = a.user_id LEFT JOIN roles r ON r.id = a.role_id
     WHERE l.workflow_id = $1 GROUP BY l.id ORDER BY l.position`, [w.id])).rows as LevelSnap[];
  levels.forEach((l) => l.approvers.forEach((a) => { if (a.kind === 'role') a.id = Number(a.id); }));
  return { id: w.id as string, name: w.name as string, levels };
}

/**
 * Everyone who currently satisfies a level, within this project: the named people who are still members, plus every
 * active member holding a named role. (Roles are per project, so "Manager" means this project's Managers.)
 */
export async function resolveLevel(db: Db, level: LevelSnap, projectId: string): Promise<Person[]> {
  const users = level.approvers.filter((a) => a.kind === 'user').map((a) => String(a.id));
  const roles = level.approvers.filter((a) => a.kind === 'role').map((a) => Number(a.id));
  return (await db.query(
    `SELECT u.id, u.email, u.display_name AS name FROM project_members m JOIN users u ON u.id = m.user_id
     WHERE m.project_id = $3 AND u.active AND (m.user_id = ANY($1::uuid[]) OR m.role_id = ANY($2::int[])) ORDER BY u.display_name`, [users, roles, projectId])).rows;
}

/** What would happen if this ticket's document were sent for approval now (shown to the requester first). */
export async function approvalPlan(ticketId: string, kind: Kind, requesterId: string) {
  const t = (await pool.query('SELECT project_id FROM tickets WHERE id=$1', [ticketId])).rows[0];
  if (!t) throw new DocError('Ticket not found', 404);
  const wf = await findWorkflow(pool, t.project_id, kind);
  if (!wf) return { workflow: null, levels: [] };
  const levels = [];
  for (const l of wf.levels) {
    const people = (await resolveLevel(pool, l, t.project_id)).filter((p) => p.id !== requesterId);
    levels.push({ position: l.position, name: l.name, rule: l.rule, approvers: people.map((p) => p.name), problem: people.length ? null : 'No eligible approvers' });
  }
  return { workflow: { id: wf.id, name: wf.name }, levels };
}

async function approvedBefore(c: pg.PoolClient, requestId: string) {
  return new Set((await c.query(`SELECT approver_id FROM approvals WHERE request_id=$1 AND status='approved'`, [requestId])).rows.map((r) => r.approver_id as string));
}

/**
 * Opens the first level from `fromIndex` that still needs someone. Levels whose people have all already approved
 * earlier in this request pass automatically. Returns the emails to send, and whether every level is now complete.
 */
async function startLevel(c: pg.PoolClient, req: any, fromIndex: number, ticketTitle: string, appUrl: string, projectId: string) {
  const levels: LevelSnap[] = req.levels;
  const done = await approvedBefore(c, req.id);
  const mails: Mail[] = [];
  for (let i = fromIndex; i < levels.length; i++) {
    const lvl = levels[i];
    const pool_ = await resolveLevel(c, lvl, projectId);
    const eligible = pool_.filter((p) => p.id !== req.requested_by && !done.has(p.id));
    if (eligible.length) {
      for (const p of eligible) {
        const token = randomBytes(32).toString('base64url');
        await c.query(
          `INSERT INTO approvals (ticket_id, approver_id, kind, version_number, token_hash, expires_at, request_id, level, level_name)
           VALUES ($1,$2,$3,$4,$5, now() + ($6 || ' days')::interval, $7,$8,$9)`,
          [req.ticket_id, p.id, req.kind, req.version_number, hash(token), String(TOKEN_TTL_DAYS), req.id, lvl.position, lvl.name]);
        mails.push({
          to: p.email,
          subject: `Approval needed (${lvl.name} of ${levels[levels.length - 1].name}): ${LABEL[req.kind as Kind]} – ${ticketTitle}`,
          body: `You are asked to approve at level ${lvl.name} (${lvl.rule === 'all' ? 'everyone at this level must approve' : 'any one approver is enough'}), version ${req.version_number}:\n\n${appUrl}/approve/${token}\n\nThis link is single-use and expires in ${TOKEN_TTL_DAYS} days. You can also decide inside the app.`,
        });
      }
      await c.query('UPDATE approval_requests SET current_level=$2 WHERE id=$1', [req.id, lvl.position]);
      return { mails, finished: false };
    }
    if (pool_.some((p) => done.has(p.id))) continue;           // same people already approved earlier: nothing more to ask
    throw new DocError(`Approval level ${lvl.name} has no eligible approvers. Ask an Admin to fix the “${req.workflow_name}” workflow.`, 409);
  }
  return { mails, finished: true };
}

async function requesterMail(c: pg.PoolClient, req: any, subject: string, body: string): Promise<Mail[]> {
  const u = req.requested_by ? (await c.query('SELECT email FROM users WHERE id=$1', [req.requested_by])).rows[0] : null;
  return u ? [{ to: u.email, subject, body }] : [];
}

export async function requestApproval(ticketId: string, kind: Kind, requester: { id: string }, mailer: Mailer, appUrl: string) {
  const c = await pool.connect();
  let mails: Mail[] = [];
  try {
    await c.query('BEGIN');
    const t = (await c.query('SELECT title, project_id, current_state FROM tickets WHERE id=$1 FOR UPDATE', [ticketId])).rows[0];
    if (!t) throw new DocError('Ticket not found', 404);
    if (!RULES[kind].editIn.includes(t.current_state)) throw new DocError(`Approval for the ${kind} can only be requested while the ticket is in ${RULES[kind].editIn.map((x) => `"${x}"`).join(' or ')}`);
    if (RULES[kind].lockedWhenApproved && (await c.query(`SELECT 1 FROM approval_requests WHERE ticket_id=$1 AND kind=$2 AND status='approved'`, [ticketId, kind])).rowCount)
      throw new DocError(`The ${kind} is already approved`);
    if (!(await c.query('SELECT 1 FROM documents WHERE ticket_id=$1 AND kind=$2 LIMIT 1', [ticketId, kind])).rowCount) throw new DocError(`There is no ${kind} to approve yet`);
    if ((await c.query(`SELECT 1 FROM approval_requests WHERE ticket_id=$1 AND kind=$2 AND status='in_progress'`, [ticketId, kind])).rowCount)
      throw new DocError('An approval is already in progress for this document');
    const wf = await findWorkflow(c, t.project_id, kind);
    if (!wf) throw new DocError(`No approval workflow covers the ${LABEL[kind]} for this project. Ask an Admin to set one up.`, 409);

    // Every level must be satisfiable before we start, so a request can never stall halfway for a fixable reason.
    for (const l of wf.levels) {
      const people = (await resolveLevel(c, l, t.project_id)).filter((p) => p.id !== requester.id);
      if (!people.length) throw new DocError(`Approval level ${l.name} has no eligible approvers (you can't approve your own request). Ask an Admin to update the “${wf.name}” workflow.`, 409);
    }
    const version = (await c.query('SELECT max(version_number) v FROM documents WHERE ticket_id=$1 AND kind=$2', [ticketId, kind])).rows[0].v;
    const req = (await c.query(
      `INSERT INTO approval_requests (ticket_id, kind, version_number, workflow_id, workflow_name, levels, requested_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [ticketId, kind, version, wf.id, wf.name, JSON.stringify(wf.levels), requester.id])).rows[0];
    const started = await startLevel(c, req, 0, t.title, appUrl, t.project_id);
    if (started.finished) throw new DocError('This workflow has no one left to ask', 409);
    mails = started.mails;
    await c.query('COMMIT');
    for (const m of mails) await mailer.send(m);
    return { requestId: req.id as string, workflow: wf.name, version, level: wf.levels[0].name, levels: wf.levels.length };
  } catch (e) {
    await c.query('ROLLBACK');
    if ((e as { code?: string }).code === '23505') throw new DocError('An approval is already in progress for this document');
    throw e;
  } finally { c.release(); }
}

export type Decision = 'approved' | 'rejected';
const effective = (a: { status: string; expires_at: Date }, ignoreExpiry: boolean) =>
  a.status === 'pending' && !ignoreExpiry && a.expires_at < new Date() ? 'expired' : a.status;

/** Shared by the emailed-link and in-app paths. `lookup` finds the task (unlocked; locking happens below). */
async function decide(lookup: (c: pg.PoolClient) => Promise<any>, decision: Decision, comment: string | undefined, ignoreExpiry: boolean, mailer: Mailer, appUrl: string) {
  const c = await pool.connect();
  let mails: Mail[] = [];
  try {
    await c.query('BEGIN');
    const found = await lookup(c);
    // Lock order matters: the shared request row first, then this person's task. (Task-first deadlocks when two
    // approvers decide at once, because the winner updates the loser's task while the loser waits for the request.)
    const req = (await c.query('SELECT * FROM approval_requests WHERE id=$1 FOR UPDATE', [found.request_id])).rows[0];
    const task = (await c.query('SELECT * FROM approvals WHERE id=$1 FOR UPDATE', [found.id])).rows[0];
    const fresh = task;
    const st = effective(fresh, ignoreExpiry);
    if (st !== 'pending') throw new DocError(`This approval is already ${st}`, st === 'expired' || st === 'superseded' || st === 'skipped' ? 410 : 409);
    if (req.status !== 'in_progress') throw new DocError(`This request is ${req.status}`, 410);
    if (task.level !== req.current_level) throw new DocError('This level is not active yet', 409);
    if (decision === 'rejected' && !comment?.trim()) throw new DocError('Please say why you are rejecting', 400);

    await c.query(`UPDATE approvals SET status=$2, comment=$3, decided_at=now() WHERE id=$1`, [task.id, decision, comment?.trim() || null]);
    const levels: LevelSnap[] = req.levels;
    const lvl = levels.find((l) => l.position === req.current_level)!;
    const tk = (await c.query('SELECT title, project_id FROM tickets WHERE id=$1', [req.ticket_id])).rows[0];
    const title = tk.title as string;
    const who = (await c.query('SELECT display_name FROM users WHERE id=$1', [task.approver_id])).rows[0].display_name as string;

    if (decision === 'rejected') {
      await c.query(`UPDATE approvals SET status='skipped' WHERE request_id=$1 AND status='pending'`, [req.id]);
      await c.query(`UPDATE approval_requests SET status='rejected', completed_at=now() WHERE id=$1`, [req.id]);
      mails = await requesterMail(c, req, `Rejected at ${lvl.name}: ${LABEL[req.kind as Kind]} – ${title}`, `${who} rejected your request at level ${lvl.name}.\n\nReason: ${comment!.trim()}\n\nUpdate the document and request approval again.`);
    } else {
      const left = (await c.query(`SELECT count(*)::int n FROM approvals WHERE request_id=$1 AND level=$2 AND status='pending'`, [req.id, lvl.position])).rows[0].n as number;
      if (lvl.rule === 'any' || left === 0) {
        await c.query(`UPDATE approvals SET status='skipped' WHERE request_id=$1 AND level=$2 AND status='pending'`, [req.id, lvl.position]);   // "any one" is satisfied
        const next = await startLevel(c, req, levels.findIndex((l) => l.position === lvl.position) + 1, title, appUrl, tk.project_id);
        mails = next.mails;
        if (next.finished) {
          await c.query(`UPDATE approval_requests SET status='approved', completed_at=now() WHERE id=$1`, [req.id]);
          const to = RULES[req.kind as Kind].onApprove;
          if (to) await applyTransition(c, req.ticket_id, to, task.approver_id);
          mails.push(...await requesterMail(c, req, `Approved: ${LABEL[req.kind as Kind]} – ${title}`, `All ${levels.length} approval level${levels.length > 1 ? 's' : ''} signed off.${to ? ` The ticket has moved to ${to}.` : ' The document is now locked.'}`));
        }
      }
    }
    await c.query('COMMIT');
    for (const m of mails) await mailer.send(m);
    return { status: decision };
  } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
}

const hashToken = hash;
export const decideByToken = (token: string, d: Decision, comment: string | undefined, mailer: Mailer, appUrl: string) =>
  decide(async (c) => {
    const a = (await c.query(`SELECT a.* FROM approvals a WHERE a.token_hash=$1 AND a.request_id IS NOT NULL`, [hashToken(token)])).rows[0];
    if (!a) throw new DocError('This approval link is not valid', 404);
    return a;
  }, d, comment, false, mailer, appUrl);

/** In-app decision: only the person the task was addressed to, and the emailed link's expiry doesn't apply. */
export const decideAsUser = (taskId: string, userId: string, projectId: string | null, d: Decision, comment: string | undefined, mailer: Mailer, appUrl: string) =>
  decide(async (c) => {
    const a = (await c.query(`SELECT a.*, t.project_id FROM approvals a JOIN tickets t ON t.id = a.ticket_id WHERE a.id=$1 AND a.request_id IS NOT NULL`, [taskId])).rows[0];
    if (!a) throw new DocError('Approval not found', 404);
    if (a.approver_id !== userId) throw new DocError('This approval is addressed to someone else', 403);
    if (a.project_id !== projectId) throw new DocError('This approval belongs to another project. Switch to it first', 409);
    return a;
  }, d, comment, true, mailer, appUrl);

/** Stops a running request (requester or an approval-workflow admin). */
export async function cancelRequest(ticketId: string, kind: Kind, user: { id: string; perms: Set<string> }) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const req = (await c.query(`SELECT * FROM approval_requests WHERE ticket_id=$1 AND kind=$2 AND status='in_progress' FOR UPDATE`, [ticketId, kind])).rows[0];
    if (!req) throw new DocError('There is no approval in progress to cancel', 404);
    if (req.requested_by !== user.id && !user.perms.has('admin.workflows')) throw new DocError('Only the requester or an Admin can cancel this approval', 403);
    await c.query(`UPDATE approvals SET status='superseded' WHERE request_id=$1 AND status='pending'`, [req.id]);
    await c.query(`UPDATE approval_requests SET status='cancelled', completed_at=now() WHERE id=$1`, [req.id]);
    await c.query('COMMIT');
  } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
}

/** Progress of each request on a ticket, level by level, for the timeline on the ticket page. */
export async function requestsForTicket(ticketId: string) {
  const reqs = (await pool.query(
    `SELECT r.*, u.display_name AS requested_by_name FROM approval_requests r LEFT JOIN users u ON u.id = r.requested_by WHERE r.ticket_id=$1 ORDER BY r.requested_at DESC LIMIT 8`, [ticketId])).rows;
  if (!reqs.length) return [];
  const tasks = (await pool.query(
    `SELECT a.id, a.request_id, a.level, a.status, a.comment, a.decided_at, a.approver_id, u.display_name AS approver
     FROM approvals a JOIN users u ON u.id = a.approver_id WHERE a.request_id = ANY($1::uuid[]) ORDER BY a.id`, [reqs.map((r) => r.id)])).rows;
  return reqs.map((r) => ({
    id: r.id, kind: r.kind, version: r.version_number, status: r.status, workflow: r.workflow_name, currentLevel: r.current_level,
    requestedBy: r.requested_by_name, requestedById: r.requested_by, requestedAt: r.requested_at, completedAt: r.completed_at,
    levels: (r.levels as LevelSnap[]).map((l) => {
      const mine = tasks.filter((t) => t.request_id === r.id && t.level === l.position);
      const open = r.status === 'in_progress';
      const state = mine.some((t) => t.status === 'rejected') ? 'rejected'
        : mine.length === 0 ? (l.position < r.current_level || r.status === 'approved' ? 'auto' : 'waiting')
        : open && l.position === r.current_level ? 'active'
        : mine.some((t) => t.status === 'approved') ? 'done' : 'stopped';
      return { position: l.position, name: l.name, rule: l.rule, state, tasks: mine.map((t) => ({ id: t.id, approverId: t.approver_id, approver: t.approver, status: t.status, comment: t.comment, decidedAt: t.decided_at })) };
    }),
  }));
}

/** Called when the document is edited: the text being approved no longer exists. */
export async function supersedeOpenRequest(c: pg.PoolClient, ticketId: string, kind: Kind) {
  await c.query(`UPDATE approvals SET status='superseded' WHERE ticket_id=$1 AND kind=$2 AND status='pending'`, [ticketId, kind]);
  await c.query(`UPDATE approval_requests SET status='superseded', completed_at=now() WHERE ticket_id=$1 AND kind=$2 AND status='in_progress'`, [ticketId, kind]);
}
