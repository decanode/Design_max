import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pool } from '../db.js';
import { buildApp } from '../app.js';
import { TemplateGenerator } from '../docs/generator.js';
import { HashEmbedder } from '../etl/vectorize.js';
import { createTicket } from '../tickets.js';
import { addMember, makeCustomUser, makeProject, makeUser, testProject } from '../testAuth.js';
import { FIELDS, FIELD_KEYS, sanitizeTicket, validateFieldAccess, resolveFieldAccess } from './fields.js';

const app = buildApp({ generator: new TemplateGenerator(), embedder: new HashEmbedder() });
type U = Awaited<ReturnType<typeof makeUser>>;
let admin: U, lead: U, manager: U, consultant: U, other: U, customer: U, projAdmin: U;
let projectId: string, ticketId: string;

const call = async (u: U, method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', path: string, payload?: unknown) => {
  const r = await app.inject({ method, url: path, payload: payload as any, headers: { cookie: u.cookie } });
  let body: any; try { body = r.json(); } catch { body = r.body; }
  return { status: r.statusCode, body };
};
const roleId = async (name: string) => (await pool.query('SELECT id FROM roles WHERE name=$1', [name])).rows[0].id as number;

const customUser = (perms: string[], access: Record<string, 'hidden' | 'read' | 'write'> = {}) => makeCustomUser(perms, access, projectId);

beforeAll(async () => {
  await app.ready();
  projectId = await testProject();
  [admin, lead, manager, consultant, other, customer, projAdmin] = await Promise.all(['Admin', 'Lead', 'Manager', 'Consultant', 'Consultant', 'Customer', 'Project Admin'].map((r) => makeUser(r)));
  const t = await createTicket(projectId, 'Field test');
  ticketId = t.id;
  await pool.query(`UPDATE tickets SET customer_id=$2, consultant_id=$3, ai_summary='SUMMARY-X', resolution_notes='RES-X', acceptance_criteria='ACC-X', legacy_id='PROJ-9', legacy_source='jira', legacy_type='Story', legacy_status='Done' WHERE id=$1`, [ticketId, customer.id, consultant.id]);
});
afterAll(async () => { await app.close(); await pool.end(); });

describe('rules (pure)', () => {
  it('sanitize removes exactly the hidden fields\' columns and never core columns', () => {
    const row = { id: 1, title: 't', current_state: 'QA', created_at: 'x', ai_summary: 's', customer_id: 'c', customer_name: 'n', consultant_id: 'k', consultant: 'kn', legacy_id: 'L', legacy_source: 'jira', is_assigned: true };
    const open_ = resolveFieldAccess(FIELD_KEYS.map((field) => ({ field, access: 'read' as const })));
    expect(Object.keys(sanitizeTicket(row, open_)).sort()).toEqual(Object.keys(row).sort());                      // everything readable: untouched
    const some = { ...open_, ai_summary: 'hidden' as const, customer: 'hidden' as const, legacy: 'hidden' as const };
    expect(Object.keys(sanitizeTicket(row, some)).sort()).toEqual(['consultant', 'consultant_id', 'created_at', 'current_state', 'id', 'is_assigned', 'title']);
    expect(Object.keys(sanitizeTicket(row, { ...some, consultant: 'hidden' })).sort()).toEqual(['created_at', 'current_state', 'id', 'is_assigned', 'title']);   // core columns always stay
    expect(row).toHaveProperty('ai_summary');                                                                     // the input is not mutated
  });
  it('limits: title cannot be hidden; non-editable fields cannot be set to write; unknown values refused', () => {
    expect(validateFieldAccess({ title: 'hidden' })).toMatch(/cannot be hidden/);
    expect(validateFieldAccess({ customer: 'write' })).toMatch(/read-only/);
    expect(validateFieldAccess({ legacy: 'write' })).toMatch(/read-only/);
    expect(validateFieldAccess({ nope: 'read' })).toMatch(/Unknown field/);
    expect(validateFieldAccess({ ai_summary: 'admin' })).toMatch(/access level/);
    expect(validateFieldAccess({ title: 'write', ai_summary: 'hidden', consultant: 'write' })).toBeNull();
  });
  it('a missing row means the new-role default: title readable, the rest hidden', () => {
    const a = resolveFieldAccess([]);
    expect(a.title).toBe('read'); expect(FIELDS.filter((f) => f.key !== 'title').every((f) => a[f.key] === 'hidden')).toBe(true);
  });
  it('every built-in role has a row for every field (so nothing silently falls to the closed default)', async () => {
    for (const r of ['Customer', 'Consultant', 'Lead', 'Manager', 'Approver']) {
      const n = (await pool.query('SELECT count(*)::int n FROM ticket_field_access a JOIN roles r ON r.id=a.role_id WHERE r.name=$1', [r])).rows[0].n;
      expect(n, r).toBe(FIELD_KEYS.length);
    }
  });
});

