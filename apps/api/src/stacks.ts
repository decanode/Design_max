import { pool } from './db.js';

export interface StackDef { id: number; name: string; description: string; keywords: string[] }
/** `allowed` are the project's stacks; `others` are every other known stack (used to spot off-stack content). */
export interface StackPolicy { allowed: StackDef[]; others: StackDef[] }
export type StackFit = 'in_scope' | 'unclear' | 'out_of_scope';

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

/** Whole-term, case-insensitive matches ("java" does not match "javascript"). Returns the distinct terms found. */
export function matchKeywords(text: string, keywords: string[]): string[] {
  const hit = new Set<string>();
  for (const k of keywords) if (new RegExp(`(?<![\\w])${esc(k)}(?![\\w])`, 'i').test(text)) hit.add(k);
  return [...hit];
}

/** The project's stack policy, or null when the project has no stacks (unrestricted). */
export async function loadStackPolicy(projectId: string): Promise<StackPolicy | null> {
  const { rows } = await pool.query(
    `SELECT s.id, s.name, s.description, s.keywords, (ps.project_id IS NOT NULL) AS allowed
     FROM tech_stacks s LEFT JOIN project_stacks ps ON ps.stack_id = s.id AND ps.project_id = $1 ORDER BY s.name`, [projectId]);
  const allowed = rows.filter((r) => r.allowed), others = rows.filter((r) => !r.allowed);
  return allowed.length ? { allowed, others } : null;
}

const names = (p: StackPolicy) => p.allowed.map((s) => s.name).join(', ');

/** Deterministic scope check over free text. Backs up the model; never relies on it alone. */
export function assessFit(text: string, policy: StackPolicy | null): { fit: StackFit; note: string; foreign: { stack: string; terms: string[] }[] } {
  if (!policy) return { fit: 'in_scope', note: '', foreign: [] };
  const foreign = policy.others.map((s) => ({ stack: s.name, terms: matchKeywords(text, s.keywords) })).filter((f) => f.terms.length);
  if (!foreign.length) return { fit: 'in_scope', note: '', foreign };
  const mine = policy.allowed.flatMap((s) => matchKeywords(text, s.keywords));
  const list = foreign.map((f) => `${f.stack} (${f.terms.join(', ')})`).join('; ');
  return mine.length
    ? { fit: 'unclear', note: `This also mentions ${list}. Confirm the work stays within ${names(policy)}.`, foreign }
    : { fit: 'out_of_scope', note: `This looks like ${list} work, but this project is limited to ${names(policy)}.`, foreign };
}

/** Prompt block that confines the model to the project's stacks. */
export function stackInstruction(policy: StackPolicy | null, mode: 'observe' | 'document'): string {
  if (!policy) return '';
  const lines = [
    `TECHNOLOGY SCOPE: This project is restricted to: ${names(policy)}.`,
    ...policy.allowed.map((s) => `- ${s.name}: ${s.description}`),
    `Work ONLY within these technologies. Never recommend, design or compare solutions on other platforms or languages${policy.others.length ? ` (for example ${policy.others.map((s) => s.name).join(', ')})` : ''}.`,
  ];
  lines.push(mode === 'observe'
    ? 'Set "stackFit" to "in_scope" when the request can be met within the allowed technologies, "out_of_scope" when it needs a different technology (do not draft a solution for it; explain briefly in "stackNote"), or "unclear" when it is partly or ambiguously outside.'
    : 'If something cannot be delivered within the allowed technologies, do not design it; list it under Open Questions as "Outside project technology scope".');
  return lines.join('\n');
}

export async function projectPolicyForTicket(ticketId: string) {
  const r = (await pool.query('SELECT project_id FROM tickets WHERE id=$1', [ticketId])).rows[0];
  return r ? loadStackPolicy(r.project_id) : null;
}

/** Replaces a project's allowed stacks (empty = unrestricted). Callers own the transaction. */
export async function setProjectStacks(c: import('pg').PoolClient, projectId: string, stackIds: number[]) {
  const ids = [...new Set(stackIds)];
  if (ids.length && (await c.query('SELECT count(*)::int n FROM tech_stacks WHERE id = ANY($1)', [ids])).rows[0].n !== ids.length) throw new Error('UNKNOWN_STACK');
  await c.query('DELETE FROM project_stacks WHERE project_id=$1', [projectId]);
  if (ids.length) await c.query('INSERT INTO project_stacks (project_id, stack_id) SELECT $1, unnest($2::int[])', [projectId, ids]);
}
