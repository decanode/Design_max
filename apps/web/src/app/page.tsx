'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { AnimatePresence, motion } from 'framer-motion';
import { Nav } from '../components/Nav';
import { RolePanels } from '../components/RolePanels';
import { NoAccess, NoProject, useAuth, j as jj } from '../lib/auth';
import { CreateItemDialog } from '../components/CreateItemDialog';
import { lanes, useWorkflow, type Phase } from '../lib/workflow';
import { PriorityBadge } from '../components/ticket/DetailsSidebar';
import { Avatar } from '../components/people/shared';

const API = '';

type Ticket = {
  id: string; title: string; current_state: string; ai_summary?: string | null;
  legacy_id?: string | null; legacy_source?: 'jira' | 'servicenow' | null;
  created_at: string; updated_at: string; awaiting_approval: boolean; is_assigned: boolean; is_done?: boolean; consultant?: string | null;
  ticket_type_id?: number; type_name?: string; type_short?: string; team_name?: string | null;
  work_total?: number; work_done?: number; out_of_sync?: boolean; key?: string; priority?: string; due_date?: string | null; signoff_status?: string | null; consultant_id?: string | null; customer_name?: string | null; approval_status?: string;
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
  const [view, setView] = useState<'board' | 'list'>('board');
  const [fType, setFType] = useState(0); const [fWho, setFWho] = useState<'all' | 'me' | 'none'>('all'); const [fPrio, setFPrio] = useState(''); const [fSrc, setFSrc] = useState(''); const [fOpen, setFOpen] = useState(true); const [fWait, setFWait] = useState(false);
  const [sort, setSort] = useState<{ k: 'key' | 'title' | 'state' | 'priority' | 'due' | 'updated'; dir: 1 | -1 }>({ k: 'updated', dir: -1 });
  useEffect(() => { try { const v = localStorage.getItem('dm-board-view'); if (v === 'list' || v === 'board') setView(v); } catch { /* no storage */ } }, []);
  const chooseView = (v: 'board' | 'list') => { setView(v); try { localStorage.setItem('dm-board-view', v); } catch { /* no storage */ } };
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
    return (tickets ?? []).filter((t) => (!n || t.title.toLowerCase().includes(n) || (t.legacy_id ?? '').toLowerCase().includes(n) || (t.key ?? '').toLowerCase().includes(n))
      && (!fType || t.ticket_type_id === fType) && (!fPrio || t.priority === fPrio) && (!fSrc || (fSrc === 'native' ? !t.legacy_source : t.legacy_source === fSrc))
      && (fWho === 'all' || (fWho === 'me' ? t.consultant_id === me?.user.id : !t.is_assigned))
      && (!fWait || t.awaiting_approval || t.signoff_status === 'pending' || t.approval_status === 'pending')
      && (view === 'list' ? (!fOpen || !t.is_done) : true));
  }, [tickets, q, fType, fPrio, fSrc, fWho, fWait, fOpen, view, me?.user.id]);
  const PR: Record<string, number> = { Critical: 0, High: 1, Medium: 2, Low: 3 };
  const rows = useMemo(() => {
    const v = (t: Ticket) => sort.k === 'key' ? (t.key ?? '') : sort.k === 'title' ? t.title.toLowerCase() : sort.k === 'state' ? t.current_state : sort.k === 'priority' ? (PR[t.priority ?? 'Medium'] ?? 2) : sort.k === 'due' ? (t.due_date ?? '9999') : t.updated_at;
    return [...shown].sort((a, b) => (v(a) < v(b) ? -1 : v(a) > v(b) ? 1 : 0) * sort.dir);
  }, [shown, sort]);   // eslint-disable-line react-hooks/exhaustive-deps

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

        <div className="board-filters" role="group" aria-label="Filter tickets">
          <div className="seg" role="tablist" aria-label="View">
            <button type="button" role="tab" aria-selected={view === 'board'} onClick={() => chooseView('board')}>Board</button>
            <button type="button" role="tab" aria-selected={view === 'list'} onClick={() => chooseView('list')}>List</button>
          </div>
          <label className="sr" htmlFor="f-type">Type</label>
          <select id="f-type" className="lc-select" value={fType} onChange={(e) => setFType(Number(e.target.value))}><option value={0}>All types</option>{wf?.ticketTypes.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select>
          <label className="sr" htmlFor="f-who">Assignee</label>
          <select id="f-who" className="lc-select" value={fWho} onChange={(e) => setFWho(e.target.value as typeof fWho)}><option value="all">Anyone</option><option value="me">Assigned to me</option><option value="none">Unassigned</option></select>
          <label className="sr" htmlFor="f-prio">Priority</label>
          <select id="f-prio" className="lc-select" value={fPrio} onChange={(e) => setFPrio(e.target.value)}><option value="">Any priority</option>{['Critical', 'High', 'Medium', 'Low'].map((p) => <option key={p}>{p}</option>)}</select>
          {(tickets ?? []).some((t) => t.legacy_source) && (<><label className="sr" htmlFor="f-src">Source</label>
            <select id="f-src" className="lc-select" value={fSrc} onChange={(e) => setFSrc(e.target.value)}><option value="">All sources</option><option value="native">Created here</option><option value="jira">Jira</option><option value="servicenow">ServiceNow</option></select></>)}
          <label className="check"><input type="checkbox" checked={fWait} onChange={(e) => setFWait(e.target.checked)} /> Waiting on someone</label>
          {view === 'list' && <label className="check"><input type="checkbox" checked={fOpen} onChange={(e) => setFOpen(e.target.checked)} /> Open only</label>}
          {(fType || fPrio || fSrc || fWho !== 'all' || fWait || q) && <button type="button" className="linklike" onClick={() => { setFType(0); setFPrio(''); setFSrc(''); setFWho('all'); setFWait(false); setQ(''); }}>Clear filters</button>}
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

        {view === 'list' ? <TicketList rows={rows} sort={sort} setSort={setSort} loaded={tickets !== null} /> : (
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
                                <div className="meta card-top">{t.type_short && <span className="type-tag" title={t.type_name}>{t.type_short}</span>}{t.key && <span className="card-key">{t.key}</span>}<PriorityBadge p={t.priority} /></div>
                                <Link className="title" href={`/tickets/${t.id}`}>{t.title}</Link>
                                {t.ai_summary && <p className="sum">{t.ai_summary}</p>}
                                <div className="meta">
                                  {t.awaiting_approval && <span className="tag warn">Awaiting approval</span>}
                                  {t.signoff_status === 'pending' && <span className="tag warn" title="The customer has been asked to confirm">Awaiting customer</span>}
                                  {t.due_date && !t.is_done && new Date(t.due_date) < new Date(new Date().toDateString()) && <span className="tag bad" title="Past its due date">Overdue</span>}
                                  {t.legacy_source && <span className="tag src">{t.legacy_source === 'jira' ? 'Jira' : 'ServiceNow'} · {t.legacy_id}</span>}
                                  {!!t.work_total && <span className="tag" title="Tasks done">☑ {t.work_done}/{t.work_total}</span>}
                                  {t.consultant && <span className="who card-who" title="Assigned consultant"><Avatar name={t.consultant} size={20} />{t.consultant}</span>}
                                  {t.team_name && <span className="tag team" title="Assigned team">{t.team_name}</span>}
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
        </div>)}
      </main>
    </>
  );
}

