import { pool } from '../db.js';
import { DocError } from '../errors.js';
import { requestsForTicket } from '../approvals/engine.js';
import { loadStackPolicy } from '../stacks.js';
import { canRead } from '../tickets/fields.js';
import type { SessionUser } from '../rbac/auth.js';
import { baseTemplate } from './baseTemplate.js';
import { markdownToPm } from './pm.js';
import { simpleTable } from './ooxml.js';
import { fillTemplate, type Typography } from './template.js';

export const DOC_LABEL: Record<string, string> = { FS: 'Functional Specification', TS: 'Technical Specification', TUT: 'Technical Unit Test', CRC: 'Code Review Checklist' };
const isoDate = (d: Date | string) => new Date(d).toISOString().slice(0, 10);
const slug = (s: string) => s.normalize('NFKD').replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '-').slice(0, 40).replace(/-+$/, '') || 'document';

export interface ExportResult { buffer: Buffer; filename: string; version: number; unknownTokens: string[] }

/**
 * Builds a Word file for one version of a ticket's document: the template's design, the version's content, and a
 * front matter that is generated from the real history (revision table from saved versions, approval table from the
 * approval timeline) so nobody types it by hand. Respects ticket-field access: a role that cannot read the customer
 * does not get the customer name in the file.
 */
export async function exportDocument(user: SessionUser, ticketId: string, kind: string, version?: number, typography?: Typography): Promise<ExportResult> {
  const t = (await pool.query('SELECT id, title, project_id FROM tickets WHERE id=$1', [ticketId])).rows[0];
  if (!t) throw new DocError('Ticket not found', 404);
  const versions = (await pool.query('SELECT version_number, content_md, author_name, change_note, created_at FROM documents WHERE ticket_id=$1 AND kind=$2 ORDER BY version_number', [ticketId, kind])).rows;
  if (!versions.length) throw new DocError('There is no document to download yet', 404);
  const v = version == null ? versions[versions.length - 1] : versions.find((x) => x.version_number === version);
  if (!v) throw new DocError('That version does not exist', 404);

  const requests = (await requestsForTicket(ticketId)).filter((r) => r.kind === kind);
  const forThis = requests.filter((r) => r.version === v.version_number);
  const approved = forThis.find((r) => r.status === 'approved');
  const open = forThis.find((r) => r.status === 'in_progress');
  const status = approved ? 'Approved' : open ? 'In approval' : v.version_number < versions[versions.length - 1].version_number ? 'Superseded' : 'Draft';

  const approvalRows = approved
    ? approved.levels.flatMap((l) => l.tasks.filter((x) => x.status === 'approved' || x.status === 'rejected').map((x) => [l.name, x.approver, x.status === 'approved' ? 'Approved' : 'Rejected', x.decidedAt ? isoDate(x.decidedAt) : '']))
    : [];
  const customer = canRead(user.fields, 'customer')
    ? (await pool.query('SELECT u.display_name FROM tickets t JOIN users u ON u.id=t.customer_id WHERE t.id=$1', [ticketId])).rows[0]?.display_name ?? '—'
    : '—';
  const stacks = (await loadStackPolicy(t.project_id))?.allowed.map((s) => s.name).join(', ') ?? 'Any';
  const label = DOC_LABEL[kind] ?? kind;

  const out = fillTemplate(baseTemplate(), {
    title: `${label}: ${t.title}`,
    typography,
    tokens: {
      PROJECT_NAME: user.projectName ?? '', TICKET_ID: String(t.id).slice(0, 8).toUpperCase(), TICKET_TITLE: t.title, DOCUMENT_TYPE: label,
      VERSION: `v${v.version_number}`, STATUS: status, DATE: isoDate(v.created_at), AUTHOR: v.author_name ?? '—', CUSTOMER: customer, TECHNOLOGY: stacks, CONFIDENTIALITY: 'Confidential',
    },
    body: markdownToPm(v.content_md),
    blocks: {
      APPROVALS: approvalRows.length ? simpleTable(['Level', 'Approver', 'Decision', 'Date'], approvalRows) : simpleTable(['Level', 'Approver', 'Decision', 'Date'], [['—', 'Not yet approved', '', '']]),
      REVISIONS: simpleTable(['Version', 'Date', 'Author', 'Change'], versions.map((x) => [`v${x.version_number}`, isoDate(x.created_at), x.author_name ?? '—', x.change_note ?? ''])),
    },
  });
  await pool.query('INSERT INTO doc_exports (ticket_id, kind, version_number, exported_by) VALUES ($1,$2,$3,$4)', [ticketId, kind, v.version_number, user.id]);
  return { buffer: out.buffer, filename: `${kind}_${slug(t.title)}_v${v.version_number}.docx`, version: v.version_number, unknownTokens: out.unknownTokens };
}
