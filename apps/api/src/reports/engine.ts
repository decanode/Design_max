import { z } from 'zod';
import { pool } from '../db.js';
import { STATES } from '../stateMachine.js';
import { ticketScope, type SessionUser } from '../rbac/auth.js';

/**
 * Report engine. A report is a validated definition (dataset + measure + grouping + filters + chart).
 * SQL is assembled ONLY from the whitelists below; user input is bound as parameters, never concatenated.
 * Every query is restricted to tickets the viewer may see (same rule as the board).
 */

type Time = 'day' | 'week' | 'month';
interface Dim { label: string; sql: string; domain?: readonly string[]; time?: Time }
interface Measure { label: string; unit: string; sql: string }
interface Dataset { label: string; from: string; dims: Record<string, Dim>; measures: Record<string, Measure>; filters: string[]; dateCol: string }

const bucket = (col: string, t: Time) => `to_char(date_trunc('${t}', ${col}), 'YYYY-MM-DD')`;
const timeDims = (col: string, prefix: string, noun: string): Record<string, Dim> => ({
  [`${prefix}day`]: { label: `${noun} (day)`, sql: bucket(col, 'day'), time: 'day' },
  [`${prefix}week`]: { label: `${noun} (week)`, sql: bucket(col, 'week'), time: 'week' },
  [`${prefix}month`]: { label: `${noun} (month)`, sql: `to_char(date_trunc('month', ${col}), 'YYYY-MM')`, time: 'month' },
});

const COUNT = (unit: string): Measure => ({ label: `Number of ${unit}`, unit, sql: 'count(*)' });
const AGE = 'extract(epoch from (now() - t.created_at)) / 86400';

export const DATASETS: Record<string, Dataset> = {
  tickets: {
    label: 'Tickets',
    from: `tickets t JOIN projects pr ON pr.id = t.project_id LEFT JOIN users co ON co.id = t.consultant_id LEFT JOIN users cu ON cu.id = t.customer_id`,
    dateCol: 't.created_at',
    dims: {
      state: { label: 'Phase', sql: 't.current_state::text', domain: STATES },
      project: { label: 'Project', sql: 'pr.name' },
      consultant: { label: 'Consultant', sql: `COALESCE(co.display_name, 'Unassigned')` },
      customer: { label: 'Customer', sql: `COALESCE(cu.display_name, 'Not recorded')` },
      source: { label: 'Source', sql: `CASE t.legacy_source WHEN 'jira' THEN 'Jira' WHEN 'servicenow' THEN 'ServiceNow' ELSE 'Design Max' END` },
      awaiting: { label: 'Approval status', sql: `CASE WHEN EXISTS (SELECT 1 FROM approvals a WHERE a.ticket_id = t.id AND a.status = 'pending') THEN 'Awaiting approval' ELSE 'Not waiting' END` },
      ...timeDims('t.created_at', 'created_', 'Created'),
    },
    measures: {
      count: COUNT('tickets'),
      avg_age_days: { label: 'Average age (days)', unit: 'days', sql: `round(avg(${AGE})::numeric, 1)` },
      max_age_days: { label: 'Oldest ticket (days)', unit: 'days', sql: `round(max(${AGE})::numeric, 1)` },
    },
    filters: ['states', 'projectIds', 'consultantIds', 'sources', 'openOnly', 'range'],
  },
  approvals: {
    label: 'Approvals',
    from: `approvals a JOIN tickets t ON t.id = a.ticket_id JOIN users ap ON ap.id = a.approver_id`,
    dateCol: 'a.requested_at',
    dims: {
      status: { label: 'Status', sql: 'a.status' },
      kind: { label: 'Document', sql: `CASE a.kind WHEN 'FS' THEN 'Functional spec' ELSE 'Technical spec' END` },
      approver: { label: 'Approver', sql: 'ap.display_name' },
      ...timeDims('a.requested_at', 'requested_', 'Requested'),
    },
    measures: {
      count: COUNT('approvals'),
      avg_decision_hours: { label: 'Average time to decision (hours)', unit: 'hours', sql: `round((avg(extract(epoch from (a.decided_at - a.requested_at)) / 3600) FILTER (WHERE a.decided_at IS NOT NULL))::numeric, 1)` },
    },
    filters: ['statuses', 'kinds', 'projectIds', 'range'],
  },
  transitions: {
    label: 'Phase changes',
    from: `ticket_transitions x JOIN tickets t ON t.id = x.ticket_id LEFT JOIN users ac ON ac.id = x.actor_id`,
    dateCol: 'x.created_at',
    dims: {
      to_state: { label: 'Moved to', sql: 'x.to_state::text', domain: STATES },
      from_state: { label: 'Moved from', sql: `COALESCE(x.from_state::text, 'Created')`, domain: ['Created', ...STATES.slice(0, -1)] },
      actor: { label: 'Done by', sql: `COALESCE(ac.display_name, 'System')` },
      ...timeDims('x.created_at', '', 'When'),
    },
    measures: { count: COUNT('phase changes') },
    filters: ['states', 'projectIds', 'range'],
  },
};