describe('what each role sees', () => {
  it('Admin sees and may edit everything; Customer does not see the legacy reference', async () => {
    const a = (await call(admin, 'GET', `/api/tickets/${ticketId}`)).body;
    expect(a.ticket).toMatchObject({ title: 'Field test', ai_summary: 'SUMMARY-X', resolution_notes: 'RES-X', legacy_id: 'PROJ-9', customer_name: expect.any(String), consultant_name: expect.any(String) });
    expect(a.fields).toMatchObject({ title: 'write', ai_summary: 'write', consultant: 'write', resolution_notes: 'write', customer: 'read', project: 'read', legacy: 'read' });   // the most each field allows
    const c = (await call(customer, 'GET', `/api/tickets/${ticketId}`)).body;
    expect(c.ticket).toMatchObject({ ai_summary: 'SUMMARY-X', resolution_notes: 'RES-X' });
    for (const k of ['legacy_id', 'legacy_source', 'legacy_type', 'legacy_status']) expect(c.ticket).not.toHaveProperty(k);
    expect(c.fields.legacy).toBe('hidden');
  });

  it('a new custom role is closed by default: only title and phase, never the sensitive columns', async () => {
    const u = await customUser(['board.view', 'ticket.view_all']);
    const list = (await call(u, 'GET', '/api/tickets')).body.find((t: any) => t.id === ticketId);
    expect(Object.keys(list).sort()).toEqual(['awaiting_approval', 'created_at', 'current_state', 'id', 'is_assigned', 'is_done', 'ticket_type_id', 'title', 'type_key', 'type_name', 'type_short', 'updated_at']);
    const t = (await call(u, 'GET', `/api/tickets/${ticketId}`)).body.ticket;
    for (const k of ['ai_summary', 'customer_id', 'customer_name', 'consultant_id', 'consultant_name', 'project_id', 'project_name', 'legacy_id', 'resolution_notes', 'acceptance_criteria'])
      expect(t, k).not.toHaveProperty(k);
    expect(t.title).toBe('Field test'); expect(t.is_assigned).toBe(true);        // "is it assigned" is core; WHO is not
  });

  it('visibility of a ticket does not depend on a column the viewer cannot read', async () => {
    const u = await customUser(['board.view', 'ticket.view_own'], { title: 'read' });          // customer field hidden
    await pool.query('UPDATE tickets SET customer_id=$2 WHERE id=$1', [ticketId, u.id]);
    try {
      expect((await call(u, 'GET', `/api/tickets/${ticketId}`)).status).toBe(200);            // still "their" ticket
      expect((await call(u, 'GET', `/api/tickets/${ticketId}`)).body.ticket).not.toHaveProperty('customer_name');
    } finally { await pool.query('UPDATE tickets SET customer_id=$2 WHERE id=$1', [ticketId, customer.id]); }
  });

  it('create and phase-change responses are sanitized too', async () => {
    const u = await customUser(['board.view', 'ticket.view_all', 'ticket.create', 'ticket.advance']);
    const made = await call(u, 'POST', '/api/tickets', { projectId, title: 'created by closed role', aiSummary: 'SECRET-SUMMARY' });
    expect(made.status).toBe(201);
    expect(made.body).not.toHaveProperty('ai_summary'); expect(made.body).not.toHaveProperty('project_id'); expect(made.body).not.toHaveProperty('customer_id');
    expect(JSON.stringify(made.body)).not.toContain('SECRET-SUMMARY');
  });
});

