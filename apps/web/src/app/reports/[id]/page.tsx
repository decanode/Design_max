'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { Nav } from '../../../components/Nav';
import { ChartView, type ChartKind, type Result } from '../../../components/charts';
import { NoAccess, NoProject, useAuth, j } from '../../../lib/auth';

type Filters = { states?: string[]; consultantIds?: string[]; sources?: string[]; openOnly?: boolean; statuses?: string[]; kinds?: string[]; range?: string };
type Def = { dataset: string; measure: string; groupBy: string | null; filters: Filters; sort: 'natural' | 'value_desc' | 'value_asc'; limit: number; chart: ChartKind };
type Meta = { datasets: { key: string; label: string; filters: string[]; measures: { key: string; label: string }[]; dimensions: { key: string; label: string; time: string | null; field: string | null }[] }[]; people: { id: string; name: string }[]; readableFields: string[]; filterFields: Record<string, string> };

const NEW: Def = { dataset: 'tickets', measure: 'count', groupBy: 'state', filters: {}, sort: 'natural', limit: 12, chart: 'column' };
const CHARTS: { key: ChartKind; label: string; hint: string }[] = [
  { key: 'kpi', label: 'Number', hint: 'One headline number' }, { key: 'column', label: 'Columns', hint: 'Compare categories or phases' },
  { key: 'bar', label: 'Bars', hint: 'Long names or many categories' }, { key: 'line', label: 'Line', hint: 'Trend over time' },
  { key: 'share', label: 'Share', hint: 'Part of a whole (counts)' }, { key: 'table', label: 'Table', hint: 'Exact figures' },
];

function Check({ legend, options, value, onChange, disabled }: { legend: string; options: { value: string; label: string }[]; value?: string[]; onChange: (v: string[] | undefined) => void; disabled?: boolean }) {
  const set = new Set(value ?? []);
  return (
    <fieldset className="field" disabled={disabled}><legend>{legend} {set.size === 0 && <span className="note">(all)</span>}</legend>
      <div className="checks">{options.map((o) => (
        <label key={o.value} className="check"><input type="checkbox" checked={set.has(o.value)}
          onChange={(e) => { const n = new Set(set); e.target.checked ? n.add(o.value) : n.delete(o.value); onChange(n.size ? [...n] : undefined); }} /> {o.label}</label>))}</div>
    </fieldset>
  );
}

