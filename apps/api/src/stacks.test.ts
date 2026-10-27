import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { io as client } from 'socket.io-client';
import type { AddressInfo } from 'node:net';
import { pool } from './db.js';
import { buildApp } from './app.js';
import { attachChat } from './chat/socket.js';
import { LlmObserver, RuleBasedObserver } from './chat/observer.js';
import { LlmGenerator, TemplateGenerator } from './docs/generator.js';
import { HashEmbedder, similar, storeEmbeddings } from './etl/vectorize.js';
import { assessFit, loadStackPolicy, matchKeywords, stackInstruction } from './stacks.js';
import { createConversation } from './chat/service.js';
import { createTicket } from './tickets.js';
import { addMember, makeProject, makeUser } from './testAuth.js';

const app = buildApp({ generator: new TemplateGenerator(), embedder: new HashEmbedder() });
let url: string, sapProject: string, openProject: string, admin: Awaited<ReturnType<typeof makeUser>>, customer: typeof admin, consultant: typeof admin, projAdmin: typeof admin;
const stackId = async (name: string) => (await pool.query('SELECT id FROM tech_stacks WHERE name=$1', [name])).rows[0].id as number;
const call = async (u: typeof admin, method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', path: string, payload?: unknown, project?: string) => {
  const r = await app.inject({ method, url: path, payload: payload as any, headers: { cookie: project ? u.cookieIn(project) : u.cookie } });
  return { status: r.statusCode, body: r.json() as any };
};

beforeAll(async () => {
  await app.ready(); attachChat(app.server, new RuleBasedObserver()); await app.listen({ port: 0 });
  url = `http://localhost:${(app.server.address() as AddressInfo).port}`;
  sapProject = await makeProject(`SAP Rollout ${Date.now()}`);
  openProject = await makeProject(`Open ${Date.now()}`);
  await pool.query('INSERT INTO project_stacks (project_id, stack_id) VALUES ($1,$2)', [sapProject, await stackId('SAP')]);
  [admin, customer, consultant, projAdmin] = await Promise.all([makeUser('Admin', undefined, sapProject), makeUser('Customer', undefined, sapProject), makeUser('Consultant', undefined, sapProject), makeUser('Project Admin', undefined, sapProject)]);
  await addMember(openProject, customer.id, 'Customer');                      // the customer works in both projects
});
afterAll(async () => { await app.close(); await pool.end(); });

describe('keyword matching and fit', () => {
  it('matches whole terms only', () => {
    expect(matchKeywords('We use JavaScript and Java', ['java'])).toEqual(['java']);
    expect(matchKeywords('Only JavaScript here', ['java'])).toEqual([]);
    expect(matchKeywords('an ASP.NET service in C#', ['.net', 'c#', 'asp.net']).sort()).toEqual(['asp.net', 'c#']);
  });
  it('flags other-stack work as out of scope, mixed as unclear, matching as in scope, and unrestricted as always in scope', async () => {
    const policy = await loadStackPolicy(sapProject);
    expect(policy?.allowed.map((s) => s.name)).toEqual(['SAP']);
    expect(assessFit('Write a C# ASP.NET web API', policy).fit).toBe('out_of_scope');
    expect(assessFit('A BAPI wrapper exposed through a Spring Boot service', policy).fit).toBe('unclear');
    expect(assessFit('Block vendor Acme in the purchase order BAPI', policy).fit).toBe('in_scope');
    expect(assessFit('Anything in C#', await loadStackPolicy(openProject))).toMatchObject({ fit: 'in_scope' });
  });
});

