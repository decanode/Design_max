'use client';
import { TemplateAdmin } from '../../components/TemplateAdmin';
import { useCallback, useEffect, useState } from 'react';
import { Nav } from '../../components/Nav';
import { FieldAdmin } from '../../components/FieldAdmin';
import { ActivityList, RoleMatrix, api } from '../../components/consoleBits';
import { NoAccess, useAuth, j } from '../../lib/auth';

type Tab = 'projects' | 'users' | 'roles' | 'fields' | 'stacks' | 'documents' | 'activity';
type Flash = (kind: 'ok' | 'err', text: string) => void;
type Project = { id: string; name: string; status: 'active' | 'archived'; members: number; tickets: number; admins: { id: string; name: string }[]; stacks: string[] };
type Stack = { id: number; name: string; description: string; keywords: string[]; projects: number };
type PUser = { id: string; email: string; name: string; active: boolean; isSuperAdmin: boolean; projects: { id: string; name: string; role: string }[] };

function Projects({ flash }: { flash: Flash }) {
  const { switchProject, me } = useAuth();
  const [list, setList] = useState<Project[]>([]);
  const [stacks, setStacks] = useState<Stack[]>([]);
  const [form, setForm] = useState({ name: '', email: '', adminName: '', stackIds: [] as number[] });
  const [appoint, setAppoint] = useState<Record<string, { email: string; name: string }>>({});
  const load = useCallback(async () => { const [p, s] = await Promise.all([api('/api/platform/projects'), api('/api/platform/stacks')]); setList(p); setStacks(s); }, []);
  useEffect(() => { load().catch((e) => flash('err', e.message)); }, [load, flash]);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    try {
      await api('/api/platform/projects', j({ name: form.name, stackIds: form.stackIds, admin: form.email ? { email: form.email, name: form.adminName || undefined } : undefined }));
      flash('ok', `Project “${form.name}” created${form.email ? ` and ${form.email} appointed Project Admin` : ''}. It starts with its own copy of the standard approval workflow.`);
      setForm({ name: '', email: '', adminName: '', stackIds: [] }); load();
    } catch (er) { flash('err', (er as Error).message); }
  }
  async function appointAdmin(p: Project) {
    const a = appoint[p.id]; if (!a?.email) return;
    try { const r = await api(`/api/platform/projects/${p.id}/admins`, j({ email: a.email, name: a.name || undefined })); flash('ok', `${a.email} is now a Project Admin of ${p.name}${r.created ? ' (new account created)' : ''}.`); setAppoint({ ...appoint, [p.id]: { email: '', name: '' } }); load(); }
    catch (e) { flash('err', (e as Error).message); }
  }
  async function setStatus(p: Project, status: 'active' | 'archived') {
    if (status === 'archived' && !confirm(`Archive “${p.name}”? Everyone loses access to it at once. Nothing is deleted, and you can restore it.`)) return;
    try { await api(`/api/platform/projects/${p.id}`, j({ status }, 'PATCH')); flash('ok', `${p.name} is now ${status}.`); load(); } catch (e) { flash('err', (e as Error).message); }
  }

  return (
    <>
      <p className="note" style={{ marginTop: 0 }}>Each project is its own workspace with its own people, tickets, chats, approvals and rules. You create it and appoint its Project Admin; they run it from there. You can step into any project to help, and each entry is recorded in that project&rsquo;s activity.</p>
      <form className="pane build" onSubmit={create} aria-label="Create a project">
        <h3>New project</h3>
        <div className="row">
          <label className="sr" htmlFor="pn">Project name</label><input id="pn" placeholder="Project name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required minLength={2} />
          <label className="sr" htmlFor="pe">Project Admin email</label><input id="pe" type="email" placeholder="Project Admin's email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
          <label className="sr" htmlFor="pa">Project Admin name</label><input id="pa" placeholder="Their name (if new)" value={form.adminName} onChange={(e) => setForm({ ...form, adminName: e.target.value })} />
        </div>
        <fieldset className="stackpick"><legend className="note">Allowed technology (optional, the Project Admin can change it)</legend>
          {stacks.map((s) => (<label key={s.id} className="check"><input type="checkbox" checked={form.stackIds.includes(s.id)} onChange={(e) => setForm({ ...form, stackIds: e.target.checked ? [...form.stackIds, s.id] : form.stackIds.filter((x) => x !== s.id) })} /> {s.name}</label>))}
        </fieldset>
        <button className="btn" type="submit" disabled={form.name.trim().length < 2}>Create project</button>
      </form>

      <div className="wf-list">
        {list.map((p) => (
          <article key={p.id} className={`wf ${p.status === 'archived' ? 'off' : ''}`} aria-label={`Project ${p.name}`}>
            <header>
              <div><h3>{p.name} {p.status === 'archived' && <span className="note">· archived</span>}</h3>
                <p className="note" style={{ margin: 0 }}>{p.members} member{p.members === 1 ? '' : 's'} · {p.tickets} ticket{p.tickets === 1 ? '' : 's'} · {p.stacks.length ? p.stacks.join(', ') : 'any technology'}</p></div>
              <div className="row" style={{ margin: 0 }}>
                {p.status === 'active' && me?.project?.id !== p.id && <button className="btn ghost sm" onClick={() => switchProject(p.id)}>Open project</button>}
                {p.status === 'active' && me?.project?.id === p.id && <span className="role-badge" data-role="Manager">Working here</span>}
                <button className="link-btn" onClick={() => setStatus(p, p.status === 'active' ? 'archived' : 'active')}>{p.status === 'active' ? 'Archive' : 'Restore'}</button>
              </div>
            </header>
            <div className="row" style={{ margin: '8px 0 0' }}>
              <span className="note">Project Admins:</span>
              {p.admins.length ? p.admins.map((a) => <span key={a.id} className="chip">{a.name}</span>) : <span className="err">none yet</span>}
            </div>
            {p.status === 'active' && (
              <div className="row" style={{ margin: '8px 0 0' }}>
                <label className="sr" htmlFor={`ae${p.id}`}>Appoint a Project Admin for {p.name}</label>
                <input id={`ae${p.id}`} type="email" placeholder="Appoint a Project Admin (email)" value={appoint[p.id]?.email ?? ''} onChange={(e) => setAppoint({ ...appoint, [p.id]: { name: appoint[p.id]?.name ?? '', email: e.target.value } })} style={{ minWidth: 260 }} />
                <label className="sr" htmlFor={`an${p.id}`}>Name</label>
                <input id={`an${p.id}`} placeholder="Name (if new)" value={appoint[p.id]?.name ?? ''} onChange={(e) => setAppoint({ ...appoint, [p.id]: { email: appoint[p.id]?.email ?? '', name: e.target.value } })} style={{ minWidth: 160 }} />
                <button className="btn ghost sm" disabled={!appoint[p.id]?.email} onClick={() => appointAdmin(p)}>Appoint</button>
              </div>)}
          </article>))}
      </div>
    </>
  );
}