const RANGES: Record<string, string> = { '7d': '7 days', '30d': '30 days', '90d': '90 days', '365d': '365 days' };
const uuid = z.string().uuid();

export const Filters = z.object({
  states: z.array(z.enum(STATES)).max(9).optional(),
  projectIds: z.array(uuid).max(50).optional(),
  consultantIds: z.array(z.union([uuid, z.literal('unassigned')])).max(50).optional(),
  sources: z.array(z.enum(['jira', 'servicenow', 'native'])).max(3).optional(),
  openOnly: z.boolean().optional(),
  statuses: z.array(z.enum(['pending', 'approved', 'rejected', 'superseded'])).max(4).optional(),
  kinds: z.array(z.enum(['FS', 'TS'])).max(2).optional(),
  range: z.enum(['7d', '30d', '90d', '365d', 'all']).optional(),
}).strict();

export const ReportDefinition = z.object({
  dataset: z.enum(['tickets', 'approvals', 'transitions']),
  measure: z.string(),
  groupBy: z.string().nullable().default(null),
  filters: Filters.default({}),
  sort: z.enum(['natural', 'value_desc', 'value_asc']).default('natural'),
  limit: z.number().int().min(1).max(50).default(12),
  chart: z.enum(['kpi', 'bar', 'column', 'line', 'share', 'table']),
}).superRefine((d, ctx) => {
  const ds = DATASETS[d.dataset];
  const bad = (message: string, path: string) => ctx.addIssue({ code: 'custom', message, path: [path] });
  if (!ds.measures[d.measure]) bad(`Unknown measure for ${ds.label}`, 'measure');
  if (d.groupBy && !ds.dims[d.groupBy]) bad(`Unknown grouping for ${ds.label}`, 'groupBy');
  for (const k of Object.keys(d.filters)) if (!ds.filters.includes(k)) bad(`The “${k}” filter does not apply to ${ds.label}`, 'filters');
  const time = d.groupBy ? ds.dims[d.groupBy]?.time : undefined;
  if (d.chart === 'kpi' && d.groupBy) bad('A single-number tile cannot be grouped', 'chart');
  if (d.chart !== 'kpi' && !d.groupBy) bad('Choose what to group by for this chart', 'groupBy');
  if (d.chart === 'line' && !time) bad('A line chart needs a time grouping (day, week or month)', 'chart');
  if (d.chart === 'share' && d.measure !== 'count') bad('A share chart only works for counts', 'chart');
});
export type ReportDef = z.infer<typeof ReportDefinition>;

export interface ReportResult {
  rows: { label: string; value: number | null }[];
  measure: { key: string; label: string; unit: string };
  dimension: { key: string; label: string; time?: Time } | null;
  truncated: boolean;
}

/** What the builder UI needs to offer: datasets, measures, groupings, and which filters apply. */
export function datasetMeta() {
  return Object.entries(DATASETS).map(([key, d]) => ({
    key, label: d.label, filters: d.filters,
    measures: Object.entries(d.measures).map(([k, m]) => ({ key: k, label: m.label, unit: m.unit })),
    dimensions: Object.entries(d.dims).map(([k, v]) => ({ key: k, label: v.label, time: v.time ?? null })),
  }));
}

// ---- time-bucket gap filling: a month with no tickets must show as 0, not vanish from the line
const fmt = (d: Date, t: Time) => (t === 'month' ? d.toISOString().slice(0, 7) : d.toISOString().slice(0, 10));
function fillGaps(rows: { label: string; value: number | null }[], t: Time) {
  if (rows.length < 2) return rows;
  const have = new Map(rows.map((r) => [r.label, r.value]));
  const start = new Date(rows[0].label.length === 7 ? `${rows[0].label}-01T00:00:00Z` : `${rows[0].label}T00:00:00Z`);
  const end = new Date(rows[rows.length - 1].label.length === 7 ? `${rows[rows.length - 1].label}-01T00:00:00Z` : `${rows[rows.length - 1].label}T00:00:00Z`);
  const out: typeof rows = [];
  for (let d = new Date(start); d <= end && out.length < 400; ) {
    const label = fmt(d, t);
    out.push({ label, value: have.get(label) ?? 0 });
    if (t === 'month') d.setUTCMonth(d.getUTCMonth() + 1); else d.setUTCDate(d.getUTCDate() + (t === 'week' ? 7 : 1));
  }
  return out;
}

