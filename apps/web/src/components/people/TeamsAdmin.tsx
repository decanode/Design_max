'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { motion } from 'framer-motion';
import { api, type Flash } from '../consoleBits';
import { j } from '../../lib/auth';
import { Avatar, Field, dateOnly, type MemberRow } from './shared';

type TeamRow = { id: string; name: string; description: string; lead_id: string | null; lead_name: string | null; created_at: string; members: { id: string; name: string }[]; tickets: number };

/** Teams: groups of people. Members of a team can work the tickets assigned to it. */
export function TeamsAdmin({ flash, sub, onSub }: { flash: Flash; sub: string | null; onSub: (s: string | null) => void }) {
  const [teams, setTeams] = useState<TeamRow[] | null>(null);
  const [people, setPeople] = useState<MemberRow[]>([]);
  const load = useCallback(async () => {
    try { const [t, m] = await Promise.all([api('/api/project/teams'), api('/api/project/members')]); setTeams(t); setPeople(m); } catch (e) { flash('err', (e as Error).message); }
  }, [flash]);
  useEffect(() => { load(); }, [load]);
  if (!teams) return <div className="skeleton" style={{ height: 200 }} aria-busy="true" aria-label="Loading teams" />;
  if (sub) return <TeamDetail key={sub} id={sub} teams={teams} people={people} flash={flash} back={() => onSub(null)} reload={load} open={onSub} />;
  return (
    <>
      <div className="tbl-tools"><span className="note count-note" aria-live="polite">{teams.length} {teams.length === 1 ? 'team' : 'teams'}</span><button type="button" className="btn" onClick={() => onSub('new')}>+ New team</button></div>
      <div className="data-wrap">
        <table className="data-table">
          <caption className="sr">Teams. Select a team to see and change it.</caption>
          <thead><tr><th scope="col">Team</th><th scope="col">Lead</th><th scope="col">People</th><th scope="col" style={{ textAlign: 'right' }}>Tickets</th><th scope="col">Created</th></tr></thead>
          <tbody>
            {teams.map((t) => (
              <tr key={t.id} className="clickable" onClick={() => onSub(t.id)}>
                <td><button type="button" className="person" onClick={(e) => { e.stopPropagation(); onSub(t.id); }} aria-label={`Open team ${t.name}`}><span className="team-badge" aria-hidden>{t.name[0]?.toUpperCase()}</span><span className="person-text"><b>{t.name}</b><span className="note">{t.description || 'No description'}</span></span></button></td>
                <td>{t.lead_name ?? <span className="note">—</span>}</td>
                <td><span className="avatars">{t.members.slice(0, 4).map((m) => <Avatar key={m.id} name={m.name} size={26} />)}{t.members.length > 4 && <span className="chip more">+{t.members.length - 4}</span>}</span>{t.members.length === 0 && <span className="note">Nobody yet</span>}</td>
                <td className="num">{t.tickets || <span className="note">0</span>}</td>
                <td className="note">{dateOnly(t.created_at)}</td>
              </tr>))}
            {teams.length === 0 && <tr><td colSpan={5} className="empty-row">No teams yet. Create one to group people and assign tickets to them.</td></tr>}
          </tbody>
        </table>
      </div>
    </>);
}

