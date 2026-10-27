import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import PizZip from 'pizzip';
import { pool } from '../db.js';
import { buildApp } from '../app.js';
import { TemplateGenerator } from './generator.js';
import { OutboxMailer } from './mailer.js';
import { makeUser, makeProject } from '../testAuth.js';
import { baseTemplate } from '../docgen/baseTemplate.js';
import { stackKey } from '../docgen/templateLibrary.js';

const app = buildApp({ generator: new TemplateGenerator(), mailer: new OutboxMailer(), appUrl: 'http://app.test' });
let pid: string; let sup: any, mgr: any, ticket: string;
beforeAll(async () => {
  await app.ready(); pid = await makeProject();
  sup = await makeUser('Admin', undefined, pid); mgr = await makeUser('Manager', undefined, pid);
  ticket = (await pool.query(`INSERT INTO tickets (project_id, title, current_state) VALUES ($1,'T','FS Drafted') RETURNING id`, [pid])).rows[0].id;
  await pool.query(`INSERT INTO documents (ticket_id, kind, version_number, content_text, author_name) VALUES ($1,'FS',1,'Body text','x')`, [ticket]);
  await pool.query(`DELETE FROM doc_templates`);
});
afterAll(async () => { await pool.query(`DELETE FROM doc_templates`); await app.close(); await pool.end(); });

const call = async (who: { cookie: string }, method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: unknown) => {
  const r = await app.inject({ method, url, payload: payload as any, headers: { cookie: who.cookie } });
  return { status: r.statusCode, body: r.headers['content-type']?.toString().includes('json') ? r.json() as any : r.rawPayload };
};
const custom = (marker: string, mutate?: (z: PizZip) => void) => {
  const z = new PizZip(baseTemplate());
  z.file('word/document.xml', z.file('word/document.xml')!.asText().replace('<w:body>', `<w:body><w:p><w:r><w:t>${marker}</w:t></w:r></w:p>`));
  mutate?.(z);
  return (z.generate({ type: 'nodebuffer' }) as Buffer).toString('base64');
};
const upload = (docxBase64: string, o: Record<string, unknown> = {}) => call(sup, 'POST', '/api/platform/doc-templates', { stack: 'sap', docType: 'FS', name: 'SAP FS', docxBase64, ...o });
const exportFs = async () => new PizZip((await call(sup, 'GET', `/api/tickets/${ticket}/documents/FS/export`)).body as Buffer).file('word/document.xml')!.asText();

describe('template library', () => {
  it('maps technology names to template sets', () => {
    expect(['SAP ABAP', '.NET', 'Java', 'Node.js', 'COBOL'].map(stackKey)).toEqual(['sap', 'dotnet', 'java', 'node', 'generic']);
  });

  it('is Super Admin only', async () => {
    expect((await call(mgr, 'GET', '/api/platform/doc-templates')).status).toBe(403);
    expect((await call(mgr, 'PUT', '/api/platform/doc-defaults', { bodyFont: 'Arial' })).status).toBe(403);
  });

  it('rejects unsafe or unusable files with a clear reason', async () => {
    expect((await upload(Buffer.from('hello world, definitely not a docx'.repeat(5)).toString('base64'))).status).toBe(400);
    const noBody = await upload(custom('x', (z) => z.file('word/document.xml', z.file('word/document.xml')!.asText().replace('{{BODY}}', ''))));
    expect(noBody.status).toBe(400); expect(noBody.body.error).toMatch(/\{\{BODY\}\}/);
    const macro = await upload(custom('x', (z) => z.file('word/vbaProject.bin', 'macro')));
    expect(macro.status).toBe(400); expect(macro.body.error).toMatch(/macros/);
  });

  it('uses the uploaded design for that stack only, versions it, and falls back when removed', async () => {
    expect(await exportFs()).not.toContain('SAP-DESIGN-1');
    await call(sup, 'PUT', '/api/project/doc-settings', { templateStack: 'sap' });
    const a = await upload(custom('SAP-DESIGN-1')); expect(a.status).toBe(201); expect(a.body.version).toBe(1);
    expect(await exportFs()).toContain('SAP-DESIGN-1');
    const b = await upload(custom('SAP-DESIGN-2')); expect(b.body.version).toBe(2);
    expect(await exportFs()).toContain('SAP-DESIGN-2'); expect(await exportFs()).not.toContain('SAP-DESIGN-1');

    await call(sup, 'PUT', '/api/project/doc-settings', { templateStack: 'java' });
    expect(await exportFs()).not.toContain('SAP-DESIGN');                       // another stack keeps its own (here the built-in)
    await upload(custom('GENERIC-DESIGN'), { stack: 'generic' });
    expect(await exportFs()).toContain('GENERIC-DESIGN');                       // no Java template -> the generic one

    await call(sup, 'PUT', '/api/project/doc-settings', { templateStack: 'sap' });
    const list = (await call(sup, 'GET', '/api/platform/doc-templates')).body.templates as any[];
    const v1 = list.find((t) => t.stack === 'sap' && t.version === 1);
    await call(sup, 'POST', `/api/platform/doc-templates/${v1.id}/activate`);
    expect(await exportFs()).toContain('SAP-DESIGN-1');                         // roll back to the earlier version
    expect(((await call(sup, 'GET', `/api/platform/doc-templates/${v1.id}/download`)).body as Buffer).subarray(0, 2).toString()).toBe('PK');
  });

  it('platform defaults sit under project settings', async () => {
    await call(sup, 'PUT', '/api/platform/doc-defaults', { headingFont: 'Georgia', confidentiality: 'Internal' });
    const s = (await call(sup, 'GET', '/api/project/doc-settings')).body.settings;
    expect(s).toMatchObject({ headingFont: 'Georgia', confidentiality: 'Internal' });
    await call(sup, 'PUT', '/api/project/doc-settings', { confidentiality: 'Client confidential' });
    expect((await call(sup, 'GET', '/api/project/doc-settings')).body.settings).toMatchObject({ headingFont: 'Georgia', confidentiality: 'Client confidential' });
    await pool.query(`UPDATE platform_doc_defaults SET settings='{}' WHERE id=1`);
  });
});
