import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pool } from '../db.js';
import { buildApp } from '../app.js';
import { makeUser } from '../testAuth.js';
import { decryptSecret, encryptSecret } from './secrets.js';
import { validateBaseUrl } from './url.js';
import { JiraConnector } from './jira.js';
import { ServiceNowConnector } from './servicenow.js';
import { runSync, toneOf, priorityOf, type ConnectionRow } from './sync.js';
import type { Connector, SourceTicket } from './types.js';

describe('credentials and addresses', () => {
  it('encrypts secrets, never the same way twice, and refuses tampering', () => {
    const a = encryptSecret('tok-123'), b = encryptSecret('tok-123');
    expect(a).not.toBe(b); expect(a).not.toContain('tok-123'); expect(decryptSecret(a)).toBe('tok-123');
    expect(() => decryptSecret(a.slice(0, -4) + 'AAAA')).toThrow();
  });
  it('accepts a plain address and rejects credentials in it', () => {
    expect(validateBaseUrl('https://acme.atlassian.net/')).toBe('https://acme.atlassian.net');
    expect(() => validateBaseUrl('https://u:p@acme.atlassian.net')).toThrow(/credentials/);
    expect(() => validateBaseUrl('not a url')).toThrow(/valid URL/);
    expect(() => validateBaseUrl('ftp://x.test')).toThrow();
  });
  it('production refuses http and private networks', () => {
    const old = process.env.NODE_ENV; process.env.NODE_ENV = 'production';
    try { expect(() => validateBaseUrl('http://acme.test')).toThrow(/https/); expect(() => validateBaseUrl('https://10.0.0.5')).toThrow(/private/); expect(() => validateBaseUrl('https://localhost')).toThrow(/private/); expect(validateBaseUrl('https://acme.test')).toBe('https://acme.test'); }
    finally { process.env.NODE_ENV = old; }
  });
  it('guesses what a status means and maps priorities', () => {
    expect(['Done', 'Closed', 'In Progress', 'In Review', 'Backlog', 'Ready for design'].map(toneOf)).toEqual(['done', 'done', 'build', 'review', 'intake', 'spec']);
    expect(['Highest', 'High', 'Medium', 'Low', undefined, '1', '4'].map(priorityOf)).toEqual(['Critical', 'High', 'Medium', 'Low', 'Medium', 'Critical', 'Low']);
  });
});

/* ------------------------------------------------------------------ connectors against pretend servers */
const adf = (t: string) => ({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: t }] }] });
const issue = (n: number, status: string) => ({ key: `P-${n}`, fields: { summary: `Issue ${n}`, description: adf(`Body ${n}`), status: { name: status }, issuetype: { name: 'Bug' }, priority: { name: 'High' }, duedate: '2030-05-01',
  reporter: { accountId: 'r1', emailAddress: 'Rita@Corp.com', displayName: 'Rita' }, assignee: { accountId: 'a1', displayName: 'Al' }, created: '2024-03-01T09:00:00.000+0000', updated: `2024-03-0${n + 1}T09:00:00.000+0000`,
  comment: { comments: [{ id: `c${n}`, author: { accountId: 'a1', displayName: 'Al' }, body: adf('hello'), created: '2024-03-02T09:00:00.000+0000' }] }, attachment: [] },
  changelog: { histories: [{ created: '2024-03-02T10:00:00.000+0000', author: { displayName: 'Al' }, items: [{ field: 'status', fromString: 'To Do', toString: 'In Progress' }, { field: 'assignee', toString: 'x' }] }] } });

