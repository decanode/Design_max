'use client';
import { useState } from 'react';
import { Avatar } from '../people/shared';
import { j } from '../../lib/auth';

type Level = 'hidden' | 'read' | 'write';
const PRIORITIES = ['Critical', 'High', 'Medium', 'Low'] as const;
const dt = (iso?: string | null) => (iso ? new Date(iso).toLocaleString([], { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—');

export const PriorityBadge = ({ p }: { p?: string }) => <span className={`prio prio-${(p ?? 'Medium').toLowerCase()}`}><i aria-hidden />{p ?? 'Medium'}</span>;

type T = { id: string; key?: string; priority?: string; due_date?: string | null; type_name?: string; type_short?: string; current_state: string; created_at: string; updated_at: string;
  consultant_id?: string | null; consultant_name?: string | null; customer_name?: string | null; team_id?: string | null; team_name?: string | null; is_assigned?: boolean; project_name?: string | null };

/** The traditional "fields" of a ticket, in one column: status, priority, people, dates. Each is editable where the role allows. */
export function DetailsSidebar({ t, fields, stacks, can, people, teamOptions, busy, run, children }: {
  t: T; fields: Record<string, Level>; stacks?: string[]; can: (p: string) => boolean; people: { id: string; name: string }[]; teamOptions: { id: string; name: string }[];
  busy: boolean; run: (fn: () => Promise<Response>, okText: string) => Promise<void>; children?: React.ReactNode;
}) {
  const [err, setErr] = useState('');
  const titleWrite = fields.title === 'write';
  const patch = async (body: object, ok: string) => { setErr(''); await run(() => fetch(`/api/tickets/${t.id}`, j(body, 'PATCH')), ok); };
  const row = (label: string, value: React.ReactNode) => <div className="kv"><dt>{label}</dt><dd>{value}</dd></div>;
  const person = (name?: string | null) => (name ? <span className="who"><Avatar name={name} size={22} />{name}</span> : <span className="note">Unassigned</span>);

  return (
    <aside className="pane tk-side" aria-label="Ticket fields">
      <h3>Details</h3>
      <div className="kv status-row"><dt>Status</dt><dd><span className="state-pill">{t.current_state}</span></dd></div>
      {children}
      <dl className="kvs">
        {row('Priority', titleWrite
          ? <select className="lc-select" aria-label="Priority" value={t.priority ?? 'Medium'} disabled={busy} onChange={(e) => patch({ priority: e.target.value }, `Priority is now ${e.target.value}.`)}>{PRIORITIES.map((p) => <option key={p}>{p}</option>)}</select>
          : <PriorityBadge p={t.priority} />)}
        {row('Assignee', fields.consultant === 'hidden' ? <span className="note">—</span> : (<span className="assignee">
          {fields.consultant === 'write' && can('ticket.assign')
            ? <select className="lc-select" aria-label="Assign consultant" value={t.consultant_id ?? ''} onChange={(e) => run(() => fetch(`/api/tickets/${t.id}/assign`, j({ consultantId: e.target.value || null })), 'Assignment updated.')}><option value="">Unassigned</option>{people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
            : person(t.consultant_name)}
          {fields.consultant === 'write' && !t.is_assigned && can('ticket.claim') && <button className="btn sm" disabled={busy} onClick={() => run(() => fetch(`/api/tickets/${t.id}/claim`, { method: 'POST' }), 'You now own this ticket.')}>Claim this ticket</button>}
        </span>))}
        {fields.consultant !== 'hidden' && row('Team', fields.consultant === 'write' && can('ticket.assign') && teamOptions.length > 0
          ? <select className="lc-select" aria-label="Assign team" value={t.team_id ?? ''} onChange={(e) => run(() => fetch(`/api/tickets/${t.id}/team`, j({ teamId: e.target.value || null })), 'Team updated.')}><option value="">No team</option>{teamOptions.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select>
          : t.team_name ? <span className="chip">{t.team_name}</span> : <span className="note">No team</span>)}
        {fields.customer !== 'hidden' && row('Reporter', person(t.customer_name ?? undefined) )}
        {row('Due date', titleWrite
          ? <input className="lc-input" type="date" aria-label="Due date" value={t.due_date?.slice(0, 10) ?? ''} disabled={busy} onChange={(e) => patch({ dueDate: e.target.value || null }, 'Due date updated.')} />
          : t.due_date ? new Date(t.due_date).toLocaleDateString() : <span className="note">None</span>)}
        {row('Type', <span><span className="type-tag">{t.type_short}</span> {t.type_name}</span>)}
        {(stacks?.length ?? 0) > 0 && row('Technology', <span className="stack-chips">{stacks!.map((s) => <span key={s} className="chip">{s}</span>)}</span>)}
        {fields.project !== 'hidden' && t.project_name && row('Project', t.project_name)}
        {row('Created', dt(t.created_at))}
        {row('Updated', dt(t.updated_at))}
      </dl>
      {err && <p role="alert" className="err">{err}</p>}
    </aside>);
}
