import PizZip from 'pizzip';
import { XMLValidator } from 'fast-xml-parser';
import { pool } from '../db.js';
import { DocError } from '../errors.js';
import { baseTemplate } from './baseTemplate.js';
import { fillTemplate } from './template.js';
import { markdownToPm } from './pm.js';

export const MAX_TEMPLATE_BYTES = 10 * 1024 * 1024;
export const TOKENS = ['PROJECT_NAME', 'CLIENT_NAME', 'HEADER_TEXT', 'FOOTER_TEXT', 'DOC_NUMBER', 'TICKET_ID', 'TICKET_TITLE', 'DOCUMENT_TYPE', 'VERSION', 'STATUS', 'DATE', 'AUTHOR', 'CUSTOMER', 'TECHNOLOGY', 'CONFIDENTIALITY'];
const STACK_KEY: [RegExp, string][] = [[/sap|abap/i, 'sap'], [/\.net|dotnet|c#/i, 'dotnet'], [/java|spring/i, 'java'], [/node|javascript|typescript/i, 'node']];
/** Which template set a technology stack name uses. */
export const stackKey = (name: string | undefined) => STACK_KEY.find(([re]) => name && re.test(name))?.[1] ?? 'generic';

/** Rejects files that are not safe, usable Word templates and reports what the template does and does not provide. */
export function validateTemplate(buf: Buffer) {
  if (buf.length > MAX_TEMPLATE_BYTES) throw new DocError('The template is larger than 10 MB', 413);
  if (buf.subarray(0, 2).toString() !== 'PK') throw new DocError('This is not a Word (.docx) file', 400);
  let zip: PizZip;
  try { zip = new PizZip(buf); } catch { throw new DocError('This is not a valid Word (.docx) file', 400); }
  const names = Object.keys(zip.files);
  if (names.length > 400) throw new DocError('The template has too many parts', 400);
  if (!zip.file('word/document.xml') || !zip.file('[Content_Types].xml')) throw new DocError('This is not a Word (.docx) file', 400);
  if (names.some((n) => /vbaProject|\.bin$|activeX|embeddings\//i.test(n))) throw new DocError('Templates with macros or embedded objects are not allowed. Save the file as .docx without macros.', 400);
  if (/encrypted/i.test(zip.file('[Content_Types].xml')!.asText()) || names.includes('EncryptedPackage')) throw new DocError('Password-protected templates cannot be used', 400);
  if (names.some((n) => /\.rels$/.test(n) && /TargetMode="External"/.test(zip.file(n)!.asText()) && /attachedTemplate|oleObject|externalLink/i.test(zip.file(n)!.asText())))
    throw new DocError('Templates that link to external files are not allowed', 400);
  for (const n of names.filter((x) => /\.(xml|rels)$/.test(x))) { const ok = XMLValidator.validate(zip.file(n)!.asText()); if (ok !== true) throw new DocError(`The template is damaged (${n}: ${ok.err.msg})`, 400); }
  const probe = 'TEMPLATE_PROBE_BODY';
  const filled = fillTemplate(buf, { tokens: {}, body: markdownToPm(probe) });
  if (!new PizZip(filled.buffer).file('word/document.xml')!.asText().includes(probe))
    throw new DocError('The template has no {{BODY}} line. Put {{BODY}} alone on its own paragraph where the content should go.', 400);
  const unknownTokens = filled.unknownTokens.filter((t) => !TOKENS.includes(t) && t !== 'BODY');
  return { unknownTokens };
}

/** The Word design to use for a document: this stack's template, else the generic one, else the built-in stand-in. */
export async function pickTemplate(stack: string | null, kind: string): Promise<{ buffer: Buffer; source: string }> {
  const rows = (await pool.query(
    `SELECT docx, name, version, stack FROM doc_templates WHERE active AND doc_type=$1 AND (stack IS NOT DISTINCT FROM $2 OR stack IS NULL) ORDER BY (stack IS NULL) ASC LIMIT 1`, [kind, stack === 'generic' ? null : stack])).rows;
  return rows[0] ? { buffer: rows[0].docx as Buffer, source: `${rows[0].name} v${rows[0].version}` } : { buffer: baseTemplate(), source: 'built-in' };
}
