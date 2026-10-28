'use client';
import { useCallback, useEffect, useState } from 'react';
import { j } from '../lib/auth';

export type Flash = (kind: 'ok' | 'err', text: string) => void;
export async function api(path: string, init?: RequestInit) {
  const r = await fetch(path, init);
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.details?.[0]?.message ?? body.error ?? 'Something went wrong');
  return body;
}

/* ------------------------------------------------------------------ roles & permissions (project tuning / platform catalog) */
type Perm = { key: string; label: string; description: string; scope?: string };
type Feature = { feature: string; permissions: Perm[] };
type RoleRow = { id: number; name: string; is_system: boolean; locked: boolean; tuned?: boolean; members?: number; permissions: string[] };

export function RoleMatrix({ mode, flash }: { mode: 'project' | 'platform'; flash: Flash }) {
  const base = mode === 'project' ? '/api/project' : '/api/platform';
  const [roles, setRoles] = useState<RoleRow[]>([]);
  const [catalog, setCatalog] = useState<Feature[]>([]);
  const [form, setForm] = useState({ name: '', description: '', copy: '' });

  const load = useCallback(async () => {
    if (mode === 'project') { const d = await api('/api/project/roles'); setRoles(d.roles); setCatalog(d.catalog); }
    else {
      const [r, c] = await Promise.all([api('/api/platform/roles'), api('/api/platform/catalog')]);
      setRoles(r); setCatalog((c as Feature[]).map((f) => ({ ...f, permissions: f.permissions.filter((p) => p.scope !== 'platform') })).filter((f) => f.permissions.length));
    }
  }, [mode]);
  useEffect(() => { load().catch((e) => flash('err', e.message)); }, [load, flash]);

  const label = (key: string) => catalog.flatMap((f) => f.permissions).find((p) => p.key === key)?.label ?? key;
  async function toggle(r: RoleRow, key: string, on: boolean) {
    const next = on ? [...r.permissions, key] : r.permissions.filter((p) => p !== key);
    setRoles((rs) => rs.map((x) => (x.id === r.id ? { ...x, permissions: next, tuned: mode === 'project' ? true : x.tuned } : x)));
    try { await api(`${base}/roles/${r.id}/permissions`, j({ permissions: next }, 'PUT')); flash('ok', `${r.name} ${on ? 'can now' : 'can no longer'} “${label(key)}”${mode === 'project' ? ' in this project' : ''}.`); }
    catch (e) { flash('err', (e as Error).message); load(); }
  }
  async function reset(r: RoleRow) {
    try { await api(`${base}/roles/${r.id}/permissions`, { method: 'DELETE' }); flash('ok', `${r.name} is back to the standard role.`); load(); } catch (e) { flash('err', (e as Error).message); }
  }
  async function create(e: React.FormEvent) {
    e.preventDefault();
    try { await api('/api/platform/roles', j({ name: form.name, description: form.description, copyFromRoleId: form.copy ? Number(form.copy) : undefined })); flash('ok', `Role “${form.name}” added to the catalog.`); setForm({ name: '', description: '', copy: '' }); load(); }
    catch (er) { flash('err', (er as Error).message); }
  }
  async function del(r: RoleRow) {
    if (!confirm(`Delete the role “${r.name}” from the catalog?`)) return;
    try { await api(`/api/platform/roles/${r.id}`, { method: 'DELETE' }); flash('ok', `Deleted “${r.name}”.`); load(); } catch (e) { flash('err', (e as Error).message); }
  }

  return (
    <>
      {mode === 'platform' && (
        <form className="pane build" onSubmit={create} aria-label="Add a role to the catalog">
          <h3>Add a role</h3>
          <div className="row">
            <label className="sr" htmlFor="rn">Role name</label><input id="rn" placeholder="Role name (e.g. Solution Architect)" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required minLength={2} />
            <label className="sr" htmlFor="rd">Description</label><input id="rd" placeholder="What is this role for?" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} style={{ minWidth: 260 }} />
            <label className="sr" htmlFor="rc">Start from</label>
            <select id="rc" value={form.copy} onChange={(e) => setForm({ ...form, copy: e.target.value })}><option value="">Start with no permissions</option>{roles.map((r) => <option key={r.id} value={r.id}>Copy of {r.name}</option>)}</select>
            <button className="btn" type="submit" disabled={form.name.trim().length < 2}>Add role</button>
          </div>
        </form>)}
      <div className="matrix-wrap">
        <table className="matrix">
          <caption className="sr">Permissions by role</caption>
          <thead><tr>
            <th scope="col" className="feat">Feature · permission</th>
            {roles.map((r) => (
              <th scope="col" key={r.id} className="rcol">
                <span className="role-badge" data-role={r.is_system ? r.name : 'Custom'}>{r.name}</span>
                {mode === 'project' && !r.locked && <span className="note">{r.tuned ? 'Customized' : 'Standard'}</span>}
                {mode === 'project' && r.tuned && <button className="link-btn" onClick={() => reset(r)} aria-label={`Reset ${r.name} to the standard role`}>Reset</button>}
                {mode === 'platform' && <span className="note">{r.members} in projects</span>}
                {mode === 'platform' && !r.is_system && <button className="link-btn" onClick={() => del(r)} aria-label={`Delete role ${r.name}`}>Delete</button>}
              </th>))}
          </tr></thead>
          {catalog.map((f) => (
            <tbody key={f.feature}>
              <tr className="fgroup"><th scope="rowgroup" colSpan={roles.length + 1}>{f.feature}</th></tr>
              {f.permissions.map((p) => (
                <tr key={p.key}>
                  <th scope="row" className="feat"><span>{p.label}</span><span className="note">{p.description}</span></th>
                  {roles.map((r) => (
                    <td key={r.id}>
                      <input type="checkbox" checked={r.permissions.includes(p.key)} disabled={r.locked} aria-label={`${r.name} role: ${p.label}`}
                        title={r.locked ? 'Project Admin always has every project permission' : undefined} onChange={(e) => toggle(r, p.key, e.target.checked)} />
                    </td>))}
                </tr>))}
            </tbody>))}
        </table>
      </div>
      <p className="note">Project Admin always has every project permission and cannot be restricted.</p>
    </>
  );
}

