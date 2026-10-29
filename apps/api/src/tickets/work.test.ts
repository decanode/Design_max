import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pool } from '../db.js';
import { buildApp } from '../app.js';
import { TemplateGenerator } from '../docs/generator.js';
import { makeUser } from '../testAuth.js';

const app = buildApp({ generator: new TemplateGenerator() });
type U = Awaited<ReturnType<typeof makeUser>>;
let sup: U, pid: string, pa: U, lead: U, customer: U, other: U, incident: number;
const call = async (u: { cookie: string }, method: 'GET' | 'POST' | 'PATCH' | 'PUT', url: string, payload?: unknown) => {
  const r = await app.inject({ method, url, payload: payload as any, headers: { cookie: u.cookie } });
  let body: any; try { body = r.json(); } catch { body = r.body; }
  return { status: r.statusCode, body };
};
const meta = { priority: 'P2 - High', impact: 'Single user', steps_to_reproduce: 'Click print' };
const approveDoc = (ticketId: string, kind: string) => pool.query(`INSERT INTO approval_requests (ticket_id, kind, version_number, workflow_name, levels, status, completed_at) VALUES ($1,$2,1,'test','[]','approved',now())`, [ticketId, kind]);
const move = (u: U, id: string, to: string) => call(u, 'POST', `/api/tickets/${id}/transition`, { to });
/** A customer-raised incident, brought to Resolved. */
async function resolvedIncident(title: string) {
  const t = (await call(pa, 'POST', '/api/tickets', { title, ticketTypeId: incident, dynamicMetadata: meta })).body;
  await pool.query('UPDATE tickets SET customer_id=$2 WHERE id=$1', [t.id, customer.id]);
  for (const to of ['Triage', 'In Progress', 'Resolved']) expect((await move(pa, t.id, to)).status).toBe(200);
  return t.id as string;
}

beforeAll(async () => {
  await app.ready();
  sup = await makeUser('Admin');
  pid = (await call(sup, 'POST', '/api/platform/projects', { name: `Work ${Math.random().toString(36).slice(2, 7)}`, projectTypeId: (await pool.query("SELECT id FROM project_types WHERE key='support'")).rows[0].id })).body.id;
  pa = await makeUser('Project Admin', undefined, pid); lead = await makeUser('Lead', undefined, pid);
  customer = await makeUser('Customer', undefined, pid); other = await makeUser('Customer', undefined, pid);
  incident = (await pool.query("SELECT id FROM ticket_types WHERE key='incident'")).rows[0].id;
});
afterAll(async () => { await app.close(); await pool.end(); });

describe('ticket keys, priority and fields', () => {
  it('numbers tickets per project with the type tag, and derives priority from an incident’s own field', async () => {
    const a = (await call(pa, 'POST', '/api/tickets', { title: 'First', ticketTypeId: incident, dynamicMetadata: meta })).body;
    const b = (await call(pa, 'POST', '/api/tickets', { title: 'Second', ticketTypeId: incident, dynamicMetadata: { ...meta, priority: 'P1 - Critical' } })).body;
    expect(a.priority).toBe('High'); expect(b.priority).toBe('Critical'); expect(b.seq).toBe(a.seq + 1);
    const list = (await call(pa, 'GET', '/api/tickets')).body;
    expect(list.find((t: any) => t.id === b.id)).toMatchObject({ key: `INC-${b.seq}`, priority: 'Critical' });
    expect((await call(pa, 'GET', `/api/tickets/${b.id}`)).body.ticket.key).toBe(`INC-${b.seq}`);
  });
  it('priority and due date can be edited, and are validated', async () => {
    const t = (await call(pa, 'POST', '/api/tickets', { title: 'Edit me', ticketTypeId: incident, dynamicMetadata: meta })).body;
    const r = await call(pa, 'PATCH', `/api/tickets/${t.id}`, { priority: 'Low', dueDate: '2030-01-31' });
    expect(r.status).toBe(200); expect(r.body.priority).toBe('Low');
    expect((await call(pa, 'PATCH', `/api/tickets/${t.id}`, { priority: 'Urgent' })).status).toBe(400);
    expect((await call(pa, 'PATCH', `/api/tickets/${t.id}`, { dueDate: 'soon' })).status).toBe(400);
  });
});

describe('which documents a ticket type needs', () => {
  it('an incident needs only its Unit Test; the overview says so, and other documents are refused', async () => {
    const t = (await call(pa, 'POST', '/api/tickets', { title: 'Docs', ticketTypeId: incident, dynamicMetadata: meta })).body;
    const o = (await call(pa, 'GET', `/api/tickets/${t.id}`)).body;
    expect(o.docRules).toEqual({ FS: 'off', TS: 'off', TUT: 'required', CRC: 'off' });
    const fs = await call(pa, 'POST', `/api/tickets/${t.id}/documents/generate`, { kind: 'FS' });
    expect(fs.status).toBeGreaterThanOrEqual(400); expect(fs.body.error).toMatch(/not used for this kind of ticket/);
  });
  it('a Super Admin changes what a type needs, and the catalog reports it', async () => {
    const cat = (await call(sup, 'GET', '/api/platform/workflow/catalog')).body.ticketTypes.find((x: any) => x.key === 'problem');
    expect(cat.documents).toEqual({ FS: 'off', TS: 'off', TUT: 'optional', CRC: 'off' });
    const put = await call(sup, 'PUT', `/api/platform/workflow/ticket-types/${cat.id}`, { name: cat.name, short: cat.short, description: cat.description, fields: cat.fields, documents: { FS: 'off', TS: 'off', TUT: 'required', CRC: 'off' } });
    expect(put.status).toBe(200);
    expect((await call(sup, 'GET', '/api/platform/workflow/catalog')).body.ticketTypes.find((x: any) => x.key === 'problem').documents.TUT).toBe('required');
    await call(sup, 'PUT', `/api/platform/workflow/ticket-types/${cat.id}`, { name: cat.name, short: cat.short, description: cat.description, fields: cat.fields, documents: { FS: 'off', TS: 'off', TUT: 'optional', CRC: 'off' } });
  });
});

