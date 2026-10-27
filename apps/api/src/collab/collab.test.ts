import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as Y from 'yjs';
import WebSocket from 'ws';
import { HocuspocusProvider } from '@hocuspocus/provider';
import type { AddressInfo } from 'node:net';
import { pool } from '../db.js';
import { buildApp } from '../app.js';
import { TemplateGenerator } from '../docs/generator.js';
import { OutboxMailer } from '../docs/mailer.js';
import { makeUser, makeProject, makeCustomUser } from '../testAuth.js';
import { attachCollab, closeCollab } from './server.js';
import { ydocToPm } from './draft.js';
import { pmText } from '../docgen/pm.js';

const app = buildApp({ generator: new TemplateGenerator(), mailer: new OutboxMailer(), appUrl: 'http://app.test' });
let hp: ReturnType<typeof attachCollab>; let url = ''; let pid: string; let ticket: string;
let ann: Awaited<ReturnType<typeof makeUser>>, bob: Awaited<ReturnType<typeof makeUser>>, viewer: Awaited<ReturnType<typeof makeUser>>;
beforeAll(async () => {
  await app.ready(); hp = attachCollab(app.server); await app.listen({ port: 0, host: '127.0.0.1' });
  url = `ws://127.0.0.1:${(app.server.address() as AddressInfo).port}/collab`;
  pid = await makeProject();
  ann = await makeUser('Consultant', 'ann', pid); bob = await makeUser('Consultant', 'bob', pid); viewer = await makeCustomUser(['spec.view', 'ticket.view_all'], {}, pid) as never;
  ticket = (await pool.query(`INSERT INTO tickets (project_id, title, current_state) VALUES ($1,'Co-edit','FS Drafted') RETURNING id`, [pid])).rows[0].id;
  await pool.query(`INSERT INTO documents (ticket_id, kind, version_number, content_md, author_name) VALUES ($1,'FS',1,'# Title\n\nFirst paragraph','x')`, [ticket]);
});
afterAll(async () => { app.server.closeAllConnections?.(); closeCollab(); await new Promise((r) => setTimeout(r, 300)); await app.close(); await pool.end(); });

const token = async (who: { cookie: string }, kind = 'FS') => (await app.inject({ method: 'POST', url: `/api/tickets/${ticket}/documents/${kind}/collab-token`, headers: { cookie: who.cookie } })).json() as { token: string; room: string; canEdit: boolean };
const join = async (who: { cookie: string }, override?: Partial<{ token: string; room: string }>) => {
  const t = await token(who);
  const doc = new Y.Doc();
  const p = new HocuspocusProvider({ url, name: override?.room ?? t.room, token: override?.token ?? t.token, document: doc, WebSocketPolyfill: WebSocket } as never);
  await new Promise<void>((res, rej) => { p.on('synced', () => res()); p.on('authenticationFailed', () => rej(new Error('auth failed'))); setTimeout(() => rej(new Error('timeout')), 6000); });
  return { p, doc, t };
};
const until = async (fn: () => boolean, ms = 4000) => { const end = Date.now() + ms; while (Date.now() < end) { if (fn()) return; await new Promise((r) => setTimeout(r, 50)); } throw new Error('condition not met'); };
const text = (d: Y.Doc) => pmText(ydocToPm(d));

describe('live co-editing', () => {
  it('starts from the latest version, shares edits both ways, and snapshots to a version', async () => {
    const a = await join(ann), b = await join(bob);
    expect(a.t.canEdit).toBe(true);
    await until(() => text(a.doc).includes('First paragraph'));
    a.doc.transact(() => { const f = a.doc.getXmlFragment('default'); const para = new Y.XmlElement('paragraph'); para.insert(0, [new Y.XmlText('From Ann')]); f.insert(f.length, [para]); });
    await until(() => text(b.doc).includes('From Ann'));
    b.doc.transact(() => { const f = b.doc.getXmlFragment('default'); const para = new Y.XmlElement('paragraph'); para.insert(0, [new Y.XmlText('From Bob')]); f.insert(f.length, [para]); });
    await until(() => text(a.doc).includes('From Bob'));

    // draft is ahead of v1 until someone saves a version
    await new Promise((r) => setTimeout(r, 300));
    const st = (await app.inject({ method: 'GET', url: `/api/tickets/${ticket}/documents/FS/draft-status`, headers: { cookie: ann.cookie } })).json();
    expect(st).toMatchObject({ latest: 1, changed: true });
    const snap = await app.inject({ method: 'POST', url: `/api/tickets/${ticket}/documents/FS/snapshot`, headers: { cookie: ann.cookie }, payload: { note: 'together' } });
    expect(snap.statusCode).toBe(201);
    const v2 = (await pool.query('SELECT content_text FROM documents WHERE ticket_id=$1 AND version_number=2', [ticket])).rows[0].content_text as string;
    expect(v2).toContain('From Ann'); expect(v2).toContain('From Bob');
    expect((await app.inject({ method: 'POST', url: `/api/tickets/${ticket}/documents/FS/snapshot`, headers: { cookie: ann.cookie }, payload: {} })).json()).toEqual({ unchanged: true });
    a.p.destroy(); b.p.destroy();
  });

  it('keeps the draft after everyone leaves', async () => {
    const c = await join(bob);
    await until(() => text(c.doc).includes('From Ann')); c.p.destroy();
  });

  it('lets a read-only pass watch but never change the draft', async () => {
    const ro = await join(viewer);
    expect(ro.t.canEdit).toBe(false);
    const watcher = await join(ann); await until(() => text(watcher.doc).includes('From Ann')); const before = text(watcher.doc); watcher.p.destroy();
    ro.doc.transact(() => { const f = ro.doc.getXmlFragment('default'); const para = new Y.XmlElement('paragraph'); para.insert(0, [new Y.XmlText('Sneaky')]); f.insert(0, [para]); });
    await new Promise((r) => setTimeout(r, 600));
    const after = await join(ann);
    await until(() => text(after.doc).includes('From Ann'));
    expect(text(after.doc)).toBe(before); expect(text(after.doc)).not.toContain('Sneaky');
    ro.p.destroy(); after.p.destroy();
  });

  it('refuses a forged, expired-for-another-room, or missing pass', async () => {
    const t = await token(ann);
    await expect(join(ann, { token: 'nonsense' })).rejects.toThrow(/auth failed/);
    await expect(join(ann, { room: t.room.replace(/FS$/, 'TS') })).rejects.toThrow(/auth failed/);
  });

  it('locks the draft while an approval is in progress or the ticket has moved on', async () => {
    await pool.query(`UPDATE tickets SET current_state='FS Approved' WHERE id=$1`, [ticket]);   // fixture: owner connection
    const t = await token(ann);
    expect(t.canEdit).toBe(false);
    expect((await app.inject({ method: 'POST', url: `/api/tickets/${ticket}/documents/FS/snapshot`, headers: { cookie: ann.cookie }, payload: {} })).statusCode).toBe(409);
  });
});