describe('the AI is confined to the project stack', () => {
  it('observer prompt carries the restriction and the model verdict is respected', async () => {
    const policy = await loadStackPolicy(sapProject);
    let system = '';
    const llm = { complete: async (s: string) => { system = s; return '{"title":"T","summary":"S","entities":{},"stackFit":"out_of_scope","stackNote":"Needs .NET"}'; } };
    const d = await new LlmObserver(llm).draft([{ role: 'customer', name: 'A', body: 'build a thing' }], policy);
    expect(system).toContain('restricted to: SAP');
    expect(system).toContain('Never recommend');
    expect(d).toMatchObject({ stackFit: 'out_of_scope', stackNote: 'Needs .NET' });
  });
  it('a model that says in_scope cannot hide off-stack terms the customer actually used', async () => {
    const policy = await loadStackPolicy(sapProject);
    const llm = { complete: async () => '{"title":"T","summary":"S","entities":{},"stackFit":"in_scope"}' };
    const d = await new LlmObserver(llm).draft([{ role: 'customer', name: 'A', body: 'Create a Blazor front end' }], policy);
    expect(d?.stackFit).toBe('unclear');
    expect(d?.stackNote).toMatch(/\.NET/);
  });
  it('no restriction text is added to unrestricted projects', async () => {
    expect(stackInstruction(null, 'observe')).toBe('');
  });
  it('document generator prompt carries the restriction', async () => {
    const policy = await loadStackPolicy(sapProject);
    let system = '';
    await new LlmGenerator({ complete: async (s) => { system = s; return '# Doc'; } }).generate('FS', { title: 'T', summary: 'S', transcript: [], policy });
    expect(system).toContain('restricted to: SAP');
    expect(system).toContain('Outside project technology scope');
  });
  it('retrieval never suggests assets tagged for another stack', async () => {
    const emb = new HashEmbedder();
    const tag = `stk${Date.now()}`;
    await storeEmbeddings(pool, emb, [
      { sourceType: 'git', sourceRef: `${tag}:dotnet`, content: `${tag} invoice service`, stack: '.NET' },
      { sourceType: 'sap_metadata', sourceRef: `${tag}:sap`, content: `${tag} invoice program`, stack: 'SAP' },
      { sourceType: 'kb_doc', sourceRef: `${tag}:generic`, content: `${tag} invoice guideline` },
    ]);
    const refs = (await similar(pool, emb, `${tag} invoice`, 20, ['SAP'])).map((r) => r.source_ref).filter((r: string) => r.startsWith(tag));
    expect(refs.sort()).toEqual([`${tag}:generic`, `${tag}:sap`]);
    expect((await similar(pool, emb, `${tag} invoice`, 20)).filter((r) => r.source_ref.startsWith(tag))).toHaveLength(3);
  });
});

describe('chat in a restricted project', () => {
  it('an off-stack request is flagged and cannot be verified; an on-stack one can; the same text is fine in an unrestricted project', async () => {
    const emit = (s: ReturnType<typeof client>, ev: string, data: unknown) => new Promise<any>((r) => s.emit(ev, data, r));
    const openSock = async (project: string) => { const s = client(url, { extraHeaders: { cookie: customer.cookieIn(project) }, reconnection: false }); await new Promise<void>((r) => s.once('connect', () => r())); return s; };
    const s = await openSock(sapProject);

    const bad = (await createConversation(sapProject, undefined, customer.id)).id as string;
    const joined = await emit(s, 'join', { conversationId: bad });
    expect(joined.project).toMatchObject({ stacks: ['SAP'] });
    const flagged = new Promise<any>((r) => s.once('draft', r));
    await emit(s, 'message', { conversationId: bad, body: 'Please build a C# ASP.NET web API for vendor data' });
    expect((await flagged).stack_fit).toBe('out_of_scope');
    expect((await emit(s, 'verify', { conversationId: bad })).error).toMatch(/limited to SAP/);
    expect((await pool.query('SELECT count(*)::int c FROM tickets WHERE customer_id=$1 AND title ILIKE $2', [customer.id, '%C# ASP.NET%'])).rows[0].c).toBe(0);

    const good = (await createConversation(sapProject, undefined, customer.id)).id as string;
    await emit(s, 'join', { conversationId: good });
    const ok = new Promise<any>((r) => s.once('draft', r));
    await emit(s, 'message', { conversationId: good, body: 'Block vendor Acme in the purchase order BAPI' });
    expect((await ok).stack_fit).toBe('in_scope');
    expect((await emit(s, 'verify', { conversationId: good })).ok).toBe(true);
    s.close();

    // the same off-stack text is fine in an unrestricted project (a separate workspace)
    const s2 = await openSock(openProject);
    const free = (await createConversation(openProject, undefined, customer.id)).id as string;
    await emit(s2, 'join', { conversationId: free });
    const d = new Promise<any>((r) => s2.once('draft', r));
    await emit(s2, 'message', { conversationId: free, body: 'Please build a C# ASP.NET web API' });
    expect((await d).stack_fit).toBe('in_scope');
    s2.close();
  });

  it('a conversation starts in the project you are working in, and your project list shows each one\'s allowed stacks', async () => {
    const inSap = (await call(customer, 'POST', '/api/conversations', {}, sapProject)).body;
    expect(inSap.project_id).toBe(sapProject);
    const inOpen = (await call(customer, 'POST', '/api/conversations', {}, openProject)).body;
    expect(inOpen.project_id).toBe(openProject);
    const list = (await call(customer, 'GET', '/api/projects')).body;
    expect(list.find((p: any) => p.id === sapProject).stacks).toEqual(['SAP']);
    expect(list.find((p: any) => p.id === openProject).stacks).toEqual([]);
  });
});