describe('Jira connector', () => {
  it('pages with nextPageToken, narrows by update time, reads history, and survives a rate limit', async () => {
    const seen: URL[] = []; let limited = true;
    const f: typeof fetch = async (input) => {
      const u = new URL(String(input)); seen.push(u);
      if (u.pathname.endsWith('/myself')) return Response.json({ displayName: 'Integration bot' });
      if (limited) { limited = false; return new Response('', { status: 429, headers: { 'retry-after': '0' } }); }
      return u.searchParams.get('nextPageToken') ? Response.json({ issues: [issue(2, 'Done')], isLast: true }) : Response.json({ issues: [issue(1, 'To Do')], nextPageToken: 't2', isLast: false });
    };
    const c = new JiraConnector({ baseUrl: 'https://j.test', username: 'me@corp.com', secret: 'tok', config: { jql: 'project = P ORDER BY created' }, fetch: f });
    expect((await c.test()).detail).toContain('Integration bot');
    const all: SourceTicket[] = []; for await (const t of c.pull('2024-03-01T09:30:00Z')) all.push(t);
    expect(all.map((t) => t.key)).toEqual(['P-1', 'P-2']);
    const jql = seen.find((u) => u.searchParams.has('jql'))!.searchParams.get('jql')!;
    expect(jql).toContain('(project = P)'); expect(jql).toContain('updated >= "2024-03-01 09:30"'); expect(jql).toMatch(/ORDER BY updated ASC$/);
    expect(all[0]).toMatchObject({ source: 'jira', status: 'To Do', priority: 'High', dueDate: '2030-05-01', url: 'https://j.test/browse/P-1', description: 'Body 1', reporter: { email: 'Rita@Corp.com' } });
    expect(all[0].history).toEqual([{ at: '2024-03-02T10:00:00.000+0000', from: 'To Do', to: 'In Progress', actor: 'Al' }]);
    expect(all[0].comments[0]).toMatchObject({ id: 'jira:P-1:c1', body: 'hello' });
  });
  it('talks to Data Center with startAt paging', async () => {
    const f: typeof fetch = async (input) => { const u = new URL(String(input)); const start = Number(u.searchParams.get('startAt')); expect(u.pathname).toBe('/rest/api/2/search'); return Response.json({ total: 2, issues: [issue(start + 1, 'Open')] }); };
    const c = new JiraConnector({ baseUrl: 'https://dc.test', username: '', secret: 'pat', config: { flavor: 'datacenter', pageSize: 1 }, fetch: f });
    const keys: string[] = []; for await (const t of c.pull(null)) keys.push(t.key);
    expect(keys).toEqual(['P-1', 'P-2']);
  });
  it('reports a refusal plainly', async () => {
    const c = new JiraConnector({ baseUrl: 'https://j.test', username: 'a', secret: 'b', config: {}, fetch: async () => new Response('', { status: 401, statusText: 'Unauthorized' }) });
    await expect(c.test()).rejects.toThrow(/401/);
  });
});

describe('ServiceNow connector', () => {
  it('reads only what changed, names states, and tolerates a closed audit table', async () => {
    const queries: string[] = [];
    const f: typeof fetch = async (input) => {
      const u = new URL(String(input)); const q = u.searchParams.get('sysparm_query') ?? ''; const json = (result: unknown) => Response.json({ result });
      queries.push(`${u.pathname}?${q}`);
      if (u.pathname.endsWith('/sys_user')) return json([{ sys_id: 'u1', email: 'carol@corp.com', name: 'Carol' }]);
      if (u.pathname.endsWith('/sys_journal_field') || u.pathname.endsWith('/attachment')) return json([]);
      if (u.pathname.endsWith('/sys_audit')) return new Response('', { status: 403, statusText: 'Forbidden' });
      if (u.pathname.endsWith('/incident')) return json([{ sys_id: 's1', number: 'INC1', short_description: 'Printer', state: '6', priority: '2', caller_id: { value: 'u1' }, sys_created_on: '2024-02-01 08:00:00', sys_updated_on: '2024-02-03 09:30:00' }]);
      return json([]);
    };
    const c = new ServiceNowConnector({ baseUrl: 'https://snow.test', username: 'u', secret: 'p', config: { tables: ['incident'] }, fetch: f });
    const out: SourceTicket[] = []; for await (const t of c.pull('2024-02-03T09:00:00Z')) out.push(t);
    expect(out[0]).toMatchObject({ key: 'INC1', status: 'Resolved', priority: 'High', createdAt: '2024-02-01T08:00:00Z', reporter: { email: 'carol@corp.com' }, history: [] });
    expect(queries.find((x) => x.includes('/incident'))).toContain('sys_updated_on>=2024-02-03 09:00:00');
  });
});

