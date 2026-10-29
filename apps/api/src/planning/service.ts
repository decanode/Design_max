import type pg from 'pg';
import { pool } from '../db.js';
import { DocError } from '../errors.js';
import { markdownToPm, type PmNode } from '../docgen/pm.js';
import { normTitle, splitSections } from '../docgen/sections.js';
import { createTicket } from '../tickets.js';
import { assertCap } from '../rbac/modes.js';
import { loadStackPolicy } from '../stacks.js';
import { loadWorkflow, typeFields, validateMetadata, type TicketTypeInfo } from '../workflow/service.js';
import { SECTION_TITLES, charterSections, type Charter, type CharterIntake, type PlanningAi, type SectionKey, type WbsPlan } from './ai.js';

export const PLANNING_MODULE = 'planning_module';
/** The three parts of Planning, each switched on separately; the later ones build on the earlier. */
export const PLANNING_SECTIONS = ['project_charter', 'wbs', 'ritm_prep'] as const;
type Section = (typeof PLANNING_SECTIONS)[number];
/** Modules announced for later: they can be chosen now, and do nothing until they ship. */
export const UPCOMING_MODULES = ['effort_estimation', 'cost_estimation', 'timesheets', 'milestones', 'risks', 'raci', 'change_control', 'assumptions'] as const;
/** `planning_module` is the older single switch: it still works (it sets all three sections) and is kept true whenever any section is on. */
export const KNOWN_MODULES = [PLANNING_MODULE, ...PLANNING_SECTIONS, ...UPCOMING_MODULES] as const;

export async function modulesOf(projectId: string): Promise<Record<string, boolean>> {
  const m = (await pool.query('SELECT enabled_modules FROM projects WHERE id=$1', [projectId])).rows[0]?.enabled_modules ?? {};
  const out: Record<string, boolean> = Object.fromEntries(Object.entries(m).map(([k, v]) => [k, v === true]));
  // Projects that switched Planning on before the sections existed have it all: a section is on unless it was switched off.
  for (const k of PLANNING_SECTIONS) {
    if (out[PLANNING_MODULE] === true) out[k] = (m as Record<string, unknown>)[k] !== false; else delete out[k];
  }
  return out;
}

export async function setModule(projectId: string, key: string, on: boolean) {
  const cur = await modulesOf(projectId);
  const sections: Record<Section, boolean> = { project_charter: !!cur.project_charter, wbs: !!cur.wbs, ritm_prep: !!cur.ritm_prep };
  if (key === PLANNING_MODULE) {
    if (!on) { await pool.query(`UPDATE projects SET enabled_modules = jsonb_set(enabled_modules, '{planning_module}', 'false'::jsonb, true) WHERE id=$1`, [projectId]); return; }
    for (const k of PLANNING_SECTIONS) sections[k] = true;
  }
  else if ((PLANNING_SECTIONS as readonly string[]).includes(key)) {
    const k = key as Section;
    if (on && k === 'wbs' && !sections.project_charter) throw new DocError('Switch on Project charter first: the work breakdown is built from the approved charter.', 409);
    if (on && k === 'ritm_prep' && !sections.wbs) throw new DocError('Switch on the Work breakdown structure first: request items are prepared from its work packages.', 409);
    if (!on && k === 'project_charter' && sections.wbs) throw new DocError('Switch off the Work breakdown structure first: it is built from the charter.', 409);
    if (!on && k === 'wbs' && sections.ritm_prep) throw new DocError('Switch off RITM preparation steps first: they are prepared from the work breakdown.', 409);
    sections[k] = on;
  } else {
    await pool.query(`UPDATE projects SET enabled_modules = jsonb_set(enabled_modules, ARRAY[$2]::text[], to_jsonb($3::boolean), true) WHERE id=$1`, [projectId, key, on]);
    return;
  }
  await pool.query(`UPDATE projects SET enabled_modules = enabled_modules || $2::jsonb WHERE id=$1`,
    [projectId, JSON.stringify({ ...sections, [PLANNING_MODULE]: PLANNING_SECTIONS.some((k) => sections[k]) })]);
}

