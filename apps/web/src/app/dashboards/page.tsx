'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { Nav } from '../../components/Nav';
import { ChartView, type ChartKind, type Result } from '../../components/charts';
import { NoAccess, NoProject, useAuth, j } from '../../lib/auth';

type Summary = { id: string; name: string; description: string; visibility: 'private' | 'shared'; isSystem: boolean; owner: string | null; mine: boolean; canEdit: boolean; widgets?: number };
type Widget = { id: string; reportId: string; size: 1 | 2 | 3; report: { id: string; name: string; description: string; definition: { chart: ChartKind } } };
type Dash = Omit<Summary, 'widgets'> & { widgets: Widget[] };
type ReportItem = { id: string; name: string; isSystem: boolean };
type Layout = { id: string; reportId: string; size: 1 | 2 | 3 }[];

async function api(path: string, init?: RequestInit) {
  const r = await fetch(path, init);
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.error ?? 'Something went wrong');
  return body;
}
const toLayout = (ws: Widget[]): Layout => ws.map(({ id, reportId, size }) => ({ id, reportId, size }));

function WidgetCard({ w, edit, first, last, onMove, onSize, onRemove, tick }: {
  w: Widget; edit: boolean; first: boolean; last: boolean; tick: number;
  onMove: (d: -1 | 1) => void; onSize: (s: 1 | 2 | 3) => void; onRemove: () => void;
}) {
  const [data, setData] = useState<Result | null>(null);
  const [err, setErr] = useState('');
  const [asTable, setAsTable] = useState(false);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let live = true; setLoading(true);
    api(`/api/reports/${w.reportId}/data`).then((d) => { if (live) { setData(d); setErr(''); } })
      .catch((e) => live && setErr(e.message)).finally(() => live && setLoading(false));
    return () => { live = false; };
  }, [w.reportId, w.report.definition, tick]);
  const chart = w.report.definition.chart;
  return (
    <article className={`widget span-${w.size}`} aria-label={w.report.name}>
      <header>
        <div><h3>{w.report.name}</h3>{w.report.description && <p className="note">{w.report.description}</p>}</div>
        <div className="widget-actions">
          {data && data.rows.length > 0 && chart !== 'kpi' && chart !== 'table' && <button className="link-btn plain" aria-pressed={asTable} onClick={() => setAsTable(!asTable)}>{asTable ? 'Chart' : 'Table'}</button>}
          <a className="link-btn plain" href={`/api/reports/${w.reportId}/csv`} download>CSV</a>
        </div>
      </header>
      <div className="widget-body" style={{ opacity: loading && data ? 0.5 : 1 }} aria-busy={loading}>
        {err ? <p role="alert" className="err">{err}</p> : data ? <ChartView chart={chart} result={data} asTable={asTable} /> : <div className="skeleton" style={{ height: 120 }} />}
      </div>
      {edit && (
        <footer className="widget-edit">
          <div className="seg" role="group" aria-label={`Size of ${w.report.name}`}>
            {([1, 2, 3] as const).map((s) => <button key={s} aria-pressed={w.size === s} onClick={() => onSize(s)}>{['Small', 'Medium', 'Large'][s - 1]}</button>)}
          </div>
          <button className="btn ghost sm" disabled={first} onClick={() => onMove(-1)} aria-label={`Move ${w.report.name} earlier`}>↑</button>
          <button className="btn ghost sm" disabled={last} onClick={() => onMove(1)} aria-label={`Move ${w.report.name} later`}>↓</button>
          <Link className="btn ghost sm" href={`/reports/${w.reportId}`} style={{ textDecoration: 'none' }}>Edit report</Link>
          <button className="link-btn" onClick={onRemove}>Remove</button>
        </footer>)}
    </article>
  );
}

