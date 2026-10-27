'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { Nav } from '../components/Nav';
import { RolePanels } from '../components/RolePanels';
import { NoAccess, useAuth, j as jj } from '../lib/auth';

const API = '';

type Ticket = {
  id: string; title: string; current_state: string; ai_summary: string | null;
  legacy_id: string | null; legacy_source: 'jira' | 'servicenow' | null;
  created_at: string; updated_at: string; awaiting_approval: boolean; consultant_id: string | null; consultant: string | null;
};

/** Phases grouped into lanes so the lifecycle reads left-to-right at a glance. */
const LANES: { name: string; tone: 'intake' | 'spec' | 'build' | 'done'; states: string[] }[] = [
  { name: 'Intake', tone: 'intake', states: ['Requirement Verified'] },
  { name: 'Specification', tone: 'spec', states: ['FS Drafted', 'FS Approved', 'TS Drafted', 'TS Approved'] },
  { name: 'Delivery', tone: 'build', states: ['Development', 'QA', 'UAT'] },
  { name: 'Done', tone: 'done', states: ['Deployed'] },
];
const ORDER = LANES.flatMap((l) => l.states);
// Steps before TS Approved need a document or approval, so they happen on the ticket page, not here.
const CAN_ADVANCE = new Set(['TS Approved', 'Development', 'QA', 'UAT']);

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
  const [title, setTitle] = useState('');
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      const r = await fetch(`${API}/api/tickets`);
      if (!r.ok) throw new Error();
      setTickets(await r.json()); setError('');
    } catch { setError('Cannot reach the API.'); setTickets((t) => t ?? []); }
  }, []);
  useEffect(() => { if (can('board.view')) load(); }, [load, can]);

  const shown = useMemo(() => {
    const n = q.trim().toLowerCase();
    return (tickets ?? []).filter((t) => !n || t.title.toLowerCase().includes(n) || (t.legacy_id ?? '').toLowerCase().includes(n));
  }, [tickets, q]);

  const stats = useMemo(() => {
    const all = tickets ?? [];
    const c = (f: (t: Ticket) => boolean) => all.filter(f).length;
    return {
      total: all.length,
      waiting: c((t) => t.awaiting_approval),
      progress: c((t) => ['Development', 'QA', 'UAT'].includes(t.current_state)),
      done: c((t) => t.current_state === 'Deployed'),
    };
  }, [tickets]);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim()) return;
    try {
      let pid: string | undefined = (await (await fetch(`${API}/api/projects`)).json())[0]?.id;
      if (!pid) pid = (await (await fetch(`${API}/api/projects`, jj({ name: 'Default' }))).json()).id;
      const r = await fetch(`${API}/api/tickets`, jj({ projectId: pid, title: title.trim() }));
      if (!r.ok) throw new Error();
      setTitle(''); setError(''); load();
    } catch { setError('Could not create the ticket.'); }
  }

  async function advance(t: Ticket) {
    const to = ORDER[ORDER.indexOf(t.current_state) + 1];
    const r = await fetch(`${API}/api/tickets/${t.id}/transition`, jj({ to }));
    setError(r.ok ? '' : (await r.json()).error);
    load();
  }

  if (loading || !me) return <><Nav current="board" /><main id="main"><p className="note">Loading…</p></main></>;
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
            {can('ticket.create') && <form className="newform" onSubmit={create}>
              <label className="sr" htmlFor="new">New ticket title</label>
              <input id="new" className="newtitle" aria-label="New ticket title" placeholder="New ticket title" value={title} onChange={(e) => setTitle(e.target.value)} />
              <button className="btn" type="submit" disabled={!title.trim()}>Create ticket</button>
            </form>}
          </div>
        </div>

        {error && <p role="alert" className="err">{error}</p>}

        {tickets && <RolePanels tickets={tickets} reload={load} />}

        <section className="stats" aria-label="Summary">
          <div className="stat"><b>{stats.total}</b><span>Total tickets</span></div>
          <div className={`stat ${stats.waiting ? 'warn' : ''}`}><b>{stats.waiting}</b><span>Awaiting approval</span></div>
          <div className="stat"><b>{stats.progress}</b><span>In delivery</span></div>
          <div className="stat good"><b>{stats.done}</b><span>Deployed</span></div>
        </section>

        <div className="lanes">
          {LANES.map((lane) => (
            <section className="lane" key={lane.name} aria-label={`${lane.name} phase`}>
              <h3>{lane.name}</h3>
              <div className="cols">
                {lane.states.map((s) => {
                  const items = shown.filter((t) => t.current_state === s);
                  return (
                    <section className="col" key={s} aria-label={s} data-tone={lane.tone}>
                      <div className="col-head"><h4>{s}</h4><span className="count" aria-label={`${items.length} tickets`}>{items.length}</span></div>
                      <div className="col-body">
                        {tickets === null && <><div className="skeleton" /><div className="skeleton" /></>}
                        {tickets !== null && items.length === 0 && <div className="col-empty">{q ? 'No matches' : 'Nothing here'}</div>}
                        {items.map((t) => (
                          <article className="card" key={t.id}>
                            <Link className="title" href={`/tickets/${t.id}`}>{t.title}</Link>
                            {t.ai_summary && <p className="sum">{t.ai_summary}</p>}
                            <div className="meta">
                              {t.awaiting_approval && <span className="tag warn">Awaiting approval</span>}
                              {t.legacy_source && <span className="tag src">{t.legacy_source === 'jira' ? 'Jira' : 'ServiceNow'} · {t.legacy_id}</span>}
                              {t.consultant && <span className="tag" title="Assigned consultant">{t.consultant}</span>}
                              <span>{ago(t.updated_at)}</span>
                            </div>
                            {CAN_ADVANCE.has(s) && can('ticket.advance') && <button className="adv" onClick={() => advance(t)}>Advance → {ORDER[ORDER.indexOf(s) + 1]}</button>}
                          </article>
                        ))}
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