/* ------------------------------------------------------------------ project members */
type Member = { id: string; email: string; name: string; active: boolean; role_id: number; role: string };
export function MembersAdmin({ flash, meId }: { flash: Flash; meId: string }) {
  const [members, setMembers] = useState<Member[]>([]);
  const [roles, setRoles] = useState<{ id: number; name: string }[]>([]);
  const [form, setForm] = useState({ email: '', name: '', roleId: '' });
  const load = useCallback(async () => { const [m, r] = await Promise.all([api('/api/project/members'), api('/api/project/roles')]); setMembers(m); setRoles(r.roles.map((x: RoleRow) => ({ id: x.id, name: x.name }))); }, []);
  useEffect(() => { load().catch((e) => flash('err', e.message)); }, [load, flash]);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    try { const r = await api('/api/project/members', j({ email: form.email, name: form.name || undefined, roleId: Number(form.roleId) })); flash('ok', r.created ? `Created an account for ${form.email} and added them to this project.` : `${form.email} was added to this project.`); setForm({ email: '', name: '', roleId: '' }); load(); }
    catch (er) { flash('err', (er as Error).message); }
  }
  async function setRole(m: Member, roleId: number) {
    try { await api(`/api/project/members/${m.id}`, j({ roleId }, 'PATCH')); flash('ok', `${m.name} is now ${roles.find((r) => r.id === roleId)?.name} in this project.`); load(); } catch (e) { flash('err', (e as Error).message); load(); }
  }
  async function remove(m: Member) {
    if (!confirm(`Remove ${m.name} from this project? Their account stays; they just lose access here.`)) return;
    try { await api(`/api/project/members/${m.id}`, { method: 'DELETE' }); flash('ok', `${m.name} was removed from this project.`); load(); } catch (e) { flash('err', (e as Error).message); }
  }
  return (
    <>
      <form className="pane build" onSubmit={add} aria-label="Add a member">
        <h3>Add someone to this project</h3>
        <div className="row">
          <label className="sr" htmlFor="me">Email</label><input id="me" type="email" placeholder="name@company.com" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} required />
          <label className="sr" htmlFor="mn">Name (only needed for new people)</label><input id="mn" placeholder="Name (for new people)" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          <label className="sr" htmlFor="mr">Role</label>
          <select id="mr" value={form.roleId} onChange={(e) => setForm({ ...form, roleId: e.target.value })} required><option value="">Choose a role…</option>{roles.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</select>
          <button className="btn" type="submit">Add</button>
        </div>
      </form>
      <div className="matrix-wrap">
        <table className="grid users">
          <caption className="sr">Project members</caption>
          <thead><tr><th scope="col">Name</th><th scope="col">Email</th><th scope="col">Role in this project</th><th scope="col"><span className="sr">Actions</span></th></tr></thead>
          <tbody>{members.map((m) => (
            <tr key={m.id} className={m.active ? '' : 'inactive'}>
              <td>{m.name}{m.id === meId && <span className="note"> (you)</span>}{!m.active && <span className="note"> · deactivated</span>}</td><td>{m.email}</td>
              <td><select aria-label={`Role for ${m.name}`} value={m.role_id} onChange={(e) => setRole(m, Number(e.target.value))}>{roles.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</select></td>
              <td style={{ textAlign: 'right' }}><button className="link-btn" onClick={() => remove(m)} aria-label={`Remove ${m.name}`}>Remove</button></td>
            </tr>))}</tbody>
        </table>
      </div>
    </>
  );
}

