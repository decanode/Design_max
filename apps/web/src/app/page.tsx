'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { AnimatePresence, motion } from 'framer-motion';
import { Nav } from '../components/Nav';
import { RolePanels } from '../components/RolePanels';
import { NoAccess, NoProject, useAuth, j as jj } from '../lib/auth';
import { CreateItemDialog } from '../components/CreateItemDialog';
import { lanes, useWorkflow, type Phase } from '../lib/workflow';

const API = '';

type Ticket = {
  id: string; title: string; current_state: string; ai_summary?: string | null;
  legacy_id?: string | null; legacy_source?: 'jira' | 'servicenow' | null;
  created_at: string; updated_at: string; awaiting_approval: boolean; is_assigned: boolean; is_done?: boolean; consultant?: string | null;
  ticket_type_id?: number; type_name?: string; type_short?: string;
};

const ago = (iso: string) => {
  const s = Math.max(1, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)}d ago`;
  return new Date(iso).toLocaleDateString();
};


export default function Board() {
  const { me, can, loading } = useAuth();
  const [tickets, setTickets] = useState<Ticket[] | null>(null);
  const [q, setQ] = useState('');
  const [creating, setCreating] = useState(false);
  const wf = useWorkflow(!!me?.project);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      const r = await fetch(`${API}/api/tickets`);
      if (!r.ok) throw new Error();
      setTickets(await r.json()); setError('');
    } catch { setError('Cannot reach the API.'); setTickets((t) => t ?? []); }
  }, []);
  useEffect(() => { if (me?.project && can('board.view')) load(); }, [load, can, me?.project]);

  const shown = useMemo(() => {
    const n = q.trim().toLowerCase();
    return (tickets ?? []).filter((t) => !n || t.title.toLowerCase().includes(n) || (t.legacy_id ?? '').toLowerCase().includes(n));
  }, [tickets, q]);

  /** The columns are the project's own phases (plus any switched-off phase that still holds tickets, so nothing disappears). */
  const columns = useMemo<Phase[]>(() => {
    if (!wf) return [];
    const have = new Set((tickets ?? []).map((t) => t.current_state));
    return wf.phases.filter((p) => p.enabled || have.has(p.name));
  }, [wf, tickets]);
  const doneNames = useMemo(() => new Set(columns.filter((p) => p.tone === 'done').map((p) => p.name)), [columns]);
  const stats = useMemo(() => {
    const all = tickets ?? [];
    const c = (f: (t: Ticket) => boolean) => all.filter(f).length;
    const tone = (n: string) => columns.find((p) => p.name === n)?.tone;
    return { total: all.length, waiting: c((t) => t.awaiting_approval), progress: c((t) => tone(t.current_state) === 'build' || tone(t.current_state) === 'review'), done: c((t) => doneNames.has(t.current_state)) };
  }, [tickets, columns, doneNames]);

  /** One legal next phase advances in one click; several offer a choice; steps that need a document or approval point to the ticket page. */
  async function advance(t: Ticket, to: string) {
    const r = await fetch(`${API}/api/tickets/${t.id}/transition`, jj({ to }));
    setError(r.ok ? '' : (await r.json()).error);
    load();
  }
  const movesFor = (t: Ticket) => (wf?.moves[t.ticket_type_id ?? -1]?.[t.current_state] ?? []);

  if (loading || !me) return <><Nav current="board" /><main id="main"><p className="note">Loading…</p></main></>;
  if (!me.project) return <><Nav current="board" /><main id="main"><NoProject /></main></>;
  if (!can('board.view')) return <><Nav current="board" /><main id="main"><NoAccess what="the board" /></main></>;

  return (
    <>
      <Nav current="board" />
      <main id="main">
        <div className="board-head">
          <div><h2>{can('ticket.view_all') ? 'Board' : 'My work'}</h2>
            <p>{can('ticket.view_all') ? 'Every ticket, from verified requirement to deployment.' : can('chat.as_customer') ? 'Your requests, from verified requirement to deployment.' : 'Tickets assigned to you and the intake queue.'}</p></div>
          <div className="tools">
            <label className="sr" htmlFor="search">Search tickets</label>
            <input id="search" className="search" type="search" placeholder="Search tickets…" value={q} onChange={(e) => setQ(e.target.value)} />
            {can('ticket.create') && wf && <button className="btn" onClick={() => setCreating(true)}>Create item</button>}
          </div>
        </div>

        {error && <p role="alert" className="err">{error}</p>}
        {creating && wf && <CreateItemDialog wf={wf} onClose={() => setCreating(false)} onCreated={() => { setCreating(false); load(); }} />}

        {tickets && <RolePanels tickets={tickets} reload={load} />}

        <section className="stats" aria-label="Summary">
          <div className="stat"><b>{stats.total}</b><span>Total tickets</span></div>
          <div className={`stat ${stats.waiting ? 'warn' : ''}`}><b>{stats.waiting}</b><span>Awaiting approval</span></div>
          <div className="stat"><b>{stats.progress}</b><span>In progress</span></div>
          <div className="stat good"><b>{stats.done}</b><span>Finished</span></div>
        </section>

        <div className="lanes">
          {!wf && <><div className="skeleton" style={{ width: 260, height: 220 }} /><div className="skeleton" style={{ width: 260, height: 220 }} /><div className="skeleton" style={{ width: 260, height: 220 }} /></>}
          {wf && lanes(columns).map((lane) => (
            <section className="lane" key={`${lane.tone}-${lane.phases[0].id}`} aria-label={`${lane.name} phase`} data-tone={lane.tone}>
              <h3>{lane.name}</h3>
              <div className="cols">
                {lane.phases.map((ph) => {
                  const s = ph.name;
                  const items = shown.filter((t) => t.current_state === s);
                  return (
                    <section className="col" key={ph.id} aria-label={s} data-tone={lane.tone}>
                      <div className="col-head"><h4>{s}{!ph.enabled && <span className="note"> (off)</span>}</h4><span className="count" aria-label={`${items.length} tickets`}>{items.length}</span></div>
                      <div className="col-body">
                        {tickets === null && <><div className="skeleton" /><div className="skeleton" /></>}
                        {tickets !== null && items.length === 0 && <div className="col-empty">{q ? 'No matches' : 'Nothing here'}</div>}
                        <AnimatePresence initial={false}>
                          {items.map((t) => {
                            const open = movesFor(t).filter((m) => !m.gated);
                            return (
                              <motion.article className="card" key={t.id} layout initial={{ opacity: 0, scale: 0.96 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.96 }} transition={{ duration: 0.18 }}>
                                <div className="meta" style={{ marginBottom: 2 }}>{t.type_short && <span className="type-tag" title={t.type_name}>{t.type_short}</span>}</div>
                                <Link className="title" href={`/tickets/${t.id}`}>{t.title}</Link>
                                {t.ai_summary && <p className="sum">{t.ai_summary}</p>}
                                <div className="meta">
                                  {t.awaiting_approval && <span className="tag warn">Awaiting approval</span>}
                                  {t.legacy_source && <span className="tag src">{t.legacy_source === 'jira' ? 'Jira' : 'ServiceNow'} · {t.legacy_id}</span>}
                                  {t.consultant && <span className="tag" title="Assigned consultant">{t.consultant}</span>}
                                  <span>{ago(t.updated_at)}</span>
                                </div>
                                {can('ticket.advance') && open.length === 1 && <button className="adv" onClick={() => advance(t, open[0].to)}>Advance → {open[0].to}</button>}
                                {can('ticket.advance') && open.length > 1 && (
                                  <select className="adv" aria-label={`Move ${t.title} to`} value="" onChange={(e) => e.target.value && advance(t, e.target.value)}>
                                    <option value="">Move to…</option>{open.map((m) => <option key={m.to} value={m.to}>{m.to}</option>)}
                                  </select>)}
                              </motion.article>);
                          })}
                        </AnimatePresence>
                      </div>
                    </section>
                  );
                })}
              </div>
            </section>
          ))}
        </div>
      </main>
    </>
  );
}
