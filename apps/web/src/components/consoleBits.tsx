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
type RoleRow = { id: number; name: string; is_system: boolean; locked: boolean; tuned?: boolean; owned?: boolean; members?: number; permissions: string[] };

export function RoleMatrix({ mode, flash }: { mode: 'project' | 'platform'; flash: Flash }) {
  const base = mode === 'project' ? '/api/project' : '/api/platform';
  const [roles, setRoles] = useState<RoleRow[]>([]);
  const [catalog, setCatalog] = useState<Feature[]>([]);
  const [form, setForm] = useState({ name: '', description: '', copy: '' });
  const [mayCreate, setMayCreate] = useState(false);       // project mode: a Super Admin has allowed this Project Admin to make roles
  const [renaming, setRenaming] = useState<{ id: number; name: string } | null>(null);

  const load = useCallback(async () => {
    if (mode === 'project') { const d = await api('/api/project/roles'); setRoles(d.roles); setCatalog(d.catalog); setMayCreate(!!d.canCreateRoles); }
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
    try { await api(mode === 'project' ? '/api/project/roles' : '/api/platform/roles', j({ name: form.name, description: form.description, copyFromRoleId: form.copy ? Number(form.copy) : undefined })); flash('ok', mode === 'project' ? `Role “${form.name}” was created for this project. Tick what it can do, then give it to people under Members.` : `Role “${form.name}” added to the catalog.`); setForm({ name: '', description: '', copy: '' }); load(); }
    catch (er) { flash('err', (er as Error).message); }
  }
  async function del(r: RoleRow) {
    if (!confirm(mode === 'project' ? `Delete the role “${r.name}”? It is removed from this project.` : `Delete the role “${r.name}” from the catalog?`)) return;
    try { await api(mode === 'project' ? `/api/project/roles/${r.id}` : `/api/platform/roles/${r.id}`, { method: 'DELETE' }); flash('ok', `Deleted “${r.name}”.`); load(); } catch (e) { flash('err', (e as Error).message); }
  }
  async function rename(e: React.FormEvent) {
    e.preventDefault(); if (!renaming) return;
    try { await api(`/api/project/roles/${renaming.id}`, j({ name: renaming.name }, 'PATCH')); flash('ok', `Renamed to “${renaming.name.trim()}”.`); setRenaming(null); load(); } catch (er) { flash('err', (er as Error).message); }
  }

  return (
    <>
      {(mode === 'platform' || mayCreate) && (
        <form className="pane build" onSubmit={create} aria-label={mode === 'project' ? 'Create a role for this project' : 'Add a role to the catalog'}>
          <h3>{mode === 'project' ? 'Create a role for this project' : 'Add a role'}</h3>
          <div className="row">
            <label className="sr" htmlFor="rn">Role name</label><input id="rn" placeholder="Role name (e.g. Solution Architect)" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required minLength={2} />
            <label className="sr" htmlFor="rd">Description</label><input id="rd" placeholder="What is this role for?" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} style={{ minWidth: 260 }} />
            <label className="sr" htmlFor="rc">Start from</label>
            <select id="rc" value={form.copy} onChange={(e) => setForm({ ...form, copy: e.target.value })}><option value="">Start with no permissions</option>{roles.map((r) => <option key={r.id} value={r.id}>Copy of {r.name}</option>)}</select>
            <button className="btn" type="submit" disabled={form.name.trim().length < 2}>{mode === 'project' ? 'Create role' : 'Add role'}</button>
          </div>
        </form>)}
      <div className="matrix-wrap">
        <table className="matrix">
          <caption className="sr">Permissions by role</caption>
          <thead><tr>
            <th scope="col" className="feat">Feature · permission</th>
            {roles.map((r) => (
              <th scope="col" key={r.id} className="rcol">
                {renaming?.id === r.id
                  ? <form onSubmit={rename} className="rename" aria-label={`Rename ${r.name}`}><input aria-label="New role name" value={renaming.name} onChange={(e) => setRenaming({ id: r.id, name: e.target.value })} autoFocus minLength={2} maxLength={40} required /><button className="link-btn" type="submit">Save</button><button className="link-btn" type="button" onClick={() => setRenaming(null)}>Cancel</button></form>
                  : <span className="role-badge" data-role={r.is_system ? r.name : 'Custom'}>{r.name}</span>}
                {mode === 'project' && !r.locked && <span className="note">{r.owned ? 'This project’s role' : r.tuned ? 'Customized' : 'Standard'}</span>}
                {mode === 'project' && r.owned && mayCreate && renaming?.id !== r.id && <span className="rc-actions"><button className="link-btn" onClick={() => setRenaming({ id: r.id, name: r.name })} aria-label={`Rename role ${r.name}`}>Rename</button><button className="link-btn" onClick={() => del(r)} aria-label={`Delete role ${r.name}`}>Delete</button></span>}
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
      <p className="note">Project Admin always has every project permission and cannot be restricted.{mode === 'project' && !mayCreate && ' Creating roles of your own needs a Super Admin to allow it for you.'}</p>
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
