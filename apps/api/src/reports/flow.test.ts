import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pool } from '../db.js';
import { buildApp } from '../app.js';
import { makeCustomUser, makeUser } from '../testAuth.js';
import { backfillSnapshots, takeSnapshot, snapshotDue } from './snapshots.js';
import { DATASETS, ReportDefinition, toCsv } from './engine.js';

const app = buildApp();
type U = Awaited<ReturnType<typeof makeUser>>;
let sup: U, pid: string, pa: U, lead: U, customer: U, incident: number;
const call = async (u: { cookie: string }, method: 'GET' | 'POST', url: string, payload?: unknown) => {
  const r = await app.inject({ method, url, payload: payload as any, headers: { cookie: u.cookie } });
  let body: any; try { body = r.json(); } catch { body = r.body; }
  return { status: r.statusCode, body };
};
const run = (u: U, definition: Record<string, unknown>) => call(u, 'POST', '/api/reports/preview', { definition: { sort: 'natural', limit: 12, filters: {}, groupBy: null, ...definition } });
const dAgo = (d: number) => `now() - interval '${d} days'`;

/** A ticket with a history we control: [phase, days ago it was entered]. The first entry is where it started. */
async function mk(title: string, createdDaysAgo: number, steps: [string, number][], extra: { legacy?: boolean } = {}) {
  const cur = steps[steps.length - 1][0];
  const id = (await pool.query(`INSERT INTO tickets (project_id, title, ticket_type_id, current_state, created_at${extra.legacy ? ', legacy_id, legacy_source' : ''}) VALUES ($1,$2,$3,$4,${dAgo(createdDaysAgo)}${extra.legacy ? `, 'MIR-' || $5, 'jira'` : ''}) RETURNING id`, [pid, title, incident, cur, ...(extra.legacy ? [Math.random().toString(36).slice(2, 7)] : [])])).rows[0].id as string;
  await pool.query('DELETE FROM ticket_transitions WHERE ticket_id=$1', [id]);
  await pool.query(`INSERT INTO ticket_transitions (ticket_id, from_state, to_state, created_at) VALUES ($1, NULL, $2, ${dAgo(createdDaysAgo)})`, [id, steps[0][0]]);
  for (let i = 1; i < steps.length; i++) await pool.query(`INSERT INTO ticket_transitions (ticket_id, from_state, to_state, created_at) VALUES ($1,$2,$3, ${dAgo(steps[i][1])})`, [id, steps[i - 1][0], steps[i][0]]);
  return id;
}

beforeAll(async () => {
  await app.ready();
  sup = await makeUser('Admin');
  pid = (await call(sup, 'POST', '/api/platform/projects', { name: `Flow ${Math.random().toString(36).slice(2, 7)}`, projectTypeId: (await pool.query("SELECT id FROM project_types WHERE key='support'")).rows[0].id })).body.id;
  pa = await makeUser('Project Admin', undefined, pid); lead = await makeUser('Lead', undefined, pid); customer = await makeUser('Customer', undefined, pid);
  incident = (await pool.query("SELECT id FROM ticket_types WHERE key='incident'")).rows[0].id;
  await mk('T1', 10, [['New', 10], ['Triage', 9], ['In Progress', 8], ['Resolved', 6], ['Closed', 5]]);                                           // lead 5, cycle 4
  await mk('T2', 20, [['New', 20], ['Triage', 19], ['In Progress', 18], ['Pending', 16], ['In Progress', 14], ['Resolved', 12], ['Closed', 10]]); // lead 10, cycle 9, came back to In Progress once
  await mk('T3', 30, [['New', 30], ['Closed', 26]]);                                                                                              // lead 4
  await mk('T4', 4, [['New', 4], ['In Progress', 3]]);                                                                                            // still open: 3 days in In Progress
  const mirrored = await mk('T5', 12, [['New', 12]], { legacy: true });                                                                           // finished in the source tool
  for (const [from, to, d] of [['To Do', 'In Progress', 10], ['In Progress', 'Done', 7]] as const) await pool.query(`INSERT INTO ticket_source_history (ticket_id, project_id, at, from_status, to_status) VALUES ($1,$2,${dAgo(d)},$3,$4)`, [mirrored, pid, from, to]);
});
afterAll(async () => { await app.close(); await pool.end(); });

describe('lead and cycle time', () => {
  it('measures finished tickets from our own history and from the source tool’s history', async () => {
    const r = async (measure: string, groupBy: string | null = null, chart = 'kpi') => (await run(lead, { dataset: 'flow', measure, groupBy, chart })).body;
    expect((await r('count')).rows[0].value).toBe(4);                                          // T1, T2, T3 here and T5 in the source
    expect((await r('p50_lead_days')).rows[0].value).toBe(5);
    expect((await r('p85_lead_days')).rows[0].value).toBe(7.8);
    expect((await r('avg_lead_days')).rows[0].value).toBe(6);
    expect((await r('avg_cycle_days')).rows[0].value).toBe(4);                                 // 4, 9, 0 (it went straight to Closed), 3
    const byType = await r('count', 'type', 'column');
    expect(byType.rows.find((x: any) => x.label === 'Incident').value).toBe(4);
  });
});

