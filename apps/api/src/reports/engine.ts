import { z } from 'zod';
import { pool } from '../db.js';
import { OPEN_SQL, projectPhaseNames } from '../workflow/service.js';
import { ticketScope, type SessionUser } from '../rbac/auth.js';
import { DocError } from '../errors.js';
import { canRead, fieldDef } from '../tickets/fields.js';

/**
 * Report engine. A report is a validated definition (dataset + measure + grouping + filters + chart).
 * SQL is assembled ONLY from the whitelists below; user input is bound as parameters, never concatenated.
 * Every query is restricted to tickets the viewer may see (same rule as the board).
 */

type Time = 'day' | 'week' | 'month';
/** Marks a dimension whose values are the project's phases; replaced by the real list when a report runs. */
const PHASES: readonly string[] = [];
interface Dim { label: string; sql: string; domain?: readonly string[]; time?: Time }
interface Measure { label: string; unit: string; sql: string; additive?: boolean }       // additive: the parts of a stacked chart really do add up to the whole
interface Dataset { label: string; from: string; dims: Record<string, Dim>; measures: Record<string, Measure>; filters: string[]; dateCol: string; stateCol?: string; noScope?: boolean; requires?: string }

const bucket = (col: string, t: Time) => `to_char(date_trunc('${t}', ${col}), 'YYYY-MM-DD')`;
const timeDims = (col: string, prefix: string, noun: string): Record<string, Dim> => ({
  [`${prefix}day`]: { label: `${noun} (day)`, sql: bucket(col, 'day'), time: 'day' },
  [`${prefix}week`]: { label: `${noun} (week)`, sql: bucket(col, 'week'), time: 'week' },
  [`${prefix}month`]: { label: `${noun} (month)`, sql: `to_char(date_trunc('month', ${col}), 'YYYY-MM')`, time: 'month' },
});

const COUNT = (unit: string): Measure => ({ label: `Number of ${unit}`, unit, sql: 'count(*)', additive: true });
const days = (a: string, b: string) => `extract(epoch from (${a} - ${b})) / 86400`;
const pct = (p: number, expr: string, filter = '') => `round((percentile_cont(${p}) WITHIN GROUP (ORDER BY ${expr})${filter})::numeric, 1)`;
const TONES = `CASE s.tone WHEN 'intake' THEN 'Intake' WHEN 'spec' THEN 'Specification' WHEN 'build' THEN 'Delivery' WHEN 'review' THEN 'Review' ELSE 'Done' END`;
const AGE = 'extract(epoch from (now() - t.created_at)) / 86400';

