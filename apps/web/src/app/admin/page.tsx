'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Nav } from '../../components/Nav';
import { NoAccess, useAuth, j } from '../../lib/auth';

type Role = { id: number; name: string; description: string; is_system: boolean; locked: boolean; users: number; permissions: string[] };
type Catalog = { feature: string; permissions: { key: string; label: string; description: string }[] }[];
type User = { id: string; email: string; name: string; active: boolean; role_id: number; role: string };
type Audit = { id: number; action: string; detail: any; created_at: string; actor: string | null };
type Tab = 'roles' | 'users' | 'activity';

async function api(path: string, init?: RequestInit) {
  const r = await fetch(path, init);
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.error ?? 'Request failed');
  return body;
}

export default function Admin() {
  const { me, can, canAny, loading } = useAuth();
  const [tab, setTab] = useState<Tab>('roles');
  const [roles, setRoles] = useState<Role[]>([]);
  const [catalog, setCatalog] = useState<Catalog>([]);
  const [users, setUsers] = useState<User[]>([]);
  const [audit, setAudit] = useState<Audit[]>([]);
  const [status, setStatus] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [newRole, setNewRole] = useState({ name: '', description: '', copy: '' });
  const [newUser, setNewUser] = useState({ name: '', email: '', roleId: '' });

  const flash = (kind: 'ok' | 'err', text: string) => setStatus({ kind, text });
  const loadRoles = useCallback(async () => { const [r, c] = await Promise.all([api('/api/admin/roles'), api('/api/admin/catalog')]); setRoles(r); setCatalog(c); }, []);
  const loadUsers = useCallback(async () => setUsers(await api('/api/admin/users')), []);
  const loadAudit = useCallback(async () => setAudit(await api('/api/admin/audit')), []);

  useEffect(() => {
    if (!me) return;
    loadRoles().catch((e) => flash('err', e.message));
    if (can('admin.users')) loadUsers().catch(() => {});
  }, [me, can, loadRoles, loadUsers]);
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
  async function createUser(e: React.FormEvent) {
    e.preventDefault();
    try {
      await api('/api/admin/users', j({ name: newUser.name, email: newUser.email, roleId: Number(newUser.roleId) }));
      flash('ok', `Added ${newUser.name}.`); setNewUser({ name: '', email: '', roleId: '' }); loadUsers(); loadRoles();
    } catch (e) { flash('err', (e as Error).message); }
  }

  if (loading || !me) return <><Nav current="admin" /><main id="main"><p className="note">Loading…</p></main></>;
  if (!canAny('admin.roles', 'admin.users')) return <><Nav current="admin" /><main id="main"><NoAccess what="administration" /></main></>;

  const tabs: [Tab, string, boolean][] = [['roles', 'Roles & permissions', true], ['users', 'Users', can('admin.users')], ['activity', 'Activity', true]];

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

        {tab === 'activity' && (
          <ul className="audit">{audit.length === 0 && <li className="note">No changes recorded yet.</li>}
            {audit.map((a) => (
              <li key={a.id}><b>{a.actor ?? 'System'}</b> <span>{a.action}</span> <span className="note">{summarize(a)}</span><time className="note">{new Date(a.created_at).toLocaleString()}</time></li>))}
          </ul>)}
      </main>
    </>
  );
}

function summarize(a: Audit) {
  const d = a.detail ?? {};
  if (a.action === 'role.permissions') return `${d.name}: +${(d.added ?? []).join(', ') || 'none'} / −${(d.removed ?? []).join(', ') || 'none'}`;
  if (a.action === 'role.create') return d.name;
  if (a.action === 'role.delete') return d.name;
  if (a.action === 'user.create') return d.email;
  if (a.action === 'user.update') return `${d.email}${d.active === false ? ' deactivated' : d.active === true ? ' reactivated' : ''}${d.roleId ? ' role changed' : ''}`;
  return '';
}