describe('the customer must confirm before a ticket they raised is closed', () => {
  it('blocks closing until the customer confirms, and only they can answer', async () => {
    const id = await resolvedIncident('Printer jam');
    await approveDoc(id, 'TUT');                                                    // documents are fine; the customer has not confirmed
    const blocked = await move(pa, id, 'Closed');
    expect(blocked.status).toBe(409); expect(blocked.body.error).toMatch(/without the approval of the customer/);

    expect((await call(customer, 'POST', `/api/tickets/${id}/signoff/decision`, { decision: 'approved' })).status).toBe(409);   // nobody asked yet
    expect((await call(customer, 'POST', `/api/tickets/${id}/signoff/request`)).status).toBe(403);                                // a customer cannot ask themselves
    expect((await call(pa, 'POST', `/api/tickets/${id}/signoff/request`)).status).toBe(201);
    expect((await call(pa, 'POST', `/api/tickets/${id}/signoff/request`)).status).toBe(409);                                      // already asked
    expect((await pool.query(`SELECT 1 FROM email_outbox WHERE to_email=$1 AND subject LIKE '%Printer jam%'`, [customer.email])).rowCount).toBe(1);
    expect((await move(pa, id, 'Closed')).body.error).toMatch(/has not answered/);

    expect((await call(other, 'POST', `/api/tickets/${id}/signoff/decision`, { decision: 'approved' })).status).toBe(404);        // not their ticket
    expect((await call(pa, 'POST', `/api/tickets/${id}/signoff/decision`, { decision: 'approved' })).status).toBe(403);           // staff cannot answer for them
    expect((await call(customer, 'POST', `/api/tickets/${id}/signoff/decision`, { decision: 'rejected' })).status).toBe(400);     // a reason is required
    expect((await call(customer, 'POST', `/api/tickets/${id}/signoff/decision`, { decision: 'rejected', comment: 'Still jams on page 2' })).status).toBe(200);
    expect((await move(pa, id, 'Closed')).status).toBe(409);                                                                       // refused: still open

    expect((await call(pa, 'POST', `/api/tickets/${id}/signoff/request`)).status).toBe(201);                                      // asked again after more work
    expect((await call(customer, 'POST', `/api/tickets/${id}/signoff/decision`, { decision: 'approved', comment: 'Works now' })).status).toBe(200);
    expect((await move(pa, id, 'Closed')).status).toBe(200);
    expect((await call(customer, 'GET', `/api/tickets/${id}`)).body.signoff.latest.status).toBe('approved');
  });
  it('a ticket nobody external raised needs no customer sign-off, and a withdrawn request can be asked again', async () => {
    const t = (await call(pa, 'POST', '/api/tickets', { title: 'Internal', ticketTypeId: incident, dynamicMetadata: meta })).body;
    expect((await call(pa, 'POST', `/api/tickets/${t.id}/signoff/request`)).status).toBe(409);
    for (const to of ['Triage', 'In Progress', 'Resolved']) await move(pa, t.id, to);
    await approveDoc(t.id, 'TUT');
    expect((await move(pa, t.id, 'Closed')).status).toBe(200);
    const id = await resolvedIncident('Withdraw');
    await call(pa, 'POST', `/api/tickets/${id}/signoff/request`);
    expect((await call(pa, 'POST', `/api/tickets/${id}/signoff/cancel`)).status).toBe(200);
    expect((await call(pa, 'POST', `/api/tickets/${id}/signoff/request`)).status).toBe(201);
  });
});

describe('the conversation and activity on a ticket', () => {
  it('shows notes and events in order; internal notes stay with the team', async () => {
    const id = await resolvedIncident('Chatty');
    expect((await call(pa, 'POST', `/api/tickets/${id}/notes`, { body: 'Checked the spooler', internal: true })).status).toBe(201);
    expect((await call(pa, 'POST', `/api/tickets/${id}/notes`, { body: 'We are on it' })).status).toBe(201);
    expect((await call(customer, 'POST', `/api/tickets/${id}/notes`, { body: 'Thanks', internal: true })).status).toBe(201);        // forced public
    expect((await call(other, 'POST', `/api/tickets/${id}/notes`, { body: 'hi' })).status).toBe(404);
    expect((await call(pa, 'POST', `/api/tickets/${id}/notes`, { body: '' })).status).toBe(400);

    const staff = (await call(pa, 'GET', `/api/tickets/${id}/activity`)).body;
    expect(staff[0].type).toBe('created');
    expect(staff.filter((x: any) => x.type === 'move').map((x: any) => x.text)).toEqual(['Moved from New to Triage', 'Moved from Triage to In Progress', 'Moved from In Progress to Resolved']);
    expect(staff.filter((x: any) => x.type === 'note').map((x: any) => x.text)).toEqual(['Checked the spooler', 'We are on it', 'Thanks']);
    const mine = (await call(customer, 'GET', `/api/tickets/${id}/activity`)).body;
    expect(mine.filter((x: any) => x.type === 'note').map((x: any) => x.text)).toEqual(['We are on it', 'Thanks']);
  });
});
