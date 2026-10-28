'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { motion } from 'framer-motion';
import { api, RoleMatrix, type Flash } from '../consoleBits';
import { FieldAdmin } from '../FieldAdmin';
import { j } from '../../lib/auth';
import { Avatar, RoleBadge, type MemberRow } from './shared';

type Level = 'hidden' | 'read' | 'write';
type Perm = { key: string; label: string; description: string; scope?: string };
type Feature = { feature: string; permissions: Perm[] };
type FieldDef = { key: string; label: string; description: string; writable: boolean; min: Level };
interface Role {
  id: number; name: string; description: string; system: boolean; owned: boolean; locked: boolean; permTuned: boolean; fieldsTuned: boolean; members: number;
  permissions: string[]; access: Record<string, Level>;
}
const LEVEL_TEXT: Record<Level, string> = { hidden: 'Hidden', read: 'Read only', write: 'Can edit' };
type Mode = 'project' | 'platform';

/**
 * Roles in two steps: first the list, then one role's own page (to create it, or to change what it may do and see).
 * The wide comparison grids are still there under "Compare".
 */
export function RolesAdmin({ mode, flash, sub, onSub }: { mode: Mode; flash: Flash; sub: string | null; onSub: (s: string | null) => void }) {
  const base = mode === 'project' ? '/api/project' : '/api/platform';
  const [roles, setRoles] = useState<Role[] | null>(null);
  const [catalog, setCatalog] = useState<Feature[]>([]);
  const [fields, setFields] = useState<FieldDef[]>([]);
  const [people, setPeople] = useState<MemberRow[]>([]);
  const [mayCreate, setMayCreate] = useState(mode === 'platform');
  const [view, setView] = useState<'list' | 'perms' | 'fields'>('list');
  const [fresh, setFresh] = useState<number | null>(null);          // a role just created: step two is "set what it can do"

  const load = useCallback(async () => {
    try {
      if (mode === 'project') {
        const [r, f, m] = await Promise.all([api('/api/project/roles'), api('/api/project/ticket-fields'), api('/api/project/members')]);
        const acc = new Map<number, { access: Record<string, Level>; tuned: boolean }>((f.roles as { id: number; access: Record<string, Level>; tuned: boolean }[]).map((x) => [x.id, x]));
        setRoles(r.roles.map((x: any): Role => ({ id: x.id, name: x.name, description: x.description ?? '', system: x.is_system, owned: !!x.owned, locked: x.locked, permTuned: !!x.tuned, fieldsTuned: !!x.fieldsTuned, members: x.members, permissions: x.permissions, access: acc.get(x.id)?.access ?? {} })));
        setCatalog(r.catalog); setFields(f.fields); setMayCreate(!!r.canCreateRoles); setPeople(m);
      } else {
        const [r, c, f] = await Promise.all([api('/api/platform/roles'), api('/api/platform/catalog'), api('/api/platform/ticket-fields')]);
        const acc = new Map<number, Record<string, Level>>((f.roles as { id: number; access: Record<string, Level> }[]).map((x) => [x.id, x.access]));
        setRoles(r.map((x: any): Role => ({ id: x.id, name: x.name, description: x.description ?? '', system: x.is_system, owned: false, locked: x.locked, permTuned: false, fieldsTuned: false, members: x.members, permissions: x.permissions, access: acc.get(x.id) ?? x.fieldAccess ?? {} })));
        setCatalog((c as Feature[]).map((x) => ({ ...x, permissions: x.permissions.filter((p) => p.scope !== 'platform') })).filter((x) => x.permissions.length)); setFields(f.fields);
      }
    } catch (e) { flash('err', (e as Error).message); }
  }, [mode, flash]);
  useEffect(() => { load(); }, [load]);

  if (!roles) return <div className="skeleton" style={{ height: 240 }} aria-busy="true" aria-label="Loading roles" />;
  if (sub === 'new') return <NewRole mode={mode} roles={roles} flash={flash} back={() => onSub(null)} created={async (id) => { await load(); setFresh(id); onSub(String(id)); }} />;
  if (sub) {
    const role = roles.find((r) => String(r.id) === sub);
    return <RolePage key={sub} mode={mode} role={role} roles={roles} catalog={catalog} fields={fields} members={people.filter((p) => String(p.role_id) === sub)} mayManage={mode === 'platform' ? true : mayCreate}
      fresh={fresh === Number(sub)} flash={flash} back={() => { setFresh(null); onSub(null); void load(); }} reload={load} />;
  }
  return (
    <>
      <div className="tbl-tools">
        <div role="group" aria-label="View" className="seg">
          <button type="button" aria-pressed={view === 'list'} onClick={() => setView('list')}>Roles</button>
          <button type="button" aria-pressed={view === 'perms'} onClick={() => setView('perms')}>Compare permissions</button>
          <button type="button" aria-pressed={view === 'fields'} onClick={() => setView('fields')}>Compare ticket fields</button>
        </div>
        <span className="note count-note" aria-live="polite">{view === 'list' ? `${roles.length} roles` : ''}</span>
        {(mode === 'platform' || mayCreate) && <button type="button" className="btn" onClick={() => onSub('new')}>+ New role</button>}
      </div>
      {view === 'perms' && <RoleMatrix mode={mode} flash={flash} />}
      {view === 'fields' && <FieldAdmin mode={mode} flash={flash} />}
      {view === 'list' && (
        <>
          <div className="data-wrap">
            <table className="data-table">
              <caption className="sr">Roles. Select a role to see and change what it may do.</caption>
              <thead><tr><th scope="col">Role</th><th scope="col">Kind</th><th scope="col">People</th><th scope="col">Permissions</th><th scope="col">Ticket fields</th></tr></thead>
              <tbody>
                {roles.map((r) => {
                  const total = catalog.flatMap((f) => f.permissions).length;
                  const lv = Object.values(r.access);
                  return (
                    <tr key={r.id} className="clickable" onClick={() => onSub(String(r.id))}>
                      <td><button type="button" className="person" onClick={(e) => { e.stopPropagation(); onSub(String(r.id)); }} aria-label={`Open role ${r.name}`}>
                        <span className="team-badge" aria-hidden data-role={r.system ? r.name : 'Custom'}>{r.name[0]?.toUpperCase()}</span><span className="person-text"><b>{r.name}</b><span className="note">{r.description || 'No description'}</span></span></button></td>
                      <td>{kind(r, mode)}</td>
                      <td className="num">{r.members || <span className="note">0</span>}</td>
                      <td>{r.locked ? <span className="note">Everything</span> : <><b>{r.permissions.length}</b><span className="note"> of {total}</span></>}</td>
                      <td>{r.locked ? <span className="note">Full access</span> : lv.length ? <span className="note nowrap">{lv.filter((l) => l === 'hidden').length} hidden · {lv.filter((l) => l === 'read').length} read · {lv.filter((l) => l === 'write').length} edit</span> : '—'}</td>
                    </tr>);
                })}
              </tbody>
            </table>
          </div>
          {mode === 'project' && !mayCreate && <p className="note">Creating roles of your own needs a Super Admin to allow it for you.</p>}
        </>)}
    </>);
}

