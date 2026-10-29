'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { motion } from 'framer-motion';
import { api, type Flash } from '../consoleBits';
import { j, useAuth } from '../../lib/auth';
import { Avatar, Field, dateOnly } from '../people/shared';

type Membership = { id: string; name: string; role: string; archived?: boolean };
type PUser = { id: string; email: string; name: string; active: boolean; isSuperAdmin: boolean; created_at: string; projects: Membership[] };
type Facets = { counts: { all: number; active: number; inactive: number; super: number; noProject: number }; projects: { id: string; name: string; status: string; users: number }[] };
type Scope = 'all' | 'super' | 'none' | string;   // a project id when it is none of the others
const PAGE = 25;

/** Platform → Users: browse by project (or by kind), search, filter and page on the server, then open one person's page. */
export function UsersAdmin({ flash, sub, onSub }: { flash: Flash; sub: string | null; onSub: (s: string | null) => void }) {
  const [scope, setScope] = useState<Scope>('all');
  const [q, setQ] = useState(''); const [status, setStatus] = useState<'all' | 'active' | 'inactive'>('all');
  const [sort, setSort] = useState<'name' | 'newest' | 'projects'>('name');
  const [page, setPage] = useState(1);
  const [data, setData] = useState<{ rows: PUser[]; total: number } | null>(null);
  const [facets, setFacets] = useState<Facets | null>(null);
  const [version, setVersion] = useState(0);
  const refresh = useCallback(() => setVersion((v) => v + 1), []);

  useEffect(() => { api('/api/platform/users/facets').then(setFacets).catch((e) => flash('err', e.message)); }, [version, flash]);
  useEffect(() => {
    const t = setTimeout(() => {
      const p = new URLSearchParams({ status, sort, page: String(page), pageSize: String(PAGE) });
      if (q.trim()) p.set('q', q.trim());
      if (scope !== 'all') p.set('project', scope);
      api(`/api/platform/users/search?${p}`).then(setData).catch((e) => flash('err', e.message));
    }, q ? 250 : 0);
    return () => clearTimeout(t);
  }, [q, status, sort, page, scope, version, flash]);
  useEffect(() => { setPage(1); }, [q, status, sort, scope]);

  if (sub === 'new') return <NewUser flash={flash} back={() => onSub(null)} done={() => { refresh(); onSub(null); }} />;
  if (sub) return <UserPage key={sub} id={sub} flash={flash} back={() => onSub(null)} changed={refresh} />;
  return <UserBrowser {...{ scope, setScope, q, setQ, status, setStatus, sort, setSort, page, setPage, data, facets }} open={onSub} />;
}

