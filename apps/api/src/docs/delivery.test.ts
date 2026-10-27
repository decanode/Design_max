import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pool } from '../db.js';
import { buildApp } from '../app.js';
import { TemplateGenerator } from './generator.js';
import { OutboxMailer } from './mailer.js';
import { makeUser, makeWorkflow, makeProject, tokenSentTo } from '../testAuth.js';
import { effectiveSettings, docNumber, BUILT_IN } from './settings.js';

const app = buildApp({ generator: new TemplateGenerator(), mailer: new OutboxMailer(), appUrl: 'http://app.test' });
let projectId: string; let admin: Awaited<ReturnType<typeof makeUser>>; let mgr: Awaited<ReturnType<typeof makeUser>>;
beforeAll(async () => {
  await app.ready();
  projectId = await makeProject();
  admin = await makeUser('Admin', undefined, projectId); mgr = await makeUser('Manager', undefined, projectId);
  await makeWorkflow({ projectId, kinds: ['FS', 'TS', 'TUT', 'CRC'], levels: [{ users: [mgr.id] }] });
});
afterAll(async () => { await app.close(); await pool.end(); });

const call = async (method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown) => {
  const r = await app.inject({ method, url, payload: payload as any, headers: { cookie: admin.cookie } });
  return { status: r.statusCode, body: r.json() as any };
};
const ticketIn = async (state: string, fsText?: string, tsText?: string) => {
  const id = (await pool.query(`INSERT INTO tickets (project_id, title, current_state, ai_summary) VALUES ($1,'Delivery',$2,'Summary') RETURNING id`, [projectId, state])).rows[0].id as string;
  for (const [k, t] of [['FS', fsText], ['TS', tsText]] as const) if (t) await pool.query(`INSERT INTO documents (ticket_id, kind, version_number, content_text, content_json, author_name) VALUES ($1,$2,1,$3,$4,'x')`, [id, k, t, JSON.stringify({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: t }] }] })]);
  return id;
};
const approve = async (id: string, kind: string) => {
  expect((await call('POST', `/api/tickets/${id}/approvals`, { kind })).status).toBe(201);
  const token = await tokenSentTo(mgr.email);
  expect((await app.inject({ method: 'POST', url: `/api/approvals/${token}/decision`, payload: { decision: 'approved' } })).statusCode).toBe(200);
};

describe('TUT and CRC', () => {
  it('only generate in delivery, trace FS criteria and TS objects, and lock once approved', async () => {
    const early = await ticketIn('FS Approved');
    expect((await call('POST', `/api/tickets/${early}/documents/generate`, { kind: 'TUT' })).status).toBe(409);

    const id = await ticketIn('Development', '## Acceptance Criteria\n- Blocked vendor cannot be paid\n- Unblock restores payment', '## Design\n- Report ZVENDOR_BLOCK\n- Interface to bank');
    const tut = await call('POST', `/api/tickets/${id}/documents/generate`, { kind: 'TUT' });
    expect(tut.status).toBe(201);
    expect(tut.body.content_md).toContain('Blocked vendor cannot be paid');
    expect(tut.body.content_md).toContain('TC-02');
    expect((await call('POST', `/api/tickets/${id}/documents/generate`, { kind: 'TUT' })).status).toBe(409);   // one per ticket; edit instead
    const crc = await call('POST', `/api/tickets/${id}/documents/generate`, { kind: 'CRC' });
    expect(crc.body.content_md).toMatch(/ZVENDOR_BLOCK/);
    expect(crc.body.content_md).toMatch(/Error handling and retry/);   // interface-specific check added
    expect((await pool.query('SELECT current_state s FROM tickets WHERE id=$1', [id])).rows[0].s).toBe('Development');   // no ticket move

    expect((await call('POST', `/api/tickets/${id}/documents/TUT/versions`, { content: tut.body.content_md + '\nmore', baseVersion: 1 })).status).toBe(201);
    await approve(id, 'TUT');
    expect((await call('POST', `/api/tickets/${id}/documents/TUT/versions`, { content: 'late', baseVersion: 2 })).status).toBe(409);   // locked
    expect((await call('GET', `/api/tickets/${id}`)).body.docs.TUT.latest.content_md).toContain('more');
  });
});

describe('QA gate', () => {
  it('is off by default, and when on requires approved TUT and CRC', async () => {
    const free = await ticketIn('Development');
    expect((await call('POST', `/api/tickets/${free}/transition`, { to: 'QA' })).status).toBe(200);

    expect((await call('PUT', '/api/project/doc-settings', { qaGate: true })).body.settings.qaGate).toBe(true);
    const id = await ticketIn('Development', '## Acceptance Criteria\n- A', '## Design\n- B');
    const blocked = await call('POST', `/api/tickets/${id}/transition`, { to: 'QA' });
    expect(blocked.status).toBe(409); expect(blocked.body.error).toMatch(/TUT and CRC/);
    await call('POST', `/api/tickets/${id}/documents/generate`, { kind: 'TUT' }); await call('POST', `/api/tickets/${id}/documents/generate`, { kind: 'CRC' });
    await approve(id, 'TUT');
    expect((await call('POST', `/api/tickets/${id}/transition`, { to: 'QA' })).body.error).toMatch(/CRC/);
    await approve(id, 'CRC');
    expect((await call('POST', `/api/tickets/${id}/transition`, { to: 'QA' })).status).toBe(200);
    await call('PUT', '/api/project/doc-settings', { qaGate: false });
  });
});

describe('document settings', () => {
  it('layers built-in < platform < project, validates, and reaches the Word file', async () => {
    expect((await effectiveSettings(projectId)).bodyFont).toBe(BUILT_IN.bodyFont);
    await pool.query(`UPDATE platform_doc_defaults SET settings='{"bodyFont":"Arial"}' WHERE id=1`);
    try {
      expect((await effectiveSettings(projectId)).bodyFont).toBe('Arial');
      const put = await call('PUT', '/api/project/doc-settings', { displayName: 'Acme Rollout', headingFont: 'Georgia', bodySize: 10 });
      expect(put.body.settings).toMatchObject({ bodyFont: 'Arial', headingFont: 'Georgia', bodySize: 10, displayName: 'Acme Rollout' });
      expect((await call('PUT', '/api/project/doc-settings', { bodyFont: 'Comic Sans' })).status).toBe(400);
      expect((await call('PUT', '/api/project/doc-settings', { bodySize: 40 })).status).toBe(400);
      expect((await call('PUT', '/api/project/doc-settings', { docNumberFormat: 'nothing' })).status).toBe(400);
      const id = await ticketIn('Development', 'x');
      const r = await app.inject({ method: 'GET', url: `/api/tickets/${id}/documents/FS/export`, headers: { cookie: admin.cookie } });
      expect(r.statusCode).toBe(200);
      const PizZip = (await import('pizzip')).default;
      const z = new PizZip(r.rawPayload);
      expect(z.file('word/document.xml')!.asText()).toContain('Acme Rollout');
      expect(z.file('word/styles.xml')!.asText()).toContain('Georgia');
    } finally { await pool.query(`UPDATE platform_doc_defaults SET settings='{}' WHERE id=1`); }
  });
  it('formats document numbers', () => {
    expect(docNumber('{PROJECT}-{TICKET}-{TYPE}-{VERSION}', { project: 'Acme Rollout', ticket: 'AB12', type: 'TS', version: 3 })).toBe('ACMEROLLOUT-AB12-TS-v3');
  });
});