type SortKey = 'key' | 'title' | 'state' | 'priority' | 'due' | 'updated';
function TicketList({ rows, sort, setSort, loaded }: { rows: Ticket[]; sort: { k: SortKey; dir: 1 | -1 }; setSort: (s: { k: SortKey; dir: 1 | -1 }) => void; loaded: boolean }) {
  const th = (k: SortKey, label: string) => (
    <th scope="col" aria-sort={sort.k === k ? (sort.dir === 1 ? 'ascending' : 'descending') : 'none'}>
      <button type="button" className="th-sort" onClick={() => setSort({ k, dir: sort.k === k ? (sort.dir === 1 ? -1 : 1) : 1 })}>{label}<span aria-hidden>{sort.k === k ? (sort.dir === 1 ? ' ▲' : ' ▼') : ''}</span></button>
    </th>);
  return (
    <div className="data-wrap">
      <table className="data-table ticket-table">
        <caption className="sr">Tickets</caption>
        <thead><tr>{th('key', 'Key')}{th('title', 'Title')}{th('state', 'Status')}{th('priority', 'Priority')}<th scope="col">Assignee</th>{th('due', 'Due')}{th('updated', 'Updated')}</tr></thead>
        <tbody>
          {rows.map((t) => (
            <tr key={t.id}>
              <td><span className="type-tag">{t.type_short}</span> <Link href={`/tickets/${t.id}`} className="card-key">{t.key ?? '—'}</Link></td>
              <td><Link className="title" href={`/tickets/${t.id}`}>{t.title}</Link>{t.awaiting_approval && <span className="tag warn" style={{ marginLeft: 6 }}>Awaiting approval</span>}{t.signoff_status === 'pending' && <span className="tag warn" style={{ marginLeft: 6 }}>Awaiting customer</span>}</td>
              <td><span className="state-pill">{t.current_state}</span></td>
              <td><PriorityBadge p={t.priority} /></td>
              <td>{t.consultant ? <span className="who"><Avatar name={t.consultant} size={22} />{t.consultant}</span> : <span className="note">Unassigned</span>}</td>
              <td className={t.due_date && !t.is_done && new Date(t.due_date) < new Date(new Date().toDateString()) ? 'overdue' : 'note'}>{t.due_date ? new Date(t.due_date).toLocaleDateString() : '—'}</td>
              <td className="note">{ago(t.updated_at)}</td>
            </tr>))}
          {loaded && rows.length === 0 && <tr><td colSpan={7} className="empty-row">No tickets match.</td></tr>}
        </tbody>
      </table>
    </div>);
}
