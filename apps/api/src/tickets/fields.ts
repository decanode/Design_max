/**
 * Column-level security for tickets. Each *field* (one or more columns) has an access level per role:
 * hidden < read < write. Admin always has write. The same rule is applied to every place ticket data leaves
 * the server: lists, detail, mutation responses, reports/CSV, and edits.
 */
export type Access = 'hidden' | 'read' | 'write';
export const LEVELS: Access[] = ['hidden', 'read', 'write'];
const rank = (a: Access) => LEVELS.indexOf(a);

export interface FieldDef {
  key: string; label: string; description: string;
  columns: string[];          // response keys that carry this field's data
  writable: boolean;          // can ever be 'write'
  min: Access;                // lowest level an admin may set ('read' = cannot be hidden)
  newRole: Access;            // what a brand-new role gets until an admin decides
}

export const FIELDS: FieldDef[] = [
  { key: 'title', label: 'Title', description: 'The ticket headline. Always at least readable: the board cannot work without it.', columns: ['title'], writable: true, min: 'read', newRole: 'read' },
  { key: 'ai_summary', label: 'Requirement summary', description: 'The plain-English requirement drafted from the chat.', columns: ['ai_summary'], writable: true, min: 'hidden', newRole: 'hidden' },
  { key: 'customer', label: 'Customer', description: 'Who raised the ticket.', columns: ['customer_id', 'customer_name'], writable: false, min: 'hidden', newRole: 'hidden' },
  { key: 'consultant', label: 'Assigned consultant', description: 'Who is working the ticket. Claiming and assigning need Edit.', columns: ['consultant_id', 'consultant', 'consultant_name', 'team_id', 'team_name'], writable: true, min: 'hidden', newRole: 'hidden' },
  { key: 'project', label: 'Project', description: 'The project the ticket belongs to.', columns: ['project_id', 'project_name'], writable: false, min: 'hidden', newRole: 'hidden' },
  { key: 'legacy', label: 'Legacy reference', description: 'Jira / ServiceNow key, source, type and status for migrated tickets.', columns: ['legacy_id', 'legacy_source', 'legacy_type', 'legacy_status'], writable: false, min: 'hidden', newRole: 'hidden' },
  { key: 'details', label: 'Type-specific details', description: 'The extra fields of the ticket type, such as impact and urgency of an incident or the RICEF category of a WRICEF.', columns: ['dynamic_metadata'], writable: true, min: 'hidden', newRole: 'hidden' },
  { key: 'resolution_notes', label: 'Resolution notes', description: 'How a past ticket was resolved.', columns: ['resolution_notes'], writable: true, min: 'hidden', newRole: 'hidden' },
  { key: 'acceptance_criteria', label: 'Acceptance criteria', description: 'What must be true for the ticket to be accepted.', columns: ['acceptance_criteria'], writable: true, min: 'hidden', newRole: 'hidden' },
];
export const FIELD_KEYS = FIELDS.map((f) => f.key);
export const fieldDef = (k: string) => FIELDS.find((f) => f.key === k);

export type FieldAccess = Record<string, Access>;
/** Admin's access: the most each field allows (Edit where a field can be edited, otherwise Read). */
export const ALL_WRITE: FieldAccess = Object.fromEntries(FIELDS.map((f) => [f.key, (f.writable ? 'write' : 'read') as Access]));

/** Turns stored rows into a complete map (missing fields fall back to the field's new-role default). */
export function resolveFieldAccess(rows: { field: string; access: Access }[]): FieldAccess {
  const have = new Map(rows.map((r) => [r.field, r.access]));
  return Object.fromEntries(FIELDS.map((f) => [f.key, have.get(f.key) ?? f.newRole]));
}

/** Validates an admin-supplied map: known fields, legal levels, and each field's limits. Returns an error message or null. */
export function validateFieldAccess(input: Record<string, string>): string | null {
  for (const [k, v] of Object.entries(input)) {
    const f = fieldDef(k);
    if (!f) return `Unknown field “${k}”`;
    if (!LEVELS.includes(v as Access)) return `“${v}” is not an access level`;
    if (rank(v as Access) < rank(f.min)) return `${f.label} cannot be hidden`;
    if (v === 'write' && !f.writable) return `${f.label} is read-only for everyone (it is not editable)`;
  }
  return null;
}

/** Removes every hidden field's columns from a ticket-shaped object. Core columns are never touched. */
export function sanitizeTicket<T extends Record<string, unknown>>(row: T, access: FieldAccess): Partial<T> {
  const out: Record<string, unknown> = { ...row };
  for (const f of FIELDS) if (access[f.key] === 'hidden') for (const c of f.columns) delete out[c];
  return out as Partial<T>;
}

export const canRead = (a: FieldAccess, field: string) => (a[field] ?? 'hidden') !== 'hidden';
export const canWrite = (a: FieldAccess, field: string) => a[field] === 'write';
