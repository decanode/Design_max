'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { motion } from 'framer-motion';
import { api, type Flash } from '../consoleBits';
import { j, useAuth } from '../../lib/auth';
import { Avatar, Field } from '../people/shared';
import { MODE_LIST, modeName, type Mode } from '../../lib/modes';
import { ModeCards, OverrideSwitches } from './ModeCards';

export type Project = { id: string; name: string; operatingMode: Mode; modeOverrides: Record<string, boolean>; status: 'active' | 'archived'; members: number; tickets: number; admins: { id: string; name: string; canCreateRoles?: boolean }[]; stacks: string[] };
type Stack = { id: number; name: string };
type Catalog = { projectTypes: { id: number; key: string; name: string; description?: string; defaultTemplateId: number | null }[]; templates: { id: number; name: string; description?: string }[] };

/** Platform → Projects: a searchable list, then one page per project (and one for creating a project). */
export function ProjectsAdmin({ flash, sub, onSub }: { flash: Flash; sub: string | null; onSub: (s: string | null) => void }) {
  const [list, setList] = useState<Project[] | null>(null);
  const load = useCallback(async () => { try { setList(await api('/api/platform/projects')); } catch (e) { flash('err', (e as Error).message); } }, [flash]);
  useEffect(() => { load(); }, [load]);
  if (!list) return <div className="skeleton" style={{ height: 220 }} aria-busy="true" aria-label="Loading projects" />;
  if (sub === 'new') return <NewProject flash={flash} back={() => onSub(null)} done={async () => { await load(); onSub(null); }} />;
  if (sub) return <ProjectPage key={sub} id={sub} list={list} flash={flash} back={() => onSub(null)} reload={load} />;
  return <ProjectList list={list} open={onSub} />;
}

function ProjectList({ list, open }: { list: Project[]; open: (id: string | null) => void }) {
  const { switchProject, me } = useAuth();
  const [q, setQ] = useState('');
  const [show, setShow] = useState<'active' | 'archived' | 'all'>('active');
  const shown = useMemo(() => list.filter((p) => (show === 'all' || p.status === show) && (!q.trim() || [p.name, ...p.admins.map((a) => a.name)].some((v) => v.toLowerCase().includes(q.trim().toLowerCase())))), [list, q, show]);
  const archived = list.filter((p) => p.status === 'archived').length;
  return (
    <>
      <div className="tbl-tools">
        <div className="search-wrap"><label className="sr" htmlFor="pj-q">Find a project</label><input id="pj-q" type="search" placeholder="Find a project or admin…" value={q} onChange={(e) => setQ(e.target.value)} /></div>
        <label className="sr" htmlFor="pj-show">Show</label>
        <select id="pj-show" className="lc-select" style={{ width: 'auto' }} value={show} onChange={(e) => setShow(e.target.value as typeof show)}>
          <option value="active">Active projects</option><option value="archived">Archived ({archived})</option><option value="all">All projects</option></select>
        <span className="note count-note" aria-live="polite">{shown.length} {shown.length === 1 ? 'project' : 'projects'}</span>
        <button type="button" className="btn" style={{ marginLeft: 'auto' }} onClick={() => open('new')}>+ New project</button>
      </div>
      <div className="data-wrap">
        <table className="data-table">
          <caption className="sr">Projects. Select a project to see and change it.</caption>
          <thead><tr><th scope="col">Project</th><th scope="col">Mode</th><th scope="col">Project Admins</th><th scope="col" style={{ textAlign: 'right' }}>Members</th><th scope="col" style={{ textAlign: 'right' }}>Tickets</th><th scope="col">Technology</th><th scope="col"><span className="sr">Actions</span></th></tr></thead>
          <tbody>
            {shown.map((p) => (
              <tr key={p.id} className={`clickable ${p.status === 'archived' ? 'inactive' : ''}`} onClick={() => open(p.id)}>
                <td><button type="button" className="person" onClick={(e) => { e.stopPropagation(); open(p.id); }} aria-label={`Open project ${p.name}`}>
                  <span className="team-badge" aria-hidden>{p.name[0]?.toUpperCase()}</span>
                  <span className="person-text"><b>{p.name}</b><span className="note">{p.status === 'archived' ? 'Archived' : me?.project?.id === p.id ? 'You are working here' : 'Active'}</span></span></button></td>
                <td><span className={`mode-chip ${p.operatingMode}`}>{modeName(p.operatingMode)}</span></td>
                <td>{p.admins.length ? <span className="chips">{p.admins.slice(0, 2).map((a) => <span key={a.id} className="chip">{a.name}</span>)}{p.admins.length > 2 && <span className="chip more">+{p.admins.length - 2}</span>}</span> : <span className="err">none yet</span>}</td>
                <td className="num">{p.members}</td><td className="num">{p.tickets}</td>
                <td>{p.stacks.length ? <span className="chips">{p.stacks.map((s) => <span key={s} className="chip">{s}</span>)}</span> : <span className="note">Any</span>}</td>
                <td style={{ textAlign: 'right' }}>
                  {p.status === 'active' && me?.project?.id !== p.id && <button type="button" className="btn ghost sm" onClick={(e) => { e.stopPropagation(); switchProject(p.id); }} aria-label={`Switch to ${p.name}`}>Switch to</button>}
                  {p.status === 'active' && me?.project?.id === p.id && <span className="role-badge" data-role="Manager">Working here</span>}
                </td>
              </tr>))}
            {shown.length === 0 && <tr><td colSpan={7} className="empty-row">{list.length === 0 ? 'No projects yet. Create the first one.' : 'No project matches.'}</td></tr>}
          </tbody>
        </table>
      </div>
    </>);
}

