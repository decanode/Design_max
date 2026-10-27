import { baseTemplate } from './baseTemplate.js';
import { markdownToPm } from './pm.js';
import { simpleTable } from './ooxml.js';
import { fillTemplate } from './template.js';
import { DOC_LABEL } from './exportDocument.js';
import { docNumber, typographyOf, type DocSettings } from '../docs/settings.js';

const SAMPLE = `## 1. Business Requirement
Blocked vendors must not appear in the purchase order value help.

## 2. Scope
- Purchase orders of type **NB** and **FO**
- Vendors blocked for *purchasing organisation* or *company code*

## 3. Acceptance Criteria
| ID | Criterion |
| --- | --- |
| AC-1 | A blocked vendor is not offered in the value help |
| AC-2 | Unblocking restores the vendor immediately |

> Sample text. Real documents are generated from the ticket.`;

/** A throwaway document in the project's look, so an admin can see a settings change before it reaches real documents. */
export function sampleDocument(kind: string, cfg: DocSettings, projectName: string, template: Buffer = baseTemplate()) {
  const label = DOC_LABEL[kind] ?? kind;
  const out = fillTemplate(template, {
    title: `${label}: Sample`, typography: typographyOf(cfg),
    tokens: {
      PROJECT_NAME: cfg.displayName || projectName, CLIENT_NAME: cfg.clientName || 'Sample Client', HEADER_TEXT: cfg.headerText, FOOTER_TEXT: cfg.footerText,
      DOC_NUMBER: docNumber(cfg.docNumberFormat, { project: cfg.displayName || projectName, ticket: 'A1B2C3D4', type: kind, version: 1 }),
      TICKET_ID: 'A1B2C3D4', TICKET_TITLE: 'Block vendors in PO value help', DOCUMENT_TYPE: label, VERSION: 'v1', STATUS: 'Draft', DATE: new Date().toISOString().slice(0, 10),
      AUTHOR: 'Sample Author', CUSTOMER: 'Sample Customer', TECHNOLOGY: 'SAP', CONFIDENTIALITY: cfg.confidentiality,
    },
    body: markdownToPm(SAMPLE),
    blocks: {
      APPROVALS: simpleTable(['Level', 'Approver', 'Decision', 'Date'], [['L1', 'Sample Approver', 'Approved', new Date().toISOString().slice(0, 10)]]),
      REVISIONS: simpleTable(['Version', 'Date', 'Author', 'Change'], [['v1', new Date().toISOString().slice(0, 10), 'Sample Author', 'Initial draft']]),
    },
  });
  return { buffer: out.buffer, filename: `${kind}_sample.docx` };
}
