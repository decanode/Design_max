import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pool } from '../db.js';
import { buildApp } from '../app.js';
import { TemplateGenerator } from '../docs/generator.js';
import { applyTransition } from '../tickets.js';
import { makeUser, makeWorkflow } from '../testAuth.js';
import { encryptSecret } from './secrets.js';
import { runSync, type ConnectionRow } from './sync.js';
import { drainConnection } from './outbox.js';
import { enqueueEvent, renderTemplate } from './writeback.js';
import type { Connector, SourceTicket } from './types.js';

const app = buildApp({ generator: new TemplateGenerator() });
type U = Awaited<ReturnType<typeof makeUser>>;
let sup: U;
beforeAll(async () => { await app.ready(); sup = await makeUser('Admin'); });
afterAll(async () => { await app.close(); await pool.end(); });
const call = async (u: { cookie: string }, method: 'GET' | 'POST' | 'PUT' | 'PATCH', url: string, payload?: unknown) => {
  const r = await app.inject({ method, url, payload: payload as any, headers: { cookie: u.cookie } });
  let body: any; try { body = r.json(); } catch { body = r.body; }
  return { status: r.statusCode, body };
};

const src = (key = 'P-1', over: Partial<SourceTicket> = {}): SourceTicket => ({ source: 'jira', key, type: 'Bug', title: `Title ${key}`, description: 'Body', status: 'In Progress', priority: 'High', comments: [], attachments: [], createdAt: '2024-01-01T08:00:00Z', updatedAt: '2024-01-05T08:00:00Z', history: [], ...over });
const feed = (list: SourceTicket[]): Connector => ({ test: async () => ({ detail: 'ok' }), async *pull() { for (const t of list) yield t; } });

/** A fake source tool that records every call made to it. */
function fakeSource(opts: { now?: { status: string; updatedAt: string }; failStatus?: boolean } = {}) {
  const calls: { op: string; args: any }[] = [];
  const conn: Connector = {
    test: async () => ({ detail: 'ok' }), async *pull() { /* none */ },
    current: async () => { calls.push({ op: 'current', args: null }); return opts.now ?? { status: 'In Progress', updatedAt: '2024-01-05T08:00:00Z' }; },
    transitionTo: async (ref, status) => { if (opts.failStatus) throw new Error('Jira answered 503'); calls.push({ op: 'status', args: { ref, status } }); return { detail: `Moved ${ref.key} to ${status}` }; },
    addComment: async (ref, body) => { calls.push({ op: 'comment', args: { ref, body } }); return { detail: 'ok' }; },
    attach: async (ref, file) => { calls.push({ op: 'attach', args: { ref, filename: file.filename, bytes: file.data.length } }); return { detail: 'ok' }; },
  };
  return { conn, calls };
}

async function setup(mode = 'connected', live = true) {
  const r = await call(sup, 'POST', '/api/platform/projects', { name: `WB ${Math.random().toString(36).slice(2, 7)}`, operatingMode: mode, projectTypeId: (await pool.query("SELECT id FROM project_types WHERE key='support'")).rows[0].id });
  const pid = r.body.id as string; const pa = await makeUser('Project Admin', undefined, pid);
  const id = (await pool.query(`INSERT INTO integration_connections (project_id, kind, name, base_url, username, secret_enc, writeback_enabled, dry_run) VALUES ($1,'jira','c','https://j.test','u',$2,$3,$4) RETURNING id`, [pid, encryptSecret('x'), live, !live])).rows[0].id as string;
  const c: ConnectionRow = (await pool.query('SELECT * FROM integration_connections WHERE id=$1', [id])).rows[0];
  await runSync(c, { connector: feed([src()]) });
  const ticketId = (await pool.query(`SELECT id FROM tickets WHERE project_id=$1 AND legacy_id='P-1'`, [pid])).rows[0].id as string;
  return { pid, pa, c, ticketId };
}
const rules = (pa: U, id: string, list: unknown[]) => call(pa, 'PUT', `/api/project/integrations/${id}/rules`, { rules: list });
const move = async (ticketId: string, to: string) => { const cl = await pool.connect(); try { await cl.query('BEGIN'); await applyTransition(cl, ticketId, to); await cl.query('COMMIT'); } catch (e) { await cl.query('ROLLBACK'); throw e; } finally { cl.release(); } };
const queue = async (ticketId: string) => (await pool.query('SELECT action, status, payload, dry_run, last_error, result FROM outbound_queue WHERE ticket_id=$1 ORDER BY created_at', [ticketId])).rows;