function ProjectPage({ id, list, flash, back, reload }: { id: string; list: Project[]; flash: Flash; back: () => void; reload: () => Promise<void> }) {
  const { switchProject, me } = useAuth();
  const p = list.find((x) => x.id === id);
  const [a, setA] = useState({ email: '', name: '' });
  if (!p) return <div className="pane" style={{ padding: 20 }}><p>That project no longer exists.</p><button className="btn ghost" onClick={back}>Back to projects</button></div>;
  const here = me?.project?.id === p.id;

  async function appoint(e: React.FormEvent) {
    e.preventDefault(); if (!a.email) return;
    try { const r = await api(`/api/platform/projects/${p!.id}/admins`, j({ email: a.email, name: a.name || undefined })); flash('ok', `${a.email} is now a Project Admin of ${p!.name}${r.created ? ' (new account created)' : ''}.`); setA({ email: '', name: '' }); reload(); }
    catch (er) { flash('err', (er as Error).message); }
  }
  async function allowRoles(userId: string, name: string, enabled: boolean) {
    try { await api(`/api/platform/projects/${p!.id}/admins/${userId}/role-creation`, j({ enabled }, 'PUT')); flash('ok', enabled ? `${name} can now create roles in ${p!.name}.` : `${name} can no longer create roles in ${p!.name}.`); reload(); }
    catch (er) { flash('err', (er as Error).message); }
  }
  async function setStatus(status: 'active' | 'archived') {
    if (status === 'archived' && !confirm(`Archive “${p!.name}”? Everyone loses access to it at once. Nothing is deleted, and you can restore it.`)) return;
    try { await api(`/api/platform/projects/${p!.id}`, j({ status }, 'PATCH')); flash('ok', `${p!.name} is now ${status}.`); reload(); } catch (er) { flash('err', (er as Error).message); }
  }

  return (
    <motion.div className="drill" aria-label={`Project ${p.name}`} role="region" initial={{ opacity: 0, x: 18 }} animate={{ opacity: 1, x: 0 }} transition={{ duration: 0.16 }}>
      <nav className="crumbs" aria-label="Breadcrumb"><button type="button" className="linklike" onClick={back}>Projects</button><span aria-hidden> › </span><span aria-current="page">{p.name}</span></nav>
      <div className="drill-head">
        <span className="team-badge big" aria-hidden>{p.name[0]?.toUpperCase()}</span>
        <div className="drill-title"><h4>{p.name}</h4><p className="note">{p.status === 'archived' ? 'Archived: nobody can open it' : here ? 'You are working in this project' : 'Active'}</p></div>
        <div className="drill-badges">
          {p.status === 'active' && !here && <button type="button" className="btn" onClick={() => switchProject(p.id)}>Open project</button>}
          {p.status === 'active' && here && <span className="role-badge" data-role="Manager">Working here</span>}
        </div>
      </div>

      <div className="pj-stats" aria-label="Project at a glance">
        <div><b>{p.members}</b><span className="note">member{p.members === 1 ? '' : 's'}</span></div>
        <div><b>{p.tickets}</b><span className="note">ticket{p.tickets === 1 ? '' : 's'}</span></div>
        <div><b>{p.admins.length}</b><span className="note">Project Admin{p.admins.length === 1 ? '' : 's'}</span></div>
        <div className="pj-tech"><span className="note">Technology</span>{p.stacks.length ? <span className="chips">{p.stacks.map((s) => <span key={s} className="chip">{s}</span>)}</span> : <span>Any technology</span>}</div>
      </div>

      <ModeSection p={p} flash={flash} reload={reload} />

      <div className="drill-grid">
        <section className="pane drill-card" aria-labelledby="pj-admins">
          <h4 id="pj-admins">Project Admins</h4>
          {p.admins.length === 0 && <p className="err">This project has no admin yet. Appoint one below.</p>}
          <ul className="pj-admins">
            {p.admins.map((x) => (
              <li key={x.id}>
                <Avatar name={x.name} size={32} /><span className="person-text"><b>{x.name}</b><span className="note">May create roles of their own</span></span>
                <label className="switch"><input type="checkbox" role="switch" aria-label={`${x.name} may create roles in ${p.name}`} checked={!!x.canCreateRoles} onChange={(e) => allowRoles(x.id, x.name, e.target.checked)} /><span className="track" aria-hidden /></label>
              </li>))}
          </ul>
        </section>
        {p.status === 'active' && (
          <form className="pane drill-card" onSubmit={appoint} aria-labelledby="pj-appoint">
            <h4 id="pj-appoint">Appoint a Project Admin</h4>
            <Field id="ae" label={`Appoint a Project Admin for ${p.name}`} hint="Their email. If they have no account yet, one is created."><input id="ae" className="lc-input" type="email" placeholder="name@company.com" value={a.email} onChange={(e) => setA({ ...a, email: e.target.value })} /></Field>
            <Field id="an" label="Name (if new)"><input id="an" className="lc-input" value={a.name} onChange={(e) => setA({ ...a, name: e.target.value })} /></Field>
            <button className="btn" type="submit" disabled={!a.email}>Appoint</button>
          </form>)}
      </div>

      <section className="danger-zone" aria-label={p.status === 'active' ? 'Archive project' : 'Restore project'}>
        <div><b>{p.status === 'active' ? 'Archive this project' : 'Restore this project'}</b><p className="note" style={{ margin: 0 }}>{p.status === 'active' ? 'Everyone loses access at once. Nothing is deleted and you can restore it later.' : 'Everyone who had access gets it back.'}</p></div>
        <button type="button" className={p.status === 'active' ? 'btn danger' : 'btn'} onClick={() => setStatus(p.status === 'active' ? 'archived' : 'active')}>{p.status === 'active' ? 'Archive' : 'Restore'}</button>
      </section>
    </motion.div>);
}