/* ------------------------------------------------------------------ charter text */
/** Plain readable text of some blocks: one line per paragraph, list item and table row. */
export function blockText(nodes: PmNode[], bullet = true): string {
  const inline = (n: PmNode): string => n.text ?? (n.content ?? []).map(inline).join('');
  const one = (n: PmNode): string => {
    switch (n.type) {
      case 'bulletList': case 'orderedList': case 'taskList': return (n.content ?? []).map((li) => `${bullet ? '- ' : ''}${blockText(li.content ?? [], false).replace(/\n/g, '\n  ')}`).join('\n');
      case 'table': return (n.content ?? []).map((r) => (r.content ?? []).map((c) => blockText(c.content ?? [], false).replace(/\n/g, ' ')).join(' | ')).join('\n');
      case 'paragraph': case 'heading': case 'codeBlock': return inline(n);
      default: return n.content ? blockText(n.content, bullet) : inline(n);
    }
  };
  return nodes.map(one).filter((t) => t.trim()).join('\n');
}

/** The editable charter document: a title and one heading per section. */
export function charterDoc(projectName: string, sections: Record<SectionKey, string>): PmNode {
  const md = [`# Project Charter: ${projectName}`, ...(Object.keys(SECTION_TITLES) as SectionKey[]).map((k) => `## ${SECTION_TITLES[k]}\n\n${sections[k] || '_Not yet written._'}`)].join('\n\n');
  return markdownToPm(md);
}

/** Reads the sections back out of an edited charter document by their headings. Anything the editor added outside them stays in the document. */
export function sectionsOf(doc: PmNode): Record<SectionKey, string> {
  const out = Object.fromEntries((Object.keys(SECTION_TITLES) as SectionKey[]).map((k) => [k, ''])) as Record<SectionKey, string>;
  const byTitle = new Map((Object.entries(SECTION_TITLES) as [SectionKey, string][]).map(([k, t]) => [normTitle(t), k]));
  for (const s of splitSections(doc)) {
    const key = byTitle.get(normTitle(s.title));
    if (key) out[key] = blockText(s.nodes.slice(1)).replace(/^Not yet written\.$/i, '');
  }
  return out;
}

/** The charter as one Markdown-like text for the AI (and for reading). */
export function charterText(row: Record<string, string>): string {
  return (Object.entries(SECTION_TITLES) as [SectionKey, string][]).map(([k, t]) => `## ${t}\n${row[k] || '(empty)'}`).join('\n\n');
}

export async function getCharter(projectId: string) {
  return (await pool.query('SELECT id, executive_summary, objectives, scope, out_of_scope, stakeholders, milestones, risks, content_json, intake, status, generated_by, approved_at, created_at, updated_at, (SELECT display_name FROM users WHERE id = approved_by) AS approved_by_name FROM project_charters WHERE project_id=$1', [projectId])).rows[0] ?? null;
}

/** Writes edited content (from the live editor or an API save) and refreshes the section columns. Approved charters do not change. */
export async function storeCharterContent(projectId: string, doc: PmNode, ydoc?: Buffer) {
  const s = sectionsOf(doc);
  await pool.query(
    `UPDATE project_charters SET content_json=$2, ydoc=COALESCE($3, ydoc), executive_summary=$4, objectives=$5, scope=$6, out_of_scope=$7, stakeholders=$8, milestones=$9, risks=$10, updated_at=now()
     WHERE project_id=$1 AND status='Draft'`,
    [projectId, JSON.stringify(doc), ydoc ?? null, s.executive_summary, s.objectives, s.scope, s.out_of_scope, s.stakeholders, s.milestones, s.risks]);
}

export interface Actor { id: string; name: string; projectId: string; projectName: string }