function Users({ flash }: { flash: Flash }) {
  const [users, setUsers] = useState<PUser[]>([]);
  const [form, setForm] = useState({ email: '', name: '', isSuperAdmin: false });
  const { me } = useAuth();
  const load = useCallback(async () => setUsers(await api('/api/platform/users')), []);
  useEffect(() => { load().catch((e) => flash('err', e.message)); }, [load, flash]);
  async function patch(u: PUser, body: object, ok: string) { try { await api(`/api/platform/users/${u.id}`, j(body, 'PATCH')); flash('ok', ok); load(); } catch (e) { flash('err', (e as Error).message); load(); } }
  async function create(e: React.FormEvent) {
    e.preventDefault();
    try { await api('/api/platform/users', j(form)); flash('ok', `Created ${form.name}. Add them to a project from that project's settings.`); setForm({ email: '', name: '', isSuperAdmin: false }); load(); } catch (er) { flash('err', (er as Error).message); }
  }
  return (
    <>
      <p className="note" style={{ marginTop: 0 }}>Everyone with an account. A new account can reach nothing until a Project Admin adds them to a project (or you make them a Super Admin).</p>
      <form className="pane build" onSubmit={create} aria-label="Create a user">
        <h3>New user</h3>
        <div className="row">
          <label className="sr" htmlFor="un">Name</label><input id="un" placeholder="Full name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required />
          <label className="sr" htmlFor="ue">Email</label><input id="ue" type="email" placeholder="name@company.com" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} required />
          <label className="check"><input type="checkbox" checked={form.isSuperAdmin} onChange={(e) => setForm({ ...form, isSuperAdmin: e.target.checked })} /> Super Admin</label>
          <button className="btn" type="submit">Create</button>
        </div>
      </form>
      <div className="matrix-wrap">
        <table className="grid users" style={{ minWidth: 760 }}>
          <caption className="sr">All users</caption>
          <thead><tr><th scope="col">Name</th><th scope="col">Email</th><th scope="col">Projects and roles</th><th scope="col">Super Admin</th><th scope="col">Active</th></tr></thead>
          <tbody>{users.map((u) => (
            <tr key={u.id} className={u.active ? '' : 'inactive'}>
              <td>{u.name}{u.id === me?.user.id && <span className="note"> (you)</span>}</td><td>{u.email}</td>
              <td>{u.projects.length ? u.projects.map((p) => <span key={p.id} className="chip" style={{ marginRight: 4 }}>{p.name} · {p.role}</span>) : <span className="note">none</span>}</td>
              <td><input type="checkbox" checked={u.isSuperAdmin} aria-label={`${u.name} is a Super Admin`} onChange={(e) => patch(u, { isSuperAdmin: e.target.checked }, `${u.name} ${e.target.checked ? 'is now' : 'is no longer'} a Super Admin.`)} /></td>
              <td><input type="checkbox" checked={u.active} aria-label={`${u.name} is active`} onChange={(e) => patch(u, { active: e.target.checked }, `${u.name} ${e.target.checked ? 'reactivated' : 'deactivated'}.`)} /></td>
            </tr>))}</tbody>
        </table>
      </div>
    </>
  );
}

