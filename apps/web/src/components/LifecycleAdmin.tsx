'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { motion } from 'framer-motion';
import { api, type Flash } from './consoleBits';
import { j } from '../lib/auth';
import { TONE_LABEL } from '../lib/workflow';

type Tone = keyof typeof TONE_LABEL;
type Status = { id: number; name: string; tone: Tone; own: boolean; tickets: number };
type Edge = { from: number | null; to: number; gated: string | null };
type Lifecycle = { id: number; key: string; name: string; short: string; enabled: boolean; custom: boolean; statuses: Status[]; edges: Edge[] };
type Catalog = { id: number; name: string; tone: Tone; own: boolean; removable: boolean };
type Data = { methodology: string | null; lifecycles: Lifecycle[]; statuses: Catalog[] };
const key = (from: number | null, to: number) => `${from ?? 'start'}>${to}`;

/** Project settings → Lifecycles: for each ticket type, the statuses a ticket passes through and which moves are allowed. */
export function LifecycleAdmin({ flash, sub, onSub }: { flash: Flash; sub: string | null; onSub: (s: string | null) => void }) {
  const [data, setData] = useState<Data | null>(null);
  const load = useCallback(async () => { try { setData(await api('/api/project/lifecycles')); } catch (e) { flash('err', (e as Error).message); } }, [flash]);
  useEffect(() => { load(); }, [load]);
  if (!data) return <div className="tb-skel" aria-busy="true" aria-label="Loading lifecycles"><div className="skeleton" style={{ height: 120 }} /><div className="skeleton" style={{ height: 220 }} /></div>;
  const open = data.lifecycles.find((l) => String(l.id) === sub);
  if (sub && open) return <Editor key={open.id} lc={open} catalog={data.statuses} flash={flash} back={() => { onSub(null); load(); }} reload={load} />;

  return (
    <div className="tb">
      <section className="pane tb-sec" aria-label="Lifecycles">
        <h3>Lifecycles</h3>
        <p className="note" style={{ marginTop: 0 }}>Each kind of item moves through its own statuses. Standard lifecycles come from the {data.methodology ?? 'project'} methodology; customise one to give this project its own statuses and allowed moves.</p>
        <ul className="lc-list">
          {data.lifecycles.map((l) => (
            <li key={l.id} className="lc-card">
              <div className="row" style={{ margin: 0, justifyContent: 'space-between' }}>
                <span><span className="type-tag">{l.short}</span> <b>{l.name}</b> {l.custom ? <span className="badge">Customised</span> : <span className="note">Standard</span>}{!l.enabled && <span className="note"> · switched off</span>}</span>
                <button type="button" className="btn ghost" onClick={() => onSub(String(l.id))} aria-label={`Edit the ${l.name} lifecycle`}>Edit lifecycle</button>
              </div>
              <ol className="tb-flow" aria-label={`${l.name} statuses`}>
                {l.statuses.map((s, i) => <li key={s.id} data-tone={s.tone}>{i > 0 && <span aria-hidden className="arrow">→</span>}<span className="chip">{s.name}</span></li>)}
              </ol>
            </li>))}
        </ul>
      </section>
    </div>);
}