describe('the field-access grids', () => {
  it('each console is limited to its own administrators', async () => {
    expect((await call(consultant, 'GET', '/api/project/ticket-fields')).status).toBe(403);
    expect((await call(consultant, 'PUT', `/api/project/roles/${await roleId('Customer')}/ticket-fields`, { access: { ai_summary: 'hidden' } })).status).toBe(403);
    expect((await call(projAdmin, 'GET', '/api/platform/roles')).status).toBe(403);                     // the role templates are the Super Admin's
    expect((await call(projAdmin, 'PUT', `/api/platform/roles/${await roleId('Customer')}/ticket-fields`, { access: { ai_summary: 'hidden' } })).status).toBe(403);
  });

  it('a Project Admin tunes a role for their project: it applies at once, only here, and can be reset', async () => {
    const grid = (await call(projAdmin, 'GET', '/api/project/ticket-fields')).body;
    expect(grid.fields.map((f: any) => f.key)).toEqual(FIELD_KEYS);
    const cust = grid.roles.find((r: any) => r.name === 'Customer');
    expect(cust).toMatchObject({ tuned: false, access: { title: 'read', ai_summary: 'read', legacy: 'hidden' } });
    expect(grid.roles.find((r: any) => r.name === 'Project Admin')).toMatchObject({ locked: true });

    expect((await call(projAdmin, 'PUT', `/api/project/roles/${cust.id}/ticket-fields`, { access: { ai_summary: 'hidden', resolution_notes: 'hidden' } })).body.changed).toBe(2);
    const seen = (await call(customer, 'GET', '/api/tickets')).body.find((t: any) => t.id === ticketId);
    expect(seen).not.toHaveProperty('ai_summary');                                 // took effect without re-login
    expect((await call(customer, 'GET', `/api/tickets/${ticketId}`)).body.ticket).not.toHaveProperty('resolution_notes');
    const after = (await call(projAdmin, 'GET', '/api/project/ticket-fields')).body.roles.find((r: any) => r.name === 'Customer');
    expect(after).toMatchObject({ tuned: true, access: { ai_summary: 'hidden', title: 'read', customer: 'read', legacy: 'hidden' } });   // untouched fields keep their meaning
    // the standard template (every other project) is untouched
    expect((await call(admin, 'GET', '/api/platform/roles')).body.find((r: any) => r.name === 'Customer').fieldAccess).toMatchObject({ ai_summary: 'read', resolution_notes: 'read' });

    expect((await call(projAdmin, 'DELETE', `/api/project/roles/${cust.id}/ticket-fields`)).status).toBe(200);        // back to the standard role
    expect((await call(customer, 'GET', `/api/tickets/${ticketId}`)).body.ticket.ai_summary).toBe('SUMMARY-X');
    expect((await call(projAdmin, 'GET', '/api/project/ticket-fields')).body.roles.find((r: any) => r.name === 'Customer').tuned).toBe(false);
  });

  it('is validated, protects Project Admin, ignores no-ops, and the log records field names, never values', async () => {
    const cust = (await call(projAdmin, 'GET', '/api/project/ticket-fields')).body.roles.find((r: any) => r.name === 'Customer');
    for (const bad of [{ title: 'hidden' }, { customer: 'write' }, { nope: 'read' }, { ai_summary: 'root' }])
      expect((await call(projAdmin, 'PUT', `/api/project/roles/${cust.id}/ticket-fields`, { access: bad })).status, JSON.stringify(bad)).toBe(400);
    expect((await call(projAdmin, 'PUT', `/api/project/roles/${await roleId('Project Admin')}/ticket-fields`, { access: { ai_summary: 'hidden' } })).status).toBe(400);
    expect((await call(projAdmin, 'PUT', '/api/project/roles/999999/ticket-fields', { access: { ai_summary: 'read' } })).status).toBe(404);
    await call(projAdmin, 'PUT', `/api/project/roles/${cust.id}/ticket-fields`, { access: { ai_summary: 'hidden' } });
    expect((await call(projAdmin, 'PUT', `/api/project/roles/${cust.id}/ticket-fields`, { access: { ai_summary: 'hidden' } })).body.changed).toBe(0);
    await call(projAdmin, 'DELETE', `/api/project/roles/${cust.id}/ticket-fields`);
    const log = (await call(projAdmin, 'GET', '/api/project/audit')).body.filter((a: any) => a.action === 'role.ticket-fields');
    expect(JSON.stringify(log)).toContain('ai_summary'); expect(JSON.stringify(log)).not.toContain('SUMMARY-X');
  });

  it('the Super Admin edits the standard template; projects that have not tuned the role follow it, tuned ones do not', async () => {
    const cust = await roleId('Customer');
    const second = await makeProject('second field project');
    const c2 = await makeUser('Customer', undefined, second);
    const t2 = await createTicket(second, 'in second'); await pool.query('UPDATE tickets SET customer_id=$2, ai_summary=$3 WHERE id=$1', [t2.id, c2.id, 'S2']);
    await addMember(second, projAdmin.id, 'Project Admin');
    try {
      expect((await call(admin, 'PUT', `/api/platform/roles/${cust}/ticket-fields`, { access: { ai_summary: 'hidden' } })).status).toBe(200);
      expect((await call(c2, 'GET', `/api/tickets/${t2.id}`)).body.ticket).not.toHaveProperty('ai_summary');
      expect((await call(customer, 'GET', `/api/tickets/${ticketId}`)).body.ticket).not.toHaveProperty('ai_summary');
      // this project tunes it back on: it now ignores the template; the other project still follows it
      await call(projAdmin, 'PUT', `/api/project/roles/${cust}/ticket-fields`, { access: { ai_summary: 'read' } });
      expect((await call(customer, 'GET', `/api/tickets/${ticketId}`)).body.ticket.ai_summary).toBe('SUMMARY-X');
      expect((await call(c2, 'GET', `/api/tickets/${t2.id}`)).body.ticket).not.toHaveProperty('ai_summary');
      expect((await call(admin, 'PUT', `/api/platform/roles/${await roleId('Project Admin')}/ticket-fields`, { access: { ai_summary: 'hidden' } })).status).toBe(400);
      expect((await call(admin, 'PUT', `/api/platform/roles/${cust}/ticket-fields`, { access: { customer: 'write' } })).status).toBe(400);
    } finally {
      await call(projAdmin, 'DELETE', `/api/project/roles/${cust}/ticket-fields`);
      await call(admin, 'PUT', `/api/platform/roles/${cust}/ticket-fields`, { access: { ai_summary: 'read' } });
    }
  });

  it('cloning a role in the catalog copies its field access; a brand-new role is closed', async () => {
    const leadId = await roleId('Lead');
    const made = (await call(admin, 'POST', '/api/platform/roles', { name: `Lead copy ${Date.now()}`, copyFromRoleId: leadId })).body.id;
    const roles = (await call(admin, 'GET', '/api/platform/roles')).body;
    expect(roles.find((r: any) => r.id === made).fieldAccess).toEqual(roles.find((r: any) => r.id === leadId).fieldAccess);
    const fromPA = (await call(admin, 'POST', '/api/platform/roles', { name: `PA copy ${Date.now()}`, copyFromRoleId: await roleId('Project Admin') })).body.id;
    expect((await call(admin, 'GET', '/api/platform/roles')).body.find((r: any) => r.id === fromPA).fieldAccess).toMatchObject({ title: 'write', ai_summary: 'write', customer: 'read', legacy: 'read' });
    const scratch = (await call(admin, 'POST', '/api/platform/roles', { name: `Scratch ${Date.now()}` })).body.id;
    expect((await call(admin, 'GET', '/api/platform/roles')).body.find((r: any) => r.id === scratch).fieldAccess).toMatchObject({ title: 'read', ai_summary: 'hidden', customer: 'hidden' });
  });
});