function StackRow({ s, onSave, onDelete }: { s: Stack; onSave: (s: Stack, d: string, k: string) => void; onDelete: (s: Stack) => void }) {
  const [d, setD] = useState(s.description);
  const [k, setK] = useState(s.keywords.join(', '));
  const dirty = d !== s.description || k !== s.keywords.join(', ');
  const box = { width: '100%', padding: 6, borderRadius: 8, border: '1px solid var(--line)', background: 'var(--panel)', color: 'var(--text)' } as const;
  return (
    <tr>
      <td><b>{s.name}</b></td>
      <td><input aria-label={`${s.name} description`} value={d} onChange={(e) => setD(e.target.value)} style={box} /></td>
      <td><input aria-label={`${s.name} keywords`} value={k} onChange={(e) => setK(e.target.value)} style={box} /></td>
      <td>{s.projects}</td>
      <td style={{ whiteSpace: 'nowrap' }}><button className="btn sm" disabled={!dirty} onClick={() => onSave(s, d, k)}>Save</button>{' '}<button className="link-btn" onClick={() => onDelete(s)} aria-label={`Delete stack ${s.name}`}>Delete</button></td>
    </tr>
  );
}

function Stacks({ flash }: { flash: Flash }) {
  const [stacks, setStacks] = useState<Stack[]>([]);
  const [form, setForm] = useState({ name: '', description: '', keywords: '' });
  const load = useCallback(async () => setStacks(await api('/api/platform/stacks')), []);
  useEffect(() => { load().catch((e) => flash('err', e.message)); }, [load, flash]);
  const kw = (t: string) => t.split(',').map((x) => x.trim()).filter(Boolean);
  async function create(e: React.FormEvent) { e.preventDefault(); try { await api('/api/platform/stacks', j({ name: form.name, description: form.description, keywords: kw(form.keywords) })); flash('ok', `Added the ${form.name} stack.`); setForm({ name: '', description: '', keywords: '' }); load(); } catch (er) { flash('err', (er as Error).message); } }
  async function save(s: Stack, description: string, keywords: string) { try { await api(`/api/platform/stacks/${s.id}`, j({ description, keywords: kw(keywords) }, 'PATCH')); flash('ok', `Saved ${s.name}.`); load(); } catch (e) { flash('err', (e as Error).message); } }
  async function del(s: Stack) { if (!confirm(`Delete the ${s.name} stack?`)) return; try { await api(`/api/platform/stacks/${s.id}`, { method: 'DELETE' }); flash('ok', `Deleted ${s.name}.`); load(); } catch (e) { flash('err', (e as Error).message); } }
  return (
    <>
      <p className="note" style={{ marginTop: 0 }}>The list of technologies a project can be limited to. Each project&rsquo;s admin chooses from it. The description is told to the AI; the keywords let the server double-check that drafts stay within a project&rsquo;s technology.</p>
      <form className="pane build" onSubmit={create} aria-label="Add a technology stack">
        <div className="row">
          <label className="sr" htmlFor="sn">Stack name</label><input id="sn" placeholder="Stack name (e.g. Salesforce)" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required />
          <label className="sr" htmlFor="sd">What it covers</label><input id="sd" placeholder="What it covers (told to the AI)" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} style={{ minWidth: 280 }} />
          <label className="sr" htmlFor="sk">Keywords</label><input id="sk" placeholder="Keywords, comma separated" value={form.keywords} onChange={(e) => setForm({ ...form, keywords: e.target.value })} style={{ minWidth: 240 }} />
          <button className="btn" type="submit" disabled={!form.name.trim()}>Add stack</button>
        </div>
      </form>
      <div className="matrix-wrap"><table className="grid users">
        <thead><tr><th scope="col">Stack</th><th scope="col">What it covers</th><th scope="col">Keywords that identify it</th><th scope="col">Projects</th><th /></tr></thead>
        <tbody>{stacks.map((s) => <StackRow key={s.id} s={s} onSave={save} onDelete={del} />)}</tbody>
      </table></div>
    </>
  );
}