/* ------------------------------------------------------------------ the technology a project allows */
export function ProjectTech({ flash }: { flash: Flash }) {
  const [cat, setCat] = useState<{ id: number; name: string; description: string }[]>([]);
  const [sel, setSel] = useState<number[]>([]);
  const load = useCallback(async () => { const d = await api('/api/project/stacks'); setCat(d.catalog); setSel(d.selected); }, []);
  useEffect(() => { load().catch((e) => flash('err', e.message)); }, [load, flash]);
  async function toggle(id: number, on: boolean) {
    const next = on ? [...sel, id] : sel.filter((x) => x !== id);
    setSel(next);
    try { await api('/api/project/stacks', j({ stackIds: next }, 'PUT')); flash('ok', next.length ? 'Saved. The AI works only in the ticked technologies for this project.' : 'Saved. This project has no technology restriction.'); }
    catch (e) { flash('err', (e as Error).message); load(); }
  }
  return (
    <>
      <fieldset className="pane build stackpick" style={{ margin: 0 }}>
        <legend className="note">Allowed technology for this project</legend>
        {cat.map((s) => (<label key={s.id} className="check" title={s.description}><input type="checkbox" checked={sel.includes(s.id)} onChange={(e) => toggle(s.id, e.target.checked)} /> {s.name}</label>))}
      </fieldset>
    </>
  );
}

/* ------------------------------------------------------------------ activity */
type Audit = { id: number; action: string; detail: any; created_at: string; actor: string | null; project?: string | null };
function summarize(a: Audit) {
  const d = a.detail ?? {};
  switch (a.action) {
    case 'member.add': return `${d.email} as ${d.role}${d.newAccount ? ' (new account)' : ''}`;
    case 'member.role': return `${d.email}: ${d.from} → ${d.to}`;
    case 'member.remove': return `${d.email} (${d.role})`;
    case 'role.permissions': return `${d.name}: +${(d.added ?? []).join(', ') || 'none'} / −${(d.removed ?? []).join(', ') || 'none'}`;
    case 'role.ticket-fields': return `${d.name}: ${(d.changed ?? []).map((c: any) => `${c.field} ${c.from}→${c.to}`).join(', ') || JSON.stringify(d.access ?? {})}`;
    case 'role.reset': return `${d.name} (${d.what}) back to standard`;
    case 'project.enter': return `Super Admin entered ${d.project}`;
    case 'project.create': return `${d.name}${d.admin ? ` · admin ${d.admin}` : ''}`;
    case 'project.admin': return d.email;
    case 'ticket.update': return `ticket fields changed: ${(d.fields ?? []).join(', ')}`;
    default: return d.name ?? d.email ?? '';
  }
}
export function ActivityList({ path, flash, showProject }: { path: string; flash: Flash; showProject?: boolean }) {
  const [rows, setRows] = useState<Audit[]>([]);
  useEffect(() => { api(path).then(setRows).catch((e) => flash('err', e.message)); }, [path, flash]);
  return (
    <ul className="audit">{rows.length === 0 && <li className="note">No changes recorded yet.</li>}
      {rows.map((a) => (
        <li key={a.id}><b>{a.actor ?? 'System'}</b> <span>{a.action}</span> <span className="note">{summarize(a)}</span>
          {showProject && a.project && <span className="role-badge" data-role="Custom">{a.project}</span>}
          <time className="note">{new Date(a.created_at).toLocaleString()}</time></li>))}
    </ul>
  );
}
