import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pool } from '../db.js';
import { buildApp } from '../app.js';
import { TemplateGenerator } from './generator.js';
import { OutboxMailer } from './mailer.js';
import { makeUser, makeProject, makeWorkflow, makeCustomUser } from '../testAuth.js';

const app = buildApp({ generator: new TemplateGenerator(), mailer: new OutboxMailer(), appUrl: 'http://app.test' });
let pid: string, ticket: string; let lead: any, sam: any, admin: any, mgr: any, outsider: any;
beforeAll(async () => {
  await app.ready(); pid = await makeProject();
  lead = await makeUser('Lead', 'lead', pid); sam = await makeUser('Consultant', 'sam', pid); admin = await makeUser('Admin', 'adm', pid); mgr = await makeUser('Manager', 'mgr', pid);
  await makeWorkflow({ projectId: pid, levels: [{ users: [mgr.id] }] });
  ticket = (await pool.query(`INSERT INTO tickets (project_id, title, current_state, consultant_id) VALUES ($1,'Review me','FS Drafted',$2) RETURNING id`, [pid, sam.id])).rows[0].id;
  await pool.query(`INSERT INTO documents (ticket_id, kind, version_number, content_text, author_name) VALUES ($1,'FS',1,'Hello world','x')`, [ticket]);
  outsider = await makeUser('Lead', 'out', await makeProject());
});
afterAll(async () => { await app.close(); await pool.end(); });

const call = async (who: { cookie: string }, method: 'GET' | 'POST' | 'PATCH' | 'PUT', url: string, payload?: unknown) => {
  const r = await app.inject({ method, url, payload: payload as any, headers: { cookie: who.cookie } });
  return { status: r.statusCode, body: r.json() as any };
};
const base = () => `/api/tickets/${ticket}/documents/FS`;
const mailsTo = async (email: string) => (await pool.query('SELECT subject, body FROM email_outbox WHERE to_email=$1 ORDER BY id', [email])).rows;

describe('review comments', () => {
  let rootId: string;
  it('lets a lead comment on a selection, notifies the consultant, and the consultant sees the thread', async () => {
    const c = await call(lead, 'POST', `${base()}/comments`, { body: 'Please define "world".', quote: 'world', anchor: { from: { a: 1 }, to: { a: 2 } }, mentions: [mgr.id] });
    expect(c.status).toBe(201); rootId = c.body.id;
    expect((await mailsTo(sam.email)).some((m) => m.subject.includes('Comment on Functional Specification'))).toBe(true);
    expect((await mailsTo(mgr.email)).some((m) => m.body.includes('mentioned'))).toBe(true);
    const list = await call(sam, 'GET', `${base()}/comments`);
    expect(list.body.unresolved).toBe(1);
    expect(list.body.threads[0]).toMatchObject({ body: 'Please define "world".', quote: 'world', status: 'open', author: 'Lead lead' });
  });

  it('supports replies; the editor marks addressed but cannot resolve; the reviewer resolves; a reply reopens', async () => {
    expect((await call(sam, 'POST', `${base()}/comments`, { body: 'Defined in section 2.', parentId: rootId })).status).toBe(201);
    expect((await mailsTo(lead.email)).some((m) => m.subject.startsWith('Reply'))).toBe(true);
    expect((await call(sam, 'PATCH', `/api/doc-comments/${rootId}`, { status: 'resolved' })).status).toBe(403);
    expect((await call(sam, 'PATCH', `/api/doc-comments/${rootId}`, { status: 'addressed' })).body.status).toBe('addressed');
    expect((await mailsTo(lead.email)).some((m) => m.subject.startsWith('Comment addressed'))).toBe(true);
    expect((await call(lead, 'PATCH', `/api/doc-comments/${rootId}`, { status: 'resolved' })).body).toMatchObject({ status: 'resolved', resolvedBy: 'Lead lead' });
    expect((await call(sam, 'GET', `${base()}/comments`)).body.unresolved).toBe(0);
    await call(lead, 'POST', `${base()}/comments`, { body: 'Actually still unclear.', parentId: rootId });
    const t = (await call(sam, 'GET', `${base()}/comments`)).body;
    expect(t.threads[0].status).toBe('open'); expect(t.threads[0].replies).toHaveLength(2);
  });

  it('reviews: cannot pass while comments are open; changes requested notifies; only reviewers may', async () => {
    expect((await call(lead, 'POST', `${base()}/reviews`, { decision: 'looks_good' })).status).toBe(409);
    expect((await call(sam, 'POST', `${base()}/reviews`, { decision: 'changes_requested' })).status).toBe(403);
    expect((await call(lead, 'POST', `${base()}/reviews`, { decision: 'changes_requested', note: 'See comments' })).status).toBe(201);
    expect((await mailsTo(sam.email)).some((m) => m.subject.startsWith('Changes requested'))).toBe(true);
    await call(lead, 'PATCH', `/api/doc-comments/${rootId}`, { status: 'resolved' });
    expect((await call(lead, 'POST', `${base()}/reviews`, { decision: 'looks_good' })).status).toBe(201);
    expect((await call(sam, 'GET', `${base()}/reviews`)).body.map((r: any) => r.decision)).toEqual(['looks_good', 'changes_requested']);
  });

  it('can block approval requests while comments are unresolved (a project choice, off by default)', async () => {
    const open = await call(lead, 'POST', `${base()}/comments`, { body: 'One more thing.' });
    expect((await call(admin, 'POST', `/api/tickets/${ticket}/approvals`, { kind: 'FS' })).status).toBe(201);   // default: allowed
    await call(admin, 'POST', `/api/tickets/${ticket}/approvals/cancel`, { kind: 'FS' });
    expect((await call(admin, 'PUT', '/api/project/doc-settings', { blockApprovalOnOpenComments: true })).status).toBe(200);
    const blocked = await call(admin, 'POST', `/api/tickets/${ticket}/approvals`, { kind: 'FS' });
    expect(blocked.status).toBe(409); expect(blocked.body.error).toMatch(/open review comment/);
    await call(lead, 'PATCH', `/api/doc-comments/${open.body.id}`, { status: 'resolved' });
    await call(lead, 'PATCH', `/api/doc-comments/${rootId}`, { status: 'resolved' });
    expect((await call(admin, 'POST', `/api/tickets/${ticket}/approvals`, { kind: 'FS' })).status).toBe(201);
  });

  it('respects permissions and project isolation', async () => {
    const reader = await makeCustomUser(['spec.view', 'ticket.view_all'], {}, pid);
    expect((await call(reader, 'GET', `${base()}/comments`)).status).toBe(200);
    expect((await call(reader, 'POST', `${base()}/comments`, { body: 'x' })).status).toBe(403);   // can read, not comment
    expect((await call(outsider, 'GET', `${base()}/comments`)).status).toBe(404);
    expect((await call(outsider, 'PATCH', `/api/doc-comments/${rootId}`, { status: 'open' })).status).toBe(404);
  });
});