describe('time in status and bounces', () => {
  it('adds up the days spent in a status, counts the times a ticket came back, and keeps our phases apart from the source’s statuses', async () => {
    const q = async (measure: string, extra: Record<string, unknown> = {}) => (await run(lead, { dataset: 'intervals', measure, groupBy: 'status', chart: 'column', ...extra })).body.rows;
    const ip = (await q('total_days', { filters: { states: ['In Progress'], origins: ['phase'] } })).find((x: any) => x.label === 'In Progress');
    expect(ip.value).toBe(9);                                                                  // T1 2 + T2 2 + 2 + T4 3
    expect((await q('reentries', { filters: { states: ['In Progress'], origins: ['phase'] } })).find((x: any) => x.label === 'In Progress').value).toBe(1);
    const src = await q('visits', { filters: { origins: ['source'] } });
    expect(src.filter((x: any) => x.value > 0).map((x: any) => x.label).sort()).toEqual(['Done', 'In Progress', 'To Do']);
    expect((await q('total_days', { filters: { states: ['To Do'], origins: ['source'] } })).find((x: any) => x.label === 'To Do').value).toBe(2);   // before its first change: created 12 days ago, changed 10 days ago
  });
});

describe('the pipeline day by day', () => {
  it('rebuilds past days from history, draws them as stacks by phase, and is for people who can see every ticket', async () => {
    expect(await backfillSnapshots(pid, 30)).toBeGreaterThan(0);
    const day = (await pool.query(`SELECT (current_date - 11)::text AS d`)).rows[0].d as string;
    const r = (await run(lead, { dataset: 'snapshots', measure: 'wip', groupBy: 'on_day', seriesBy: 'phase', chart: 'stack', filters: { range: '30d' } })).body;
    const row = r.rows.find((x: any) => x.label === day);
    expect(row.parts).toEqual({ Resolved: 1, Closed: 1, New: 1 });                               // T2 was resolved, T3 closed, the mirrored T5 was still new here; T1 and T4 did not exist yet
    expect(row.value).toBe(3);
    expect(r.series).toEqual(expect.arrayContaining(['New', 'In Progress', 'Resolved', 'Closed']));
    const narrow = await makeCustomUser(['board.view', 'ticket.view_own', 'report.view', 'report.build'], {}, pid);        // can build reports, but cannot see every ticket
    expect((await run(narrow, { dataset: 'snapshots', measure: 'wip', groupBy: 'on_day', seriesBy: 'phase', chart: 'stack' })).status).toBe(403);
    const meta = (await call(narrow, 'GET', '/api/reports/meta')).body.datasets.map((d: any) => d.key);
    expect(meta).not.toContain('snapshots'); expect((await call(lead, 'GET', '/api/reports/meta')).body.datasets.map((d: any) => d.key)).toContain('snapshots');
    expect(toCsv(r).split('\r\n')[0]).toContain('Total');
  });
  it('takes a record for today, replaces it rather than doubling it, and does so for projects that have none', async () => {
    await takeSnapshot(pid); const n1 = (await pool.query('SELECT sum(tickets)::int n FROM ticket_daily_snapshot WHERE project_id=$1 AND day=current_date', [pid])).rows[0].n;
    await takeSnapshot(pid); expect((await pool.query('SELECT sum(tickets)::int n FROM ticket_daily_snapshot WHERE project_id=$1 AND day=current_date', [pid])).rows[0].n).toBe(n1);
    expect(n1).toBe(5);
    await pool.query('DELETE FROM ticket_daily_snapshot WHERE project_id=$1 AND day=current_date', [pid]);
    expect(await snapshotDue()).toBeGreaterThan(0);
    expect((await pool.query('SELECT count(*)::int n FROM ticket_daily_snapshot WHERE project_id=$1 AND day=current_date', [pid])).rows[0].n).toBeGreaterThan(0);
  });
});

describe('definitions', () => {
  it('only stack by something that adds up, and only on a stacked chart', () => {
    const base = { dataset: 'flow', groupBy: 'type', filters: {}, sort: 'natural', limit: 12 };
    expect(ReportDefinition.safeParse({ ...base, measure: 'p50_lead_days', seriesBy: 'priority', chart: 'stack' }).success).toBe(false);
    expect(ReportDefinition.safeParse({ ...base, measure: 'count', seriesBy: 'priority', chart: 'stack' }).success).toBe(true);
    expect(ReportDefinition.safeParse({ ...base, measure: 'count', seriesBy: 'priority', chart: 'column' }).success).toBe(false);
    expect(ReportDefinition.safeParse({ ...base, measure: 'count', seriesBy: 'type', chart: 'stack' }).success).toBe(false);
    expect(ReportDefinition.safeParse({ ...base, measure: 'count', chart: 'stack' }).success).toBe(false);
    expect(Object.keys(DATASETS)).toEqual(expect.arrayContaining(['flow', 'intervals', 'signoffs', 'snapshots']));
  });
  it('the built-in flow reports all run for a Lead, and the dashboard that holds them exists', async () => {
    const reports = (await call(lead, 'GET', '/api/reports')).body.filter((r: any) => r.isSystem && /lead time|per week|time in|bounces|Pipeline over|turnaround|spend their time|bounce/i.test(r.name));
    expect(reports.length).toBeGreaterThanOrEqual(6);
    for (const rp of reports) expect((await call(lead, 'GET', `/api/reports/${rp.id}/data`)).status, rp.name).toBe(200);
    expect((await call(lead, 'GET', '/api/dashboards')).body.some((d: any) => d.name === 'Flow and delivery health')).toBe(true);
  });
  it('a sign-off report counts answers and times them', async () => {
    const t = (await pool.query('SELECT id, project_id FROM tickets WHERE project_id=$1 LIMIT 1', [pid])).rows[0];
    await pool.query(`INSERT INTO ticket_signoffs (ticket_id, project_id, customer_id, status, requested_at, decided_at) VALUES ($1,$2,$3,'approved', now() - interval '5 hours', now() - interval '2 hours')`, [t.id, pid, customer.id]);
    expect((await run(lead, { dataset: 'signoffs', measure: 'avg_hours', chart: 'kpi' })).body.rows[0].value).toBe(3);
  });
});