function kind(r: Role, mode: Mode) {
  if (r.locked) return <span className="status">Full access</span>;
  if (mode === 'project') return r.owned ? <span className="status own">This project’s role</span> : r.permTuned || r.fieldsTuned ? <span className="status warn">Standard · customized here</span> : <span className="status">Standard</span>;
  return r.system ? <span className="status">Built-in</span> : <span className="status own">Custom</span>;
}

/* ------------------------------------------------------------------ step one of creating: name it */
function NewRole({ mode, roles, flash, back, created }: { mode: Mode; roles: Role[]; flash: Flash; back: () => void; created: (id: number) => Promise<void> }) {
  const [f, setF] = useState({ name: '', description: '', copy: '' });
  const [err, setErr] = useState(''); const [busy, setBusy] = useState(false);
  async function submit(e: React.FormEvent) {
    e.preventDefault(); setErr('');
    if (f.name.trim().length < 2) { setErr('Give the role a name of at least 2 letters'); return; }
    setBusy(true);
    try {
      const r = await api(`${mode === 'project' ? '/api/project' : '/api/platform'}/roles`, j({ name: f.name, description: f.description, copyFromRoleId: f.copy ? Number(f.copy) : undefined }));
      flash('ok', `Role “${f.name.trim()}” was created.`); await created(r.id);
    } catch (e2) { setErr((e2 as Error).message); } finally { setBusy(false); }
  }
  return (
    <motion.form onSubmit={submit} noValidate className="drill" aria-label="New role" initial={{ opacity: 0, x: 18 }} animate={{ opacity: 1, x: 0 }} transition={{ duration: 0.16 }}>
      <nav className="crumbs" aria-label="Breadcrumb"><button type="button" className="linklike" onClick={back}>Roles</button><span aria-hidden> › </span><span aria-current="page">New role</span></nav>
      <Steps step={1} />
      {err && <p role="alert" className="err banner">{err}</p>}
      <section className="pane drill-card narrow" aria-labelledby="nr">
        <h4 id="nr">Name the role</h4>
        <div className="pf"><label htmlFor="nr-name">Role name <span className="req" aria-hidden>*</span></label><input id="nr-name" value={f.name} maxLength={40} autoFocus onChange={(e) => setF({ ...f, name: e.target.value })} /></div>
        <div className="pf"><label htmlFor="nr-desc">What is this role for?</label><input id="nr-desc" value={f.description} maxLength={200} onChange={(e) => setF({ ...f, description: e.target.value })} /></div>
        <div className="pf"><label htmlFor="nr-copy">Start from</label>
          <select id="nr-copy" value={f.copy} onChange={(e) => setF({ ...f, copy: e.target.value })}><option value="">Start with no permissions</option>{roles.map((r) => <option key={r.id} value={r.id}>Copy of {r.name}</option>)}</select>
          <span className="note">Copying starts the new role with that role’s permissions and ticket-field access. You change them in the next step.</span></div>
      </section>
      <div className="tb-bar drill-bar" role="region" aria-label="Continue"><span className="note">Next: choose what it can do and see.</span>
        <button type="button" className="btn ghost" onClick={back} disabled={busy}>Cancel</button><button className="btn" disabled={busy}>{busy ? 'Creating…' : 'Create role and continue'}</button></div>
    </motion.form>);
}