/* ------------------------------------------------------------------ the sync itself */
const app = buildApp();
let sup: Awaited<ReturnType<typeof makeUser>>;
beforeAll(async () => { await app.ready(); sup = await makeUser('Admin'); });
afterAll(async () => { await app.close(); await pool.end(); });
const call = async (u: { cookie: string }, method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: unknown) => {
  const r = await app.inject({ method, url, payload: payload as any, headers: { cookie: u.cookie } });
  let body: any; try { body = r.json(); } catch { body = r.body; }
  return { status: r.statusCode, body };
};
async function mirrorProject(mode = 'mirror') {
  const r = await call(sup, 'POST', '/api/platform/projects', { name: `Sync ${Math.random().toString(36).slice(2, 7)}`, operatingMode: mode, projectTypeId: (await pool.query("SELECT id FROM project_types WHERE key='support'")).rows[0].id });
  const pid = r.body.id as string; const pa = await makeUser('Project Admin', undefined, pid);
  return { pid, pa };
}
async function connection(pid: string, extra: Record<string, unknown> = {}): Promise<ConnectionRow> {
  const id = (await pool.query(`INSERT INTO integration_connections (project_id, kind, name, base_url, username, secret_enc) VALUES ($1,'jira',$2,'https://j.test','me',$3) RETURNING id`, [pid, `conn-${Math.random().toString(36).slice(2, 6)}`, encryptSecret('x')])).rows[0].id;
  void extra;
  return (await pool.query('SELECT * FROM integration_connections WHERE id=$1', [id])).rows[0];
}
const ticket = (key: string, over: Partial<SourceTicket> = {}): SourceTicket => ({ source: 'jira', key, type: 'Bug', title: `Title ${key}`, description: 'Body', status: 'In Progress', priority: 'High', reporter: { id: 'r1', email: 'rita@corp.com', name: 'Rita' }, assignee: { id: 'a1', name: 'Al' },
  comments: [{ id: `jira:${key}:1`, body: 'hi', createdAt: '2024-01-02T00:00:00Z', author: { id: 'a1' } }], attachments: [], createdAt: '2024-01-01T08:00:00Z', updatedAt: '2024-01-05T08:00:00Z', url: `https://j.test/browse/${key}`,
  history: [{ at: '2024-01-02T08:00:00Z', from: 'To Do', to: 'In Progress', actor: 'Al' }, { at: '2024-01-04T08:00:00Z', from: 'In Progress', to: 'Done' }], ...over });
const feed = (list: () => SourceTicket[]): Connector => ({ test: async () => ({ detail: 'ok' }), async *pull() { for (const t of list()) yield t; } });