describe('editing ticket details', () => {
  it('needs Edit on each field, and refuses the whole request if any field is not allowed', async () => {
    const before = (await pool.query('SELECT ai_summary, resolution_notes FROM tickets WHERE id=$1', [ticketId])).rows[0];
    expect((await call(lead, 'PATCH', `/api/tickets/${ticketId}`, { aiSummary: 'LEAD-EDIT', resolutionNotes: 'LEAD-NOTES' })).status).toBe(200);
    expect((await pool.query('SELECT ai_summary FROM tickets WHERE id=$1', [ticketId])).rows[0].ai_summary).toBe('LEAD-EDIT');

    const m = await call(manager, 'PATCH', `/api/tickets/${ticketId}`, { aiSummary: 'nope' });       // Manager: read-only
    expect(m.status).toBe(403); expect(m.body.denied).toEqual(['ai_summary']);
    const mixed = await call(consultant, 'PATCH', `/api/tickets/${ticketId}`, { acceptanceCriteria: 'ALLOWED?', title: 'T2' });   // Consultant may edit both
    expect(mixed.status).toBe(200);
    await pool.query('UPDATE ticket_field_access SET access=$2 WHERE role_id=$1 AND field=$3', [await roleId('Consultant'), 'read', 'title']);
    try {
      const partial = await call(consultant, 'PATCH', `/api/tickets/${ticketId}`, { acceptanceCriteria: 'SHOULD-NOT-SAVE', title: 'T3' });
      expect(partial.status).toBe(403);                                                               // title now read-only → nothing saved
      expect((await pool.query('SELECT acceptance_criteria FROM tickets WHERE id=$1', [ticketId])).rows[0].acceptance_criteria).not.toBe('SHOULD-NOT-SAVE');
    } finally { await pool.query('UPDATE ticket_field_access SET access=$2 WHERE role_id=$1 AND field=$3', [await roleId('Consultant'), 'write', 'title']); }
    await pool.query('UPDATE tickets SET ai_summary=$2, resolution_notes=$3, title=$4 WHERE id=$1', [ticketId, before.ai_summary, before.resolution_notes, 'Field test']);
  });

  it('only on tickets the person can see, with a strict body, and the log records field names only', async () => {
    expect((await call(other, 'PATCH', `/api/tickets/${ticketId}`, { aiSummary: 'x' })).status).toBe(404);   // someone else's ticket
    expect((await call(customer, 'PATCH', `/api/tickets/${ticketId}`, { aiSummary: 'x' })).status).toBe(403);
    expect((await call(lead, 'PATCH', `/api/tickets/${ticketId}`, {})).status).toBe(400);
    expect((await call(lead, 'PATCH', `/api/tickets/${ticketId}`, { customerId: customer.id })).status).toBe(400);   // not an editable field
    expect((await call(lead, 'PATCH', `/api/tickets/${ticketId}`, { title: '   ' })).status).toBe(400);
    await call(lead, 'PATCH', `/api/tickets/${ticketId}`, { resolutionNotes: 'TOP-SECRET-NOTE' });
    const log = (await call(admin, 'GET', '/api/admin/audit')).body;                                  // audit shows activity for admins
    void log;
    const rows = (await pool.query(`SELECT detail FROM audit_log WHERE action='ticket.update' ORDER BY id DESC LIMIT 5`)).rows;
    expect(JSON.stringify(rows)).toContain('resolution_notes'); expect(JSON.stringify(rows)).not.toContain('TOP-SECRET-NOTE');
    const res = await call(lead, 'PATCH', `/api/tickets/${ticketId}`, { resolutionNotes: '' });      // empty clears
    expect(res.body.resolution_notes ?? null).toBeNull();
  });

  it('claiming and assigning need Edit on the consultant field', async () => {
    const free = await createTicket(projectId, 'to claim');
    const noEdit = await customUser(['board.view', 'ticket.view_all', 'ticket.claim', 'ticket.assign'], { consultant: 'read' });
    expect((await call(noEdit, 'POST', `/api/tickets/${free.id}/claim`)).status).toBe(403);
    expect((await call(noEdit, 'POST', `/api/tickets/${free.id}/assign`, { consultantId: consultant.id })).status).toBe(403);
    expect((await call(consultant, 'POST', `/api/tickets/${free.id}/claim`)).status).toBe(200);
    expect((await call(lead, 'POST', `/api/tickets/${free.id}/assign`, { consultantId: other.id })).status).toBe(200);
  });
});