export async function generateCharter(user: Actor, intake: CharterIntake, ai: PlanningAi, opts: { replace?: boolean } = {}) {
  const existing = await getCharter(user.projectId);
  if (existing?.status === 'Approved') throw new DocError('The charter is approved. Reopen it before generating a new draft.', 409);
  if (existing && !opts.replace && (existing.content_json || existing.executive_summary)) throw new DocError('A charter draft already exists. Confirm to replace it.', 409, { exists: true });
  const policy = await loadStackPolicy(user.projectId);
  const charter: Charter = await ai.draftCharter(intake, { stacks: policy?.allowed.map((a) => a.name), projectName: user.projectName });
  const doc = charterDoc(user.projectName, charterSections(charter));
  const s = sectionsOf(doc);
  const by = ai.provider === 'gemini' ? ai.model : 'offline template';
  await pool.query(
    `INSERT INTO project_charters (project_id, executive_summary, objectives, scope, out_of_scope, stakeholders, milestones, risks, content_json, ydoc, intake, status, generated_by, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NULL,$10,'Draft',$11,$12)
     ON CONFLICT (project_id) DO UPDATE SET executive_summary=$2, objectives=$3, scope=$4, out_of_scope=$5, stakeholders=$6, milestones=$7, risks=$8, content_json=$9, ydoc=NULL,
       intake=$10, status='Draft', generated_by=$11, approved_by=NULL, approved_at=NULL, updated_at=now()`,
    [user.projectId, s.executive_summary, s.objectives, s.scope, s.out_of_scope, s.stakeholders, s.milestones, s.risks, JSON.stringify(doc), JSON.stringify(intake), by, user.id]);
  return { doc, by };
}

export async function approveCharter(user: Actor) {
  const c = await getCharter(user.projectId);
  if (!c) throw new DocError('There is no charter to approve yet', 404);
  if (c.status === 'Approved') return;
  const s = sectionsOf(c.content_json ?? charterDoc(user.projectName, {} as never));
  if (!s.executive_summary.trim() || !s.scope.trim()) throw new DocError('The charter needs at least an Executive Summary and a Scope before it can be approved', 400);
  await pool.query(`UPDATE project_charters SET status='Approved', approved_by=$2, approved_at=now(), updated_at=now() WHERE project_id=$1`, [user.projectId, user.id]);
}
export async function reopenCharter(projectId: string) {
  if (!(await pool.query(`UPDATE project_charters SET status='Draft', approved_by=NULL, approved_at=NULL, updated_at=now() WHERE project_id=$1 RETURNING 1`, [projectId])).rowCount) throw new DocError('There is no charter yet', 404);
}

/* ------------------------------------------------------------------ WBS */
export interface WbsRow { id: string; parentId: string | null; title: string; description: string; effort: number | null; order: number; level: number; source: string; ticket: { id: string; title: string; state: string } | null }

export async function listWbs(projectId: string, db: Pick<pg.Pool, 'query'> = pool): Promise<WbsRow[]> {
  return (await db.query(
    `SELECT w.id, w.parent_id, w.title, w.description, w.estimated_effort, w.order_index, w.level, w.source, t.id AS ticket_id, t.title AS ticket_title, t.current_state AS ticket_state
     FROM wbs_elements w LEFT JOIN tickets t ON t.id = w.ticket_id WHERE w.project_id = $1 ORDER BY w.level, w.order_index, w.created_at`, [projectId])).rows.map((r) => ({
    id: r.id, parentId: r.parent_id, title: r.title, description: r.description, effort: r.estimated_effort == null ? null : Number(r.estimated_effort), order: r.order_index, level: r.level, source: r.source,
    ticket: r.ticket_id ? { id: r.ticket_id, title: r.ticket_title, state: r.ticket_state } : null }));
}

/** The database enforces the shape of the tree; its refusals become plain messages. */
const shape = async <T>(fn: () => Promise<T>) => { try { return await fn(); } catch (e) { if ((e as { code?: string }).code === '23514') throw new DocError((e as Error).message, 400); throw e; } };

export async function generateWbs(user: Actor, ai: PlanningAi, opts: { replace?: boolean } = {}) {
  const c = await getCharter(user.projectId);
  if (!c || c.status !== 'Approved') throw new DocError('Approve the project charter first. The work breakdown is built from the approved charter.', 409);
  const existing = await listWbs(user.projectId);
  if (existing.some((e) => e.ticket)) throw new DocError('Some work packages have already become tickets, so the plan can no longer be regenerated. Edit it by hand instead.', 409);
  if (existing.length && !opts.replace) throw new DocError('A work breakdown already exists. Confirm to replace it.', 409, { exists: true });
  const policy = await loadStackPolicy(user.projectId);
  const plan: WbsPlan = await ai.generateWbs(charterText(c), { stacks: policy?.allowed.map((a) => a.name), projectName: user.projectName });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM wbs_elements WHERE project_id=$1', [user.projectId]);
    const add = async (parent: string | null, i: number, e: { title: string; description?: string; effortDays?: number }) =>
      (await client.query(`INSERT INTO wbs_elements (project_id, parent_id, title, description, estimated_effort, order_index, source) VALUES ($1,$2,$3,$4,$5,$6,'ai') RETURNING id`,
        [user.projectId, parent, e.title, e.description ?? '', e.effortDays ?? null, i])).rows[0].id as string;
    let pi = 0;
    for (const ph of plan.phases) {
      const phId = await add(null, pi++, ph);
      let di = 0;
      for (const d of ph.deliverables) { const dId = await add(phId, di++, d); let wi = 0; for (const w of d.workPackages) await add(dId, wi++, w); }
    }
    await client.query('COMMIT');
  } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
  return plan;
}