describe('rules', () => {
  it('fills a comment template and ignores unknown placeholders', () => {
    expect(renderTemplate('{{ticket.key}} reached {{phase}}. {{nope}}', { 'ticket.key': 'P-1', phase: 'Resolved' })).toBe('P-1 reached Resolved.');
  });
  it('are checked when saved, and only the allowed people can switch sending on', async () => {
    const { pa, c } = await setup();
    expect((await rules(pa, c.id, [{ event: 'phase_entered', action: 'status', params: {} }])).body.details?.[0]?.message ?? (await rules(pa, c.id, [{ event: 'phase_entered', action: 'status', params: {} }])).body.error).toMatch(/status/i);
    expect((await rules(pa, c.id, [{ event: 'phase_entered', action: 'comment', params: { template: '' } }])).status).toBe(400);
    expect((await rules(pa, c.id, [{ event: 'ticket_closed', action: 'attach', params: {} }])).status).toBe(400);
    expect((await rules(pa, c.id, [{ event: 'phase_entered', action: 'status', params: { phase: 'Resolved', status: 'Done' } }, { event: 'document_approved', action: 'attach', params: { docKind: 'TUT' } }])).status).toBe(200);
    expect((await call(pa, 'PUT', `/api/project/integrations/${c.id}/writeback`, { enabled: true })).status).toBe(403);
    expect((await call(pa, 'PUT', `/api/project/integrations/${c.id}/writeback`, { dryRun: false })).status).toBe(403);
    expect((await call(pa, 'PUT', `/api/project/integrations/${c.id}/writeback`, { enabled: false })).status).toBe(200);          // anyone who manages the project can stop it
  });
  it('are refused outright in Mirror and Full projects', async () => {
    for (const mode of ['mirror', 'full']) { const { pa, c } = await setup(mode, false); expect((await rules(pa, c.id, [])).status).toBe(409); expect((await call(pa, 'PUT', `/api/project/integrations/${c.id}/writeback`, { enabled: true })).status).toBe(409); }
  });
});

