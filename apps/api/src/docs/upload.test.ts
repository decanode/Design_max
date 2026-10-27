import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import PizZip from 'pizzip';
import { pool } from '../db.js';
import { buildApp } from '../app.js';
import { TemplateGenerator } from './generator.js';
import { OutboxMailer } from './mailer.js';
import { makeUser, makeProject } from '../testAuth.js';
import { baseTemplate } from '../docgen/baseTemplate.js';
import { fillTemplate } from '../docgen/template.js';
import { markdownToPm } from '../docgen/pm.js';
import { splitSections, pairSections, normTitle } from '../docgen/sections.js';
import { importDocx } from '../docgen/importDocx.js';

const app = buildApp({ generator: new TemplateGenerator(), mailer: new OutboxMailer(), appUrl: 'http://app.test' });
let pid: string, ticket: string; let sam: any, reader: any;
beforeAll(async () => {
  await app.ready(); pid = await makeProject();
  sam = await makeUser('Admin', 'u', pid); reader = await makeUser('Customer', 'r', pid);
  ticket = (await pool.query(`INSERT INTO tickets (project_id, title, current_state) VALUES ($1,'Merge me','FS Drafted') RETURNING id`, [pid])).rows[0].id;
  await pool.query(`INSERT INTO documents (ticket_id, kind, version_number, content_md, author_name) VALUES ($1,'FS',1,$2,'x')`,
    [ticket, '# Functional Specification\n\n## 1. Business Requirement\nOriginal requirement text.\n\n## 2. Scope\nOriginal scope text.\n\n## 3. Acceptance Criteria\nOriginal criteria.']);
});
afterAll(async () => { await app.close(); await pool.end(); });

const call = async (who: { cookie: string }, method: 'GET' | 'POST', url: string, payload?: unknown) => {
  const r = await app.inject({ method, url, payload: payload as any, headers: { cookie: who.cookie } });
  return { status: r.statusCode, body: r.json() as any };
};
const word = (md: string) => fillTemplate(baseTemplate(), { tokens: {}, body: markdownToPm(md) }).buffer;
const b64 = (b: Buffer) => b.toString('base64');
const base = () => `/api/tickets/${ticket}/documents/FS`;

describe('section matching', () => {
  it('ignores numbering and punctuation, and pairs similar titles', () => {
    expect(normTitle('2.1  Business Requirement:')).toBe('business requirement');
    const d = splitSections(markdownToPm('## 1. Business Requirement\na\n\n## 2. Scope\nb'));
    const u = splitSections(markdownToPm('## Requirement (business)\nx\n\n## Scope\ny\n\n## Risks\nz'));
    const pairs = pairSections(d, u);
    expect(pairs.map((p) => p.match)).toEqual(['similar', 'exact', 'new']);
  });
});

describe('reading a Word file', () => {
  it('keeps headings, lists, tables and links, drops unsafe links, and refuses unsafe files', async () => {
    const { doc } = await importDocx(word('# T\n\n## Heading two\n\n- one\n- two\n\n| A | B |\n| - | - |\n| 1 | 2 |\n\n[ok](https://example.com) and [bad](javascript:alert(1))'));
    const types = JSON.stringify(doc);
    expect(types).toContain('"heading"'); expect(types).toContain('bulletList'); expect(types).toContain('"table"'); expect(types).toContain('https://example.com');
    expect(types).not.toContain('javascript:');
    await expect(importDocx(Buffer.from('not a zip at all'))).rejects.toThrow(/not a Word/);
    const z = new PizZip(word('x')); z.file('word/vbaProject.bin', 'x');
    await expect(importDocx(z.generate({ type: 'nodebuffer' }) as Buffer)).rejects.toThrow(/Macro/);
  });
});