describe('mirroring tickets', () => {
  it('brings tickets in with their dates, source status, history and people, without giving anyone access', async () => {
    const { pid } = await mirrorProject(); const c = await connection(pid);
    const r = await runSync(c, { connector: feed(() => [ticket('P-1'), ticket('P-2', { status: 'Done' })]) });
    expect(r).toMatchObject({ created: 2, updated: 0, unchanged: 0, failed: 0, fullScan: true });
    const t = (await pool.query(`SELECT * FROM tickets WHERE project_id=$1 AND legacy_id='P-1'`, [pid])).rows[0];
    expect(t).toMatchObject({ source_status: 'In Progress', priority: 'High', legacy_source: 'jira', connection_id: c.id, source_url: 'https://j.test/browse/P-1', current_state: 'In Progress' });
    expect(t.created_at.toISOString()).toBe('2024-01-01T08:00:00.000Z');                                     // it was created then, not when we pulled it
    expect((await pool.query(`SELECT current_state FROM tickets WHERE legacy_id='P-2' AND project_id=$1`, [pid])).rows[0].current_state).toMatch(/Closed|Resolved/);   // a done status lands in a done-ish phase
    expect((await pool.query('SELECT to_status FROM ticket_source_history WHERE ticket_id=$1 ORDER BY at', [t.id])).rows.map((x) => x.to_status)).toEqual(['In Progress', 'Done']);
    expect((await pool.query('SELECT created_at FROM ticket_transitions WHERE ticket_id=$1 AND from_state IS NULL', [t.id])).rows[0].created_at.toISOString()).toBe('2024-01-01T08:00:00.000Z');
    const people = (await pool.query('SELECT active, (SELECT count(*)::int FROM project_members m WHERE m.user_id=u.id) AS member_of FROM users u WHERE id IN ($1,$2)', [t.customer_id, t.consultant_id])).rows;
    expect(people.every((p) => p.active === false && p.member_of === 0)).toBe(true);
    expect((await pool.query('SELECT count(*)::int n FROM ticket_comments WHERE ticket_id=$1', [t.id])).rows[0].n).toBe(1);
  });

  it('is safe to run again: unchanged tickets are skipped, changes update the source side but never our own status', async () => {
    const { pid } = await mirrorProject(); let c = await connection(pid);
    let list = [ticket('P-1')];
    await runSync(c, { connector: feed(() => list) });
    const id = (await pool.query(`SELECT id FROM tickets WHERE legacy_id='P-1' AND project_id=$1`, [pid])).rows[0].id;
    c = (await pool.query('SELECT * FROM integration_connections WHERE id=$1', [c.id])).rows[0];
    expect(await runSync(c, { connector: feed(() => list) })).toMatchObject({ created: 0, updated: 0, unchanged: 1 });
    await pool.query(`UPDATE tickets SET current_state='Triage' WHERE id=$1`, [id]).catch(() => {});             // someone works it locally
    const local = (await pool.query('SELECT current_state FROM tickets WHERE id=$1', [id])).rows[0].current_state;
    list = [ticket('P-1', { title: 'Renamed', status: 'Done', updatedAt: '2024-02-01T00:00:00Z' })];
    expect(await runSync(c, { connector: feed(() => list) })).toMatchObject({ created: 0, updated: 1 });
    const after = (await pool.query('SELECT title, source_status, current_state FROM tickets WHERE id=$1', [id])).rows[0];
    expect(after).toMatchObject({ title: 'Renamed', source_status: 'Done', current_state: local });             // the source moved; our status stays ours
    expect((await pool.query('SELECT count(*)::int n FROM ticket_comments WHERE ticket_id=$1', [id])).rows[0].n).toBe(1);   // no duplicates
  });

  it('notices tickets that disappeared from the source on a full look, and keeps the cursor', async () => {
    const { pid } = await mirrorProject(); const c = await connection(pid);
    await runSync(c, { connector: feed(() => [ticket('P-1'), ticket('P-2')]) });
    const c2 = (await pool.query('SELECT * FROM integration_connections WHERE id=$1', [c.id])).rows[0];
    expect(c2.cursor.updatedSince).toBe('2024-01-05T08:00:00Z'); expect(c2.health).toBe('ok');
    await pool.query(`UPDATE integration_connections SET cursor='{}' WHERE id=$1`, [c.id]);                          // force a full look
    const r = await runSync({ ...c2, cursor: {} }, { connector: feed(() => [ticket('P-1')]) });
    expect(r.removed).toBe(1);
    expect((await pool.query(`SELECT source_removed_at IS NOT NULL AS gone FROM tickets WHERE legacy_id='P-2' AND project_id=$1`, [pid])).rows[0].gone).toBe(true);
  });

  it('records one bad ticket without losing the rest, and a failed source as a failed run', async () => {
    const { pid } = await mirrorProject(); const c = await connection(pid);
    const r = await runSync(c, { connector: feed(() => [ticket('P-1'), { ...ticket('P-2'), title: undefined as never, createdAt: 'not a date' }, ticket('P-3')]) });
    expect(r).toMatchObject({ created: 2, failed: 1 });
    expect((await pool.query('SELECT source_key FROM sync_failures WHERE run_id=$1', [r.runId])).rows[0].source_key).toBe('P-2');
    const down: Connector = { test: async () => ({ detail: '' }), pull: async function* () { throw new Error('Jira answered 503'); } };
    const bad = await runSync(c, { connector: down });
    expect(bad.error).toMatch(/503/);
    expect((await pool.query('SELECT health FROM integration_connections WHERE id=$1', [c.id])).rows[0].health).toBe('error');
  });
});