function Steps({ step }: { step: 1 | 2 }) {
  return (
    <ol className="mini-steps" aria-label="Steps">
      <li className={step === 1 ? 'cur' : 'done'} aria-current={step === 1 ? 'step' : undefined}><span className="n">{step === 2 ? '✓' : 1}</span>Name the role</li>
      <li className={step === 2 ? 'cur' : ''} aria-current={step === 2 ? 'step' : undefined}><span className="n">2</span>Choose what it can do</li>
    </ol>);
}

/* ------------------------------------------------------------------ step two: one role */
function RolePage({ mode, role, roles, catalog, fields, members, mayManage, fresh, flash, back, reload }: {
  mode: Mode; role: Role | undefined; roles: Role[]; catalog: Feature[]; fields: FieldDef[]; members: MemberRow[]; mayManage: boolean; fresh: boolean; flash: Flash; back: () => void; reload: () => Promise<void>;
}) {
  const base = mode === 'project' ? '/api/project' : '/api/platform';
  const [tab, setTab] = useState<'perms' | 'fields'>('perms');
  const [q, setQ] = useState('');
  const [perms, setPerms] = useState<string[]>(role?.permissions ?? []);
  const [access, setAccess] = useState<Record<string, Level>>(role?.access ?? {});
  const [meta, setMeta] = useState({ name: role?.name ?? '', description: role?.description ?? '' });
  const [err, setErr] = useState('');
  const [permTuned, setPermTuned] = useState(role?.permTuned ?? false);
  const [fieldsTuned, setFieldsTuned] = useState(role?.fieldsTuned ?? false);
  const [ver, setVer] = useState(0);
  // What is on screen is authoritative while you edit (a quick second tick must not be overwritten by an older server copy);
  // it is re-read only when the page opens and after a reset, which changes many values at once.
  useEffect(() => { if (role) { setPerms(role.permissions); setAccess(role.access); setPermTuned(role.permTuned); setFieldsTuned(role.fieldsTuned); } }, [role?.id, ver]);   // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (role) setMeta({ name: role.name, description: role.description }); }, [role?.name, role?.description]);   // eslint-disable-line react-hooks/exhaustive-deps
  const label = useMemo(() => new Map(catalog.flatMap((f) => f.permissions).map((p) => [p.key, p.label])), [catalog]);

  if (!role) return <div className="pane" style={{ padding: 20 }}><p>That role no longer exists.</p><button className="btn ghost" onClick={back}>Back to roles</button></div>;
  const canEditMeta = mode === 'platform' ? !role.system : role.owned && mayManage;
  const metaDirty = meta.name.trim() !== role.name || meta.description.trim() !== role.description;
  const total = catalog.flatMap((f) => f.permissions).length;

  async function togglePerm(key: string, on: boolean) {
    const next = on ? [...perms, key] : perms.filter((p) => p !== key);
    setPerms(next);
    try { await api(`${base}/roles/${role!.id}/permissions`, j({ permissions: next }, 'PUT')); flash('ok', `${role!.name} ${on ? 'can now' : 'can no longer'} “${label.get(key) ?? key}”${mode === 'project' ? ' in this project' : ''}.`); setPermTuned(true); }
    catch (e) { setPerms(perms); flash('err', (e as Error).message); }
  }
  async function setGroup(f: Feature, on: boolean) {
    const keys = f.permissions.map((p) => p.key);
    const next = on ? [...new Set([...perms, ...keys])] : perms.filter((p) => !keys.includes(p));
    setPerms(next);
    try { await api(`${base}/roles/${role!.id}/permissions`, j({ permissions: next }, 'PUT')); flash('ok', `${role!.name} ${on ? 'can now' : 'can no longer'} use everything under ${f.feature}.`); setPermTuned(true); }
    catch (e) { setPerms(perms); flash('err', (e as Error).message); }
  }
  async function setLevel(f: FieldDef, level: Level) {
    const prev = access[f.key]; setAccess({ ...access, [f.key]: level });
    try { await api(`${base}/roles/${role!.id}/ticket-fields`, j({ access: { [f.key]: level } }, 'PUT')); flash('ok', `${role!.name}: ${f.label.toLowerCase()} is now ${LEVEL_TEXT[level].toLowerCase()}.`); setFieldsTuned(true); }
    catch (e) { setAccess({ ...access, [f.key]: prev }); flash('err', (e as Error).message); }
  }
  async function reset(what: 'permissions' | 'ticket-fields') {
    try { await api(`${base}/roles/${role!.id}/${what}`, { method: 'DELETE' }); flash('ok', `${role!.name} is back to the standard ${what === 'permissions' ? 'permissions' : 'ticket-field access'}.`); await reload(); setVer((v) => v + 1); } catch (e) { flash('err', (e as Error).message); }
  }
  async function saveMeta(e: React.FormEvent) {
    e.preventDefault(); setErr('');
    try { await api(`${base}/roles/${role!.id}`, j({ name: meta.name.trim(), description: meta.description.trim() }, 'PATCH')); flash('ok', 'Role details saved.'); await reload(); } catch (e2) { setErr((e2 as Error).message); }
  }
  async function remove() {
    if (!confirm(`Delete the role “${role!.name}”? ${mode === 'project' ? 'It is removed from this project.' : 'It is removed from the catalog.'}`)) return;
    try { await api(`${base}/roles/${role!.id}`, { method: 'DELETE' }); flash('ok', `Deleted “${role!.name}”.`); await reload(); back(); } catch (e) { setErr((e as Error).message); }
  }

  const shown = catalog.map((f) => ({ ...f, permissions: f.permissions.filter((p) => !q.trim() || `${p.label} ${p.description}`.toLowerCase().includes(q.trim().toLowerCase())) })).filter((f) => f.permissions.length);
  const standardTuned = mode === 'project' && !role.owned && !role.locked;

  return (
    <motion.div className="drill" aria-label={`Role ${role.name}`} initial={{ opacity: 0, x: 18 }} animate={{ opacity: 1, x: 0 }} transition={{ duration: 0.16 }}>
      <nav className="crumbs" aria-label="Breadcrumb"><button type="button" className="linklike" onClick={back}>Roles</button><span aria-hidden> › </span><span aria-current="page">{role.name}</span></nav>
      {fresh && <><Steps step={2} /><p className="scope-warn unclear" role="note" style={{ margin: 0 }}><b>Step 2: choose what “{role.name}” can do.</b><span>Tick its permissions and set the ticket fields it can see. Changes are saved as you make them. Give the role to people under Members.</span><button type="button" className="btn sm" onClick={back}>Done</button></p></>}
      <header className="drill-head">
        <RoleBadge role={role.system ? role.name : 'Custom'} />
        <div className="drill-title"><h4>{role.name}</h4><p className="note">{role.description || 'No description'}</p></div>
        <div className="drill-badges">{kind(role, mode)}<span className="status">{role.members} {role.members === 1 ? 'person' : 'people'}</span></div>
      </header>
      {err && <p role="alert" className="err banner">{err}</p>}

      {canEditMeta && (
        <form onSubmit={saveMeta} className="pane drill-card" aria-label="Role details">
          <h4>Details</h4>
          <div className="pf-grid">
            <div className="pf"><label htmlFor="rp-name">Name</label><input id="rp-name" value={meta.name} maxLength={40} onChange={(e) => setMeta({ ...meta, name: e.target.value })} /></div>
            <div className="pf"><label htmlFor="rp-desc">Description</label><input id="rp-desc" value={meta.description} maxLength={200} onChange={(e) => setMeta({ ...meta, description: e.target.value })} /></div>
          </div>
          <div className="row"><button className="btn sm" disabled={!metaDirty || meta.name.trim().length < 2}>Save details</button></div>
        </form>)}

      <div className="seg" role="tablist" aria-label="What to change">
        <button type="button" role="tab" aria-selected={tab === 'perms'} onClick={() => setTab('perms')}>Permissions <span className="chip">{role.locked ? 'all' : `${perms.length}/${total}`}</span></button>
        <button type="button" role="tab" aria-selected={tab === 'fields'} onClick={() => setTab('fields')}>Field access</button>
        {standardTuned && tab === 'perms' && permTuned && <button type="button" className="btn ghost sm" onClick={() => reset('permissions')} aria-label={`Reset ${role.name} to the standard role`}>Reset to standard</button>}
        {standardTuned && tab === 'fields' && fieldsTuned && <button type="button" className="btn ghost sm" onClick={() => reset('ticket-fields')} aria-label={`Reset ${role.name} ticket fields to the standard role`}>Reset to standard</button>}
      </div>

      {tab === 'perms' && (
        <section className="pane drill-card" aria-label="Permissions">
          {role.locked ? <p className="note" style={{ margin: 0 }}>Project Admin always has every project permission and cannot be restricted.</p> : (<>
            <div className="search-wrap"><label className="sr" htmlFor="rp-q">Find a permission</label><input id="rp-q" type="search" placeholder="Find a permission…" value={q} onChange={(e) => setQ(e.target.value)} /></div>
            {shown.map((f) => {
              const keys = f.permissions.map((p) => p.key); const on = keys.filter((k) => perms.includes(k)).length;
              return (
                <fieldset key={f.feature} className="perm-group"><legend>{f.feature} <span className="note">{on} of {keys.length}</span></legend>
                  <button type="button" className="linklike sm-link" onClick={() => setGroup(f, on !== keys.length)} aria-label={`${on === keys.length ? 'Clear' : 'Select'} all ${f.feature} permissions`}>{on === keys.length ? 'Clear all' : 'Select all'}</button>
                  {f.permissions.map((p) => (
                    <label key={p.key} className={`perm-row ${perms.includes(p.key) ? 'on' : ''}`}>
                      <input type="checkbox" checked={perms.includes(p.key)} aria-label={`${role.name} role: ${p.label}`} onChange={(e) => togglePerm(p.key, e.target.checked)} />
                      <span className="person-text"><b>{p.label}</b><span className="note">{p.description}</span></span></label>))}
                </fieldset>);
            })}
            {shown.length === 0 && <p className="note">No permission matches.</p>}
          </>)}
        </section>)}

      {tab === 'fields' && (
        <section className="pane drill-card" aria-label="Ticket fields">
          {role.locked ? <p className="note" style={{ margin: 0 }}>Project Admin always has full access to every ticket field.</p> : (
            <div className="field-list">
              {fields.map((f) => (
                <div key={f.key} className="field-line">
                  <span className="person-text"><b>{f.label}</b><span className="note">{f.description}</span></span>
                  <select className={`lvl lvl-${access[f.key]}`} aria-label={`${role.name} role: ${f.label}`} value={access[f.key] ?? 'hidden'} onChange={(e) => setLevel(f, e.target.value as Level)}>
                    {(['hidden', 'read', 'write'] as Level[]).filter((l) => !(l === 'hidden' && f.min !== 'hidden') && !(l === 'write' && !f.writable)).map((l) => <option key={l} value={l}>{LEVEL_TEXT[l]}</option>)}
                  </select>
                </div>))}
            </div>)}
        </section>)}

      {mode === 'project' && (
        <section className="pane drill-card" aria-label="People with this role">
          <h4>People with this role</h4>
          {members.length === 0 ? <p className="note" style={{ margin: 0 }}>Nobody has this role yet. Give it to someone under Members.</p> : (
            <div className="people-pick">{members.map((m) => (
              <a key={m.id} className="person-check" href={`#members/${m.id}`}><Avatar name={m.name} size={28} /><span className="person-text"><b>{m.name}</b><span className="note">{m.job_title ?? m.email}</span></span></a>))}</div>)}
        </section>)}

      {mayManage && (mode === 'platform' ? !role.system : role.owned) && (
        <section className="danger-zone" aria-label="Delete role"><div><b>Delete this role</b><p className="note" style={{ margin: 0 }}>{role.members ? 'It can be deleted once nobody holds it.' : 'Nobody holds it, so it can be deleted.'}</p></div>
          <button type="button" className="btn ghost danger" onClick={remove}>Delete role</button></section>)}
      {roles.length === 0 && null}
    </motion.div>);
}