function TeamDetail({ id, teams, people, flash, back, reload, open }: { id: string; teams: TeamRow[]; people: MemberRow[]; flash: Flash; back: () => void; reload: () => Promise<void>; open: (id: string | null) => void }) {
  const isNew = id === 'new';
  const team = teams.find((t) => t.id === id);
  const start = useMemo(() => ({ name: team?.name ?? '', description: team?.description ?? '', leadId: team?.lead_id ?? '', memberIds: team?.members.map((m) => m.id) ?? [] }), [team]);
  const [f, setF] = useState(start);
  const [q, setQ] = useState('');
  const [err, setErr] = useState('');
  const [nameErr, setNameErr] = useState('');
  const [busy, setBusy] = useState(false);
  const dirty = JSON.stringify(f) !== JSON.stringify(start);
  if (!isNew && !team) return <div className="pane" style={{ padding: 20 }}><p>That team no longer exists.</p><button className="btn ghost" onClick={back}>Back to teams</button></div>;
  const shown = people.filter((p) => !q.trim() || [p.name, p.email, p.job_title].some((v) => v?.toLowerCase().includes(q.trim().toLowerCase())));
  const leave = () => { if (!dirty || confirm('Discard your changes?')) back(); };

  async function save(e: React.FormEvent) {
    e.preventDefault(); setErr(''); setNameErr('');
    if (!f.name.trim()) { setNameErr('Give the team a name'); return; }
    setBusy(true);
    try {
      const body = { name: f.name, description: f.description, leadId: f.leadId || null, memberIds: f.memberIds };
      if (isNew) { const r = await api('/api/project/teams', j(body)); flash('ok', `Team “${f.name.trim()}” was created.`); await reload(); open(r.id); }
      else { await api(`/api/project/teams/${id}`, j(body, 'PUT')); flash('ok', `Team “${f.name.trim()}” was saved.`); await reload(); }
    } catch (er) { const m = (er as Error).message; if (/name/i.test(m)) setNameErr(m); setErr(m); } finally { setBusy(false); }
  }
  async function remove() {
    if (!team || !confirm(`Delete the team “${team.name}”? ${team.tickets ? `${team.tickets} ticket${team.tickets > 1 ? 's' : ''} assigned to it will have no team. ` : ''}People stay in the project.`)) return;
    try { await api(`/api/project/teams/${id}`, { method: 'DELETE' }); flash('ok', `Team “${team.name}” was deleted.`); await reload(); back(); } catch (e) { setErr((e as Error).message); }
  }

  return (
    <motion.form onSubmit={save} noValidate className="drill" aria-label={isNew ? 'New team' : `Team ${team!.name}`} initial={{ opacity: 0, x: 18 }} animate={{ opacity: 1, x: 0 }} transition={{ duration: 0.16 }}>
      <nav className="crumbs" aria-label="Breadcrumb"><button type="button" className="linklike" onClick={leave}>Teams</button><span aria-hidden> › </span><span aria-current="page">{isNew ? 'New team' : team!.name}</span></nav>
      {err && <p role="alert" className="err banner">{err}</p>}
      <div className="drill-grid">
        <section className="pane drill-card" aria-labelledby="t-main">
          <h4 id="t-main">Team</h4>
          <Field id="t-name" label="Name" required error={nameErr}><input id="t-name" value={f.name} maxLength={80} aria-invalid={!!nameErr} onChange={(e) => { setF({ ...f, name: e.target.value }); setNameErr(''); }} /></Field>
          <Field id="t-desc" label="Description"><input id="t-desc" value={f.description} maxLength={300} onChange={(e) => setF({ ...f, description: e.target.value })} /></Field>
          <Field id="t-lead" label="Team lead" hint="The lead is always a member of the team.">
            <select id="t-lead" value={f.leadId} onChange={(e) => setF({ ...f, leadId: e.target.value, memberIds: e.target.value && !f.memberIds.includes(e.target.value) ? [...f.memberIds, e.target.value] : f.memberIds })}>
              <option value="">No lead</option>{people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
          </Field>
          {!isNew && <p className="note">{team!.tickets} ticket{team!.tickets === 1 ? '' : 's'} assigned to this team.</p>}
        </section>
        <section className="pane drill-card" aria-labelledby="t-people">
          <h4 id="t-people">People <span className="note">{f.memberIds.length} selected</span></h4>
          <div className="search-wrap"><label className="sr" htmlFor="t-q">Find people</label><input id="t-q" type="search" placeholder="Find people…" value={q} onChange={(e) => setQ(e.target.value)} /></div>
          <div className="people-pick" role="group" aria-label="Team members">
            {shown.map((p) => (
              <label key={p.id} className={`person-check ${f.memberIds.includes(p.id) ? 'on' : ''}`}>
                <input type="checkbox" checked={f.memberIds.includes(p.id)} onChange={(e) => setF({ ...f, memberIds: e.target.checked ? [...f.memberIds, p.id] : f.memberIds.filter((x) => x !== p.id), leadId: !e.target.checked && f.leadId === p.id ? '' : f.leadId })} />
                <Avatar name={p.name} size={28} /><span className="person-text"><b>{p.name}</b><span className="note">{p.job_title ?? p.role}</span></span></label>))}
            {shown.length === 0 && <p className="note">Nobody matches.</p>}
          </div>
        </section>
      </div>
      {!isNew && <section className="danger-zone" aria-label="Delete team"><div><b>Delete this team</b><p className="note" style={{ margin: 0 }}>Tickets keep existing; they just stop belonging to the team.</p></div><button type="button" className="btn ghost danger" onClick={remove}>Delete team</button></section>}
      <div className="tb-bar drill-bar" role="region" aria-label="Save changes">
        <span className="note">{isNew ? 'The team is created when you save.' : dirty ? 'You have unsaved changes.' : 'No changes.'}</span>
        <button type="button" className="btn ghost" onClick={leave} disabled={busy}>{isNew ? 'Cancel' : 'Back to teams'}</button>
        <button className="btn" disabled={busy || (!isNew && !dirty)}>{busy ? 'Saving…' : isNew ? 'Create team' : 'Save changes'}</button>
      </div>
    </motion.form>);
}