export const DATASETS: Record<string, Dataset> = {
  tickets: {
    label: 'Tickets',
    from: `tickets t LEFT JOIN users co ON co.id = t.consultant_id LEFT JOIN users cu ON cu.id = t.customer_id`,
    dateCol: 't.created_at',
    dims: {
      state: { label: 'Phase', sql: 't.current_state::text', domain: PHASES },
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
    filters: ['states', 'consultantIds', 'sources', 'openOnly', 'range'],
  },
  approvals: {
    label: 'Approvals',
    from: `approvals a JOIN tickets t ON t.id = a.ticket_id JOIN users ap ON ap.id = a.approver_id`,
    dateCol: 'a.requested_at',
    dims: {
      status: { label: 'Status', sql: 'a.status' },
      kind: { label: 'Document', sql: `CASE a.kind WHEN 'FS' THEN 'Functional spec' WHEN 'TS' THEN 'Technical spec' WHEN 'TUT' THEN 'Unit test' ELSE 'Code review' END` },
      approver: { label: 'Approver', sql: 'ap.display_name' },
      level: { label: 'Approval level', sql: `COALESCE(a.level_name, 'Ad hoc')` },
      ...timeDims('a.requested_at', 'requested_', 'Requested'),
    },
    measures: {
      count: COUNT('approvals'),
      avg_decision_hours: { label: 'Average time to decision (hours)', unit: 'hours', sql: `round((avg(extract(epoch from (a.decided_at - a.requested_at)) / 3600) FILTER (WHERE a.decided_at IS NOT NULL))::numeric, 1)` },
      p50_decision_hours: { label: 'Median time to decision (hours)', unit: 'hours', sql: pct(0.5, 'extract(epoch from (a.decided_at - a.requested_at)) / 3600', ' FILTER (WHERE a.decided_at IS NOT NULL)') },
      p85_decision_hours: { label: '85th percentile time to decision (hours)', unit: 'hours', sql: pct(0.85, 'extract(epoch from (a.decided_at - a.requested_at)) / 3600', ' FILTER (WHERE a.decided_at IS NOT NULL)') },
    },
    filters: ['statuses', 'kinds', 'range'],
  },
  flow: {
    label: 'Finished tickets (lead and cycle time)',
    from: `ticket_flow_v f JOIN tickets t ON t.id = f.ticket_id AND f.done_at IS NOT NULL LEFT JOIN ticket_types tt ON tt.id = t.ticket_type_id LEFT JOIN users co ON co.id = t.consultant_id`,
    dateCol: 'f.done_at',
    dims: {
      type: { label: 'Ticket type', sql: `COALESCE(tt.name, 'Other')` },
      consultant: { label: 'Consultant', sql: `COALESCE(co.display_name, 'Unassigned')` },
      priority: { label: 'Priority', sql: 't.priority', domain: ['Critical', 'High', 'Medium', 'Low'] },
      source: { label: 'Source', sql: `CASE t.legacy_source WHEN 'jira' THEN 'Jira' WHEN 'servicenow' THEN 'ServiceNow' ELSE 'Design Max' END` },
      ...timeDims('f.done_at', 'done_', 'Finished'),
    },
    measures: {
      count: COUNT('finished tickets'),
      avg_lead_days: { label: 'Average lead time (days, created to finished)', unit: 'days', sql: `round(avg(${days('f.done_at', 't.created_at')})::numeric, 1)` },
      p50_lead_days: { label: 'Median lead time (days)', unit: 'days', sql: pct(0.5, days('f.done_at', 't.created_at')) },
      p85_lead_days: { label: '85th percentile lead time (days)', unit: 'days', sql: pct(0.85, days('f.done_at', 't.created_at')) },
      p95_lead_days: { label: '95th percentile lead time (days)', unit: 'days', sql: pct(0.95, days('f.done_at', 't.created_at')) },
      avg_cycle_days: { label: 'Average cycle time (days, started to finished)', unit: 'days', sql: `round(avg(${days('f.done_at', 'COALESCE(f.started_at, t.created_at)')})::numeric, 1)` },
      p85_cycle_days: { label: '85th percentile cycle time (days)', unit: 'days', sql: pct(0.85, days('f.done_at', 'COALESCE(f.started_at, t.created_at)')) },
    },
    filters: ['consultantIds', 'sources', 'range'],
  },
  intervals: {
    label: 'Time in status',
    from: `ticket_intervals_v i JOIN tickets t ON t.id = i.ticket_id LEFT JOIN ticket_types tt ON tt.id = t.ticket_type_id`,
    dateCol: 'i.entered_at', stateCol: 'i.name',
    dims: {
      status: { label: 'Status', sql: 'i.name', domain: PHASES },
      origin: { label: 'Where it is tracked', sql: `CASE i.origin WHEN 'phase' THEN 'Our phases' ELSE 'Source tool' END` },
      type: { label: 'Ticket type', sql: `COALESCE(tt.name, 'Other')` },
      ...timeDims('i.entered_at', 'entered_', 'Entered'),
    },
    measures: {
      visits: { label: 'Number of visits to a status', unit: 'visits', sql: 'count(*)', additive: true },
      avg_days: { label: 'Average time in status (days)', unit: 'days', sql: `round(avg(${days('i.left_at', 'i.entered_at')})::numeric, 1)` },
      p85_days: { label: '85th percentile time in status (days)', unit: 'days', sql: pct(0.85, days('i.left_at', 'i.entered_at')) },
      total_days: { label: 'Total days spent in status', unit: 'days', sql: `round(sum(${days('i.left_at', 'i.entered_at')})::numeric, 1)`, additive: true },
      reentries: { label: 'Times a ticket came back to a status (bounces)', unit: 'times', sql: 'count(*) FILTER (WHERE i.visit_no > 1)', additive: true },
    },
    filters: ['states', 'sources', 'origins', 'range'],
  },
  signoffs: {
    label: 'Customer sign-offs',
    from: `ticket_signoffs so JOIN tickets t ON t.id = so.ticket_id`,
    dateCol: 'so.requested_at',
    dims: { status: { label: 'Answer', sql: `CASE so.status WHEN 'approved' THEN 'Confirmed' WHEN 'rejected' THEN 'Not resolved' WHEN 'pending' THEN 'Waiting' ELSE 'Withdrawn' END` }, ...timeDims('so.requested_at', 'asked_', 'Asked') },
    measures: {
      count: COUNT('sign-off requests'),
      avg_hours: { label: 'Average time to answer (hours)', unit: 'hours', sql: `round((avg(extract(epoch from (so.decided_at - so.requested_at)) / 3600) FILTER (WHERE so.decided_at IS NOT NULL AND so.status IN ('approved','rejected')))::numeric, 1)` },
      p85_hours: { label: '85th percentile time to answer (hours)', unit: 'hours', sql: pct(0.85, 'extract(epoch from (so.decided_at - so.requested_at)) / 3600', ` FILTER (WHERE so.decided_at IS NOT NULL AND so.status IN ('approved','rejected'))`) },
    },
    filters: ['range'],
  },
  snapshots: {
    label: 'Pipeline by day (trends)',
    from: 'ticket_daily_snapshot s', dateCol: 's.day', stateCol: 's.phase', noScope: true, requires: 'ticket.view_all',
    dims: { phase: { label: 'Phase', sql: 's.phase', domain: PHASES }, tone: { label: 'Kind of phase', sql: TONES, domain: ['Intake', 'Specification', 'Delivery', 'Review', 'Done'] }, ...timeDims('s.day', 'on_', 'Day') },
    measures: {
      wip: { label: 'Tickets in the pipeline (average per day)', unit: 'tickets', sql: 'round(sum(s.tickets)::numeric / NULLIF(count(DISTINCT s.day), 0), 1)', additive: true },
      oldest: { label: 'Oldest ticket in the bucket (days)', unit: 'days', sql: 'max(s.oldest_days)' },
    },
    filters: ['states', 'range'],
  },
  transitions: {
    label: 'Phase changes',
    from: `ticket_transitions x JOIN tickets t ON t.id = x.ticket_id LEFT JOIN users ac ON ac.id = x.actor_id`,
    dateCol: 'x.created_at',
    dims: {
      to_state: { label: 'Moved to', sql: 'x.to_state::text', domain: PHASES },
      from_state: { label: 'Moved from', sql: `COALESCE(x.from_state::text, 'Created')`, domain: ['Created', ...PHASES] },
      actor: { label: 'Done by', sql: `COALESCE(ac.display_name, 'System')` },
      ...timeDims('x.created_at', '', 'When'),
    },
    measures: { count: COUNT('phase changes') },
    filters: ['states', 'range'],
  },
};

/**
 * Column-level security: a report may not group by, or filter on, a ticket field the viewer cannot read,
 * otherwise a chart would reveal the hidden values (e.g. "tickets per consultant" for someone who cannot see consultants).
 */
export const DIM_FIELD: Record<string, Record<string, string>> = {
  tickets: { consultant: 'consultant', customer: 'customer', source: 'legacy' }, approvals: {}, transitions: {}, flow: { consultant: 'consultant', source: 'legacy' }, intervals: {}, signoffs: {}, snapshots: {},
};
export const FILTER_FIELD: Record<string, string> = { consultantIds: 'consultant', sources: 'legacy' };

export function fieldsNeeded(def: { dataset: string; groupBy: string | null; filters: Record<string, unknown> }): string[] {
  const need = new Set<string>();
  if (def.groupBy && DIM_FIELD[def.dataset]?.[def.groupBy]) need.add(DIM_FIELD[def.dataset][def.groupBy]);
  for (const k of Object.keys(def.filters)) if (FILTER_FIELD[k]) need.add(FILTER_FIELD[k]);
  return [...need];
}

const RANGES: Record<string, string> = { '7d': '7 days', '30d': '30 days', '90d': '90 days', '365d': '365 days' };
const uuid = z.string().uuid();

export const Filters = z.object({
  states: z.array(z.string().regex(/^[A-Za-z0-9 .&\/()-]{1,60}$/)).max(40).optional(),   // phase names are plain words; anything else is refused before it can reach a query
  consultantIds: z.array(z.union([uuid, z.literal('unassigned')])).max(50).optional(),
  sources: z.array(z.enum(['jira', 'servicenow', 'native'])).max(3).optional(),
  origins: z.array(z.enum(['phase', 'source'])).max(2).optional(),
  openOnly: z.boolean().optional(),
  statuses: z.array(z.enum(['pending', 'approved', 'rejected', 'superseded', 'skipped'])).max(5).optional(),
  kinds: z.array(z.enum(['FS', 'TS', 'TUT', 'CRC'])).max(4).optional(),
  range: z.enum(['7d', '30d', '90d', '365d', 'all']).optional(),
}).strict();

export const ReportDefinition = z.object({
  dataset: z.enum(['tickets', 'approvals', 'transitions', 'flow', 'intervals', 'signoffs', 'snapshots']),
  measure: z.string(),
  groupBy: z.string().nullable().default(null),
  seriesBy: z.string().nullable().default(null),         // a second grouping, for stacked charts
  filters: Filters.default({}),
  sort: z.enum(['natural', 'value_desc', 'value_asc']).default('natural'),
  limit: z.number().int().min(1).max(50).default(12),
  chart: z.enum(['kpi', 'bar', 'column', 'line', 'share', 'table', 'stack']),
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
  if (d.chart === 'stack') {
    if (!d.groupBy) bad('A stacked chart needs a main grouping', 'groupBy');
    if (!d.seriesBy || !ds.dims[d.seriesBy]) bad('Choose what to stack by', 'seriesBy');
    else if (d.seriesBy === d.groupBy) bad('Stack by something other than the main grouping', 'seriesBy');
    if (ds.measures[d.measure] && !ds.measures[d.measure].additive) bad('A stacked chart needs a measure that adds up (a count, or total days)', 'measure');
  } else if (d.seriesBy) bad('Only a stacked chart uses a second grouping', 'seriesBy');
});
export type ReportDef = z.infer<typeof ReportDefinition>;

export interface ReportResult {
  rows: { label: string; value: number | null; parts?: Record<string, number> }[];
  series?: string[];
  measure: { key: string; label: string; unit: string };
  dimension: { key: string; label: string; time?: Time } | null;
  truncated: boolean;
}

/** What the builder UI needs to offer: datasets, measures, groupings, and which filters apply. */
export function datasetMeta(perms?: Set<string>) {
  return Object.entries(DATASETS).filter(([, d]) => !d.requires || !perms || perms.has(d.requires)).map(([key, d]) => ({
    key, label: d.label, filters: d.filters,
    measures: Object.entries(d.measures).map(([k, m]) => ({ key: k, label: m.label, unit: m.unit, additive: !!m.additive })),
    dimensions: Object.entries(d.dims).map(([k, v]) => ({ key: k, label: v.label, time: v.time ?? null, field: DIM_FIELD[key]?.[k] ?? null })),
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
  const blocked = fieldsNeeded(def).filter((f) => !canRead(user.fields, f));
  if (blocked.length) throw new DocError(`This report uses ${blocked.map((f) => fieldDef(f)!.label.toLowerCase()).join(' and ')} data your role cannot see.`, 403, { blockedFields: blocked });
  const ds = DATASETS[def.dataset];
  if (ds.requires && !user.perms.has(ds.requires)) throw new DocError(`${ds.label} is for people who can see every ticket.`, 403);
  const measure = ds.measures[def.measure];
  const dim = def.groupBy ? ds.dims[def.groupBy] : null;
  const dim2 = def.chart === 'stack' && def.seriesBy ? ds.dims[def.seriesBy] : null;
  const params: unknown[] = [];
  const p = (v: unknown) => (params.push(v), `$${params.length}`);

  const where: string[] = [];
  if (ds.noScope) where.push(`s.project_id = ${p(user.projectId)}`);        // pre-summed per project: only people who may see every ticket are let in (above)
  else { const scope = ticketScope(user, params.length + 1); params.push(...scope.params); where.push(scope.sql); }

  const f = def.filters;
  const stateCol = ds.stateCol ?? (def.dataset === 'transitions' ? 'x.to_state' : 't.current_state');
  if (f.states?.length) where.push(`${stateCol} = ANY(${p(f.states)}::text[])`);
  if (f.consultantIds?.length) {
    const ids = f.consultantIds.filter((x) => x !== 'unassigned');
    const un = f.consultantIds.includes('unassigned');
    where.push(`(${[ids.length ? `t.consultant_id = ANY(${p(ids)}::uuid[])` : '', un ? 't.consultant_id IS NULL' : ''].filter(Boolean).join(' OR ')})`);
  }
  if (f.sources?.length) where.push(`COALESCE(t.legacy_source, 'native') = ANY(${p(f.sources)}::text[])`);
  if (f.origins?.length) where.push(`i.origin = ANY(${p(f.origins)}::text[])`);
  if (f.openOnly) where.push(OPEN_SQL('t'));
  if (f.statuses?.length) where.push(`a.status = ANY(${p(f.statuses)}::text[])`);
  if (f.kinds?.length) where.push(`a.kind = ANY(${p(f.kinds)}::text[])`);
  if (f.range && f.range !== 'all') where.push(`${ds.dateCol} >= now() - interval '${RANGES[f.range]}'`); // RANGES is a closed whitelist

  const select = dim2 ? `${dim!.sql} AS label, ${dim2.sql} AS series, ${measure.sql} AS value` : dim ? `${dim.sql} AS label, ${measure.sql} AS value` : `'' AS label, ${measure.sql} AS value`;
  const sql = `SELECT ${select} FROM ${ds.from} WHERE ${where.join(' AND ')}${dim2 ? ' GROUP BY 1, 2' : dim ? ' GROUP BY 1' : ''}`;
  const res = (await pool.query(`${sql}${dim2 ? ' ORDER BY 1 LIMIT 5000' : dim ? ' ORDER BY 1 LIMIT 500' : ''}`, params)).rows;
  const domainOf = async (d: Dim) => (d.domain === PHASES ? await projectPhaseNames(user.projectId!) : d.domain ? [...d.domain] : null);

  if (dim2) return stacked(def, res, dim!, dim2, measure, await domainOf(dim2));

  const raw = res.map((r) => ({ label: String(r.label), value: r.value == null ? null : Number(r.value) }));
  let rows = raw;
  let truncated = false;
  if (dim?.time) {
    rows = fillGaps(raw, dim.time).slice(-120);                       // time series: oldest first, newest 120 buckets
  } else if (dim) {
    if (def.sort === 'natural' && dim.domain) {
      // Lifecycle order, and every phase shown even when empty, so a gap reads as "none" and not "missing".
      const have = new Map(raw.map((r) => [r.label, r.value]));
      const domain = [...(dim.domain === PHASES ? await projectPhaseNames(user.projectId!) : dim.domain[0] === 'Created' && dim.domain.length === 1 ? ['Created', ...await projectPhaseNames(user.projectId!)]   : dim.domain)];
      for (const l of raw.map((r) => r.label)) if (!domain.includes(l)) domain.push(l);   // a phase that was switched off but still has tickets
      rows = domain.map((label) => ({ label, value: have.get(label) ?? (def.measure === 'count' ? 0 : null) }));
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

/** Two groupings at once (for example phase by week): one stack per label, one segment per series. */
function stacked(def: ReportDef, res: Record<string, unknown>[], dim: Dim, dim2: Dim, measure: Measure, domain2: string[] | null): ReportResult {
  const byLabel = new Map<string, Record<string, number>>();
  const totals = new Map<string, number>();
  for (const r of res) {
    const label = String(r.label), series = String(r.series), v = r.value == null ? 0 : Number(r.value);
    byLabel.set(label, { ...(byLabel.get(label) ?? {}), [series]: v });
    totals.set(series, (totals.get(series) ?? 0) + v);
  }
  let series = domain2 ? [...domain2.filter((x) => totals.has(x)), ...[...totals.keys()].filter((x) => !domain2.includes(x))] : [...totals.keys()].sort((a, b) => (totals.get(b) ?? 0) - (totals.get(a) ?? 0) || a.localeCompare(b));
  let truncated = false;
  const MAX = 10;
  if (series.length > MAX) {                                           // keep the biggest, fold the rest so the chart stays readable
    const keep = new Set(series.slice(0, MAX)); truncated = true;
    for (const [l, parts] of byLabel) { let other = 0; for (const k of Object.keys(parts)) if (!keep.has(k)) { other += parts[k]; delete parts[k]; } if (other) parts.Other = other; }
    series = [...series.slice(0, MAX), 'Other'];
  }
  let rows = [...byLabel.entries()].map(([label, parts]) => ({ label, parts, value: Object.values(parts).reduce((a, b) => a + b, 0) }));
  rows.sort((a, b) => a.label.localeCompare(b.label));
  if (dim.time) {
    const filled = fillGaps(rows.map((r) => ({ label: r.label, value: r.value })), dim.time);
    const have = new Map(rows.map((r) => [r.label, r]));
    rows = filled.map((r) => have.get(r.label) ?? { label: r.label, value: 0, parts: {} }).slice(-120);
  } else if (rows.length > def.limit) { rows = rows.slice(0, def.limit); truncated = true; }
  return { rows, series, truncated, measure: { key: def.measure, label: measure.label, unit: measure.unit }, dimension: { key: def.groupBy!, label: dim.label, time: dim.time } };
}

/** CSV with spreadsheet-formula neutralisation (cells starting = + - @ are prefixed with an apostrophe). */
export function toCsv(r: ReportResult) {
  const cell = (v: unknown) => {
    let s = v == null ? '' : String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  if (r.series) {
    const out = [[r.dimension?.label ?? '', ...r.series, 'Total'].map(cell).join(',')];
    for (const row of r.rows) out.push([row.label, ...r.series.map((k) => row.parts?.[k] ?? 0), row.value].map(cell).join(','));
    return out.join('\r\n') + '\r\n';
  }
  const lines = [[r.dimension?.label ?? 'Measure', r.measure.label].map(cell).join(',')];
  for (const row of r.rows) lines.push([row.label, row.value].map(cell).join(','));
  return lines.join('\r\n') + '\r\n';
}