function UserBrowser({ scope, setScope, q, setQ, status, setStatus, sort, setSort, page, setPage, data, facets, open }: {
  scope: Scope; setScope: (s: Scope) => void; q: string; setQ: (s: string) => void; status: 'all' | 'active' | 'inactive'; setStatus: (s: 'all' | 'active' | 'inactive') => void;
  sort: 'name' | 'newest' | 'projects'; setSort: (s: 'name' | 'newest' | 'projects') => void; page: number; setPage: (n: number) => void;
  data: { rows: PUser[]; total: number } | null; facets: Facets | null; open: (id: string | null) => void;
}) {
  const { me } = useAuth();
  const [pq, setPq] = useState('');
  const c = facets?.counts;
  const projects = useMemo(() => (facets?.projects ?? []).filter((p) => !pq.trim() || p.name.toLowerCase().includes(pq.trim().toLowerCase())), [facets, pq]);
  const scopeName = scope === 'all' ? 'All users' : scope === 'super' ? 'Super Admins' : scope === 'none' ? 'Not in any project' : facets?.projects.find((p) => p.id === scope)?.name ?? 'Project';
  const pages = data ? Math.max(1, Math.ceil(data.total / PAGE)) : 1;
  const item = (key: Scope, label: string, n?: number) => (
    <li key={key}><button type="button" className={`rail-item scope ${scope === key ? 'on' : ''}`} aria-pressed={scope === key} onClick={() => setScope(key)}><span>{label}</span>{n !== undefined && <span className="count">{n.toLocaleString()}</span>}</button></li>);

  return (
    <div className="users-layout">
      <aside className="pane users-rail" aria-label="Browse users">
        <h4>Browse</h4>
        <ul>{item('all', 'All users', c?.all)}{item('super', 'Super Admins', c?.super)}{item('none', 'Not in any project', c?.noProject)}</ul>
        <h4>By project</h4>
        <div className="search-wrap"><label className="sr" htmlFor="up-q">Find a project</label><input id="up-q" type="search" placeholder="Find a project…" value={pq} onChange={(e) => setPq(e.target.value)} /></div>
        <ul className="users-projects">
          {projects.map((p) => item(p.id, p.status === 'archived' ? `${p.name} (archived)` : p.name, p.users))}
          {facets && projects.length === 0 && <li className="note" style={{ padding: 8 }}>No project matches.</li>}
        </ul>
      </aside>

      <section aria-label="Users" className="users-main">
        <div className="tbl-tools">
          <div className="search-wrap"><label className="sr" htmlFor="u-q">Search users</label><input id="u-q" type="search" placeholder="Search by name or email…" value={q} onChange={(e) => setQ(e.target.value)} /></div>
          <label className="sr" htmlFor="u-status">Status</label>
          <select id="u-status" className="lc-select" style={{ width: 'auto' }} value={status} onChange={(e) => setStatus(e.target.value as typeof status)}>
            <option value="all">Active and inactive</option><option value="active">Active only{c ? ` (${c.active.toLocaleString()})` : ''}</option><option value="inactive">Inactive only{c ? ` (${c.inactive.toLocaleString()})` : ''}</option></select>
          <label className="sr" htmlFor="u-sort">Sort by</label>
          <select id="u-sort" className="lc-select" style={{ width: 'auto' }} value={sort} onChange={(e) => setSort(e.target.value as typeof sort)}>
            <option value="name">Name A–Z</option><option value="newest">Newest first</option><option value="projects">Most projects</option></select>
          <button type="button" className="btn" style={{ marginLeft: 'auto' }} onClick={() => open('new')}>+ New user</button>
        </div>
        <p className="users-scope" aria-live="polite"><b>{scopeName}</b><span className="note"> · {data ? `${data.total.toLocaleString()} ${data.total === 1 ? 'person' : 'people'}` : 'Loading…'}{(q || status !== 'all') ? ' match your filters' : ''}</span>
          {scope !== 'all' && <button type="button" className="linklike" onClick={() => setScope('all')}>Show everyone</button>}</p>
        <div className="data-wrap">
          <table className="data-table">
            <caption className="sr">Users. Select a person to see and change their account.</caption>
            <thead><tr><th scope="col">User</th><th scope="col">{scope !== 'all' && scope !== 'super' && scope !== 'none' ? 'Role here · other projects' : 'Projects and roles'}</th><th scope="col">Status</th><th scope="col">Added</th></tr></thead>
            <tbody>
              {data?.rows.map((u) => {
                const here = u.projects.find((p) => p.id === scope); const rest = u.projects.filter((p) => p.id !== scope);
                const show = here ? [here, ...rest] : u.projects;
                return (
                  <tr key={u.id} className={`clickable ${u.active ? '' : 'inactive'}`} onClick={() => open(u.id)}>
                    <td><button type="button" className="person" onClick={(e) => { e.stopPropagation(); open(u.id); }} aria-label={`Open user ${u.name}`}>
                      <Avatar name={u.name} size={34} /><span className="person-text"><b>{u.name}{u.id === me?.user.id && <span className="note"> (you)</span>}</b><span className="note">{u.email}</span></span></button></td>
                    <td>{u.isSuperAdmin && <span className="role-badge" data-role="Super Admin" style={{ marginRight: 6 }}>Super Admin</span>}
                      {show.length ? <span className="chips">{show.slice(0, 2).map((p) => <span key={p.id} className={`chip ${p.id === scope ? 'here' : ''}`}>{p.name} · {p.role}</span>)}
                        {show.length > 2 && <span className="chip more" title={show.slice(2).map((p) => `${p.name} · ${p.role}`).join('\n')}>+{show.length - 2}</span>}</span> : !u.isSuperAdmin && <span className="note">No project</span>}</td>
                    <td><span className={`status ${u.active ? 'ok' : 'off'}`}>{u.active ? 'Active' : 'Inactive'}</span></td>
                    <td className="note">{dateOnly(u.created_at)}</td>
                  </tr>);
              })}
              {data && data.rows.length === 0 && <tr><td colSpan={4} className="empty-row">No user matches. Try a different search or filter.</td></tr>}
              {!data && <tr><td colSpan={4}><div className="skeleton" style={{ height: 120 }} aria-busy="true" /></td></tr>}
            </tbody>
          </table>
        </div>
        {data && data.total > PAGE && (
          <nav className="pager" aria-label="Pages">
            <span className="note">Showing {((page - 1) * PAGE + 1).toLocaleString()}–{Math.min(page * PAGE, data.total).toLocaleString()} of {data.total.toLocaleString()}</span>
            <button type="button" className="btn ghost sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>← Previous</button>
            <span className="note">Page {page} of {pages.toLocaleString()}</span>
            <button type="button" className="btn ghost sm" disabled={page >= pages} onClick={() => setPage(page + 1)}>Next →</button>
          </nav>)}
      </section>
    </div>);
}

