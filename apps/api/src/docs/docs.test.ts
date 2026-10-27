import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pool } from '../db.js';
import { buildApp } from '../app.js';
import { TemplateGenerator, LlmGenerator } from './generator.js';
import { OutboxMailer } from './mailer.js';
import { diffLines } from './diff.js';
import { createTicket } from '../tickets.js';
import { makeUser } from '../testAuth.js';
import { HashEmbedder } from '../etl/vectorize.js';

const app = buildApp({ generator: new TemplateGenerator(), mailer: new OutboxMailer(), embedder: new HashEmbedder(), appUrl: 'http://app.test' });
let projectId: string;
let cookie: string;
beforeAll(async () => { await app.ready(); cookie = (await makeUser('Admin')).cookie; projectId = (await pool.query("INSERT INTO projects(name) VALUES('docs') RETURNING id")).rows[0].id; });
afterAll(async () => { await app.close(); await pool.end(); });

const call = async (method: 'GET' | 'POST', url: string, payload?: unknown) => {
  const r = await app.inject({ method, url, payload: payload as any, headers: { cookie } });
  return { status: r.statusCode, body: r.json() as any };
};
const newTicket = async (title = 'Block vendor') => (await createTicket(projectId, title, 'Customer wants vendors blocked')).id as string;
const state = async (id: string) => (await pool.query('SELECT current_state s FROM tickets WHERE id=$1', [id])).rows[0].s;
const tokenFor = async (to: string) => {
  const mail = (await pool.query('SELECT body FROM email_outbox WHERE to_email=$1 ORDER BY id DESC LIMIT 1', [to])).rows[0];
  return mail.body.match(/\/approve\/([\w-]+)/)[1] as string;
};

describe('diff', () => {
  it('reports adds, deletes and unchanged lines', () => {
    expect(diffLines('a\nb\nc', 'a\nx\nc')).toEqual([
      { type: 'same', text: 'a' }, { type: 'del', text: 'b' }, { type: 'add', text: 'x' }, { type: 'same', text: 'c' }]);
  });
});

