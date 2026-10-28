import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { io as client, type Socket } from 'socket.io-client';
import type { AddressInfo } from 'node:net';
import { pool } from '../db.js';
import { buildApp } from '../app.js';
import { attachChat } from './socket.js';
import { RuleBasedObserver, LlmObserver, AnthropicClient, GitHubModelsClient, GeminiClient } from './observer.js';
import { createConversation } from './service.js';
import { makeUser, testProject } from '../testAuth.js';
import { GeminiEmbedder, EMBEDDING_DIM } from '../etl/vectorize.js';

const app = buildApp();
let url: string, sock: Socket, cid: string, cookie: string;
const once = <T = any>(s: Socket, ev: string) => new Promise<T>((r) => s.once(ev, r));
const emit = <T = any>(s: Socket, ev: string, data: unknown) => new Promise<T>((r) => s.emit(ev, data, r));

beforeAll(async () => {
  await app.ready();
  attachChat(app.server, new RuleBasedObserver());
  await app.listen({ port: 0 });
  url = `http://localhost:${(app.server.address() as AddressInfo).port}`;
  const pid = await testProject();
  const admin = await makeUser('Admin'); cookie = admin.cookie;
  cid = (await createConversation(pid, undefined, admin.id)).id;
  sock = client(url, { extraHeaders: { cookie } });
  await once(sock, 'connect');
  await emit(sock, 'join', { conversationId: cid });
});
afterAll(async () => { sock.close(); await app.close(); await pool.end(); });

describe('role detection', () => {
  it('speaks as the customer in your own conversation and as a consultant in someone else’s, without being told', async () => {
    const pid = await testProject();
    const lead = await makeUser('Admin'); const other = await makeUser('Admin');
    const mine = (await createConversation(pid, undefined, lead.id)).id;
    const s1 = client(url, { extraHeaders: { cookie: lead.cookie } }); await once(s1, 'connect');
    const j1 = await emit(s1, 'join', { conversationId: mine });
    expect(j1.sendAs).toBe('customer');
    const got = once(s1, 'message'); await emit(s1, 'message', { conversationId: mine, body: 'My own request' });
    expect((await got).sender_role).toBe('customer');

    const s2 = client(url, { extraHeaders: { cookie: other.cookie } }); await once(s2, 'connect');
    expect((await emit(s2, 'join', { conversationId: mine })).sendAs).toBe('consultant');
    const got2 = once(s2, 'message'); await emit(s2, 'message', { conversationId: mine, body: 'Replying to you' });
    expect((await got2).sender_role).toBe('consultant');
    s1.close(); s2.close();
  });

  it('shows that the summary is being drafted and acknowledges the first draft in the chat', async () => {
    const pid = await testProject(); const u = await makeUser('Admin');
    const c = (await createConversation(pid, undefined, u.id)).id;
    const s = client(url, { extraHeaders: { cookie: u.cookie } }); await once(s, 'connect'); await emit(s, 'join', { conversationId: c });
    const working = once(s, 'observer:working');
    const ack = new Promise<any>((res) => s.on('message', (m) => m.sender_role === 'system' && res(m)));
    await emit(s, 'message', { conversationId: c, body: 'Please add a vendor report' });
    await working;
    expect((await ack).body).toMatch(/drafted a requirement summary/);
    s.close();
  });
});

describe('chat + observer + verify', () => {
  it('rejects invalid input', async () => {
    expect(await emit(sock, 'message', { conversationId: cid, role: 'customer', body: '' })).toHaveProperty('error');
    expect(await emit(sock, 'verify', { conversationId: 'nope' })).toHaveProperty('error');
  });

  it('cannot verify before there is a draft', async () => {
    expect(await emit(sock, 'verify', { conversationId: cid })).toEqual({ error: 'Nothing to verify yet' });
  });

  it('broadcasts messages and drafts a requirement with entities', async () => {
    const draft = once(sock, 'draft');
    await emit(sock, 'message', { conversationId: cid, role: 'customer', body: 'We need to block vendor Acme from every purchase order. Raw material only.' });
    const d = await draft;
    expect(d.title).toBe('We need to block vendor Acme from every purchase order');
    expect(d.entities).toMatchObject({ vendors: ['Acme'], businessObjects: ['purchase order'], materialTypes: ['raw material'] });
    expect(d.status).toBe('draft');
  });

  it('consultant messages do not alter the draft', async () => {
    await emit(sock, 'message', { conversationId: cid, role: 'consultant', body: 'Understood.' });
    const r = await (await fetch(`${url}/api/conversations/${cid}`, { headers: { cookie } })).json() as any;
    expect(r.messages.filter((m: any) => m.sender_role !== 'system')).toHaveLength(2);   // plus the automatic acknowledgement
    expect(r.draft.summary).not.toContain('Understood');
  });

  it('verify logs exactly one ticket, even when double-clicked, and freezes the draft', async () => {
    const [a, b] = await Promise.all([emit(sock, 'verify', { conversationId: cid }), emit(sock, 'verify', { conversationId: cid })]);
    expect(a.ticketId).toBe(b.ticketId);
    const t = await pool.query("SELECT current_state, ai_summary FROM tickets WHERE id=$1", [a.ticketId]);
    expect(t.rows[0].current_state).toBe('Requirement Verified');
    expect(t.rows[0].ai_summary).toContain('vendor Acme');
    expect((await pool.query('SELECT count(*)::int c FROM requirement_drafts d JOIN tickets t ON t.id=d.ticket_id WHERE d.conversation_id=$1', [cid])).rows[0].c).toBe(1);

    await emit(sock, 'message', { conversationId: cid, role: 'customer', body: 'Also something else' });
    await new Promise((r) => setTimeout(r, 150));
    const after = await (await fetch(`${url}/api/conversations/${cid}`, { headers: { cookie } })).json() as any;
    expect(after.draft.status).toBe('verified');
    expect(after.draft.summary).not.toContain('something else');
  });
});

