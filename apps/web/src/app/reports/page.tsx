'use client';
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Nav } from '../../components/Nav';
import { NoAccess, NoProject, useAuth } from '../../lib/auth';

type Item = { id: string; name: string; description: string; visibility: 'private' | 'shared'; isSystem: boolean; owner: string | null; mine: boolean; canEdit: boolean; definition: { dataset: string; chart: string; groupBy: string | null } };
const CHART: Record<string, string> = { kpi: 'Number', bar: 'Bars', column: 'Columns', line: 'Line', share: 'Share', table: 'Table' };
const DATASET: Record<string, string> = { tickets: 'Tickets', approvals: 'Approvals', transitions: 'Phase changes' };

export default function Reports() {
  const { me, can, loading } = useAuth();
  const [items, setItems] = useState<Item[]>([]);
  const [q, setQ] = useState('');
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const load = useCallback(async () => { const r = await fetch('/api/reports'); if (r.ok) setItems(await r.json()); }, []);
  useEffect(() => { if (can('report.view')) load(); }, [can, load]);

  async function act(path: string, method: string, ok: string) {
    const r = await fetch(path, { method }); const b = await r.json().catch(() => ({}));
    setMsg(r.ok ? { kind: 'ok', text: ok } : { kind: 'err', text: b.error ?? 'Failed' }); load(); return b;
  }
  if (loading || !me) return <><Nav current="dashboards" /><main id="main"><p className="note">Loading…</p></main></>;
  if (!me.project) return <><Nav current="dashboards" /><main id="main"><NoProject /></main></>;
  if (!can('report.view')) return <><Nav current="dashboards" /><main id="main"><NoAccess what="reports" /></main></>;

  const shown = items.filter((i) => !q.trim() || i.name.toLowerCase().includes(q.trim().toLowerCase()));
  return (
    <>
      <Nav current="dashboards" />
      <main id="main">
        <div className="board-head">
          <div><h2>Reports</h2><p>Every report you can use. Add them to any summary.</p></div>
          <div className="tools">
            <label className="sr" htmlFor="rq">Search reports</label>
            <input id="rq" className="search" type="search" placeholder="Search reports…" value={q} onChange={(e) => setQ(e.target.value)} />
            <Link className="btn ghost" href="/dashboards" style={{ textDecoration: 'none' }}>Summary</Link>
            {can('report.build') && <Link className="btn" href="/reports/new" style={{ textDecoration: 'none' }}>New report</Link>}
          </div>
        </div>
        <div aria-live="polite" style={{ minHeight: 22 }}>{msg && <p className={msg.kind === 'err' ? 'err' : 'ok'} role={msg.kind === 'err' ? 'alert' : 'status'} style={{ margin: '0 0 8px' }}>{msg.text}</p>}</div>
        <div className="matrix-wrap"><table className="grid users" style={{ minWidth: 760 }}>
          <caption className="sr">Reports</caption>
          <thead><tr><th scope="col">Report</th><th scope="col">Data</th><th scope="col">Shown as</th><th scope="col">Who can see it</th><th scope="col"><span className="sr">Actions</span></th></tr></thead>
          <tbody>
            {shown.length === 0 && <tr><td colSpan={5} className="note">No reports match.</td></tr>}
            {shown.map((r) => (
              <tr key={r.id}>
                <td><Link href={`/reports/${r.id}`} style={{ fontWeight: 600, color: 'var(--text)' }}>{r.name}</Link>{r.isSystem && <span className="note"> · built-in</span>}
                  {r.description && <div className="note">{r.description}</div>}</td>
                <td>{DATASET[r.definition.dataset]}</td><td>{CHART[r.definition.chart]}</td>
                <td>{r.visibility === 'shared' ? 'Everyone' : 'Only me'}{!r.mine && r.owner ? <span className="note"> · {r.owner}</span> : null}</td>
                <td style={{ whiteSpace: 'nowrap', textAlign: 'right' }}>
                  <Link className="btn ghost sm" href={`/reports/${r.id}`} style={{ textDecoration: 'none' }}>{r.canEdit ? 'Edit' : 'View'}</Link>{' '}
                  <a className="btn ghost sm" href={`/api/reports/${r.id}/csv`} download style={{ textDecoration: 'none' }}>CSV</a>{' '}
                  {can('report.build') && <button className="btn ghost sm" onClick={() => act(`/api/reports/${r.id}/duplicate`, 'POST', `Copied “${r.name}”.`)}>Copy</button>}{' '}
                  {r.canEdit && <button className="link-btn" onClick={() => confirm(`Delete “${r.name}”? It is removed from every summary.`) && act(`/api/reports/${r.id}`, 'DELETE', `Deleted “${r.name}”.`)}>Delete</button>}
                </td>
              </tr>))}
          </tbody>
        </table></div>
      </main>
    </>
  );
}
