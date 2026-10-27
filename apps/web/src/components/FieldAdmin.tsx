'use client';
import { useCallback, useEffect, useState } from 'react';
import { j } from '../lib/auth';

type Level = 'hidden' | 'read' | 'write';
type Field = { key: string; label: string; description: string; writable: boolean; min: Level };
type Role = { id: number; name: string; isSystem: boolean; locked: boolean; tuned?: boolean; access: Record<string, Level> };
const TEXT: Record<Level, string> = { hidden: 'Hidden', read: 'Read only', write: 'Can edit' };

async function api(path: string, init?: RequestInit) {
  const r = await fetch(path, init); const b = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(b.error ?? 'Something went wrong');
  return b;
}

/** Column-level security grid: which ticket fields each role can see or edit. */
export function FieldAdmin({ flash, mode = 'project' }: { flash: (kind: 'ok' | 'err', text: string) => void; mode?: 'project' | 'platform' }) {
  const base = mode === 'project' ? '/api/project' : '/api/platform';
  const [fields, setFields] = useState<Field[]>([]);
  const [roles, setRoles] = useState<Role[]>([]);
  const load = useCallback(async () => { const d = await api(`${base}/ticket-fields`); setFields(d.fields); setRoles(d.roles); }, []);
  useEffect(() => { load().catch((e) => flash('err', e.message)); }, [load, flash]);
  async function reset(role: Role) {
    try { await api(`${base}/roles/${role.id}/ticket-fields`, { method: 'DELETE' }); flash('ok', `${role.name} is back to the standard role.`); load(); } catch (e) { flash('err', (e as Error).message); }
  }

  async function set(role: Role, f: Field, level: Level) {
    const prev = role.access[f.key];
    setRoles((rs) => rs.map((r) => (r.id === role.id ? { ...r, access: { ...r.access, [f.key]: level } } : r)));     // optimistic
    try {
      await api(`${base}/roles/${role.id}/ticket-fields`, j({ access: { [f.key]: level } }, 'PUT'));
      flash('ok', `${role.name}: ${f.label.toLowerCase()} is now ${TEXT[level].toLowerCase()}.`);
    } catch (e) {
      setRoles((rs) => rs.map((r) => (r.id === role.id ? { ...r, access: { ...r.access, [f.key]: prev } } : r)));
      flash('err', (e as Error).message);
    }
  }

  return (
    <>
      <p className="note" style={{ marginTop: 0 }}>{mode === 'project'
        ? 'Decide which parts of a ticket each role can see or change in THIS project. A hidden field is removed from the board, the ticket page, reports and downloads. Roles you have not changed follow the standard setting from the platform; changing one here applies to this project only.'
        : 'The standard field access every project starts from. A project can tune its own copy, and projects that have not follow what you set here.'} The title, phase and dates are always visible. A new role starts with only the title until you open more. Changes apply at once.</p>
      <div className="matrix-wrap">
        <table className="matrix">
          <caption className="sr">Ticket field access by role</caption>
          <thead><tr>
            <th scope="col" className="feat">Ticket field</th>
            {roles.map((r) => (
              <th scope="col" key={r.id} className="rcol">
                <span className="role-badge" data-role={r.isSystem ? r.name : 'Custom'}>{r.name}</span>
                {mode === 'project' && !r.locked && <span className="note">{r.tuned ? 'Customized' : 'Standard'}</span>}
                {mode === 'project' && r.tuned && <button className="link-btn" onClick={() => reset(r)} aria-label={`Reset ${r.name} to the standard role`}>Reset</button>}
              </th>))}
          </tr></thead>
          <tbody>
            {fields.map((f) => (
              <tr key={f.key}>
                <th scope="row" className="feat"><span>{f.label}</span><span className="note">{f.description}</span></th>
                {roles.map((r) => {
                  const level = r.access[f.key];
                  return (
                    <td key={r.id}>
                      <select className={`lvl lvl-${level}`} value={level} disabled={r.locked} aria-label={`${r.name} role: ${f.label}`}
                        title={r.locked ? 'Project Admin always has full access' : undefined} onChange={(e) => set(r, f, e.target.value as Level)}>
                        {(['hidden', 'read', 'write'] as Level[]).filter((l) => !(l === 'hidden' && f.min !== 'hidden') && !(l === 'write' && !f.writable)).map((l) => <option key={l} value={l}>{TEXT[l]}</option>)}
                      </select>
                    </td>);
                })}
              </tr>))}
          </tbody>
        </table>
      </div>
      <p className="note">Project Admin always has full access. Customer and consultant details stay hidden from a role unless you open them, even for tickets that role can otherwise see.</p>
    </>
  );
}