describe('reports, exports and dashboards cannot reveal a hidden column', () => {
  const def = (o: Record<string, unknown>) => ({ dataset: 'tickets', measure: 'count', groupBy: 'state', filters: {}, sort: 'natural', limit: 12, chart: 'column', ...o });

  it('grouping or filtering by a hidden field is refused; other groupings still work', async () => {
    const u = await customUser(['report.view', 'report.build', 'board.view', 'ticket.view_all'], { project: 'read' });   // consultant hidden
    const run = (d: object) => call(u, 'POST', '/api/reports/preview', { definition: d });
    const byCons = await run(def({ groupBy: 'consultant', chart: 'bar' }));
    expect(byCons.status).toBe(403); expect(byCons.body.blockedFields).toEqual(['consultant']);
    expect((await run(def({ filters: { consultantIds: ['unassigned'] } }))).status).toBe(403);
    expect((await run(def({ groupBy: 'source', chart: 'bar' }))).status).toBe(403);          // legacy hidden
    expect((await run(def({ groupBy: 'customer', chart: 'bar' }))).status).toBe(403);
    expect((await run(def({}))).status).toBe(200);
    expect((await run({ dataset: 'approvals', measure: 'count', groupBy: 'status', filters: {}, chart: 'bar' })).status).toBe(200);
    // the same restriction on a SAVED, shared report and on its CSV, for a viewer who lacks the field
    const rep = (await call(admin, 'POST', '/api/reports', { name: 'Per consultant', definition: def({ groupBy: 'consultant', chart: 'bar' }), visibility: 'shared' })).body.id;
    expect((await call(admin, 'GET', `/api/reports/${rep}/data`)).status).toBe(200);
    const viewer = await customUser(['report.view', 'board.view', 'ticket.view_all']);
    expect((await call(viewer, 'GET', `/api/reports/${rep}/data`)).status).toBe(403);
    expect((await call(viewer, 'GET', `/api/reports/${rep}/csv`)).status).toBe(403);
  });

  it('the report builder is told which fields the viewer can use', async () => {
    const u = await customUser(['report.view', 'report.build', 'board.view'], { project: 'read' });
    const meta = (await call(u, 'GET', '/api/reports/meta')).body;
    expect(meta.readableFields).toEqual(['title', 'project']);
    expect(meta.datasets.find((d: any) => d.key === 'tickets').dimensions.find((d: any) => d.key === 'consultant').field).toBe('consultant');
    expect(meta.filterFields).toMatchObject({ consultantIds: 'consultant', sources: 'legacy' });
    expect(meta.filterFields).not.toHaveProperty('projectIds');                       // one project per workspace: nothing to filter by
  });

  it('the team dashboard, which names consultants, needs that field', async () => {
    const u = await customUser(['dashboard.team', 'board.view', 'ticket.view_all']);
    expect((await call(u, 'GET', '/api/dashboard/team')).status).toBe(403);
    expect((await call(lead, 'GET', '/api/dashboard/team')).status).toBe(200);
  });
});