describe('LLM observer (mocked HTTP)', () => {
  const msgs = [{ role: 'customer' as const, name: 'A', body: 'hi' }];
  const json = '{"title":"T","summary":"S","entities":{"vendors":["V"]}}';

  it('Anthropic: parses JSON replies and rejects bad ones', async () => {
    const reply = (text: string): typeof fetch => async () => Response.json({ content: [{ text }] });
    const obs = (t: string) => new LlmObserver(new AnthropicClient('k', undefined, reply(t)));
    expect(await obs(`Sure: ${json}`).draft(msgs)).toMatchObject({ title: 'T', entities: { vendors: ['V'], businessObjects: [] } });
    await expect(obs('{"title":""}').draft(msgs)).rejects.toThrow();
    await expect(new LlmObserver(new AnthropicClient('k', undefined, async () => new Response('', { status: 500 }))).draft(msgs)).rejects.toThrow(/500/);
  });

  it('GitHub Models: org-attributed URL, bearer auth, OpenAI-style reply', async () => {
    let seen: { url: string; auth: string; body: any } | undefined;
    const f: typeof fetch = async (u, init: any) => { seen = { url: String(u), auth: init.headers.Authorization, body: JSON.parse(init.body) }; return Response.json({ choices: [{ message: { content: json } }] }); };
    const d = await new LlmObserver(new GitHubModelsClient('tok', 'openai/gpt-4.1', 'acme-corp', f)).draft(msgs);
    expect(d?.title).toBe('T');
    expect(seen).toMatchObject({ url: 'https://models.github.ai/orgs/acme-corp/inference/chat/completions', auth: 'Bearer tok' });
    expect(seen!.body.messages[0].role).toBe('system');
  });

  it('Gemini: key header, systemInstruction, joins response parts', async () => {
    let seen: { url: string; key: string; body: any } | undefined;
    const f: typeof fetch = async (u, init: any) => { seen = { url: String(u), key: init.headers['x-goog-api-key'], body: JSON.parse(init.body) }; return Response.json({ candidates: [{ content: { parts: [{ text: '{"title":"T","summary":"S",' }, { text: '"entities":{}}' }] } }] }); };
    const d = await new LlmObserver(new GeminiClient('gk', 'gemini-3.5-flash', f)).draft(msgs);
    expect(d?.title).toBe('T');
    expect(seen).toMatchObject({ url: 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent', key: 'gk' });
    expect(seen!.body.systemInstruction.parts[0].text).toContain('requirement');
    await expect(new GeminiClient('k', undefined, async () => new Response('', { status: 429 }), 0).complete('s', 'u')).rejects.toThrow(/429/);
    let n = 0;
    const flaky: typeof fetch = async () => (++n < 3 ? new Response('', { status: 503 }) : Response.json({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] }));
    expect(await new GeminiClient('k', undefined, flaky, 0).complete('s', 'u')).toBe('ok');
    expect(n).toBe(3);
  });

  it('GeminiEmbedder: requests 1536 dims, normalizes, rejects wrong sizes', async () => {
    let body: any;
    const vec = (n: number) => new Array(n).fill(3);
    const ok: typeof fetch = async (_u, init: any) => { body = JSON.parse(init.body); return Response.json({ embeddings: body.requests.map(() => ({ values: vec(EMBEDDING_DIM) })) }); };
    const [v] = await new GeminiEmbedder('k', undefined, ok).embed(['a']);
    expect(body.requests[0].outputDimensionality).toBe(EMBEDDING_DIM);
    expect(Math.hypot(...v)).toBeCloseTo(1, 5);
    const bad: typeof fetch = async () => Response.json({ embeddings: [{ values: vec(768) }] });
    await expect(new GeminiEmbedder('k', undefined, bad).embed(['a'])).rejects.toThrow(/dimension/);
  });
});
