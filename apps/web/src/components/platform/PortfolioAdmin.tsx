'use client';
import { useEffect, useMemo, useState } from 'react';
import { api, type Flash } from '../consoleBits';
import { modeName } from '../../lib/modes';

type Row = { id: string; name: string; operatingMode: string; open: number; awaitingApproval: number; avgAgeDays: number | null; finished30: number; p85LeadDays: number | null; connections: number; connectionsFailing: number; lastSyncAt: string | null; sendFailures: number };
type Key = 'name' | 'open' | 'awaitingApproval' | 'avgAgeDays' | 'finished30' | 'p85LeadDays';
const num = (v: number | null) => (v == null ? '—' : v.toLocaleString(undefined, { maximumFractionDigits: 1 }));
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—');

/** Platform → Portfolio: every active project side by side. Where is work piling up, where is it flowing, and is every source connection healthy? */
export function PortfolioAdmin({ flash }: { flash: Flash }) {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [sort, setSort] = useState<{ k: Key; dir: 1 | -1 }>({ k: 'open', dir: -1 });
  useEffect(() => { api('/api/platform/portfolio').then(setRows).catch((e) => flash('err', e.message)); }, [flash]);
  const sorted = useMemo(() => [...(rows ?? [])].sort((a, b) => { const x = a[sort.k] ?? -1, y = b[sort.k] ?? -1; return (x < y ? -1 : x > y ? 1 : 0) * sort.dir; }), [rows, sort]);
  if (!rows) return <div className="skeleton" style={{ height: 200 }} aria-busy="true" aria-label="Loading portfolio" />;
  const total = rows.reduce((a, r) => ({ open: a.open + r.open, wait: a.wait + r.awaitingApproval, fin: a.fin + r.finished30 }), { open: 0, wait: 0, fin: 0 });
  const th = (k: Key, label: string, right = true) => (
    <th scope="col" aria-sort={sort.k === k ? (sort.dir === 1 ? 'ascending' : 'descending') : 'none'} style={right ? { textAlign: 'right' } : undefined}>
      <button type="button" className="th-sort" onClick={() => setSort({ k, dir: sort.k === k ? (sort.dir === 1 ? -1 : 1) : (k === 'name' ? 1 : -1) })}>{label}<span aria-hidden>{sort.k === k ? (sort.dir === 1 ? ' ▲' : ' ▼') : ''}</span></button>
    </th>);
  return (
    <>
      <div className="pj-stats" aria-label="Across every project">
        <div><b>{rows.length}</b><span className="note">active projects</span></div>
        <div><b>{total.open.toLocaleString()}</b><span className="note">open tickets</span></div>
        <div><b>{total.wait.toLocaleString()}</b><span className="note">waiting for an approval</span></div>
        <div><b>{total.fin.toLocaleString()}</b><span className="note">finished in 30 days</span></div>
      </div>
      <div className="data-wrap" style={{ marginTop: 12 }}>
        <table className="data-table">
          <caption className="sr">Projects compared</caption>
          <thead><tr>{th('name', 'Project', false)}<th scope="col">Mode</th>{th('open', 'Open')}{th('awaitingApproval', 'Awaiting approval')}{th('avgAgeDays', 'Avg age (days)')}{th('finished30', 'Finished (30 days)')}{th('p85LeadDays', 'Lead time p85 (days)')}<th scope="col">Source</th></tr></thead>
          <tbody>
            {sorted.map((r) => (
              <tr key={r.id}>
                <td><b>{r.name}</b></td><td><span className={`mode-chip ${r.operatingMode}`}>{modeName(r.operatingMode)}</span></td>
                <td className="num">{r.open}</td><td className={`num ${r.awaitingApproval ? 'warnnum' : ''}`}>{r.awaitingApproval}</td><td className="num">{num(r.avgAgeDays)}</td><td className="num">{r.finished30}</td><td className="num">{num(r.p85LeadDays)}</td>
                <td>{r.connections === 0 ? <span className="note">Not connected</span>
                  : <span><span className={`status ${r.connectionsFailing || r.sendFailures ? 'bad' : 'ok'}`}>{r.connectionsFailing ? `${r.connectionsFailing} failing` : r.sendFailures ? `${r.sendFailures} not sent` : 'Healthy'}</span><span className="note"> · last sync {when(r.lastSyncAt)}</span></span>}</td>
              </tr>))}
            {rows.length === 0 && <tr><td colSpan={8} className="empty-row">No active projects.</td></tr>}
          </tbody>
        </table>
      </div>
    </>);
}