function UserPage({ id, flash, back, changed }: { id: string; flash: Flash; back: () => void; changed: () => void }) {
  const { me } = useAuth();
  const [u, setU] = useState<PUser | null | undefined>(undefined);
  const load = useCallback(async () => { setU(await api(`/api/platform/users/${id}`).catch(() => null)); }, [id]);
  useEffect(() => { load(); }, [load]);
  if (u === undefined) return <div className="skeleton" style={{ height: 200 }} aria-busy="true" aria-label="Loading user" />;
  if (!u) return <div className="pane" style={{ padding: 20 }}><p>That user no longer exists.</p><button className="btn ghost" onClick={back}>Back to users</button></div>;
  const self = u.id === me?.user.id;

  async function patch(body: object, ok: string) {
    try { await api(`/api/platform/users/${u!.id}`, j(body, 'PATCH')); flash('ok', ok); await load(); changed(); } catch (e) { flash('err', (e as Error).message); await load(); }
  }
  return (
    <motion.div className="drill" role="region" aria-label={`User ${u.name}`} initial={{ opacity: 0, x: 18 }} animate={{ opacity: 1, x: 0 }} transition={{ duration: 0.16 }}>
      <nav className="crumbs" aria-label="Breadcrumb"><button type="button" className="linklike" onClick={back}>Users</button><span aria-hidden> › </span><span aria-current="page">{u.name}</span></nav>
      <div className="drill-head">
        <Avatar name={u.name} size={56} />
        <div className="drill-title"><h4>{u.name}{self && <span className="note"> (you)</span>}</h4><p className="note">{u.email} · added {dateOnly(u.created_at)}</p></div>
        <div className="drill-badges">{u.isSuperAdmin && <span className="role-badge" data-role="Super Admin">Super Admin</span>}<span className={`status ${u.active ? 'ok' : 'off'}`}>{u.active ? 'Active' : 'Inactive'}</span></div>
      </div>
      <div className="drill-grid">
        <section className="pane drill-card" aria-labelledby="ua-acc">
          <h4 id="ua-acc">Account</h4>
          <label className="ds-rule"><span className="ds-rule-text"><b>Active</b><span className="note">An inactive person cannot sign in anywhere. Their history stays.</span></span>
            <span className="switch"><input type="checkbox" role="switch" aria-label={`${u.name} is active`} checked={u.active} onChange={(e) => patch({ active: e.target.checked }, `${u.name} ${e.target.checked ? 'reactivated' : 'deactivated'}.`)} /><span className="track" aria-hidden /></span></label>
          <label className="ds-rule"><span className="ds-rule-text"><b>Super Admin</b><span className="note">Runs the whole platform: every project, role and setting. Give it sparingly.</span></span>
            <span className="switch"><input type="checkbox" role="switch" aria-label={`${u.name} is a Super Admin`} checked={u.isSuperAdmin} onChange={(e) => patch({ isSuperAdmin: e.target.checked }, `${u.name} ${e.target.checked ? 'is now' : 'is no longer'} a Super Admin.`)} /><span className="track" aria-hidden /></span></label>
        </section>
        <section className="pane drill-card" aria-labelledby="ua-proj">
          <h4 id="ua-proj">Projects and roles <span className="note">{u.projects.length}</span></h4>
          {u.projects.length === 0 ? <p className="note">Not in any project. A Project Admin adds people from that project’s Members page.</p> : (
            <ul className="pj-admins">{u.projects.map((p) => (
              <li key={p.id}><span className="team-badge" aria-hidden>{p.name[0]?.toUpperCase()}</span><span className="person-text"><b>{p.name}</b><span className="note">{p.archived ? 'Archived project' : 'Active project'}</span></span><span className="role-pill" data-role={p.role} style={{ marginLeft: 'auto' }}>{p.role}</span></li>))}</ul>)}
        </section>
      </div>
    </motion.div>);
}