describe('connection routes', () => {
  it('only a Super Admin connects a project; credentials never come back; the connection can be tested and synced', async () => {
    const { pid, pa } = await mirrorProject();
    const fake: typeof fetch = async (input) => { const u = new URL(String(input)); return u.pathname.endsWith('/myself') ? Response.json({ displayName: 'Bot' }) : Response.json({ issues: [issue(1, 'To Do')], isLast: true }); };
    const app2 = buildApp({ sourceFetch: fake }); await app2.ready();
    const call2 = async (u: { cookie: string }, method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown) => { const r = await app2.inject({ method, url, payload: payload as any, headers: { cookie: u.cookie } }); let body: any; try { body = r.json(); } catch { body = r.body; } return { status: r.statusCode, body }; };
    const body = { kind: 'jira', name: 'Main Jira', baseUrl: 'https://jira.test', username: 'bot@corp.com', secret: 'super-secret-token', config: { jql: 'project = P' } };
    expect((await call2(pa, 'POST', '/api/project/integrations', body)).status).toBe(403);
    const made = await call2(sup, 'POST', '/api/project/integrations', { ...body, baseUrl: 'ftp://nope' }); expect(made.status).toBe(400);
    const ok = await call2({ cookie: sup.cookieIn(pid) }, 'POST', '/api/project/integrations', body); expect(ok.status).toBe(201);
    const list = (await call2(pa, 'GET', '/api/project/integrations')).body;
    expect(list).toHaveLength(1); expect(JSON.stringify(list)).not.toContain('super-secret-token'); expect(list[0]).toMatchObject({ name: 'Main Jira', hasSecret: true, baseUrl: 'https://jira.test' });
    expect((await pool.query('SELECT secret_enc FROM integration_connections WHERE id=$1', [ok.body.id])).rows[0].secret_enc).not.toContain('super-secret-token');
    expect((await call2(pa, 'POST', `/api/project/integrations/${ok.body.id}/test`)).body).toMatchObject({ ok: true, detail: 'Signed in as Bot' });
    expect((await call2(pa, 'PUT', `/api/project/integrations/${ok.body.id}`, { secret: 'new' })).status).toBe(403);        // changing the credential is a Super Admin job
    expect((await call2(pa, 'PUT', `/api/project/integrations/${ok.body.id}`, { syncIntervalMin: 30 })).status).toBe(200);
    const sync = await call2(pa, 'POST', `/api/project/integrations/${ok.body.id}/sync`);
    expect(sync.body).toMatchObject({ created: 1, failed: 0 });
    expect((await call2(pa, 'GET', `/api/project/integrations/${ok.body.id}/runs`)).body[0]).toMatchObject({ status: 'ok', created: 1 });
    // another project cannot see or touch it
    const other = await mirrorProject();
    expect((await call2(other.pa, 'GET', '/api/project/integrations')).body).toEqual([]);
    expect((await call2(other.pa, 'POST', `/api/project/integrations/${ok.body.id}/sync`)).status).toBe(404);
    await app2.close();
  });

  it('maps source statuses to the project’s own phases and re-applies the map only to untouched tickets', async () => {
    const { pid, pa } = await mirrorProject(); const c = await connection(pid);
    await runSync(c, { connector: feed(() => [ticket('P-1', { status: 'Waiting for vendor' }), ticket('P-2', { status: 'Waiting for vendor' })]) });
    const map = (await call(pa, 'GET', `/api/project/integrations/${c.id}/status-map`)).body;
    expect(map.observed).toEqual([{ status: 'Waiting for vendor', tickets: 2, phaseId: null, guess: 'intake' }]);
    const pending = map.phases.find((p: any) => p.name === 'Pending');
    expect((await call(pa, 'PUT', `/api/project/integrations/${c.id}/status-map`, { maps: [{ sourceStatus: 'Waiting for vendor', phaseId: 99999999 }] })).status).toBe(400);
    expect((await call(pa, 'PUT', `/api/project/integrations/${c.id}/status-map`, { maps: [{ sourceStatus: 'Waiting for vendor', phaseId: pending.id }] })).status).toBe(200);
    const touched = (await pool.query(`SELECT id FROM tickets WHERE legacy_id='P-2' AND project_id=$1`, [pid])).rows[0].id;
    await pool.query(`UPDATE tickets SET current_state='Triage' WHERE id=$1`, [touched]);                          // moved by a person: not untouched
    expect((await call(pa, 'POST', `/api/project/integrations/${c.id}/status-map/apply`)).body.moved).toBe(1);
    expect((await pool.query(`SELECT current_state FROM tickets WHERE legacy_id='P-1' AND project_id=$1`, [pid])).rows[0].current_state).toBe('Pending');
    expect((await pool.query('SELECT current_state FROM tickets WHERE id=$1', [touched])).rows[0].current_state).toBe('Triage');
  });
});

describe('webhooks', () => {
  it('a source tool can ask for an early look with its secret address; a wrong or missing token learns nothing', async () => {
    const { pid, pa } = await mirrorProject(); const c = await connection(pid);
    expect((await call(pa, 'POST', `/api/project/integrations/${c.id}/webhook`)).status).toBe(200);
    const { path } = (await call(pa, 'POST', `/api/project/integrations/${c.id}/webhook`)).body;              // asking again replaces the token
    const raw = (u: string) => app.inject({ method: 'POST', url: u });
    expect((await raw(`/api/integrations/webhook/${c.id}`)).statusCode).toBe(404);
    expect((await raw(`/api/integrations/webhook/${c.id}?token=not-the-token-at-all`)).statusCode).toBe(404);
    expect((await raw(`/api/integrations/webhook/00000000-0000-4000-8000-000000000000?token=whatever-whatever`)).statusCode).toBe(404);
    const ok = await raw(path); expect(ok.statusCode).toBe(202); expect(ok.json()).toEqual({ queued: true });
    expect((await raw(path)).json()).toMatchObject({ queued: false });                                           // asked again straight away: nothing extra starts
    expect((await pool.query('SELECT webhook_token_hash FROM integration_connections WHERE id=$1', [c.id])).rows[0].webhook_token_hash).not.toContain(path.split('token=')[1]);
  });
});