function NewProject({ flash, back, done }: { flash: Flash; back: () => void; done: () => Promise<void> }) {
  const [stacks, setStacks] = useState<Stack[]>([]);
  const [cat, setCat] = useState<Catalog | null>(null);
  const [f, setF] = useState({ name: '', email: '', adminName: '', stackIds: [] as number[], projectTypeId: 0, templateTypeId: 0, operatingMode: 'full' as Mode });
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    Promise.all([api('/api/platform/stacks'), api('/api/platform/workflow/catalog')]).then(([s, c]) => { setStacks(s); setCat(c); setF((x) => (x.projectTypeId ? x : { ...x, projectTypeId: c.projectTypes[0]?.id ?? 0 })); }).catch((e) => flash('err', e.message));
  }, [flash]);
  const dirty = !!(f.name || f.email || f.adminName || f.stackIds.length);
  const leave = () => { if (!dirty || confirm('Discard this new project?')) back(); };
  const type = cat?.projectTypes.find((t) => t.id === f.projectTypeId);
  const recommended = cat?.templates.find((t) => t.id === type?.defaultTemplateId)?.name ?? '—';

  async function create(e: React.FormEvent) {
    e.preventDefault(); setBusy(true);
    try {
      await api('/api/platform/projects', j({ name: f.name, stackIds: f.stackIds, projectTypeId: f.projectTypeId || undefined, templateTypeId: f.templateTypeId || undefined, operatingMode: f.operatingMode, admin: f.email ? { email: f.email, name: f.adminName || f.email.split('@')[0] } : undefined }));
      flash('ok', `Project “${f.name}” created${f.email ? ` and ${f.email} appointed Project Admin` : ''}. It starts with its own copy of the standard approval workflow.`);
      await done();
    } catch (er) { flash('err', (er as Error).message); } finally { setBusy(false); }
  }
  return (
    <motion.form onSubmit={create} className="drill" aria-label="Create a project" initial={{ opacity: 0, x: 18 }} animate={{ opacity: 1, x: 0 }} transition={{ duration: 0.16 }}>
      <nav className="crumbs" aria-label="Breadcrumb"><button type="button" className="linklike" onClick={leave}>Projects</button><span aria-hidden> › </span><span aria-current="page">New project</span></nav>
      <div className="drill-grid">
        <section className="pane drill-card" aria-labelledby="np-main">
          <h4 id="np-main">1 · The project</h4>
          <Field id="pn" label="Project name" required><input id="pn" className="lc-input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required minLength={2} maxLength={80} /></Field>
          <h4 style={{ marginTop: 18 }}>2 · First Project Admin <span className="note">(optional)</span></h4>
          <Field id="pe" label="Project Admin email" hint="Appointed as the project's admin. If they have no account yet, one is created."><input id="pe" className="lc-input" type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></Field>
          <Field id="pa" label="Project Admin name" hint="Only needed for a new account."><input id="pa" className="lc-input" value={f.adminName} onChange={(e) => setF({ ...f, adminName: e.target.value })} /></Field>
        </section>
        <section className="pane drill-card" aria-labelledby="np-flow">
          <h4 id="np-flow">3 · How the work flows</h4>
          {cat && (<>
            <Field id="ppt" label="Project type" hint={type?.description}>
              <select id="ppt" className="lc-select" value={f.projectTypeId} onChange={(e) => setF({ ...f, projectTypeId: Number(e.target.value), templateTypeId: 0 })}>{cat.projectTypes.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select></Field>
            <Field id="ptt" label="Methodology" hint="Phases and ticket types start from this; the Project Admin can fine-tune them in Project settings.">
              <select id="ptt" className="lc-select" value={f.templateTypeId} onChange={(e) => setF({ ...f, templateTypeId: Number(e.target.value) })}>
                <option value={0}>Recommended for the project type ({recommended})</option>{cat.templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select></Field>
          </>)}
          <h4 style={{ marginTop: 18 }}>4 · Allowed technology <span className="note">(optional)</span></h4>
          <p className="note" style={{ marginTop: 0 }}>Leave empty for no restriction. The Project Admin can change it later.</p>
          <div className="pj-stacks" role="group" aria-label="Allowed technology">
            {stacks.map((s) => (
              <label key={s.id} className={`person-check ${f.stackIds.includes(s.id) ? 'on' : ''}`}>
                <input type="checkbox" checked={f.stackIds.includes(s.id)} onChange={(e) => setF({ ...f, stackIds: e.target.checked ? [...f.stackIds, s.id] : f.stackIds.filter((x) => x !== s.id) })} /><b>{s.name}</b></label>))}
          </div>
        </section>
      </div>
      <section className="pane drill-card" aria-labelledby="np-mode" style={{ marginTop: 14 }}>
        <h4 id="np-mode">5 · How much of the lifecycle runs here?</h4>
        <p className="note" style={{ marginTop: 0 }}>You can change this later. Nothing is deleted when you do.</p>
        <ModeCards value={f.operatingMode} onChange={(m) => setF({ ...f, operatingMode: m })} />
      </section>
      <div className="tb-bar drill-bar" role="region" aria-label="Create project">
        <span className="note">The project is created when you press Create project.</span>
        <button type="button" className="btn ghost" onClick={leave} disabled={busy}>Cancel</button>
        <button className="btn" type="submit" disabled={busy || f.name.trim().length < 2}>{busy ? 'Creating…' : 'Create project'}</button>
      </div>
    </motion.form>);
}

/** The project's operating mode: pick it, see exactly what changes, confirm, and adjust the few things that may differ. */
function ModeSection({ p, flash, reload }: { p: Project; flash: Flash; reload: () => Promise<void> }) {
  const [pick, setPick] = useState<Mode>(p.operatingMode);
  const [busy, setBusy] = useState(false);
  useEffect(() => { setPick(p.operatingMode); }, [p.operatingMode]);
  const cur = MODE_LIST.find((m) => m.key === p.operatingMode)!, next = MODE_LIST.find((m) => m.key === pick)!;
  const caps = { closing_gates: pick !== 'mirror', customer_signoff: pick !== 'mirror', planning_convert: pick === 'full', ...p.modeOverrides };

  async function apply() {
    const lines = [`Change ${p.name} from ${cur.name} to ${next.name}?`, '', 'Nothing is deleted.', ...(next.limits.length ? ['', 'From now on:', ...next.limits.map((l) => `• ${l}`)] : [])];
    if (p.operatingMode === 'connected') lines.push('', 'Anything still waiting to be sent back to the source tool is cancelled.');
    if (!confirm(lines.join('\n'))) return;
    setBusy(true);
    try { await api(`/api/platform/projects/${p.id}`, j({ operatingMode: pick }, 'PATCH')); flash('ok', `${p.name} now runs in ${next.name} mode.`); await reload(); } catch (e) { flash('err', (e as Error).message); } finally { setBusy(false); }
  }
  async function override(key: string, on: boolean) {
    try { await api(`/api/platform/projects/${p.id}`, j({ modeOverrides: { ...p.modeOverrides, [key]: on } }, 'PATCH')); flash('ok', 'Saved.'); await reload(); } catch (e) { flash('err', (e as Error).message); }
  }
  return (
    <section className="pane drill-card" aria-labelledby="pj-mode">
      <h4 id="pj-mode">Operating mode <span className={`mode-chip ${p.operatingMode}`}>{cur.short}</span></h4>
      <ModeCards value={pick} onChange={setPick} />
      {pick !== p.operatingMode && <div className="row"><button type="button" className="btn" disabled={busy} onClick={apply}>Change to {next.name}</button><button type="button" className="btn ghost" onClick={() => setPick(p.operatingMode)}>Keep {cur.short}</button></div>}
      {p.operatingMode !== 'full' && (<>
        <h4 style={{ marginTop: 14 }}>Adjustments for this project</h4>
        <OverrideSwitches mode={p.operatingMode} caps={caps} onChange={override} />
      </>)}
    </section>);
}
