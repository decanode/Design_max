'use client';
import { useCallback, useEffect, useState } from 'react';
import { Avatar } from '../people/shared';
import { j } from '../../lib/auth';

type Item = { id: string; title: string; state: 'todo' | 'doing' | 'blocked' | 'done'; ownerId: string | null; owner: string | null; estimateH: number | null; actualH: number | null; dependsOn: string[] };
type Data = { items: Item[]; progress: { done: number; total: number }; estimateH: number; actualH: number };
const STATES: { key: Item['state']; label: string }[] = [{ key: 'todo', label: 'To do' }, { key: 'doing', label: 'Doing' }, { key: 'blocked', label: 'Blocked' }, { key: 'done', label: 'Done' }];

/** The work this ticket takes, as a checklist the team owns. It stays here: it is never sent to a source tool. */
export function WorkItems({ ticketId, people, canEdit, gate, onChanged }: { ticketId: string; people: { id: string; name: string }[]; canEdit: boolean; gate: boolean; onChanged: () => void }) {
  const [d, setD] = useState<Data | null>(null);
  const [title, setTitle] = useState('');
  const [error, setError] = useState('');
  const [suggest, setSuggest] = useState<{ by: string; tasks: { title: string; estimateH?: number | null }[]; pick: boolean[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => { const r = await fetch(`/api/tickets/${ticketId}/work`); if (r.ok) setD(await r.json()); }, [ticketId]);
  useEffect(() => { load(); }, [load]);
  const apply = async (r: Response) => { const b = await r.json().catch(() => ({})); if (!r.ok) { setError(b.error ?? 'That did not work'); return; } setError(''); setD(b); onChanged(); };
  const patch = (id: string, body: object) => fetch(`/api/work/${id}`, j(body, 'PATCH')).then(apply);
  if (!d) return null;
  const pct = d.progress.total ? Math.round((d.progress.done / d.progress.total) * 100) : 0;

  async function add(e: React.FormEvent) { e.preventDefault(); if (!title.trim()) return; setBusy(true); await fetch(`/api/tickets/${ticketId}/work`, j({ title: title.trim() })).then(apply); setTitle(''); setBusy(false); }
  async function fromTemplate() { setBusy(true); await fetch(`/api/tickets/${ticketId}/work/from-template`, j({})).then(apply); setBusy(false); }
  async function ask() { setBusy(true); const r = await fetch(`/api/tickets/${ticketId}/work/suggest`, j({})); const b = await r.json(); setBusy(false); if (r.ok) setSuggest({ ...b, pick: b.tasks.map(() => true) }); }
  async function accept() { if (!suggest) return; const tasks = suggest.tasks.filter((_, i) => suggest.pick[i]); if (!tasks.length) return setSuggest(null); setBusy(true); await fetch(`/api/tickets/${ticketId}/work/bulk`, j({ tasks })).then(apply); setSuggest(null); setBusy(false); }

  return (
    <section className="pane tk-card work" aria-label="Work">
      <div className="row" style={{ justifyContent: 'space-between', margin: '0 0 8px' }}>
        <h3 style={{ margin: 0 }}>Work <span className="note">{d.progress.done} of {d.progress.total} done{d.estimateH ? ` · ${d.estimateH}h estimated` : ''}{d.actualH ? ` · ${d.actualH}h spent` : ''}</span></h3>
        {canEdit && <span className="row" style={{ margin: 0 }}>
          {d.items.length === 0 && <button type="button" className="btn ghost sm" disabled={busy} onClick={fromTemplate}>Add the standard tasks</button>}
          <button type="button" className="btn ghost sm" disabled={busy} onClick={ask}>✦ Suggest a breakdown</button></span>}
      </div>
      {gate && d.progress.total - d.progress.done > 0 && <p className="note" style={{ margin: '0 0 8px' }}>This project does not allow closing the ticket until every task is done.</p>}
      <div className="progress" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label="Work done"><i style={{ width: `${pct}%` }} /></div>
      {error && <p role="alert" className="err" style={{ margin: '8px 0 0' }}>{error}</p>}
      {suggest && (
        <div className="suggest" role="group" aria-label="Suggested tasks">
          <b>{suggest.by === 'ai' ? 'Suggested by the AI' : 'Standard tasks for this kind of ticket'}</b>
          <ul>{suggest.tasks.map((t, i) => <li key={i}><label className="check"><input type="checkbox" checked={suggest.pick[i]} onChange={(e) => setSuggest({ ...suggest, pick: suggest.pick.map((p, k) => (k === i ? e.target.checked : p)) })} /> {t.title}{t.estimateH ? <span className="note"> · {t.estimateH}h</span> : null}</label></li>)}</ul>
          <div className="row" style={{ margin: 0 }}><button type="button" className="btn sm" disabled={busy} onClick={accept}>Add the ticked tasks</button><button type="button" className="btn ghost sm" onClick={() => setSuggest(null)}>Dismiss</button></div>
        </div>)}
      <ol className="wi-list">
        {d.items.map((i) => (
          <li key={i.id} className={`wi ${i.state}`}>
            <label className="sr" htmlFor={`wi-s-${i.id}`}>State of {i.title}</label>
            <select id={`wi-s-${i.id}`} className="lc-select wi-state" value={i.state} disabled={!canEdit} onChange={(e) => patch(i.id, { state: e.target.value })}>{STATES.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}</select>
            <span className="wi-title">{i.title}{i.dependsOn.length > 0 && <span className="note"> · waits for {i.dependsOn.map((x) => d.items.find((y) => y.id === x)?.title ?? '?').join(', ')}</span>}</span>
            <span className="wi-meta">
              {canEdit ? <><label className="sr" htmlFor={`wi-o-${i.id}`}>Owner of {i.title}</label>
                <select id={`wi-o-${i.id}`} className="lc-select" value={i.ownerId ?? ''} onChange={(e) => patch(i.id, { ownerId: e.target.value || null })}><option value="">Unassigned</option>{people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></>
                : i.owner ? <span className="who"><Avatar name={i.owner} size={20} />{i.owner}</span> : null}
              {canEdit && <><label className="sr" htmlFor={`wi-e-${i.id}`}>Estimate in hours for {i.title}</label>
                <input id={`wi-e-${i.id}`} className="lc-input wi-num" type="number" min={0} step={0.5} placeholder="est h" value={i.estimateH ?? ''} onChange={(e) => patch(i.id, { estimateH: e.target.value === '' ? null : Number(e.target.value) })} />
                <label className="sr" htmlFor={`wi-a-${i.id}`}>Hours spent on {i.title}</label>
                <input id={`wi-a-${i.id}`} className="lc-input wi-num" type="number" min={0} step={0.5} placeholder="spent h" value={i.actualH ?? ''} onChange={(e) => patch(i.id, { actualH: e.target.value === '' ? null : Number(e.target.value) })} />
                <button type="button" className="btn ghost sm" aria-label={`Remove ${i.title}`} onClick={() => fetch(`/api/work/${i.id}`, { method: 'DELETE' }).then(apply)}>✕</button></>}
            </span>
          </li>))}
        {d.items.length === 0 && <li className="note">No tasks yet.</li>}
      </ol>
      {canEdit && <form className="row" onSubmit={add} style={{ marginTop: 10 }} aria-label="Add a task"><label className="sr" htmlFor="wi-new">New task</label><input id="wi-new" className="lc-input" style={{ flex: 1 }} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Add a task…" maxLength={300} /><button className="btn sm" disabled={busy || !title.trim()}>Add</button></form>}
    </section>);
}