function NewUser({ flash, back, done }: { flash: Flash; back: () => void; done: () => void }) {
  const [f, setF] = useState({ email: '', name: '', isSuperAdmin: false });
  const [busy, setBusy] = useState(false);
  const dirty = !!(f.email || f.name || f.isSuperAdmin);
  const leave = () => { if (!dirty || confirm('Discard this new user?')) back(); };
  async function create(e: React.FormEvent) {
    e.preventDefault(); setBusy(true);
    try { await api('/api/platform/users', j(f)); flash('ok', `Created ${f.name}. Add them to a project from that project's settings.`); done(); } catch (er) { flash('err', (er as Error).message); } finally { setBusy(false); }
  }
  return (
    <motion.form onSubmit={create} className="drill" aria-label="Create a user" initial={{ opacity: 0, x: 18 }} animate={{ opacity: 1, x: 0 }} transition={{ duration: 0.16 }}>
      <nav className="crumbs" aria-label="Breadcrumb"><button type="button" className="linklike" onClick={leave}>Users</button><span aria-hidden> › </span><span aria-current="page">New user</span></nav>
      <section className="pane drill-card narrow" aria-labelledby="nu">
        <h4 id="nu">New user</h4>
        <Field id="un" label="Name" required><input id="un" className="lc-input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required maxLength={80} /></Field>
        <Field id="ue" label="Email" required hint="They sign in with this address."><input id="ue" className="lc-input" type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} required /></Field>
        <label className="ds-rule"><span className="ds-rule-text"><b>Super Admin</b><span className="note">Runs the whole platform. Leave off for normal people.</span></span>
          <span className="switch"><input type="checkbox" role="switch" aria-label="Super Admin" checked={f.isSuperAdmin} onChange={(e) => setF({ ...f, isSuperAdmin: e.target.checked })} /><span className="track" aria-hidden /></span></label>
        <p className="note">A new account can reach nothing until a Project Admin adds them to a project.</p>
      </section>
      <div className="tb-bar drill-bar" role="region" aria-label="Create user">
        <button type="button" className="btn ghost" onClick={leave} disabled={busy}>Cancel</button>
        <button className="btn" type="submit" disabled={busy || !f.name.trim() || !f.email.trim()}>{busy ? 'Creating…' : 'Create user'}</button>
      </div>
    </motion.form>);
}