export async function runReport(def: ReportDef, user: SessionUser): Promise<ReportResult> {
  const ds = DATASETS[def.dataset];
  const measure = ds.measures[def.measure];
  const dim = def.groupBy ? ds.dims[def.groupBy] : null;
  const params: unknown[] = [];
  const p = (v: unknown) => (params.push(v), `$${params.length}`);

  const scope = ticketScope(user, params.length + 1);
  params.push(...scope.params);
  const where: string[] = [scope.sql];

  const f = def.filters;
  if (f.states?.length) where.push(`${def.dataset === 'transitions' ? 'x.to_state' : 't.current_state'} = ANY(${p(f.states)}::ticket_state[])`);
  if (f.projectIds?.length) where.push(`t.project_id = ANY(${p(f.projectIds)}::uuid[])`);
  if (f.consultantIds?.length) {
    const ids = f.consultantIds.filter((x) => x !== 'unassigned');
    const un = f.consultantIds.includes('unassigned');
    where.push(`(${[ids.length ? `t.consultant_id = ANY(${p(ids)}::uuid[])` : '', un ? 't.consultant_id IS NULL' : ''].filter(Boolean).join(' OR ')})`);
  }
  if (f.sources?.length) where.push(`COALESCE(t.legacy_source, 'native') = ANY(${p(f.sources)}::text[])`);
  if (f.openOnly) where.push(`t.current_state <> 'Deployed'`);
  if (f.statuses?.length) where.push(`a.status = ANY(${p(f.statuses)}::text[])`);
  if (f.kinds?.length) where.push(`a.kind = ANY(${p(f.kinds)}::text[])`);
  if (f.range && f.range !== 'all') where.push(`${ds.dateCol} >= now() - interval '${RANGES[f.range]}'`); // RANGES is a closed whitelist

  const select = dim ? `${dim.sql} AS label, ${measure.sql} AS value` : `'' AS label, ${measure.sql} AS value`;
  const sql = `SELECT ${select} FROM ${ds.from} WHERE ${where.join(' AND ')}${dim ? ' GROUP BY 1' : ''}`;
  const raw = (await pool.query(`${sql}${dim ? ' ORDER BY 1 LIMIT 500' : ''}`, params)).rows
    .map((r) => ({ label: String(r.label), value: r.value == null ? null : Number(r.value) }));

  let rows = raw;
  let truncated = false;
  if (dim?.time) {
    rows = fillGaps(raw, dim.time).slice(-120);                       // time series: oldest first, newest 120 buckets
  } else if (dim) {
    if (def.sort === 'natural' && dim.domain) {
      // Lifecycle order, and every phase shown even when empty, so a gap reads as "none" and not "missing".
      const have = new Map(raw.map((r) => [r.label, r.value]));
      rows = dim.domain.map((label) => ({ label, value: have.get(label) ?? (def.measure === 'count' ? 0 : null) }));
    } else if (def.sort === 'value_desc') rows = [...raw].sort((a, b) => (b.value ?? -1) - (a.value ?? -1) || a.label.localeCompare(b.label));  // ties by name: stable between refreshes
    else if (def.sort === 'value_asc') rows = [...raw].sort((a, b) => ((a.value ?? Infinity) - (b.value ?? Infinity)) || a.label.localeCompare(b.label));
    if (rows.length > def.limit) {
      const rest = rows.slice(def.limit);
      rows = rows.slice(0, def.limit);
      truncated = true;
      if (def.measure === 'count') rows.push({ label: `Other (${rest.length})`, value: rest.reduce((n, r) => n + (r.value ?? 0), 0) });
    }
  } else rows = [{ label: measure.label, value: raw[0]?.value ?? null }];

  return {
    rows, truncated,
    measure: { key: def.measure, label: measure.label, unit: measure.unit },
    dimension: dim ? { key: def.groupBy!, label: dim.label, time: dim.time } : null,
  };
}

/** CSV with spreadsheet-formula neutralisation (cells starting = + - @ are prefixed with an apostrophe). */
export function toCsv(r: ReportResult) {
  const cell = (v: unknown) => {
    let s = v == null ? '' : String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [[r.dimension?.label ?? 'Measure', r.measure.label].map(cell).join(',')];
  for (const row of r.rows) lines.push([row.label, row.value].map(cell).join(','));
  return lines.join('\r\n') + '\r\n';
}