describe('upload and merge', () => {
  it('proposes a per-section plan, merges only what was chosen, snapshots first, and syncs the draft', async () => {
    const file = word('## 1. Business Requirement\nRewritten by the consultant offline.\n\n## 2. Scope\nOriginal scope text.\n\n## 4. Risks\nVendor data quality.');
    const up = await call(sam, 'POST', `${base()}/upload`, { filename: 'mine.docx', docxBase64: b64(file) });
    expect(up.status).toBe(201);
    const by = (t: string) => up.body.sections.find((s: any) => s.title.includes(t));
    expect(by('Business Requirement')).toMatchObject({ match: 'exact' });
    expect(by('Risks')).toMatchObject({ match: 'new' });
    expect(by('Acceptance')).toMatchObject({ match: 'missing' });

    // nothing changed yet
    expect((await pool.query('SELECT count(*)::int n FROM documents WHERE ticket_id=$1', [ticket])).rows[0].n).toBe(1);

    const choices = { [by('Business Requirement').id]: 'upload', [by('Scope').id]: 'keep', [by('Risks').id]: 'upload' };
    const m = await call(sam, 'POST', `${base()}/upload/${up.body.uploadId}/merge`, { choices });
    expect(m.status).toBe(201);
    const v = (await pool.query('SELECT content_text, change_note FROM documents WHERE ticket_id=$1 ORDER BY version_number DESC LIMIT 1', [ticket])).rows[0];
    expect(v.change_note).toMatch(/Merged from mine.docx/);
    expect(v.content_text).toContain('Rewritten by the consultant offline.');
    expect(v.content_text).not.toContain('Original requirement text.');
    expect(v.content_text).toContain('Original criteria.');                 // sections only in the draft are kept
    expect(v.content_text).toContain('Additional sections'); expect(v.content_text).toContain('Vendor data quality.');

    // the shared draft follows the merged version, and the same upload cannot be merged twice
    expect((await call(sam, 'GET', `${base()}/draft-status`)).body.changed).toBe(false);
    expect((await call(sam, 'POST', `${base()}/upload/${up.body.uploadId}/merge`, { choices })).status).toBe(409);
  });

  it('keeps unsaved team edits as a version before merging', async () => {
    const { resetDraft } = await import('../collab/server.js');
    await resetDraft(pid, ticket, 'FS', markdownToPm('## 1. Business Requirement\nTeam edit not yet saved.'));
    const up = await call(sam, 'POST', `${base()}/upload`, { filename: 'again.docx', docxBase64: b64(word('## 1. Business Requirement\nFrom file.')) });
    const before = (await pool.query('SELECT max(version_number) v FROM documents WHERE ticket_id=$1', [ticket])).rows[0].v as number;
    await call(sam, 'POST', `${base()}/upload/${up.body.uploadId}/merge`, { choices: { [up.body.sections[0].id]: 'append' } });
    const rows = (await pool.query('SELECT version_number, content_text, change_note FROM documents WHERE ticket_id=$1 AND version_number > $2 ORDER BY version_number', [ticket, before])).rows;
    expect(rows[0].change_note).toBe('Before merging an uploaded file'); expect(rows[0].content_text).toContain('Team edit not yet saved.');
    expect(rows[1].content_text).toContain('Team edit not yet saved.'); expect(rows[1].content_text).toContain('From file.');   // "append" keeps both
  });

  it('needs edit access, rejects bad files, and respects the lock', async () => {
    const good = b64(word('## x\ny'));
    expect((await call(reader, 'POST', `${base()}/upload`, { filename: 'a.docx', docxBase64: good })).status).toBe(403);
    expect((await call(sam, 'POST', `${base()}/upload`, { filename: 'a.docx', docxBase64: Buffer.from('plain text file'.repeat(20)).toString('base64') })).status).toBe(400);
    await pool.query(`UPDATE tickets SET current_state='FS Approved' WHERE id=$1`, [ticket]);
    expect((await call(sam, 'POST', `${base()}/upload`, { filename: 'a.docx', docxBase64: good })).status).toBe(409);
  });
});