describe('sending outcomes back', () => {
  it('queues with the change that caused it, sends once, and sets our record of the source status', async () => {
    const { pa, c, ticketId } = await setup();
    await rules(pa, c.id, [{ event: 'phase_entered', action: 'status', params: { phase: 'Resolved', status: 'Done' } }, { event: 'phase_entered', action: 'comment', params: { phase: 'Resolved', template: '{{ticket.key}} is resolved in {{phase}}.' } }]);
    await move(ticketId, 'Resolved');
    expect((await queue(ticketId)).map((q) => [q.action, q.status]).sort()).toEqual([['comment', 'pending'], ['status', 'pending']]);
    const { conn, calls } = fakeSource();
    expect(await drainConnection(c, { connector: conn })).toMatchObject({ sent: 2, skipped: 0, failed: 0 });
    expect(calls.filter((x) => x.op !== 'current')).toEqual(expect.arrayContaining([{ op: 'status', args: { ref: { key: 'P-1', type: 'Bug' }, status: 'Done' } }, { op: 'comment', args: { ref: { key: 'P-1', type: 'Bug' }, body: 'P-1 is resolved in Resolved.' } }]));
    expect((await pool.query('SELECT source_status FROM tickets WHERE id=$1', [ticketId])).rows[0].source_status).toBe('Done');
    expect((await drainConnection(c, { connector: conn })).sent).toBe(0);                                                                      // nothing is sent twice
  });

  it('a change that is rolled back sends nothing, and the same event never queues twice', async () => {
    const { pa, c, ticketId } = await setup();
    await rules(pa, c.id, [{ event: 'phase_entered', action: 'comment', params: { template: 'moved to {{phase}}' } }]);
    const cl = await pool.connect();
    try { await cl.query('BEGIN'); await applyTransition(cl, ticketId, 'Resolved'); await cl.query('ROLLBACK'); } finally { cl.release(); }
    expect(await queue(ticketId)).toEqual([]);
    const cl2 = await pool.connect();
    try { await cl2.query('BEGIN'); const ev = { type: 'phase_entered' as const, ticketId, phase: 'Resolved', eventKey: 'same' }; expect(await enqueueEvent(cl2, ev)).toBe(1); expect(await enqueueEvent(cl2, ev)).toBe(0); await cl2.query('COMMIT'); } finally { cl2.release(); }
  });

  it('a trial run (dry run) sends nothing and says what it would have sent', async () => {
    const { pa, c, ticketId } = await setup('connected', false);
    await pool.query('UPDATE integration_connections SET writeback_enabled=true WHERE id=$1', [c.id]);
    await rules(pa, c.id, [{ event: 'phase_entered', action: 'status', params: { phase: 'Resolved', status: 'Done' } }]);
    await move(ticketId, 'Resolved');
    const { conn, calls } = fakeSource();
    expect(await drainConnection(c, { connector: conn })).toMatchObject({ sent: 0, skipped: 1 });
    expect(calls).toEqual([]);
    expect((await queue(ticketId))[0]).toMatchObject({ status: 'skipped', dry_run: true, result: { dryRun: true, wouldSend: { action: 'status', payload: { status: 'Done' } } } });
  });

  it('does not overwrite what someone changed in the source since we last read it', async () => {
    const { pa, c, ticketId } = await setup();
    await rules(pa, c.id, [{ event: 'phase_entered', action: 'status', params: { phase: 'Resolved', status: 'Done' } }]);
    await move(ticketId, 'Resolved');
    const { conn, calls } = fakeSource({ now: { status: 'Blocked', updatedAt: '2024-02-01T00:00:00Z' } });
    expect(await drainConnection(c, { connector: conn })).toMatchObject({ sent: 0, skipped: 1 });
    expect(calls.some((x) => x.op === 'status')).toBe(false);
    expect((await queue(ticketId))[0].result.reason).toMatch(/changed since we last read it/);
    expect((await pool.query('SELECT out_of_sync FROM tickets WHERE id=$1', [ticketId])).rows[0].out_of_sync).toBe(true);
  });

  it('retries a failing send with growing gaps, then stops and waits for a person, who can retry it', async () => {
    const { pa, c, ticketId } = await setup();
    await rules(pa, c.id, [{ event: 'phase_entered', action: 'status', params: { phase: 'Resolved', status: 'Done' } }]);
    await move(ticketId, 'Resolved');
    const { conn } = fakeSource({ failStatus: true });
    let now = new Date();
    for (let i = 1; i <= 5; i++) { expect(await drainConnection(c, { connector: conn, now })).toMatchObject({ retry: 1 }); now = new Date(now.getTime() + 61 * 60_000); }
    expect(await drainConnection(c, { connector: conn, now })).toMatchObject({ failed: 1 });
    const q = (await queue(ticketId))[0]; expect(q).toMatchObject({ status: 'failed', last_error: 'Jira answered 503' });
    const id = (await pool.query('SELECT id FROM outbound_queue WHERE ticket_id=$1', [ticketId])).rows[0].id;
    expect((await call(pa, 'POST', `/api/project/integrations/queue/${id}/retry`)).status).toBe(200);
    const ok = fakeSource(); expect((await drainConnection(c, { connector: ok.conn })).sent).toBe(1);
  });

  it('the kill switch, a paused ticket and leaving Connected mode each stop everything', async () => {
    const { pid, pa, c, ticketId } = await setup();
    await rules(pa, c.id, [{ event: 'phase_entered', action: 'comment', params: { template: 'hello' } }]);
    await move(ticketId, 'Pending');
    await call(pa, 'PUT', `/api/project/integrations/${c.id}/writeback`, { enabled: false });
    const { conn, calls } = fakeSource();
    expect((await drainConnection(c, { connector: conn })).sent).toBe(0); expect(calls).toEqual([]);                                         // off: nothing leaves
    await pool.query('UPDATE integration_connections SET writeback_enabled=true WHERE id=$1', [c.id]);
    expect((await call(pa, 'POST', `/api/tickets/${ticketId}/writeback-pause`, { paused: true })).status).toBe(200);
    await move(ticketId, 'In Progress');                                                                                                      // no new items while paused
    expect((await queue(ticketId)).length).toBe(1);
    expect((await drainConnection(c, { connector: conn })).skipped).toBe(1);                                                                // the old one is skipped, not sent
    expect(calls).toEqual([]);
    await pool.query(`UPDATE outbound_queue SET status='pending' WHERE ticket_id=$1`, [ticketId]);
    await call(sup, 'PATCH', `/api/platform/projects/${pid}`, { operatingMode: 'mirror' });
    expect((await queue(ticketId))[0].status).toBe('cancelled');
    expect((await pool.query('SELECT writeback_enabled FROM integration_connections WHERE id=$1', [c.id])).rows[0].writeback_enabled).toBe(false);
  });

  it('a Mirror project can never queue anything, whatever rules exist', async () => {
    const { pid, c, ticketId } = await setup('mirror', false);
    await pool.query(`INSERT INTO writeback_rules (connection_id, project_id, event, action, params) VALUES ($1,$2,'phase_entered','comment','{"template":"x"}')`, [c.id, pid]);
    await pool.query('UPDATE integration_connections SET writeback_enabled=true, dry_run=false WHERE id=$1', [c.id]);
    await move(ticketId, 'Pending');
    expect(await queue(ticketId)).toEqual([]);
  });

  it('attaches the approved document when it is approved, and never an unapproved one', async () => {
    const { pid, pa, c, ticketId } = await setup();
    const manager = await makeUser('Manager', undefined, pid);
    await pool.query('UPDATE approval_workflows SET active=false WHERE project_id=$1', [pid]);
    await makeWorkflow({ projectId: pid, kinds: ['TUT'], levels: [{ users: [manager.id] }] });
    await rules(pa, c.id, [{ event: 'document_approved', action: 'attach', params: { docKind: 'TUT' } }, { event: 'document_approved', action: 'comment', params: { docKind: 'TUT', template: '{{doc}} approved for {{ticket.key}}' } }]);
    expect((await call(pa, 'POST', `/api/tickets/${ticketId}/documents/generate`, { kind: 'TUT' })).status).toBe(201);
    expect((await call(pa, 'POST', `/api/tickets/${ticketId}/approvals`, { kind: 'TUT' })).status).toBe(201);
    expect(await queue(ticketId)).toEqual([]);                                                                                                // requested is not approved
    const task = (await call(manager, 'GET', '/api/my/approvals')).body.find((a: any) => a.ticket_id === ticketId);
    expect((await call(manager, 'POST', `/api/my/approvals/${task.id}/decision`, { decision: 'approved' })).status).toBe(200);
    expect((await queue(ticketId)).map((q) => q.action).sort()).toEqual(['attach', 'comment']);
    const { conn, calls } = fakeSource();
    expect(await drainConnection(c, { connector: conn })).toMatchObject({ sent: 2 });
    const att = calls.find((x) => x.op === 'attach')!.args;
    expect(att.filename).toMatch(/^TUT_.*_v1\.docx$/); expect(att.bytes).toBeGreaterThan(1000);
    expect(calls.find((x) => x.op === 'comment')!.args.body).toBe('Unit Test approved for P-1');
  });
});