const Title = (t: string) => { const v = t.trim(); if (!v) throw new DocError('A title is needed', 400); return v; };

export async function addElement(projectId: string, e: { parentId: string | null; title: string; description?: string; effort?: number | null }) {
  const row = await shape(async () => (await pool.query(
    `INSERT INTO wbs_elements (project_id, parent_id, title, description, estimated_effort, order_index, source)
     VALUES ($1,$2,$3,$4,$5,(SELECT coalesce(max(order_index) + 1, 0) FROM wbs_elements WHERE project_id=$1 AND parent_id IS NOT DISTINCT FROM $2),'manual') RETURNING id`,
    [projectId, e.parentId, Title(e.title), e.description ?? '', e.effort ?? null])).rows[0]);
  return row.id as string;
}

export async function updateElement(projectId: string, id: string, p: { title?: string; description?: string; effort?: number | null }) {
  const sets: string[] = [], vals: unknown[] = [id, projectId];
  const set = (col: string, v: unknown) => { vals.push(v); sets.push(`${col} = $${vals.length}`); };
  if (p.title !== undefined) set('title', Title(p.title));
  if (p.description !== undefined) set('description', p.description);
  if (p.effort !== undefined) set('estimated_effort', p.effort);
  if (!sets.length) return;
  if (!(await pool.query(`UPDATE wbs_elements SET ${sets.join(', ')} WHERE id=$1 AND project_id=$2 RETURNING 1`, vals)).rowCount) throw new DocError('Element not found', 404);
}

/** Moves an element under a (new) parent at a position; siblings are renumbered. A null parent means a top-level phase. */
export async function moveElement(projectId: string, id: string, parentId: string | null, index: number) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query('SELECT 1 FROM wbs_elements WHERE project_id=$1 FOR UPDATE', [projectId]);       // one reorder at a time per project
    const cur = (await c.query('SELECT parent_id FROM wbs_elements WHERE id=$1 AND project_id=$2', [id, projectId])).rows[0];
    if (!cur) throw new DocError('Element not found', 404);
    await shape(async () => { await c.query('UPDATE wbs_elements SET parent_id=$2 WHERE id=$1', [id, parentId]); });
    const sibs = (await c.query('SELECT id FROM wbs_elements WHERE project_id=$1 AND parent_id IS NOT DISTINCT FROM $2 AND id <> $3 ORDER BY order_index, created_at', [projectId, parentId, id])).rows.map((r) => r.id as string);
    sibs.splice(Math.max(0, Math.min(index, sibs.length)), 0, id);
    for (let i = 0; i < sibs.length; i++) await c.query('UPDATE wbs_elements SET order_index=$2 WHERE id=$1 AND order_index <> $2', [sibs[i], i]);
    if ((cur.parent_id ?? null) !== (parentId ?? null)) {            // close the gap left behind
      const old = (await c.query('SELECT id FROM wbs_elements WHERE project_id=$1 AND parent_id IS NOT DISTINCT FROM $2 ORDER BY order_index, created_at', [projectId, cur.parent_id])).rows;
      for (let i = 0; i < old.length; i++) await c.query('UPDATE wbs_elements SET order_index=$2 WHERE id=$1 AND order_index <> $2', [old[i].id, i]);
    }
    await c.query('COMMIT');
  } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
}