export default function Platform() {
  const { me, isSuper, loading } = useAuth();
  const [tab, setTab] = useState<Tab>('projects');
  const [status, setStatus] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const flash = useCallback<Flash>((kind, text) => setStatus({ kind, text }), []);
  useEffect(() => { setStatus(null); }, [tab]);
  if (loading || !me) return <><Nav current="platform" /><main id="main"><p className="note">Loading…</p></main></>;
  if (!isSuper) return <><Nav current="platform" /><main id="main"><NoAccess what="the platform console" /></main></>;
  const tabs: [Tab, string][] = [['projects', 'Projects'], ['users', 'Users'], ['roles', 'Role catalog'], ['fields', 'Default ticket fields'], ['stacks', 'Technology catalog'], ['documents', 'Documents'], ['activity', 'Activity']];
  return (
    <>
      <Nav current="platform" />
      <main id="main">
        <div className="board-head"><div><h2>Platform</h2><p>Create projects, appoint their admins, and keep the standard roles and technologies every project starts from.</p></div></div>
        <div className="tabs" role="tablist" aria-label="Platform">
          {tabs.map(([k, label]) => <button key={k} role="tab" className="tab" aria-selected={tab === k} onClick={() => setTab(k)}>{label}</button>)}
        </div>
        <div aria-live="polite" style={{ minHeight: 24 }}>{status && <p className={status.kind === 'err' ? 'err' : 'ok'} role={status.kind === 'err' ? 'alert' : 'status'} style={{ margin: '0 0 10px' }}>{status.text}</p>}</div>
        {tab === 'projects' && <Projects flash={flash} />}
        {tab === 'users' && <Users flash={flash} />}
        {tab === 'roles' && <RoleMatrix mode="platform" flash={flash} />}
        {tab === 'fields' && <FieldAdmin mode="platform" flash={flash} />}
        {tab === 'stacks' && <Stacks flash={flash} />}
        {tab === 'documents' && <TemplateAdmin flash={flash} />}
        {tab === 'activity' && <ActivityList path="/api/platform/audit" flash={flash} showProject />}
      </main>
    </>
  );
}