export default function Builder() {
  const { id } = useParams<{ id: string }>();
  const toDash = useSearchParams().get('dashboard');
  const router = useRouter();
  const { me, can, loading } = useAuth();
  const isNew = id === 'new';
  const [meta, setMeta] = useState<Meta | null>(null);
  const [STATES, setStates] = useState<string[]>([]);
  useEffect(() => { fetch('/api/states').then((r) => r.ok && r.json()).then((d) => d && setStates(d)); }, []);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [visibility, setVisibility] = useState<'private' | 'shared'>('private');
  const [def, setDef] = useState<Def>(NEW);
  const [editable, setEditable] = useState(true);
  const [meta2, setMeta2] = useState<{ isSystem: boolean; owner: string | null } | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [asTable, setAsTable] = useState(false);

  useEffect(() => { if (can('report.view')) fetch('/api/reports/meta').then((r) => r.json()).then(setMeta); }, [can]);
  useEffect(() => {
    if (isNew || !can('report.view')) return;
    fetch(`/api/reports/${id}`).then(async (r) => {
      const b = await r.json(); if (!r.ok) return setMsg({ kind: 'err', text: b.error });
      setName(b.name); setDescription(b.description); setVisibility(b.visibility); setDef(b.definition); setEditable(b.canEdit); setMeta2({ isSystem: b.isSystem, owner: b.owner });
    });
  }, [id, isNew, can]);

  // Column-level security: groupings and filters on fields this viewer cannot read are not offered (the server refuses them anyway).
  const ds0 = meta?.datasets.find((d) => d.key === def.dataset);
  const readable = (f?: string | null) => !f || (meta?.readableFields.includes(f) ?? true);
  const ds = ds0 && { ...ds0, dimensions: ds0.dimensions.filter((d) => readable(d.field) || d.key === def.groupBy), filters: ds0.filters.filter((k) => readable(meta?.filterFields[k]) || k in def.filters) };
  const dim = ds?.dimensions.find((d) => d.key === def.groupBy);
  const timeDim = ds?.dimensions.find((d) => d.time)?.key ?? null;
  const readOnly = !editable || !can('report.build');

  // Live preview, debounced; a stale response never overwrites a newer one.
  const seq = useRef(0);
  useEffect(() => {
    if (!can('report.build')) return;
    const mine = ++seq.current;
    const t = setTimeout(async () => {
      const r = await fetch('/api/reports/preview', j({ definition: def })); const b = await r.json().catch(() => ({}));
      if (mine !== seq.current) return;
      if (r.ok) { setResult(b); setError(''); } else { setError(b.details?.[0]?.message ?? b.error ?? 'Could not run this report'); }
    }, 350);
    return () => clearTimeout(t);
  }, [def, can]);

  // Keep the chart, grouping and measure consistent whenever one of them changes.
  const patch = (p: Partial<Def>) => setDef((d) => ({ ...d, ...p }));
  const setDataset = (key: string) => { const n = meta!.datasets.find((x) => x.key === key)!; setDef({ ...NEW, dataset: key, measure: n.measures[0].key, groupBy: n.dimensions[0].key }); };
  const setChart = (c: ChartKind) => setDef((d) => {
    const n = { ...d, chart: c };
    if (c === 'kpi') n.groupBy = null;
    else if (!n.groupBy) n.groupBy = ds!.dimensions[0].key;
    if (c === 'line' && !ds!.dimensions.find((x) => x.key === n.groupBy)?.time) n.groupBy = timeDim;
    if (c === 'share') n.measure = 'count';
    return n;
  });
  const setGroup = (g: string) => setDef((d) => {
    const n: Def = { ...d, groupBy: g || null };
    if (!g) n.chart = 'kpi'; else if (d.chart === 'kpi') n.chart = 'column';
    if (g && d.chart === 'line' && !ds!.dimensions.find((x) => x.key === g)?.time) n.chart = 'column';
    return n;
  });
  const setMeasure = (m: string) => setDef((d) => ({ ...d, measure: m, chart: d.chart === 'share' && m !== 'count' ? 'column' : d.chart }));
  const setFilter = (k: keyof Filters, v: unknown) => setDef((d) => { const f = { ...d.filters, [k]: v } as Filters; if (v === undefined || v === false || v === 'all') delete f[k]; return { ...d, filters: f }; });

  async function save(asCopy = false) {
    setBusy(true); setMsg(null);
    try {
      const body = { name: name.trim(), description, definition: def, visibility };
      const create = isNew || asCopy;
      const r = await fetch(create ? '/api/reports' : `/api/reports/${id}`, j(body, create ? 'POST' : 'PUT')); const b = await r.json();
      if (!r.ok) return setMsg({ kind: 'err', text: b.details?.[0]?.message ?? b.error });
      const rid = create ? b.id : id;
      if (toDash && create) {            // came from a dashboard: put the new report on it
        const d = await (await fetch(`/api/dashboards/${toDash}`)).json();
        const layout = [...d.widgets.map((w: any) => ({ id: w.id, reportId: w.reportId, size: w.size })), { id: crypto.randomUUID(), reportId: rid, size: 1 }];
        await fetch(`/api/dashboards/${toDash}`, j({ layout }, 'PUT'));
        return router.push(`/dashboards?d=${toDash}`);
      }
      if (create) router.replace(`/reports/${rid}`); else setMsg({ kind: 'ok', text: 'Saved.' });
    } finally { setBusy(false); }
  }
  async function copy() {
    const r = await fetch(`/api/reports/${id}/duplicate`, { method: 'POST' }); const b = await r.json();
    if (r.ok) router.push(`/reports/${b.id}`); else setMsg({ kind: 'err', text: b.error });
  }

  const back = toDash ? `/dashboards?d=${toDash}` : '/reports';
  const people = useMemo(() => [{ id: 'unassigned', name: 'Unassigned' }, ...(meta?.people ?? [])], [meta]);
  if (loading || !me) return <><Nav current="dashboards" /><main id="main"><p className="note">Loading…</p></main></>;
  if (!me.project) return <><Nav current="dashboards" /><main id="main"><NoProject /></main></>;
  if (!can('report.view')) return <><Nav current="dashboards" /><main id="main"><NoAccess what="reports" /></main></>;
  if (isNew && !can('report.build')) return <><Nav current="dashboards" /><main id="main"><NoAccess what="building reports" /></main></>;

  const chartOk = (c: ChartKind) => !(c === 'line' && !timeDim) && !(c === 'share' && !ds?.measures.some((m) => m.key === 'count'));
  const F = (k: string) => ds?.filters.includes(k);

  return (
    <>
      <Nav current="dashboards" />
      <main id="main">
        <div className="board-head">
          <div><h2>{isNew ? 'New report' : readOnly ? 'Report' : 'Edit report'}</h2><p><Link href={back}>← Back</Link></p></div>
        </div>
        {msg && <p role={msg.kind === 'err' ? 'alert' : 'status'} className={msg.kind === 'err' ? 'err' : 'ok'}>{msg.text}</p>}
        {readOnly && !isNew && (
          <div className="scope-warn unclear" style={{ marginBottom: 14 }}><b>{meta2?.isSystem ? 'Built-in report' : `Owned by ${meta2?.owner ?? 'someone else'}`}</b>
            <span>You can’t change this one. {can('report.build') ? 'Make your own copy to customize it.' : ''}</span>
            {can('report.build') && <div><button className="btn sm" onClick={copy} style={{ marginTop: 6 }}>Make my copy</button></div>}</div>)}

        <div className="builder">
          <form className="pane build" onSubmit={(e) => { e.preventDefault(); save(); }} aria-label="Report settings">
            <fieldset disabled={readOnly} className="plain">
              <div className="field"><label htmlFor="rn">Name</label><input id="rn" value={name} onChange={(e) => setName(e.target.value)} required maxLength={80} placeholder="e.g. Open work by consultant" /></div>
              <div className="field"><label htmlFor="rd">Description <span className="note">(optional)</span></label><input id="rd" value={description} onChange={(e) => setDescription(e.target.value)} maxLength={300} /></div>

              <div className="field"><label htmlFor="ds">What to report on</label>
                <select id="ds" value={def.dataset} onChange={(e) => setDataset(e.target.value)}>{meta?.datasets.map((d) => <option key={d.key} value={d.key}>{d.label}</option>)}</select></div>
              <div className="field"><label htmlFor="ms">Measure</label>
                <select id="ms" value={def.measure} onChange={(e) => setMeasure(e.target.value)}>{ds?.measures.map((m) => <option key={m.key} value={m.key}>{m.label}</option>)}</select></div>
              <div className="field"><label htmlFor="gb">Group by</label>
                <select id="gb" value={def.groupBy ?? ''} onChange={(e) => setGroup(e.target.value)}>
                  <option value="">Nothing — a single number</option>{ds?.dimensions.map((d) => <option key={d.key} value={d.key}>{d.label}</option>)}</select></div>

              <div className="field"><span className="lbl" id="ct">Show as</span>
                <div className="seg wrap" role="group" aria-labelledby="ct">{CHARTS.map((c) => (
                  <button type="button" key={c.key} aria-pressed={def.chart === c.key} disabled={!chartOk(c.key)} title={chartOk(c.key) ? c.hint : 'Not available for this data'} onClick={() => setChart(c.key)}>{c.label}</button>))}</div>
                <span className="note">{CHARTS.find((c) => c.key === def.chart)?.hint}</span></div>

              {def.groupBy && !dim?.time && (
                <div className="row" style={{ margin: 0 }}>
                  <div className="field" style={{ flex: 1 }}><label htmlFor="so">Order</label>
                    <select id="so" value={def.sort} onChange={(e) => patch({ sort: e.target.value as Def['sort'] })}><option value="natural">Natural order</option><option value="value_desc">Highest first</option><option value="value_asc">Lowest first</option></select></div>
                  <div className="field" style={{ width: 96 }}><label htmlFor="li">Show top</label>
                    <input id="li" type="number" min={1} max={50} value={def.limit} onChange={(e) => patch({ limit: Math.min(50, Math.max(1, Number(e.target.value) || 1)) })} /></div>
                </div>)}

              <h3 className="mini" style={{ margin: '14px 0 6px' }}>Filters</h3>
              {F('range') && <div className="field"><label htmlFor="rg">Time period</label>
                <select id="rg" value={def.filters.range ?? 'all'} onChange={(e) => setFilter('range', e.target.value)}>
                  <option value="all">All time</option><option value="7d">Last 7 days</option><option value="30d">Last 30 days</option><option value="90d">Last 90 days</option><option value="365d">Last 12 months</option></select></div>}
              {F('openOnly') && <label className="check" style={{ marginBottom: 8 }}><input type="checkbox" checked={!!def.filters.openOnly} onChange={(e) => setFilter('openOnly', e.target.checked)} /> Only tickets not yet deployed</label>}
              {F('states') && <Check legend="Phase" options={STATES.map((s) => ({ value: s, label: s }))} value={def.filters.states} onChange={(v) => setFilter('states', v)} />}
              {F('statuses') && <Check legend="Approval status" options={['pending', 'approved', 'rejected', 'superseded'].map((s) => ({ value: s, label: s[0].toUpperCase() + s.slice(1) }))} value={def.filters.statuses} onChange={(v) => setFilter('statuses', v)} />}
              {F('kinds') && <Check legend="Document" options={[{ value: 'FS', label: 'Functional spec' }, { value: 'TS', label: 'Technical spec' }]} value={def.filters.kinds} onChange={(v) => setFilter('kinds', v)} />}
              {F('sources') && <Check legend="Source" options={[{ value: 'native', label: 'Design Max' }, { value: 'jira', label: 'Jira' }, { value: 'servicenow', label: 'ServiceNow' }]} value={def.filters.sources} onChange={(v) => setFilter('sources', v)} />}
              {F('consultantIds') && <Check legend="Consultant" options={people.map((p) => ({ value: p.id, label: p.name }))} value={def.filters.consultantIds} onChange={(v) => setFilter('consultantIds', v)} />}

              <div className="field"><label htmlFor="vi">Who can see this report</label>
                <select id="vi" value={visibility} onChange={(e) => setVisibility(e.target.value as 'private' | 'shared')}><option value="private">Only me</option><option value="shared">Everyone who can view reports</option></select></div>
            </fieldset>
            {!readOnly && <div className="row"><button className="btn" type="submit" disabled={busy || !name.trim() || !!error}>{isNew ? (toDash ? 'Save and add to dashboard' : 'Create report') : 'Save changes'}</button>
              {!isNew && <button type="button" className="btn ghost" disabled={busy || !name.trim() || !!error} onClick={() => save(true)}>Save as new report</button>}</div>}
          </form>

          <section className="pane preview" aria-label="Preview" aria-live="polite">
            <header className="preview-head"><h3>{name || 'Untitled report'}</h3>
              {result && result.rows.length > 0 && def.chart !== 'kpi' && def.chart !== 'table' && <button type="button" className="link-btn plain" aria-pressed={asTable} onClick={() => setAsTable(!asTable)}>{asTable ? 'Chart' : 'Table'}</button>}</header>
            {description && <p className="note" style={{ margin: '0 0 8px' }}>{description}</p>}
            {error ? <p role="alert" className="err">{error}</p> : result ? <ChartView chart={def.chart} result={result} asTable={asTable} /> : <div className="skeleton" style={{ height: 180 }} />}
            <p className="note" style={{ margin: '12px 0 0' }}>Preview uses live data, limited to what you’re allowed to see. Other viewers see only their own slice.</p>
          </section>
        </div>
      </main>
    </>
  );
}
