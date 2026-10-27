import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import PizZip from 'pizzip';
import { XMLValidator } from 'fast-xml-parser';
import { pool } from '../db.js';
import { buildApp } from '../app.js';
import { TemplateGenerator } from './../docs/generator.js';
import { HashEmbedder } from '../etl/vectorize.js';
import { createTicket } from '../tickets.js';
import { addMember, makeCustomUser, makeProject, makeUser, makeWorkflow, tokenSentTo, type TestUser } from '../testAuth.js';

const app = buildApp({ generator: new TemplateGenerator(), embedder: new HashEmbedder() });
let alpha: string, beta: string, consultant: TestUser, manager: TestUser, customer: TestUser, outsider: TestUser, ticket: string, title: string;

const call = (u: TestUser | null, method: 'GET' | 'POST' | 'PATCH', url: string, payload?: unknown) =>
  app.inject({ method, url, payload: payload as any, headers: u ? { cookie: u.cookie } : {} });
const docx = (r: { rawPayload: Buffer }) => {
  const z = new PizZip(r.rawPayload);
  return { z, text: (n: string) => z.file(n)!.asText(), all: Object.keys(z.files).map((f) => (/\.(xml|rels)$/.test(f) ? z.file(f)!.asText() : '')).join('\n') };
};

beforeAll(async () => {
  await app.ready();
  alpha = await makeProject('Acme Rollout'); beta = await makeProject('Other Co');
  [consultant, manager, customer] = await Promise.all([makeUser('Consultant', undefined, alpha), makeUser('Manager', undefined, alpha), makeUser('Customer', undefined, alpha)]);
  outsider = await makeUser('Consultant', undefined, beta);
  await makeWorkflow({ projectId: alpha, levels: [{ users: [manager.id] }] });
  title = `Vendor "block" & <more> ${Date.now()}`;
  ticket = (await createTicket(alpha, title)).id;
  await pool.query('UPDATE tickets SET consultant_id=$2, customer_id=$3 WHERE id=$1', [ticket, consultant.id, customer.id]);
  await call(consultant, 'POST', `/api/tickets/${ticket}/documents/generate`, { kind: 'FS' });
  await call(consultant, 'POST', `/api/tickets/${ticket}/documents/FS/versions`, { content: '# Functional Specification\n\n## Scope\nBlock **vendor Acme** on every PO.\n\n| Field | Rule |\n|---|---|\n| LIFNR | must exist |\n\n- [x] reviewed\n', baseVersion: 1, note: 'second pass' });
});
afterAll(async () => { await app.close(); await pool.end(); });