describe('gated lifecycle', () => {
  it('blocks skipping the FS / approval steps through the generic transition endpoint', async () => {
    const id = await newTicket();
    const r = await call('POST', `/api/tickets/${id}/transition`, { to: 'FS Drafted' });
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/Generate the Functional Specification/);
    expect(await state(id)).toBe('Requirement Verified');
  });

  it('runs FS: generate -> edit -> approve, then TS: generate -> approve', async () => {
    const id = await newTicket('Full flow');
    const gen = await call('POST', `/api/tickets/${id}/documents/generate`, { kind: 'FS' });
    expect(gen.status).toBe(201);
    expect(gen.body.content_md).toContain('# Functional Specification: Full flow');
    expect(await state(id)).toBe('FS Drafted');

    // cannot generate twice, cannot request TS yet
    expect((await call('POST', `/api/tickets/${id}/documents/generate`, { kind: 'FS' })).status).toBe(409);
    expect((await call('POST', `/api/tickets/${id}/documents/generate`, { kind: 'TS' })).status).toBe(409);

    // versioned edit with optimistic concurrency
    const v2 = await call('POST', `/api/tickets/${id}/documents/FS/versions`, { content: gen.body.content_md + '\nExtra line', baseVersion: 1, author: 'Bob', note: 'added line' });
    expect(v2.status).toBe(201);
    expect(v2.body.version_number).toBe(2);
    const stale = await call('POST', `/api/tickets/${id}/documents/FS/versions`, { content: 'other', baseVersion: 1, author: 'Eve' });
    expect(stale.status).toBe(409);
    expect(stale.body.latestVersion).toBe(2);
    const diff = await call('GET', `/api/tickets/${id}/documents/FS/diff?from=1&to=2`);
    expect(diff.body.filter((l: any) => l.type === 'add').map((l: any) => l.text)).toEqual(['Extra line']);

    // approval request -> email -> approve
    expect((await call('POST', `/api/tickets/${id}/approvals`, { kind: 'FS', approverEmail: 'not-an-email' })).status).toBe(400);
    expect((await call('POST', `/api/tickets/${id}/approvals`, { kind: 'FS', approverEmail: 'Mgr@Corp.com' })).status).toBe(201);
    expect((await call('POST', `/api/tickets/${id}/approvals`, { kind: 'FS', approverEmail: 'mgr@corp.com' })).status).toBe(409); // already pending
    const token = await tokenFor('mgr@corp.com');
    const view = await call('GET', `/api/approvals/${token}`);
    expect(view.body).toMatchObject({ kind: 'FS', version: 2, status: 'pending' });
    expect(view.body.content).toContain('Extra line');
    expect((await call('POST', `/api/approvals/${token}/decision`, { decision: 'approved' })).status).toBe(200);
    expect(await state(id)).toBe('FS Approved');

    // single-use, and the FS is now locked
    expect((await call('POST', `/api/approvals/${token}/decision`, { decision: 'approved' })).status).toBe(409);
    expect((await call('POST', `/api/tickets/${id}/documents/FS/versions`, { content: 'late', baseVersion: 2, author: 'x' })).status).toBe(409);

    // TS
    const ts = await call('POST', `/api/tickets/${id}/documents/generate`, { kind: 'TS' });
    expect(ts.body.content_md).toContain('Extra line'); // built from the approved FS
    expect(await state(id)).toBe('TS Drafted');
    await call('POST', `/api/tickets/${id}/approvals`, { kind: 'TS', approverEmail: 'arch@corp.com' });
    expect((await call('POST', `/api/approvals/${await tokenFor('arch@corp.com')}/decision`, { decision: 'approved' })).status).toBe(200);
    expect(await state(id)).toBe('TS Approved');
    // the normal ungated path continues
    expect((await call('POST', `/api/tickets/${id}/transition`, { to: 'Development' })).status).toBe(200);

    const o = await call('GET', `/api/tickets/${id}`);
    expect(o.body.docs.FS.versions).toHaveLength(2);
    expect(o.body.approvals.map((a: any) => a.status)).toEqual(expect.arrayContaining(['approved']));
  });

  it('rejection needs a reason, keeps the ticket drafted, and a new request is allowed after edits', async () => {
    const id = await newTicket('Reject flow');
    await call('POST', `/api/tickets/${id}/documents/generate`, { kind: 'FS' });
    await call('POST', `/api/tickets/${id}/approvals`, { kind: 'FS', approverEmail: 'rej@corp.com' });
    const t1 = await tokenFor('rej@corp.com');
    expect((await call('POST', `/api/approvals/${t1}/decision`, { decision: 'rejected' })).status).toBe(400);
    expect((await call('POST', `/api/approvals/${t1}/decision`, { decision: 'rejected', comment: 'Missing scope' })).status).toBe(200);
    expect(await state(id)).toBe('FS Drafted');
    expect((await call('GET', `/api/approvals/${t1}`)).body).toMatchObject({ status: 'rejected', comment: 'Missing scope' });
    expect((await call('POST', `/api/approvals/${t1}/decision`, { decision: 'approved' })).status).toBe(409);
    expect((await call('POST', `/api/tickets/${id}/approvals`, { kind: 'FS', approverEmail: 'rej@corp.com' })).status).toBe(201);
  });

  it('editing after requesting approval voids the old link', async () => {
    const id = await newTicket('Supersede');
    await call('POST', `/api/tickets/${id}/documents/generate`, { kind: 'FS' });
    await call('POST', `/api/tickets/${id}/approvals`, { kind: 'FS', approverEmail: 'sup@corp.com' });
    const tok = await tokenFor('sup@corp.com');
    await call('POST', `/api/tickets/${id}/documents/FS/versions`, { content: 'changed text', baseVersion: 1, author: 'Bob' });
    const r = await call('POST', `/api/approvals/${tok}/decision`, { decision: 'approved' });
    expect(r.status).toBe(410);
    expect(await state(id)).toBe('FS Drafted');
  });

  it('expired and unknown tokens are refused', async () => {
    const id = await newTicket('Expiry');
    await call('POST', `/api/tickets/${id}/documents/generate`, { kind: 'FS' });
    await call('POST', `/api/tickets/${id}/approvals`, { kind: 'FS', approverEmail: 'exp@corp.com' });
    const tok = await tokenFor('exp@corp.com');
    await pool.query(`UPDATE approvals SET expires_at = now() - interval '1 day' WHERE ticket_id=$1`, [id]);
    expect((await call('POST', `/api/approvals/${tok}/decision`, { decision: 'approved' })).status).toBe(410);
    expect((await call('GET', `/api/approvals/${'x'.repeat(43)}`)).status).toBe(404);
    expect(await state(id)).toBe('FS Drafted');
  });

  it('document revisions are immutable in the database', async () => {
    const id = await newTicket('Immutable');
    await call('POST', `/api/tickets/${id}/documents/generate`, { kind: 'FS' });
    await expect(pool.query("UPDATE documents SET content_md='x' WHERE ticket_id=$1", [id])).rejects.toThrow(/immutable/);
    await expect(pool.query('DELETE FROM documents WHERE ticket_id=$1', [id])).rejects.toThrow(/immutable/);
  });

  it('concurrent generate creates a single v1', async () => {
    const id = await newTicket('Race');
    const rs = await Promise.all([1, 2].map(() => call('POST', `/api/tickets/${id}/documents/generate`, { kind: 'FS' })));
    expect(rs.map((r) => r.status).sort()).toEqual([201, 409]);
  });
});

describe('LlmGenerator', () => {
  it('passes ticket + FS context to the model and rejects empty output', async () => {
    let seen = '';
    const g = new LlmGenerator({ complete: async (_s, u) => { seen = u; return '# Doc'; } });
    expect(await g.generate('TS', { title: 'T', summary: 'S', transcript: ['hello'], fs: 'APPROVED FS', knowledge: ['[git] a: b'] })).toBe('# Doc');
    expect(seen).toContain('APPROVED FS'); expect(seen).toContain('[git] a: b'); expect(seen).toContain('hello');
    await expect(new LlmGenerator({ complete: async () => '  ' }).generate('FS', { title: 'T', summary: 'S', transcript: [] })).rejects.toThrow(/empty/);
  });
});