function Editor({ lc, catalog, flash, back, reload }: { lc: Lifecycle; catalog: Catalog[]; flash: Flash; back: () => void; reload: () => Promise<void> }) {
  const [cat, setCat] = useState(catalog);
  const [statuses, setStatuses] = useState<Status[]>(lc.statuses);
  const [moves, setMoves] = useState<Set<string>>(new Set(lc.edges.map((e) => key(e.from, e.to))));
  const [saved, setSaved] = useState(() => JSON.stringify([lc.statuses.map((s) => s.id), lc.edges.map((e) => key(e.from, e.to)).sort()]));
  const [busy, setBusy] = useState(false);
  const [pick, setPick] = useState('');
  const [newName, setNewName] = useState(''); const [newTone, setNewTone] = useState<Tone>('build');
  const gated = useMemo(() => new Map(lc.edges.filter((e) => e.gated).map((e) => [key(e.from, e.to), e.gated!])), [lc.edges]);
  const gatedStatus = useMemo(() => new Set(lc.edges.filter((e) => e.gated).flatMap((e) => [e.from, e.to]).filter((x): x is number => x !== null)), [lc.edges]);
  const dirty = JSON.stringify([statuses.map((s) => s.id), [...moves].sort()]) !== saved;
  const addable = cat.filter((c) => !statuses.some((s) => s.id === c.id));
  const name = (id: number) => statuses.find((s) => s.id === id)?.name ?? '';

  const shift = (i: number, d: number) => setStatuses((p) => { const n = [...p]; const j2 = i + d; if (j2 < 0 || j2 >= n.length) return p; [n[i], n[j2]] = [n[j2], n[i]]; return n; });
  const remove = (s: Status) => { setStatuses((p) => p.filter((x) => x.id !== s.id)); setMoves((p) => new Set([...p].filter((k) => { const [f, t] = k.split('>'); return f !== String(s.id) && t !== String(s.id); }))); };
  const add = (c: Catalog) => setStatuses((p) => [...p, { id: c.id, name: c.name, tone: c.tone, own: c.own, tickets: 0 }]);
  const toggle = (from: number | null, to: number, on: boolean) => setMoves((p) => { const n = new Set(p); on ? n.add(key(from, to)) : n.delete(key(from, to)); return n; });

  async function createStatus(e: React.FormEvent) {
    e.preventDefault();
    if (!newName.trim()) return;
    try {
      const s = await api('/api/project/statuses', j({ name: newName.trim(), tone: newTone }));
      if (!cat.some((c) => c.id === s.id)) setCat((p) => [...p, { id: s.id, name: s.name, tone: s.tone, own: s.own, removable: true }]);
      if (!statuses.some((x) => x.id === s.id)) setStatuses((p) => [...p, { id: s.id, name: s.name, tone: s.tone, own: s.own, tickets: 0 }]);
      setNewName('');
    } catch (err) { flash('err', (err as Error).message); }
  }
  async function save() {
    setBusy(true);
    try {
      const edges = [...moves].map((k) => { const [f, t] = k.split('>'); return { from: f === 'start' ? null : Number(f), to: Number(t) }; });
      await api(`/api/project/lifecycles/${lc.id}`, j({ statuses: statuses.map((s) => s.id), edges }, 'PUT'));
      setSaved(JSON.stringify([statuses.map((s) => s.id), [...moves].sort()]));
      flash('ok', `${lc.name} lifecycle saved. The board and ticket moves follow it now.`); await reload();
    } catch (e) { flash('err', (e as Error).message); } finally { setBusy(false); }
  }
  async function restore() {
    if (!window.confirm(`Go back to the standard ${lc.name} lifecycle? Your custom statuses and moves for ${lc.name} are removed.`)) return;
    setBusy(true);
    try { await api(`/api/project/lifecycles/${lc.id}`, { method: 'DELETE' }); flash('ok', `${lc.name} follows the standard lifecycle again.`); back(); }
    catch (e) { flash('err', (e as Error).message); setBusy(false); }
  }

  const targets = (from: number | null) => statuses.filter((s) => s.id !== from);
  return (
    <motion.div className="tb drill" aria-label={`${lc.name} lifecycle`} initial={{ opacity: 0, x: 18 }} animate={{ opacity: 1, x: 0 }} transition={{ duration: 0.16 }}>
      <section className="pane tb-sec" aria-label="Statuses">
        <h3>{lc.name}: statuses</h3>
        <p className="note" style={{ marginTop: 0 }}>The order is the board order. “Category” decides colour and whether a ticket still counts as open: only <b>Done</b> statuses finish a ticket.</p>
        <ol className="lc-statuses">
          {statuses.map((s, i) => {
            const locked = gatedStatus.has(s.id) || s.tickets > 0;
            return (
              <li key={s.id} className="tb-phase" data-tone={s.tone}>
                <span className="tb-phase-name">{s.name}</span>
                <span className="note">{TONE_LABEL[s.tone]}{s.own ? ' · yours' : ''}{gatedStatus.has(s.id) ? ' · documents' : ''}{s.tickets ? ` · ${s.tickets} ticket${s.tickets > 1 ? 's' : ''}` : ''}</span>
                <span className="lc-actions">
                  <button type="button" className="btn ghost" onClick={() => shift(i, -1)} disabled={i === 0} aria-label={`Move ${s.name} earlier`}>↑</button>
                  <button type="button" className="btn ghost" onClick={() => shift(i, 1)} disabled={i === statuses.length - 1} aria-label={`Move ${s.name} later`}>↓</button>
                  <button type="button" className="btn ghost" onClick={() => remove(s)} disabled={locked} title={locked ? 'Tickets are in this status, or documents depend on it' : undefined} aria-label={`Remove ${s.name}`}>Remove</button>
                </span>
              </li>);
          })}
        </ol>
        <div className="lc-add">
          <div className="lc-add-card">
            <label htmlFor="lc-pick"><b>Add an existing status</b><span className="note">Standard statuses and ones you created before.</span></label>
            <select id="lc-pick" className="lc-select" value={pick} onChange={(e) => { const c = cat.find((x) => String(x.id) === e.target.value); if (c) add(c); setPick(''); }} disabled={addable.length === 0}>
              <option value="">{addable.length ? 'Choose a status…' : 'Every status is already in this lifecycle'}</option>
              {addable.map((c) => <option key={c.id} value={c.id}>{c.name} · {TONE_LABEL[c.tone]}{c.own ? ' · yours' : ''}</option>)}
            </select>
          </div>
          <form onSubmit={createStatus} className="lc-add-card" aria-label="Create a status">
            <label htmlFor="lc-new"><b>Create a new status</b><span className="note">Your own name and category, for example Awaiting vendor.</span></label>
            <div className="lc-new-row">
              <input id="lc-new" className="lc-input" value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="Status name" maxLength={60} />
              <label className="sr" htmlFor="lc-tone">Category</label>
              <select id="lc-tone" className="lc-select" value={newTone} onChange={(e) => setNewTone(e.target.value as Tone)}>{(Object.keys(TONE_LABEL) as Tone[]).map((t) => <option key={t} value={t}>{TONE_LABEL[t]}</option>)}</select>
              <button className="btn" type="submit" disabled={!newName.trim()}>Create status</button>
            </div>
          </form>
        </div>
      </section>

      <section className="pane tb-sec" aria-label="Moves">
        <h3>{lc.name}: allowed moves</h3>
        <p className="note" style={{ marginTop: 0 }}>For each status, tick where a ticket may go next. Steps that need a document or approval are fixed.</p>
        {[null, ...statuses.map((s) => s.id)].map((from) => (
          <fieldset key={from ?? 'start'} className="lc-moves">
            <legend>{from === null ? 'A new ticket starts at' : `From ${name(from)} a ticket can go to`}</legend>
            {targets(from).map((t) => {
              const k = key(from, t.id); const g = gated.get(k);
              return (
                <label key={t.id} className={`check lc-opt ${moves.has(k) ? 'on' : ''}`} title={g}>
                  <input type="checkbox" checked={moves.has(k) || !!g} disabled={!!g} onChange={(e) => toggle(from, t.id, e.target.checked)} aria-label={`${from === null ? 'Start' : name(from)} to ${t.name}`} /> {t.name}{g ? ' (document step)' : ''}
                </label>);
            })}
          </fieldset>))}
      </section>

      <div className="tb-bar drill-bar" role="region" aria-label="Save changes">
        <span className="note">{dirty ? 'You have unsaved changes.' : lc.custom ? 'Customised lifecycle, saved.' : 'Standard lifecycle. Make a change to customise it.'}</span>
        {lc.custom && <button type="button" className="btn ghost" onClick={restore} disabled={busy}>Restore standard</button>}
        <button type="button" className="btn ghost" onClick={back} disabled={busy}>Back to lifecycles</button>
        <button type="button" className="btn" onClick={save} disabled={!dirty || busy}>{busy ? 'Saving…' : 'Save lifecycle'}</button>
      </div>
    </motion.div>);
}