describe('downloading a document as DOCX', () => {
  it('returns a valid Word file named after the document and version, with the project\'s details and content', async () => {
    const r = await call(consultant, 'GET', `/api/tickets/${ticket}/documents/FS/export`);
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toBe('application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    expect(r.headers['content-disposition']).toMatch(/^attachment; filename="FS_Vendor-block-more-\d+_v2\.docx"$/);   // safe characters only
    expect(r.headers['cache-control']).toBe('no-store');
    const d = docx(r);
    for (const name of Object.keys(d.z.files).filter((f) => /\.(xml|rels)$/.test(f))) expect(XMLValidator.validate(d.text(name)), name).toBe(true);
    const doc = d.text('word/document.xml');
    expect(doc).toContain('Functional Specification');
    expect(doc).toContain('Block ');
    expect(doc).toContain('vendor Acme');
    expect(doc).toContain('LIFNR'); expect(doc).toContain('☒');                                   // the table and the ticked checklist item
    expect(doc).toContain('Vendor &quot;block&quot; &amp; &lt;more&gt;');                              // the awkward title is escaped, not interpreted
    expect(doc).not.toContain('{{');
    expect(d.text('word/header1.xml')).toContain('Acme Rollout');
    expect(d.text('docProps/core.xml')).toContain('Functional Specification: Vendor');
  });

  it('builds the front matter from real history: revisions from saved versions, approvals from the approval timeline', async () => {
    const before = docx(await call(consultant, 'GET', `/api/tickets/${ticket}/documents/FS/export`)).text('word/document.xml');
    expect(before).toContain('Not yet approved'); expect(before).toContain('second pass'); expect(before).toContain('>Draft<');
    // approve version 2 through the real workflow
    await call(consultant, 'POST', `/api/tickets/${ticket}/approvals`, { kind: 'FS' });
    const token = await tokenSentTo(manager.email, 'Vendor');
    expect((await app.inject({ method: 'POST', url: `/api/approvals/${token}/decision`, payload: { decision: 'approved' } })).statusCode).toBe(200);
    const after = docx(await call(consultant, 'GET', `/api/tickets/${ticket}/documents/FS/export`)).text('word/document.xml');
    expect(after).toContain('>Approved<'); expect(after).toContain('Manager '); expect(after).not.toContain('Not yet approved');
    expect(after).toMatch(/>L1</);
    // an older version is marked as such and still downloads
    const v1 = docx(await call(consultant, 'GET', `/api/tickets/${ticket}/documents/FS/export?version=1`)).text('word/document.xml');
    expect(v1).toContain('>Superseded<'); expect(v1).toContain('>v1<');
    expect((await call(consultant, 'GET', `/api/tickets/${ticket}/documents/FS/export?version=99`)).statusCode).toBe(404);
    expect((await call(consultant, 'GET', `/api/tickets/${ticket}/documents/FS/export?version=abc`)).statusCode).toBe(400);
  });

  it('is limited to people who can see the ticket and read specifications; another project\'s document does not exist for you', async () => {
    const path = `/api/tickets/${ticket}/documents/FS/export`;
    expect((await call(null, 'GET', path)).statusCode).toBe(401);
    expect((await call(outsider, 'GET', path)).statusCode).toBe(404);
    const noSpec = await makeCustomUser(['board.view', 'ticket.view_all'], {}, alpha);
    expect((await call(noSpec, 'GET', path)).statusCode).toBe(403);
    expect((await call(customer, 'GET', path)).statusCode).toBe(200);                                  // Customers may read specifications of their own tickets
    const other = await makeUser('Customer', undefined, alpha);
    expect((await call(other, 'GET', path)).statusCode).toBe(404);                                     // …but not someone else's ticket
    expect((await call(consultant, 'GET', `/api/tickets/${ticket}/documents/TS/export`)).statusCode).toBe(404);   // no TS yet
    expect((await call(consultant, 'GET', `/api/tickets/${ticket}/documents/XX/export`)).statusCode).toBe(400);
  });

  it('keeps ticket-field access: a role that cannot read the customer does not get the customer\'s name in the file', async () => {
    const reader = await makeCustomUser(['board.view', 'ticket.view_all', 'spec.view'], { title: 'read' }, alpha);   // customer field stays hidden
    const withName = docx(await call(consultant, 'GET', `/api/tickets/${ticket}/documents/FS/export`)).text('word/document.xml');
    const without = docx(await call(reader, 'GET', `/api/tickets/${ticket}/documents/FS/export`)).text('word/document.xml');
    expect(withName).toContain('Customer ');                                                            // the customer's display name ("Customer xxxxxx")
    expect(without).not.toMatch(/Customer [a-z0-9]{6}/);
  });

  it('records every download (who, which document, which version)', async () => {
    const n = async () => (await pool.query('SELECT count(*)::int n FROM doc_exports WHERE ticket_id=$1 AND exported_by=$2', [ticket, manager.id])).rows[0].n;
    const before = await n();
    await call(manager, 'GET', `/api/tickets/${ticket}/documents/FS/export?version=2`);
    expect(await n()).toBe(before + 1);
    const row = (await pool.query('SELECT kind, version_number, format FROM doc_exports WHERE ticket_id=$1 AND exported_by=$2 ORDER BY id DESC LIMIT 1', [ticket, manager.id])).rows[0];
    expect(row).toEqual({ kind: 'FS', version_number: 2, format: 'docx' });
    await call(outsider, 'GET', `/api/tickets/${ticket}/documents/FS/export`);                          // a refused download leaves no record
    expect((await pool.query('SELECT 1 FROM doc_exports WHERE exported_by=$1', [outsider.id])).rowCount).toBe(0);
  });
});