export default function Dashboards() {
  const { me, can, loading: authLoading } = useAuth();
  const [list, setList] = useState<Summary[]>([]);
  const [id, setId] = useState<string | null>(null);
  const [dash, setDash] = useState<Dash | null>(null);
  const [reports, setReports] = useState<ReportItem[]>([]);
  const [edit, setEdit] = useState(false);
  const [pick, setPick] = useState('');
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [tick, setTick] = useState(0);
  const keepEdit = useRef(false);   // a dashboard we just created/copied opens ready to edit
  const flash = (kind: 'ok' | 'err', text: string) => setMsg({ kind, text });

  const loadList = useCallback(async () => { const l: Summary[] = await api('/api/dashboards'); setList(l); return l; }, []);
  const loadDash = useCallback(async (d: string) => { try { setDash(await api(`/api/dashboards/${d}`)); } catch (e) { flash('err', (e as Error).message); } }, []);

  useEffect(() => {
    if (!can('report.view')) return;
    loadList().then((l) => { const want = new URLSearchParams(location.search).get('d'); setId(l.find((x) => x.id === want)?.id ?? l[0]?.id ?? null); }).catch((e) => flash('err', e.message));
  }, [can, loadList]);
  useEffect(() => { if (id) { loadDash(id); history.replaceState(null, '', `?d=${id}`); setEdit(keepEdit.current); keepEdit.current = false; } }, [id, loadDash]);
  useEffect(() => { if (edit) api('/api/reports').then(setReports).catch(() => {}); }, [edit]);

  async function save(patch: Partial<{ name: string; description: string; visibility: string; layout: Layout }>, ok?: string) {
    if (!dash) return;
    try { await api(`/api/dashboards/${dash.id}`, j(patch, 'PUT')); if (ok) flash('ok', ok); await loadDash(dash.id); loadList(); }
    catch (e) { flash('err', (e as Error).message); loadDash(dash.id); }
  }
  const relayout = (ws: Widget[]) => { setDash((d) => d && { ...d, widgets: ws }); return save({ layout: toLayout(ws) }); };
  const move = (i: number, d: -1 | 1) => { if (!dash) return; const ws = [...dash.widgets]; [ws[i], ws[i + d]] = [ws[i + d], ws[i]]; relayout(ws); };
  const size = (i: number, s: 1 | 2 | 3) => dash && relayout(dash.widgets.map((w, k) => (k === i ? { ...w, size: s } : w)));
  const remove = (i: number) => dash && relayout(dash.widgets.filter((_, k) => k !== i));
  const add = () => {
    const rep = reports.find((r) => r.id === pick); if (!dash || !rep) return;
    save({ layout: [...toLayout(dash.widgets), { id: crypto.randomUUID(), reportId: rep.id, size: 1 }] }, `Added “${rep.name}”.`); setPick('');
  };
  async function create() {
    const name = prompt('Name your dashboard'); if (!name?.trim()) return;
    try { const { id: nid } = await api('/api/dashboards', j({ name: name.trim() })); keepEdit.current = true; await loadList(); setId(nid); flash('ok', 'Dashboard created. Add widgets below.'); }
    catch (e) { flash('err', (e as Error).message); }
  }
  async function copy() {
    if (!dash) return;
    try { const { id: nid } = await api(`/api/dashboards/${dash.id}/duplicate`, { method: 'POST' }); keepEdit.current = true; await loadList(); setId(nid); flash('ok', 'Your copy is ready to customize.'); }
    catch (e) { flash('err', (e as Error).message); }
  }
  async function del() {
    if (!dash || !confirm(`Delete the dashboard “${dash.name}”? The reports stay in your library.`)) return;
    try { await api(`/api/dashboards/${dash.id}`, { method: 'DELETE' }); const l = await loadList(); setDash(null); setId(l[0]?.id ?? null); flash('ok', 'Dashboard deleted.'); }
    catch (e) { flash('err', (e as Error).message); }
  }

  if (authLoading || !me) return <><Nav current="dashboards" /><main id="main"><p className="note">Loading…</p></main></>;
  if (!me.project) return <><Nav current="dashboards" /><main id="main"><NoProject /></main></>;
  if (!can('report.view')) return <><Nav current="dashboards" /><main id="main"><NoAccess what="dashboards" /></main></>;
  const canBuild = can('report.build');

  return (
    <>
      <Nav current="dashboards" />
      <main id="main">
        <div className="board-head">
          <div>
            <h2>Dashboards</h2>
            <p>Track delivery and report on it. {canBuild ? 'Build your own reports and arrange them how you like.' : ''}</p>
          </div>
          <div className="tools">
            <label className="sr" htmlFor="dash-pick">Dashboard</label>
            <select id="dash-pick" className="search" value={id ?? ''} onChange={(e) => setId(e.target.value)} style={{ minWidth: 240 }}>
              {list.map((d) => <option key={d.id} value={d.id}>{d.name}{d.isSystem ? ' (built-in)' : d.mine ? '' : ` · ${d.owner ?? 'shared'}`}</option>)}
            </select>
            {canBuild && <button className="btn ghost" onClick={create}>New dashboard</button>}
            {(canBuild || can('report.manage_all')) && <Link className="btn ghost" href="/reports" style={{ textDecoration: 'none' }}>Reports</Link>}
          </div>
        </div>

        <div aria-live="polite" style={{ minHeight: 22 }}>{msg && <p className={msg.kind === 'err' ? 'err' : 'ok'} role={msg.kind === 'err' ? 'alert' : 'status'} style={{ margin: '0 0 8px' }}>{msg.text}</p>}</div>

        {!dash ? <p className="note">{list.length ? 'Loading…' : 'No dashboards yet.'}</p> : (<>
          <div className="dash-bar">
            {edit ? (
              <div className="row" style={{ margin: 0 }}>
                <label className="sr" htmlFor="dn">Dashboard name</label>
                <input id="dn" defaultValue={dash.name} key={dash.id + dash.name} onBlur={(e) => e.target.value.trim() && e.target.value !== dash.name && save({ name: e.target.value.trim() }, 'Renamed.')} style={{ fontWeight: 600, minWidth: 220 }} />
                <label className="sr" htmlFor="dv">Who can see this</label>
                <select id="dv" value={dash.visibility} onChange={(e) => save({ visibility: e.target.value }, e.target.value === 'shared' ? 'Shared with everyone who can view dashboards.' : 'Now private to you.')}>
                  <option value="private">Private to me</option><option value="shared">Shared with everyone</option>
                </select>
              </div>
            ) : (
              <div><b>{dash.name}</b> <span className="role-badge" data-role={dash.visibility === 'shared' ? 'Manager' : 'Custom'}>{dash.visibility === 'shared' ? 'Shared' : 'Private'}</span>
                {dash.description && <span className="note"> · {dash.description}</span>}</div>)}
            <div className="row" style={{ margin: 0 }}>
              <button className="btn ghost sm" onClick={() => setTick((t) => t + 1)}>Refresh</button>
              {canBuild && <button className="btn ghost sm" onClick={copy}>{dash.canEdit ? 'Duplicate' : 'Copy to customize'}</button>}
              {dash.canEdit && <button className={edit ? 'btn sm' : 'btn ghost sm'} onClick={() => setEdit(!edit)}>{edit ? 'Done' : 'Edit dashboard'}</button>}
              {edit && dash.canEdit && <button className="link-btn" onClick={del}>Delete</button>}
            </div>
          </div>

          {edit && (
            <div className="pane build" role="region" aria-label="Add a widget">
              <h3>Add a widget</h3>
              <div className="row">
                <label className="sr" htmlFor="rp">Report</label>
                <select id="rp" value={pick} onChange={(e) => setPick(e.target.value)} style={{ minWidth: 260 }}>
                  <option value="">Choose a report…</option>
                  {reports.map((r) => <option key={r.id} value={r.id}>{r.name}{r.isSystem ? ' (built-in)' : ''}</option>)}
                </select>
                <button className="btn" disabled={!pick} onClick={add}>Add to dashboard</button>
                <span className="note">or</span>
                <Link className="btn ghost" href={`/reports/new?dashboard=${dash.id}`} style={{ textDecoration: 'none' }}>Create a new report</Link>
              </div>
            </div>)}

          {dash.widgets.length === 0 ? (
            <div className="pane" style={{ padding: 28, textAlign: 'center' }}><p style={{ margin: 0 }} className="note">This dashboard is empty. {dash.canEdit ? 'Choose “Edit dashboard” to add reports.' : ''}</p></div>
          ) : (
            <section className="widgets" aria-label={`${dash.name} widgets`}>
              {dash.widgets.map((w, i) => (
                <WidgetCard key={w.id} w={w} edit={edit && dash.canEdit} first={i === 0} last={i === dash.widgets.length - 1} tick={tick}
                  onMove={(d) => move(i, d)} onSize={(s) => size(i, s)} onRemove={() => remove(i)} />))}
            </section>)}
        </>)}
      </main>
    </>
  );
}
