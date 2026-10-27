'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Nav } from '../../components/Nav';
import { WorkflowAdmin } from '../../components/WorkflowAdmin';
import { FieldAdmin } from '../../components/FieldAdmin';
import { NoAccess, useAuth, j } from '../../lib/auth';

type Role = { id: number; name: string; description: string; is_system: boolean; locked: boolean; users: number; permissions: string[] };
type Catalog = { feature: string; permissions: { key: string; label: string; description: string }[] }[];
type User = { id: string; email: string; name: string; active: boolean; role_id: number; role: string };
type Audit = { id: number; action: string; detail: any; created_at: string; actor: string | null };
type Tab = 'roles' | 'fields' | 'users' | 'projects' | 'workflows' | 'activity';
type Stack = { id: number; name: string; description: string; keywords: string[]; projects: number };
type Proj = { id: string; name: string; tickets: number; stacks: { id: number; name: string }[] };

async function api(path: string, init?: RequestInit) {
  const r = await fetch(path, init);
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.error ?? 'Request failed');
  return body;
}

export default function Admin() {
  const { me, can, canAny, loading } = useAuth();
  const [tab, setTab] = useState<Tab>('roles');
  useEffect(() => { if (me && !can('admin.roles') && !can('admin.users')) setTab(can('admin.projects') ? 'projects' : can('admin.workflows') ? 'workflows' : 'activity'); }, [me, can]);
  const [roles, setRoles] = useState<Role[]>([]);
  const [catalog, setCatalog] = useState<Catalog>([]);
  const [users, setUsers] = useState<User[]>([]);
  const [audit, setAudit] = useState<Audit[]>([]);
  const [stacks, setStacks] = useState<Stack[]>([]);
  const [projects, setProjects] = useState<Proj[]>([]);
  const [newStack, setNewStack] = useState({ name: '', description: '', keywords: '' });
  const [newProject, setNewProject] = useState<{ name: string; stackIds: number[] }>({ name: '', stackIds: [] });
  const [status, setStatus] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [newRole, setNewRole] = useState({ name: '', description: '', copy: '' });
  const [newUser, setNewUser] = useState({ name: '', email: '', roleId: '' });

  const flash = (kind: 'ok' | 'err', text: string) => setStatus({ kind, text });
  const loadRoles = useCallback(async () => { const [r, c] = await Promise.all([api('/api/admin/roles'), api('/api/admin/catalog')]); setRoles(r); setCatalog(c); }, []);
  const loadUsers = useCallback(async () => setUsers(await api('/api/admin/users')), []);
  const loadProjects = useCallback(async () => { const [a, b] = await Promise.all([api('/api/admin/stacks'), api('/api/admin/projects')]); setStacks(a); setProjects(b); }, []);
  const loadAudit = useCallback(async () => setAudit(await api('/api/admin/audit')), []);

  useEffect(() => {
    if (!me) return;
    loadRoles().catch((e) => flash('err', e.message));
    if (can('admin.users')) loadUsers().catch(() => {});
    if (can('admin.projects')) loadProjects().catch(() => {});
  }, [me, can, loadRoles, loadUsers, loadProjects]);
  useEffect(() => { if (tab === 'activity') loadAudit().catch(() => {}); }, [tab, loadAudit]);

  const editable = can('admin.roles');
  const count = useMemo(() => catalog.reduce((n, f) => n + f.permissions.length, 0), [catalog]);

  async function toggle(role: Role, key: string, on: boolean) {
    const next = on ? [...role.permissions, key] : role.permissions.filter((p) => p !== key);
    setRoles((rs) => rs.map((r) => (r.id === role.id ? { ...r, permissions: next } : r)));        // optimistic
    try { await api(`/api/admin/roles/${role.id}/permissions`, j({ permissions: next }, 'PUT')); flash('ok', `Saved — ${role.name} ${on ? 'can now' : 'can no longer'} use “${labelOf(key)}”.`); }
    catch (e) { setRoles((rs) => rs.map((r) => (r.id === role.id ? role : r))); flash('err', (e as Error).message); }
  }
  const labelOf = (key: string) => catalog.flatMap((f) => f.permissions).find((p) => p.key === key)?.label ?? key;

  async function createRole(e: React.FormEvent) {
    e.preventDefault();
    try {
      await api('/api/admin/roles', j({ name: newRole.name, description: newRole.description, copyFromRoleId: newRole.copy ? Number(newRole.copy) : undefined }));
      flash('ok', `Role “${newRole.name}” created. Tick its permissions below.`); setNewRole({ name: '', description: '', copy: '' }); loadRoles();
    } catch (e) { flash('err', (e as Error).message); }
  }
  async function deleteRole(r: Role) {
    if (!confirm(`Delete the role “${r.name}”?`)) return;
    try { await api(`/api/admin/roles/${r.id}`, { method: 'DELETE' }); flash('ok', `Deleted “${r.name}”.`); loadRoles(); } catch (e) { flash('err', (e as Error).message); }
  }
  async function patchUser(u: User, body: object, ok: string) {
    try { await api(`/api/admin/users/${u.id}`, j(body, 'PATCH')); flash('ok', ok); loadUsers(); loadRoles(); } catch (e) { flash('err', (e as Error).message); loadUsers(); }
  }
  const kw = (t: string) => t.split(',').map((x) => x.trim()).filter(Boolean);
  async function createStack(e: React.FormEvent) {
    e.preventDefault();
    try { await api('/api/admin/stacks', j({ name: newStack.name, description: newStack.description, keywords: kw(newStack.keywords) }));
      flash('ok', `Added the ${newStack.name} stack.`); setNewStack({ name: '', description: '', keywords: '' }); loadProjects(); } catch (e) { flash('err', (e as Error).message); }
  }
  async function saveStack(s: Stack, description: string, keywords: string) {
    try { await api(`/api/admin/stacks/${s.id}`, j({ description, keywords: kw(keywords) }, 'PATCH')); flash('ok', `Saved ${s.name}.`); loadProjects(); } catch (e) { flash('err', (e as Error).message); }
  }
  async function deleteStack(s: Stack) {
    if (!confirm(`Delete the ${s.name} stack?`)) return;
    try { await api(`/api/admin/stacks/${s.id}`, { method: 'DELETE' }); flash('ok', `Deleted ${s.name}.`); loadProjects(); } catch (e) { flash('err', (e as Error).message); }
  }
  async function createProject(e: React.FormEvent) {
    e.preventDefault();
    try { await api('/api/admin/projects', j(newProject)); flash('ok', `Project “${newProject.name}” created.`); setNewProject({ name: '', stackIds: [] }); loadProjects(); } catch (e) { flash('err', (e as Error).message); }
  }
  async function setProjectStack(p: Proj, stackId: number, on: boolean) {
    const ids = on ? [...p.stacks.map((x) => x.id), stackId] : p.stacks.filter((x) => x.id !== stackId).map((x) => x.id);
    try { await api(`/api/admin/projects/${p.id}/stacks`, j({ stackIds: ids }, 'PUT'));
      const name = stacks.find((x) => x.id === stackId)?.name;
      flash('ok', on ? `${p.name}: the AI may now work in ${name}.` : `${p.name}: ${name} removed.${ids.length === 0 ? ' This project now has no technology restriction.' : ''}`); loadProjects(); }
    catch (e) { flash('err', (e as Error).message); }
  }
  async function createUser(e: React.FormEvent) {
    e.preventDefault();
    try {
      await api('/api/admin/users', j({ name: newUser.name, email: newUser.email, roleId: Number(newUser.roleId) }));
      flash('ok', `Added ${newUser.name}.`); setNewUser({ name: '', email: '', roleId: '' }); loadUsers(); loadRoles();
    } catch (e) { flash('err', (e as Error).message); }
  }

  if (loading || !me) return <><Nav current="admin" /><main id="main"><p className="note">Loading…</p></main></>;
  if (!canAny('admin.roles', 'admin.users', 'admin.projects', 'admin.workflows')) return <><Nav current="admin" /><main id="main"><NoAccess what="administration" /></main></>;

  const tabs: [Tab, string, boolean][] = [['roles', 'Roles & permissions', can('admin.roles') || can('admin.users')], ['fields', 'Ticket fields', can('admin.roles')], ['users', 'Users', can('admin.users')], ['projects', 'Projects & stacks', can('admin.projects')], ['workflows', 'Approval workflows', can('admin.workflows')], ['activity', 'Activity', true]];

  return (
    <>
      <Nav current="admin" />
      <main id="main">
        <div className="board-head"><div><h2>Administration</h2><p>Decide what each role can do, per feature, and who holds each role.</p></div></div>
        <div className="tabs" role="tablist" aria-label="Administration">
          {tabs.filter((t) => t[2]).map(([k, label]) => (
            <button key={k} role="tab" className="tab" aria-selected={tab === k} onClick={() => setTab(k)}>{label}</button>))}
        </div>
        <div aria-live="polite" style={{ minHeight: 24 }}>{status && <p className={status.kind === 'err' ? 'err' : 'ok'} role={status.kind === 'err' ? 'alert' : 'status'} style={{ margin: '0 0 10px' }}>{status.text}</p>}</div>

        {tab === 'roles' && (<>
          {editable && (
            <form className="pane build" onSubmit={createRole} aria-label="Create a role">
              <h3>Build a new role</h3>
              <div className="row">
                <label className="sr" htmlFor="rn">Role name</label>
                <input id="rn" placeholder="Role name (e.g. Solution Architect)" value={newRole.name} onChange={(e) => setNewRole({ ...newRole, name: e.target.value })} required minLength={2} />
                <label className="sr" htmlFor="rd">Description</label>
                <input id="rd" placeholder="What is this role for?" value={newRole.description} onChange={(e) => setNewRole({ ...newRole, description: e.target.value })} style={{ minWidth: 280 }} />
                <label className="sr" htmlFor="rc">Start from</label>
                <select id="rc" value={newRole.copy} onChange={(e) => setNewRole({ ...newRole, copy: e.target.value })}>
                  <option value="">Start with no permissions</option>
                  {roles.map((r) => <option key={r.id} value={r.id}>Copy of {r.name}</option>)}
                </select>
                <button className="btn" type="submit" disabled={newRole.name.trim().length < 2}>Create role</button>
              </div>
            </form>)}

          <div className="matrix-wrap">
            <table className="matrix">
              <caption className="sr">Permissions by role. Each checkbox grants a role one permission.</caption>
              <thead><tr>
                <th scope="col" className="feat">Feature · permission <span className="note">({count})</span></th>
                {roles.map((r) => (
                  <th scope="col" key={r.id} className="rcol">
                    <span className="role-badge" data-role={r.is_system ? r.name : 'Custom'}>{r.name}</span>
                    <span className="note">{r.users} user{r.users === 1 ? '' : 's'}</span>
                    {editable && !r.is_system && <button className="link-btn" onClick={() => deleteRole(r)} aria-label={`Delete role ${r.name}`}>Delete</button>}
                  </th>))}
              </tr></thead>
              {catalog.map((f) => (
                <tbody key={f.feature}>
                  <tr className="fgroup"><th scope="rowgroup" colSpan={roles.length + 1}>{f.feature}</th></tr>
                  {f.permissions.map((p) => (
                    <tr key={p.key}>
                      <th scope="row" className="feat"><span>{p.label}</span><span className="note">{p.description}</span></th>
                      {roles.map((r) => {
                        const on = r.permissions.includes(p.key);
                        return (
                          <td key={r.id}>
                            <input type="checkbox" checked={on} disabled={r.locked || !editable}
                              aria-label={`${r.name} role: ${p.label}`} title={r.locked ? 'Admin always has every permission' : undefined}
                              onChange={(e) => toggle(r, p.key, e.target.checked)} />
                          </td>);
                      })}
                    </tr>))}
                </tbody>))}
            </table>
          </div>
          <p className="note">Admin always has every permission and cannot be restricted. Built-in roles can be edited but not deleted. Changes apply immediately.</p>
        </>)}

        {tab === 'users' && can('admin.users') && (<>
          <form className="pane build" onSubmit={createUser} aria-label="Add a user">
            <h3>Add a user</h3>
            <div className="row">
              <label className="sr" htmlFor="un">Name</label><input id="un" placeholder="Full name" value={newUser.name} onChange={(e) => setNewUser({ ...newUser, name: e.target.value })} required />
              <label className="sr" htmlFor="ue">Email</label><input id="ue" type="email" placeholder="name@company.com" value={newUser.email} onChange={(e) => setNewUser({ ...newUser, email: e.target.value })} required />
              <label className="sr" htmlFor="ur">Role</label>
              <select id="ur" value={newUser.roleId} onChange={(e) => setNewUser({ ...newUser, roleId: e.target.value })} required>
                <option value="">Choose a role…</option>{roles.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
              </select>
              <button className="btn" type="submit">Add user</button>
            </div>
          </form>
          <div className="matrix-wrap">
            <table className="grid users">
              <thead><tr><th scope="col">Name</th><th scope="col">Email</th><th scope="col">Role</th><th scope="col">Active</th></tr></thead>
              <tbody>{users.map((u) => (
                <tr key={u.id} className={u.active ? '' : 'inactive'}>
                  <td>{u.name}{u.id === me.user.id && <span className="note"> (you)</span>}</td><td>{u.email}</td>
                  <td><select aria-label={`Role for ${u.name}`} value={u.role_id} onChange={(e) => patchUser(u, { roleId: Number(e.target.value) }, `${u.name} is now ${roles.find((r) => r.id === Number(e.target.value))?.name}.`)}>
                    {roles.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</select></td>
                  <td><input type="checkbox" checked={u.active} aria-label={`${u.name} is active`} onChange={(e) => patchUser(u, { active: e.target.checked }, `${u.name} ${e.target.checked ? 'reactivated' : 'deactivated'}.`)} /></td>
                </tr>))}</tbody>
            </table>
          </div>
        </>)}

        {tab === 'projects' && can('admin.projects') && (<>
          <p className="note" style={{ marginTop: 0 }}>The AI assistant only drafts requirements and specifications within a project’s allowed technologies. Requests that need something else are flagged and cannot be verified. A project with no stacks has no restriction.</p>
          <section aria-label="Projects" className="stack-grid">
            <form className="pane build" onSubmit={createProject} aria-label="Create a project">
              <h3>New project</h3>
              <div className="row">
                <label className="sr" htmlFor="pn">Project name</label>
                <input id="pn" placeholder="Project name" value={newProject.name} onChange={(e) => setNewProject({ ...newProject, name: e.target.value })} required minLength={2} />
              </div>
              <fieldset className="stackpick"><legend className="note">Allowed technology</legend>
                {stacks.map((s) => (<label key={s.id} className="check"><input type="checkbox" checked={newProject.stackIds.includes(s.id)}
                  onChange={(e) => setNewProject({ ...newProject, stackIds: e.target.checked ? [...newProject.stackIds, s.id] : newProject.stackIds.filter((x) => x !== s.id) })} /> {s.name}</label>))}
              </fieldset>
              <button className="btn" type="submit" disabled={newProject.name.trim().length < 2}>Create project</button>
            </form>
            {projects.map((p) => (
              <div key={p.id} className="pane build" role="group" aria-label={`Project ${p.name}`}>
                <h3>{p.name} <span className="note">· {p.tickets} ticket{p.tickets === 1 ? '' : 's'}</span></h3>
                <fieldset className="stackpick"><legend className="note">{p.stacks.length ? 'The AI works only in' : 'No restriction — the AI is not limited to any stack'}</legend>
                  {stacks.map((s) => (<label key={s.id} className="check"><input type="checkbox" checked={p.stacks.some((x) => x.id === s.id)}
                    aria-label={`${p.name}: ${s.name}`} onChange={(e) => setProjectStack(p, s.id, e.target.checked)} /> {s.name}</label>))}
                </fieldset>
              </div>))}
          </section>

          <h3 style={{ margin: '24px 0 8px' }}>Technology stacks</h3>
          <form className="pane build" onSubmit={createStack} aria-label="Add a technology stack">
            <div className="row">
              <label className="sr" htmlFor="sn">Stack name</label><input id="sn" placeholder="Stack name (e.g. Salesforce)" value={newStack.name} onChange={(e) => setNewStack({ ...newStack, name: e.target.value })} required />
              <label className="sr" htmlFor="sd">What it covers</label><input id="sd" placeholder="What it covers (told to the AI)" value={newStack.description} onChange={(e) => setNewStack({ ...newStack, description: e.target.value })} style={{ minWidth: 280 }} />
              <label className="sr" htmlFor="sk">Keywords</label><input id="sk" placeholder="Keywords, comma separated" value={newStack.keywords} onChange={(e) => setNewStack({ ...newStack, keywords: e.target.value })} style={{ minWidth: 240 }} />
              <button className="btn" type="submit" disabled={!newStack.name.trim()}>Add stack</button>
            </div>
          </form>
          <div className="matrix-wrap"><table className="grid users">
            <thead><tr><th scope="col">Stack</th><th scope="col">What it covers</th><th scope="col">Keywords that identify it</th><th scope="col">Projects</th><th /></tr></thead>
            <tbody>{stacks.map((s) => <StackRow key={s.id} s={s} onSave={saveStack} onDelete={deleteStack} />)}</tbody>
          </table></div>
          <p className="note">Keywords let the server double-check the AI: if a request or draft uses terms from a stack the project doesn’t allow, it is flagged.</p>
        </>)}

        {tab === 'fields' && can('admin.roles') && <FieldAdmin flash={flash} />}

        {tab === 'workflows' && can('admin.workflows') && <WorkflowAdmin flash={flash} />}

        {tab === 'activity' && (
          <ul className="audit">{audit.length === 0 && <li className="note">No changes recorded yet.</li>}
            {audit.map((a) => (
              <li key={a.id}><b>{a.actor ?? 'System'}</b> <span>{a.action}</span> <span className="note">{summarize(a)}</span><time className="note">{new Date(a.created_at).toLocaleString()}</time></li>))}
          </ul>)}
      </main>
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
      <td style={{ whiteSpace: 'nowrap' }}>
        <button className="btn sm" disabled={!dirty} onClick={() => onSave(s, d, k)}>Save</button>{' '}
        <button className="link-btn" onClick={() => onDelete(s)} aria-label={`Delete stack ${s.name}`}>Delete</button>
      </td>
    </tr>
  );
}

function summarize(a: Audit) {
  const d = a.detail ?? {};
  if (a.action === 'role.permissions') return `${d.name}: +${(d.added ?? []).join(', ') || 'none'} / −${(d.removed ?? []).join(', ') || 'none'}`;
  if (a.action === 'role.create') return d.name;
  if (a.action === 'role.ticket-fields') return `${d.name}: ${(d.changed ?? []).map((c: any) => `${c.field} ${c.from}→${c.to}`).join(', ')}`;
  if (a.action === 'ticket.update') return `ticket fields changed: ${(d.fields ?? []).join(', ')}`;
  if (a.action.startsWith('workflow.')) return `${d.name}${d.levels ? ` · ${d.levels} level${d.levels === 1 ? '' : 's'}` : ''}`;
  if (a.action.startsWith('stack.') || a.action.startsWith('project.') && a.action !== 'project.stacks') return d.name;
  if (a.action === 'project.stacks') return `${d.name}: ${(d.stackIds ?? []).length} stack(s)`;
  if (a.action === 'role.delete') return d.name;
  if (a.action === 'user.create') return d.email;
  if (a.action === 'user.update') return `${d.email}${d.active === false ? ' deactivated' : d.active === true ? ' reactivated' : ''}${d.roleId ? ' role changed' : ''}`;
  return '';
}