describe('ticket specs in a restricted project', () => {
  it('shows the stack and warns when a draft drifts to another technology', async () => {
    const t = await createTicket(sapProject, 'Warn me');
    await pool.query('UPDATE tickets SET consultant_id=$2 WHERE id=$1', [t.id, consultant.id]);
    await call(consultant, 'POST', `/api/tickets/${t.id}/documents/generate`, { kind: 'FS' });
    let o = (await call(consultant, 'GET', `/api/tickets/${t.id}`)).body;
    expect(o.stacks).toEqual(['SAP']); expect(o.stackWarnings).toEqual([]);
    expect(o.docs.FS.latest.content_md).toContain('Technology scope: SAP');
    await call(consultant, 'POST', `/api/tickets/${t.id}/documents/FS/versions`, { content: 'Implement as a Spring Boot microservice', baseVersion: 1 });
    o = (await call(consultant, 'GET', `/api/tickets/${t.id}`)).body;
    expect(o.stackWarnings).toEqual([{ kind: 'FS', stack: 'Java', terms: ['spring boot'] }]);
  });
});

describe('administration of stacks and projects', () => {
  it('the stack catalog is the Super Admin\'s; a Project Admin only chooses from it for their own project', async () => {
    expect((await call(projAdmin, 'GET', '/api/platform/stacks')).status).toBe(403);
    expect((await call(projAdmin, 'POST', '/api/platform/stacks', { name: 'Nope' })).status).toBe(403);
    const cat = (await call(projAdmin, 'GET', '/api/project/stacks')).body;
    expect(cat.catalog.map((s: any) => s.name)).toEqual(expect.arrayContaining(['SAP', '.NET', 'Java', 'Node.js']));
    expect(cat.selected).toEqual([await stackId('SAP')]);
    expect((await call(consultant, 'GET', '/api/project/stacks')).status).toBe(403);
  });

  it('Super Admin builds the catalog; stacks in use are protected; Project Admin applies one to their project', async () => {
    const name = `Salesforce ${Date.now()}`;
    const made = await call(admin, 'POST', '/api/platform/stacks', { name, description: 'Apex, Lightning', keywords: ['apex', 'lightning'] });
    expect(made.status).toBe(201);
    expect((await call(admin, 'POST', '/api/platform/stacks', { name: name.toUpperCase() })).status).toBe(409);

    expect((await call(projAdmin, 'PUT', '/api/project/stacks', { stackIds: [made.body.id, await stackId('SAP')] })).status).toBe(200);
    expect((await call(admin, 'DELETE', `/api/platform/stacks/${made.body.id}`)).status).toBe(409);       // in use
    expect((await call(projAdmin, 'PUT', '/api/project/stacks', { stackIds: [99999] })).status).toBe(400);
    expect((await call(projAdmin, 'PUT', '/api/project/stacks', { stackIds: [await stackId('SAP')] })).status).toBe(200);
    expect((await call(admin, 'DELETE', `/api/platform/stacks/${made.body.id}`)).status).toBe(200);
    expect((await call(admin, 'GET', '/api/platform/audit')).body.map((a: any) => a.action)).toEqual(expect.arrayContaining(['stack.create', 'stack.delete']));
    expect((await call(projAdmin, 'GET', '/api/project/audit')).body.map((a: any) => a.action)).toContain('project.stacks');
  });

  it('a Project Admin can delegate stack choice to another role in their project', async () => {
    const pmo = await makeUser('Consultant', undefined, sapProject);
    expect((await call(pmo, 'GET', '/api/project/stacks')).status).toBe(403);
    const consultantRole = (await pool.query("SELECT id FROM roles WHERE name='Consultant'")).rows[0].id;
    const current = (await call(projAdmin, 'GET', '/api/project/roles')).body.roles.find((r: any) => r.id === consultantRole).permissions as string[];
    await call(projAdmin, 'PUT', `/api/project/roles/${consultantRole}/permissions`, { permissions: [...current, 'admin.projects'] });
    expect((await call(pmo, 'GET', '/api/project/stacks')).status).toBe(200);
    expect((await call(pmo, 'GET', '/api/project/members')).status).toBe(403);                              // only what was delegated
    await call(projAdmin, 'DELETE', `/api/project/roles/${consultantRole}/permissions`);                    // back to the standard role
    expect((await call(pmo, 'GET', '/api/project/stacks')).status).toBe(403);
  });
});

describe('database-down detection', () => {
  it('recognises unreachable-database errors (including pg\'s multi-address AggregateError) and nothing else', async () => {
    const { isDatabaseDown } = await import('./errors.js');
    expect(isDatabaseDown(Object.assign(new Error('x'), { code: 'ECONNREFUSED' }))).toBe(true);
    expect(isDatabaseDown(Object.assign(new AggregateError([Object.assign(new Error('a'), { code: 'ECONNREFUSED' })]), {}))).toBe(true);
    expect(isDatabaseDown(Object.assign(new Error('x'), { code: '57P01' }))).toBe(true);
    expect(isDatabaseDown(Object.assign(new Error('x'), { cause: { code: 'ETIMEDOUT' } }))).toBe(true);
    expect(isDatabaseDown(new Error('syntax error'))).toBe(false);
    expect(isDatabaseDown(Object.assign(new Error('dup'), { code: '23505' }))).toBe(false);
    expect(isDatabaseDown(null)).toBe(false);
  });
});
