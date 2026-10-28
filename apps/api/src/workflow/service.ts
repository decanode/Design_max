import { z } from 'zod';
import type pg from 'pg';
import { pool } from '../db.js';
import { DocError } from '../errors.js';

export type FieldKind = 'text' | 'textarea' | 'select' | 'number' | 'date' | 'checkbox';
export interface TypeField { id: number; key: string; label: string; kind: FieldKind; options: string[]; required: boolean; help: string; position: number }
export interface PhaseInfo { id: number; name: string; tone: string; position: number; enabled: boolean }
export interface TicketTypeInfo { id: number; key: string; name: string; short: string; description: string; enabled: boolean; isDefault: boolean; fields: TypeField[] }
export interface Workflow {
  projectType: { id: number; key: string; name: string } | null;
  template: { id: number; key: string; name: string } | null;
  phases: PhaseInfo[];                 // every phase of the methodology, in board order, with whether this project uses it
  ticketTypes: TicketTypeInfo[];       // every type the methodology can carry, with whether this project allows it
}
type Db = Pick<pg.Pool, 'query'>;

export async function typeFields(db: Db = pool): Promise<Map<number, TypeField[]>> {
  const rows = (await db.query('SELECT id, ticket_type_id, key, label, kind, options, required, help, position FROM ticket_type_fields ORDER BY ticket_type_id, position, id')).rows;
  const m = new Map<number, TypeField[]>();
  for (const r of rows) m.set(r.ticket_type_id, [...(m.get(r.ticket_type_id) ?? []), { id: r.id, key: r.key, label: r.label, kind: r.kind, options: r.options, required: r.required, help: r.help, position: r.position }]);
  return m;
}

/** Everything that defines how a project behaves: its methodology, phases and ticket types (with their form fields). */
export async function loadWorkflow(projectId: string, db: Db = pool): Promise<Workflow> {
  const p = (await db.query(
    `SELECT pt.id AS pt_id, pt.key AS pt_key, pt.name AS pt_name, tt.id AS tt_id, tt.key AS tt_key, tt.name AS tt_name
     FROM projects p LEFT JOIN project_types pt ON pt.id = p.project_type_id LEFT JOIN template_types tt ON tt.id = p.template_type_id WHERE p.id = $1`, [projectId])).rows[0];
  if (!p) throw new DocError('Project not found', 404);
  const phases = (await db.query(
    `SELECT ph.id, ph.name, ph.tone, pp.position, pp.enabled FROM project_phases pp JOIN phases ph ON ph.id = pp.phase_id WHERE pp.project_id = $1 ORDER BY pp.position`, [projectId])).rows;
  const fields = await typeFields(db);
  const types = (await db.query(
    `SELECT t.id, t.key, t.name, t.short, t.description, pt.enabled, pt.is_default FROM project_ticket_types pt JOIN ticket_types t ON t.id = pt.ticket_type_id WHERE pt.project_id = $1 ORDER BY t.sort`, [projectId])).rows;
  return {
    projectType: p.pt_id ? { id: p.pt_id, key: p.pt_key, name: p.pt_name } : null,
    template: p.tt_id ? { id: p.tt_id, key: p.tt_key, name: p.tt_name } : null,
    phases,
    ticketTypes: types.map((t) => ({ id: t.id, key: t.key, name: t.name, short: t.short, description: t.description, enabled: t.enabled, isDefault: t.is_default, fields: fields.get(t.id) ?? [] })),
  };
}

export interface NextPhase { to: string; gated: string | null }
/** Where a ticket may go next (from = null: where a new ticket of this type starts). The same rule the database enforces. */
export async function nextPhases(projectId: string, ticketTypeId: number | null, from: string | null, db: Db = pool): Promise<NextPhase[]> {
  const rows = (await db.query('SELECT to_phase, gated_reason FROM next_phases($1, $2, $3)', [projectId, ticketTypeId, from])).rows;
  return rows.map((r) => ({ to: r.to_phase as string, gated: (r.gated_reason as string | null) ?? null }));
}

/** The form definition as a zod schema, built at runtime from the field rows. */
export function metadataSchema(fields: TypeField[]) {
  const shape: Record<string, z.ZodType> = {};
  for (const f of fields) {
    let s: z.ZodType;
    switch (f.kind) {
      case 'number': s = z.coerce.number().finite().min(-1e12).max(1e12); break;
      case 'checkbox': s = z.boolean(); break;
      case 'date': s = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use the format YYYY-MM-DD').refine((v) => !Number.isNaN(Date.parse(v)), 'Not a real date'); break;
      case 'select': s = z.string().refine((v) => f.options.includes(v), `Choose one of: ${f.options.join(', ')}`); break;
      case 'textarea': s = z.string().trim().max(5000); break;
      default: s = z.string().trim().max(500);
    }
    const isEmpty = (v: unknown) => v === undefined || v === null || v === '' ;
    shape[f.key] = z.preprocess((v) => (isEmpty(v) ? undefined : v), f.required && f.kind !== 'checkbox' ? s : s.optional());
  }
  return z.object(shape).strict();
}

/** Validates what a person typed against the ticket type's fields. Returns the cleaned values or throws with one message per field. */
export function validateMetadata(fields: TypeField[], input: unknown): Record<string, unknown> {
  const r = metadataSchema(fields).safeParse(input ?? {});
  if (!r.success) {
    const fieldErrors: Record<string, string> = {};
    for (const i of r.error.issues) {
      const k = String(i.path[0] ?? '');
      const label = fields.find((f) => f.key === k)?.label ?? k;
      fieldErrors[k] = i.code === 'unrecognized_keys' ? `Unknown field: ${(i as { keys?: string[] }).keys?.join(', ')}` : i.message.startsWith('Invalid input') || i.message.startsWith('Invalid option') || i.message.includes('expected') ? `${label} is required` : i.message;
    }
    throw new DocError('Some details need attention', 400, { fieldErrors });
  }
  return Object.fromEntries(Object.entries(r.data).filter(([, v]) => v !== undefined && v !== ''));
}

/** The ticket type a new ticket gets, checked against what the project allows. */
export async function resolveTicketType(projectId: string, requested: number | undefined, db: Db = pool): Promise<TicketTypeInfo> {
  const wf = await loadWorkflow(projectId, db);
  const allowed = wf.ticketTypes.filter((t) => t.enabled);
  if (!allowed.length) throw new DocError('This project has no ticket types switched on. Ask a Project Admin to set up the template.', 409);
  if (requested == null) return allowed.find((t) => t.isDefault) ?? allowed[0];
  const t = allowed.find((x) => x.id === requested);
  if (!t) throw new DocError(`This project does not allow that kind of ticket. Allowed: ${allowed.map((x) => x.name).join(', ')}`, 400);
  return t;
}

/** Names of every phase the project's tickets can be in, in board order (used by dashboards and reports). */
export async function projectPhaseNames(projectId: string, db: Db = pool): Promise<string[]> {
  return (await db.query(`SELECT ph.name FROM project_phases pp JOIN phases ph ON ph.id = pp.phase_id WHERE pp.project_id = $1 AND pp.enabled ORDER BY pp.position`, [projectId])).rows.map((r) => r.name as string);
}

/** SQL predicate for "this ticket is still open": it is not in a finishing phase. */
export const OPEN_SQL = (alias = 't') => `${alias}.current_state NOT IN (SELECT name FROM phases WHERE tone = 'done')`;
