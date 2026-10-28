import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as Y from 'yjs';
import WebSocket from 'ws';
import { HocuspocusProvider } from '@hocuspocus/provider';
import type { AddressInfo } from 'node:net';
import { pool } from '../db.js';
import { buildApp } from '../app.js';
import { makeUser } from '../testAuth.js';
import { attachCollab, closeCollab } from '../collab/server.js';
import { ydocToPm } from '../collab/draft.js';
import { OfflinePlanningAi } from './ai.js';
import { blockText } from './service.js';

const app = buildApp({ planningAi: new OfflinePlanningAi() });
let hp: ReturnType<typeof attachCollab>, url = '', pm: any, admin: any, pid: string;
beforeAll(async () => {
  await app.ready(); hp = attachCollab(app.server); await app.listen({ port: 0, host: '127.0.0.1' });
  url = `ws://127.0.0.1:${(app.server.address() as AddressInfo).port}/collab`;
  const sup = await makeUser('Admin');
  const typeId = (await pool.query(`SELECT id FROM project_types WHERE key='implementation'`)).rows[0].id;
  const r = await app.inject({ method: 'POST', url: '/api/platform/projects', payload: { name: `Live ${Math.random().toString(36).slice(2, 7)}`, projectTypeId: typeId }, headers: { cookie: sup.cookie } });
  pid = r.json().id; admin = await makeUser('Admin', undefined, pid); pm = await makeUser('Project Manager', undefined, pid);
  await app.inject({ method: 'PUT', url: '/api/project/modules', payload: { key: 'planning_module', enabled: true }, headers: { cookie: admin.cookie } });
  await app.inject({ method: 'POST', url: '/api/planning/charter/generate', payload: { problem: 'Vendors are paid late and complain.', sponsor: 'Sue Sponsor', goals: 'Pay invoices on time' }, headers: { cookie: pm.cookie } });
});
afterAll(async () => { closeCollab(); await new Promise((r) => setTimeout(r, 300)); await app.close(); await pool.end(); });

const until = async (fn: () => boolean | Promise<boolean>, ms = 8000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return; await new Promise((r) => setTimeout(r, 100)); } throw new Error('condition not met'); };

describe('live charter editing', () => {
  it('starts from the generated charter, saves typed text into the charter’s sections, and goes read-only after approval', async () => {
    const t = (await app.inject({ method: 'POST', url: '/api/planning/charter/collab-token', headers: { cookie: pm.cookie } })).json();
    expect(t.canEdit).toBe(true); expect(t.room).toBe(`${pid}:charter:CHARTER`);
    const doc = new Y.Doc();
    const p = new HocuspocusProvider({ url, name: t.room, token: t.token, document: doc, WebSocketPolyfill: WebSocket } as never);
    await until(() => blockText([ydocToPm(doc)]).includes('Executive Summary'));
    // type a new paragraph under the summary
    doc.transact(() => { const f = doc.getXmlFragment('default'); const para = new Y.XmlElement('paragraph'); para.insert(0, [new Y.XmlText('LIVE-EDIT-MARKER')]); f.insert(2, [para]); });
    await until(async () => (await pool.query('SELECT executive_summary FROM project_charters WHERE project_id=$1', [pid])).rows[0].executive_summary.includes('LIVE-EDIT-MARKER'));

    // approving saves what is still in memory, locks the charter, and the token turns read-only
    const ok = await app.inject({ method: 'POST', url: '/api/planning/charter/approve', headers: { cookie: pm.cookie } });
    expect(ok.json().charter.status).toBe('Approved');
    expect((await app.inject({ method: 'POST', url: '/api/planning/charter/collab-token', headers: { cookie: pm.cookie } })).json().canEdit).toBe(false);
    p.destroy();
    const after = (await pool.query('SELECT executive_summary, status FROM project_charters WHERE project_id=$1', [pid])).rows[0];
    expect(after.status).toBe('Approved'); expect(after.executive_summary).toContain('LIVE-EDIT-MARKER');
  });
});
