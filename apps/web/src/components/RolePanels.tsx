'use client';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { useAuth, j } from '../lib/auth';

export type PanelTicket = { id: string; title: string; current_state: string; is_assigned: boolean; is_done?: boolean; awaiting_approval: boolean };

function Panel({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <details className="rpanel" open>
      <summary><h3>{title}</h3>{hint && <span className="note">{hint}</span>}</summary>
      <div className="rpanel-body">{children}</div>
    </details>
  );
}

/** Customer: the entry point for raising a new requirement. */
function CustomerPanel() {
  return (
    <Panel title="Raise a new request" hint="Describe what you need in chat; an assistant drafts it for you to confirm.">
      <Link className="btn" href="/chat" style={{ display: 'inline-block', textDecoration: 'none' }}>Start a conversation</Link>
    </Panel>
  );
}

/** Consultant (and anyone who can claim): the intake queue. */
function QueuePanel({ tickets, reload }: { tickets: PanelTicket[]; reload: () => void }) {
  const queue = tickets.filter((t) => !t.is_assigned && !t.is_done);
  const [err, setErr] = useState('');
  async function claim(id: string) {
    const r = await fetch(`/api/tickets/${id}/claim`, { method: 'POST' });
    setErr(r.ok ? '' : (await r.json()).error); reload();
  }
  return (
    <Panel title="Intake queue" hint={`${queue.length} waiting for a consultant`}>
      {err && <p role="alert" className="err">{err}</p>}
      {queue.length === 0 ? <p className="note" style={{ margin: 0 }}>Nothing waiting. New verified requirements appear here.</p> : (
        <ul className="rlist">
          {queue.slice(0, 8).map((t) => (
            <li key={t.id}><Link href={`/tickets/${t.id}`}>{t.title}</Link><span className="note">{t.current_state}</span>
              <button className="btn sm" onClick={() => claim(t.id)}>Claim</button></li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

type Team = { consultants: { id: string; name: string; role: string; open: number; awaiting_approval: number }[]; unassigned: number };

/** Lead: workload per person and quick assignment of unassigned work. */
function TeamPanel({ tickets, reload }: { tickets: PanelTicket[]; reload: () => void }) {
  const [team, setTeam] = useState<Team | null>(null);
  const [people, setPeople] = useState<{ id: string; name: string }[]>([]);
  const load = useCallback(async () => {
    const [a, b] = await Promise.all([fetch('/api/dashboard/team'), fetch('/api/users/assignable')]);
    if (a.ok) setTeam(await a.json()); if (b.ok) setPeople(await b.json());
  }, []);
  useEffect(() => { load(); }, [load, tickets]);
  const waiting = tickets.filter((t) => !t.is_assigned && !t.is_done);
  const max = Math.max(1, ...(team?.consultants.map((c) => c.open) ?? [1]));
  async function assign(ticketId: string, consultantId: string) {
    if (!consultantId) return;
    await fetch(`/api/tickets/${ticketId}/assign`, j({ consultantId })); reload(); load();
  }
  return (
    <Panel title="Team workload" hint={team ? `${team.unassigned} unassigned` : ''}>
      {!team ? <p className="note">Loading…</p> : (
        <div className="split">
          <div>
            <table className="grid"><thead><tr><th>Person</th><th>Open</th><th>Awaiting approval</th></tr></thead>
              <tbody>{team.consultants.map((c) => (
                <tr key={c.id}><td>{c.name}<span className="note"> · {c.role}</span></td>
                  <td><span className="bar" aria-hidden><i style={{ width: `${(c.open / max) * 100}%` }} /></span> {c.open}</td><td>{c.awaiting_approval}</td></tr>))}
                {team.consultants.length === 0 && <tr><td colSpan={3} className="note">No assignable people yet.</td></tr>}
              </tbody></table>
          </div>
          <div>
            <h4 className="mini">Needs an owner</h4>
            {waiting.length === 0 ? <p className="note" style={{ margin: 0 }}>Everything is assigned.</p> : (
              <ul className="rlist">{waiting.slice(0, 6).map((t) => (
                <li key={t.id}><Link href={`/tickets/${t.id}`}>{t.title}</Link>
                  <select aria-label={`Assign ${t.title}`} defaultValue="" onChange={(e) => assign(t.id, e.target.value)}>
                    <option value="">Assign…</option>{people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                  </select></li>))}</ul>)}
          </div>
        </div>
      )}
    </Panel>
  );
}

type Portfolio = { byState: { state: string; count: number }[]; pendingApprovals: number; mine: number };
import { FULL, type Kind } from '../lib/docKinds';
type Mine = { id: string; ticket_id: string; title: string; kind: Kind; version_number: number; level_name: string | null; workflow_name: string | null }[];

/** Approvals waiting on this person, whatever their role: being named in a workflow is what puts them here. */
function MyApprovalsPanel() {
  const [mine, setMine] = useState<Mine>([]);
  useEffect(() => { fetch('/api/my/approvals').then((r) => r.ok && r.json()).then((d) => d && setMine(d)); }, []);
  if (mine.length === 0) return null;
  return (
    <Panel title="Waiting for your approval" hint={`${mine.length} document${mine.length === 1 ? '' : 's'}`}>
      <ul className="rlist">{mine.map((a) => (
        <li key={a.id}><Link href={`/tickets/${a.ticket_id}`}>{a.title}</Link>
          <span className="note">{FULL[a.kind]} v{a.version_number}{a.level_name ? ` · ${a.level_name}` : ''}{a.workflow_name ? ` · ${a.workflow_name}` : ''}</span>
          <Link className="btn sm" href={`/tickets/${a.ticket_id}`} style={{ textDecoration: 'none' }}>Review</Link></li>))}</ul>
    </Panel>
  );
}

/** Manager view: how tickets are spread across phases, and how many approvals are open firm-wide. */
function PortfolioPanel() {
  const [p, setP] = useState<Portfolio | null>(null);
  useEffect(() => { fetch('/api/dashboard/portfolio').then((r) => r.ok && r.json()).then((d) => d && setP(d)); }, []);
  const max = Math.max(1, ...(p?.byState.map((s) => s.count) ?? [1]));
  return (
    <Panel title="Portfolio" hint={p ? `${p.pendingApprovals} approvals pending across the firm` : ''}>
      <ul className="bars" aria-label="Tickets by phase">
        {p?.byState.map((s) => (
          <li key={s.state}><span className="bl">{s.state}</span><span className="bar"><i style={{ width: `${(s.count / max) * 100}%` }} /></span><span className="bn">{s.count}</span></li>))}
      </ul>
    </Panel>
  );
}

export function RolePanels({ tickets, reload }: { tickets: PanelTicket[]; reload: () => void }) {
  const { can } = useAuth();
  return (
    <div className="rpanels">
      <MyApprovalsPanel />
      {can('chat.as_customer') && !can('ticket.view_all') && <CustomerPanel />}
      {/* Leads get the same list inside Team workload, with assignment controls instead of Claim. */}
      {can('ticket.claim') && !can('dashboard.team') && <QueuePanel tickets={tickets} reload={reload} />}
      {can('dashboard.team') && <TeamPanel tickets={tickets} reload={reload} />}
      {can('dashboard.portfolio') && <PortfolioPanel />}
    </div>
  );
}
