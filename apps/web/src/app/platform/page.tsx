'use client';
import { SettingsShell, useSectionHash, type SettingsGroup } from '../../components/SettingsShell';
import { WorkflowMasters } from '../../components/WorkflowMasters';
import { TemplateAdmin } from '../../components/TemplateAdmin';
import { useCallback, useEffect, useState } from 'react';
import { Nav } from '../../components/Nav';
import { FieldAdmin } from '../../components/FieldAdmin';
import { ActivityList, api } from '../../components/consoleBits';
import { RolesAdmin } from '../../components/people/RolesAdmin';
import { ProjectsAdmin } from '../../components/platform/ProjectsAdmin';
import { NoAccess, useAuth, j } from '../../lib/auth';

type Tab = 'projects' | 'users' | 'roles' | 'fields' | 'stacks' | 'workflows' | 'documents' | 'activity';
type Flash = (kind: 'ok' | 'err', text: string) => void;
type Stack = { id: number; name: string; description: string; keywords: string[]; projects: number };
type PUser = { id: string; email: string; name: string; active: boolean; isSuperAdmin: boolean; projects: { id: string; name: string; role: string }[] };

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
  const [status, setStatus] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const flash = useCallback<Flash>((kind, text) => setStatus({ kind, text }), []);
  const groups: SettingsGroup<Tab>[] = [
    { label: 'Workspace', items: [{ key: 'projects', label: 'Projects', hint: 'Create projects, appoint their admins, step into one, or archive it.' }, { key: 'users', label: 'Users', hint: 'Everyone on the platform, their projects and roles.' }] },
    { label: 'Standards', items: [{ key: 'roles', label: 'Role catalog', hint: 'The standard roles every project starts from.' }, { key: 'fields', label: 'Default ticket fields', hint: 'Which ticket fields each standard role can see.' }, { key: 'stacks', label: 'Technology catalog', hint: 'The technologies a project can be limited to.' }] },
    { label: 'Building blocks', items: [{ key: 'workflows', label: 'Workflows', hint: 'Ticket types and their fields, methodologies and their transitions, project-type defaults.' }, { key: 'documents', label: 'Documents', hint: 'Word templates and the defaults for document style.' }] },
    { label: 'Audit', items: [{ key: 'activity', label: 'Activity', hint: 'A log of platform-wide changes.' }] },
  ];
  const { section: tab, choose: setTab, sub, setSub } = useSectionHash<Tab>(groups.flatMap((g) => g.items.map((i) => i.key)), 'projects');
  useEffect(() => { setStatus(null); }, [tab]);
  if (loading || !me) return <><Nav current="platform" /><main id="main"><p className="note">Loading…</p></main></>;
  if (!isSuper) return <><Nav current="platform" /><main id="main"><NoAccess what="the platform console" /></main></>;
  return (
    <>
      <Nav current="platform" />
      <main id="main">
        <div className="board-head"><div><h2>Platform</h2></div></div>
        <SettingsShell label="Platform" groups={groups} active={tab} onSelect={setTab} status={status && <p className={status.kind === 'err' ? 'err' : 'ok'} role={status.kind === 'err' ? 'alert' : 'status'} style={{ margin: 0 }}>{status.text}</p>}>
        {tab === 'projects' && <ProjectsAdmin flash={flash} sub={sub} onSub={setSub} />}
        {tab === 'users' && <Users flash={flash} />}
        {tab === 'roles' && <RolesAdmin mode="platform" flash={flash} sub={sub} onSub={setSub} />}
        {tab === 'fields' && <FieldAdmin mode="platform" flash={flash} />}
        {tab === 'stacks' && <Stacks flash={flash} />}
        {tab === 'workflows' && <WorkflowMasters flash={flash} />}
        {tab === 'documents' && <TemplateAdmin flash={flash} />}
        {tab === 'activity' && <ActivityList path="/api/platform/audit" flash={flash} showProject />}
        </SettingsShell>
      </main>
    </>
  );
}