export async function deleteElement(projectId: string, id: string) {
  const converted = (await pool.query(
    `WITH RECURSIVE s AS (SELECT id, ticket_id FROM wbs_elements WHERE id=$1 AND project_id=$2 UNION ALL SELECT e.id, e.ticket_id FROM wbs_elements e JOIN s ON e.parent_id = s.id)
     SELECT count(*)::int total, count(ticket_id)::int tickets FROM s`, [id, projectId])).rows[0];
  if (!converted.total) throw new DocError('Element not found', 404);
  if (converted.tickets) throw new DocError('Part of this branch has already become tickets, so it cannot be deleted', 409);
  await pool.query('DELETE FROM wbs_elements WHERE id=$1 AND project_id=$2', [id, projectId]);
}

/* ------------------------------------------------------------------ work packages -> tickets */
export interface ConvertResult { type: { id: number; name: string }; created: { elementId: string; ticketId: string }[]; skipped: { elementId: string; reason: string }[] }

/** The ticket type used when the PM does not choose one: a Request Item if the project allows it, else the project's default. */
export async function defaultConvertType(projectId: string): Promise<TicketTypeInfo> {
  const types = (await loadWorkflow(projectId)).ticketTypes.filter((t) => t.enabled);
  if (!types.length) throw new DocError('This project has no ticket types switched on', 409);
  return types.find((t) => t.key === 'ritm') ?? types.find((t) => t.isDefault) ?? types[0];
}

const fill = (v: unknown, vars: Record<string, string>) => (typeof v === 'string' ? v.replace(/\{(title|description|phase|deliverable)\}/g, (_, k) => vars[k] ?? '') : v);

export async function convertToTickets(user: Actor, opts: { elementIds?: string[]; ticketTypeId?: number; fields?: Record<string, unknown> }): Promise<ConvertResult> {
  await assertCap(user.projectId, 'planning_convert');
  const wf = await loadWorkflow(user.projectId);
  const type = opts.ticketTypeId ? wf.ticketTypes.find((t) => t.id === opts.ticketTypeId && t.enabled) : await defaultConvertType(user.projectId);
  if (!type) throw new DocError('This project does not allow that kind of ticket', 400);
  const all = await listWbs(user.projectId);
  const byId = new Map(all.map((r) => [r.id, r]));
  const wanted = opts.elementIds?.length ? opts.elementIds : all.filter((r) => r.level === 3 && !r.ticket).map((r) => r.id);
  const defs = (await typeFields()).get(type.id) ?? [];
  const todo: { el: WbsRow; summary: string; meta: Record<string, unknown> }[] = [], skipped: ConvertResult['skipped'] = [];
  for (const id of wanted) {
    const el = byId.get(id);
    if (!el) { skipped.push({ elementId: id, reason: 'Not found' }); continue; }
    if (el.level !== 3) { skipped.push({ elementId: id, reason: 'Only work packages become tickets' }); continue; }
    if (el.ticket) { skipped.push({ elementId: id, reason: 'Already a ticket' }); continue; }
    const deliverable = byId.get(el.parentId!), phase = deliverable && byId.get(deliverable.parentId!);
    const vars = { title: el.title, description: el.description, phase: phase?.title ?? '', deliverable: deliverable?.title ?? '' };
    const meta = Object.fromEntries(Object.entries(opts.fields ?? {}).map(([k, v]) => [k, fill(v, vars)]));
    todo.push({ el, meta, summary: [el.description, `From the project plan: ${[vars.phase, vars.deliverable, el.title].filter(Boolean).join(' › ')}.`, el.effort != null ? `Estimated effort: ${el.effort} person-days.` : ''].filter(Boolean).join('\n\n') });
  }
  if (!todo.length && !skipped.length) throw new DocError('There are no work packages to convert', 400);
  for (const t of todo) t.meta = validateMetadata(defs, t.meta);           // every ticket is checked before the first one is created
  const created: ConvertResult['created'] = [];
  for (const t of todo) {
    const ticket = await createTicket(user.projectId, t.el.title, t.summary, { ticketTypeId: type.id, dynamicMetadata: t.meta, requesterId: user.id, via: 'planning' });
    await pool.query('UPDATE wbs_elements SET ticket_id=$2 WHERE id=$1', [t.el.id, ticket.id]);
    created.push({ elementId: t.el.id, ticketId: ticket.id });
  }
  return { type: { id: type.id, name: type.name }, created, skipped };
}
