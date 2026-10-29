'use client';
import { useCallback, useEffect, useState } from 'react';
import { j } from '../lib/auth';

type Approver = { kind: 'user' | 'role'; id: string | number; name: string };
type Level = { name: string; rule: 'any' | 'all'; approvers: Approver[]; eligible?: number };
type Workflow = { id: string; name: string; description: string; kinds: (typeof KINDS[number])[]; ticketTypeIds: number[]; active: boolean; levels: Level[] };
type Options = { ticketTypes: { id: number; name: string; short: string }[]; roles: { id: number; name: string }[]; users: { id: string; name: string; role: string }[] };
type Draft = { id: string | null; name: string; description: string; kinds: (typeof KINDS[number])[]; ticketTypeIds: number[]; active: boolean; levels: Level[] };

const blank = (): Draft => ({ id: null, name: '', description: '', kinds: ['FS', 'TS'], ticketTypeIds: [], active: true, levels: [{ name: 'L1', rule: 'any', approvers: [] }] });
import { KINDS, LABEL as KIND } from '../lib/docKinds';
/** Levels still carrying a default name (L1, L2…) are renumbered when levels are added, removed or moved. */
const renumber = (ls: Level[]) => ls.map((l, i) => (/^L\d+$/.test(l.name) ? { ...l, name: `L${i + 1}` } : l));

async function api(path: string, init?: RequestInit) {
  const r = await fetch(path, init); const b = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(b.details?.[0]?.message ?? b.error ?? 'Something went wrong');
  return b;
}

/** The chain drawn as connected steps: L1 → L2 → L3. */
export function Chain({ levels, compact }: { levels: Level[]; compact?: boolean }) {
  return (
    <ol className={`chain ${compact ? 'compact' : ''}`} aria-label="Approval levels in order">
      {levels.map((l, i) => (
        <li key={i} className={l.eligible === 0 ? 'bad' : ''}>
          <span className="chain-name">{l.name}</span>
          <span className="chain-rule">{l.approvers.length === 1 && l.approvers[0].kind === 'user' ? 'Approver' : l.rule === 'all' ? 'Everyone in' : 'Any one in'}</span>
          <span className="chain-who">{l.approvers.map((a) => <span key={`${a.kind}${a.id}`} className="chip">{a.kind === 'role' ? `${a.name} role` : a.name}</span>)}</span>
          {l.eligible === 0 && <span className="chain-warn">No active people</span>}
        </li>))}
    </ol>
  );
}

export function WorkflowAdmin({ flash }: { flash: (kind: 'ok' | 'err', text: string) => void }) {
  const [list, setList] = useState<Workflow[]>([]);
  const [opts, setOpts] = useState<Options | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => { const [w, o] = await Promise.all([api('/api/project/workflows'), api('/api/project/workflows/options')]); setList(w); setOpts(o); }, []);
  useEffect(() => { load().catch((e) => flash('err', e.message)); }, [load, flash]);

  const edit = (w: Workflow) => setDraft({ id: w.id, name: w.name, description: w.description, kinds: w.kinds, ticketTypeIds: w.ticketTypeIds ?? [], active: w.active, levels: w.levels.map((l) => ({ name: l.name, rule: l.rule, approvers: l.approvers })) });
  const setLevels = (f: (ls: Level[]) => Level[]) => setDraft((d) => d && { ...d, levels: renumber(f(d.levels)) });
  const patchLevel = (i: number, p: Partial<Level>) => setLevels((ls) => ls.map((l, k) => (k === i ? { ...l, ...p } : l)));
  const move = (i: number, d: -1 | 1) => setLevels((ls) => { const n = [...ls]; [n[i], n[i + d]] = [n[i + d], n[i]]; return n; });

  function addApprover(i: number, value: string) {
    if (!value || !opts) return;
    const [kind, id] = value.split(':');
    const a: Approver = kind === 'role'
      ? { kind: 'role', id: Number(id), name: opts.roles.find((r) => r.id === Number(id))!.name }
      : { kind: 'user', id, name: opts.users.find((u) => u.id === id)!.name };
    setLevels((ls) => ls.map((l, k) => (k === i && !l.approvers.some((x) => x.kind === a.kind && String(x.id) === String(a.id)) ? { ...l, approvers: [...l.approvers, a] } : l)));
  }

  async function save(e: React.FormEvent) {
    e.preventDefault(); if (!draft) return;
    setBusy(true);
    const body = { name: draft.name, description: draft.description, kinds: draft.kinds, ticketTypeIds: draft.ticketTypeIds, active: draft.active,
      levels: draft.levels.map((l) => ({ name: l.name, rule: l.rule, approvers: l.approvers.map((a) => ({ kind: a.kind, id: a.id })) })) };
    try {
      await api(draft.id ? `/api/project/workflows/${draft.id}` : '/api/project/workflows', j(body, draft.id ? 'PUT' : 'POST'));
      flash('ok', `Saved “${draft.name}”. New requests use it straight away; requests already under way keep their old route.`); setDraft(null); load();
    } catch (er) { flash('err', (er as Error).message); } finally { setBusy(false); }
  }
  async function del(w: Workflow) {
    if (!confirm(`Delete the workflow “${w.name}”? Requests already under way are not affected.`)) return;
    try { await api(`/api/project/workflows/${w.id}`, { method: 'DELETE' }); flash('ok', `Deleted “${w.name}”.`); load(); } catch (e) { flash('err', (e as Error).message); }
  }
  async function toggle(w: Workflow) {
    try { await api(`/api/project/workflows/${w.id}`, j({ name: w.name, description: w.description, kinds: w.kinds, ticketTypeIds: w.ticketTypeIds ?? [], active: !w.active, levels: w.levels.map((l) => ({ name: l.name, rule: l.rule, approvers: l.approvers.map((a) => ({ kind: a.kind, id: a.id })) })) }, 'PUT')); flash('ok', `“${w.name}” is now ${w.active ? 'off' : 'on'}.`); load(); }
    catch (e) { flash('err', (e as Error).message); }
  }

  return (
    <>
      {!draft && <div className="row"><button className="btn" onClick={() => setDraft(blank())}>New workflow</button></div>}

      {draft && opts && (
        <form className="pane build wf-editor" onSubmit={save} aria-label={draft.id ? 'Edit workflow' : 'New workflow'}>
          <h3>{draft.id ? 'Edit workflow' : 'New workflow'}</h3>
          <div className="wf-grid">
            <div className="field"><label htmlFor="wn">Name</label><input id="wn" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} required minLength={2} placeholder="e.g. Regulated change approval" /></div>
            <fieldset className="field"><legend>Documents</legend>
              <div className="checks">{KINDS.map((k) => (
                <label key={k} className="check"><input type="checkbox" checked={draft.kinds.includes(k)} onChange={(e) => setDraft({ ...draft, kinds: e.target.checked ? [...draft.kinds, k] : draft.kinds.filter((x) => x !== k) })} /> {KIND[k]}</label>))}</div></fieldset>
            <fieldset className="field"><legend>New tickets <span className="note">(approved before work starts)</span></legend>
              <div className="checks">{opts.ticketTypes.map((t) => (
                <label key={t.id} className="check"><input type="checkbox" checked={draft.ticketTypeIds.includes(t.id)} onChange={(e) => setDraft({ ...draft, ticketTypeIds: e.target.checked ? [...draft.ticketTypeIds, t.id] : draft.ticketTypeIds.filter((x) => x !== t.id) })} /> {t.name}</label>))}</div></fieldset>
            <div className="field"><label htmlFor="wd">Description <span className="note">(optional)</span></label><input id="wd" value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} /></div>
          </div>

          <h4 className="mini" style={{ margin: '12px 0 8px' }}>Approval levels, in order</h4>
          <ol className="levels">
            {draft.levels.map((l, i) => (
              <li key={i} className="level" aria-label={`Level ${i + 1}`}>
                <span className="level-no" aria-hidden>{i + 1}</span>
                <div className="level-body">
                  <div className="row" style={{ margin: 0 }}>
                    <div className="field" style={{ margin: 0 }}><label htmlFor={`ln${i}`} className="sr">Level {i + 1} name</label>
                      <input id={`ln${i}`} value={l.name} onChange={(e) => patchLevel(i, { name: e.target.value })} required maxLength={30} style={{ width: 130, fontWeight: 600 }} /></div>
                    <div className="field" style={{ margin: 0 }}><label htmlFor={`lr${i}`} className="sr">Level {i + 1} rule</label>
                      <select id={`lr${i}`} value={l.rule} onChange={(e) => patchLevel(i, { rule: e.target.value as 'any' | 'all' })}>
                        <option value="any">Any one approver is enough</option><option value="all">Everyone must approve</option></select></div>
                    <span className="grow" />
                    <button type="button" className="btn ghost sm" disabled={i === 0} onClick={() => move(i, -1)} aria-label={`Move level ${i + 1} earlier`}>↑</button>
                    <button type="button" className="btn ghost sm" disabled={i === draft.levels.length - 1} onClick={() => move(i, 1)} aria-label={`Move level ${i + 1} later`}>↓</button>
                    <button type="button" className="link-btn" disabled={draft.levels.length === 1} onClick={() => setLevels((ls) => ls.filter((_, k) => k !== i))}>Remove level</button>
                  </div>
                  <div className="row" style={{ margin: '8px 0 0' }}>
                    {l.approvers.map((a) => (
                      <span key={`${a.kind}${a.id}`} className="chip removable">{a.kind === 'role' ? `${a.name} role` : a.name}
                        <button type="button" aria-label={`Remove ${a.name} from ${l.name}`} onClick={() => patchLevel(i, { approvers: l.approvers.filter((x) => !(x.kind === a.kind && String(x.id) === String(a.id))) })}>×</button></span>))}
                    {l.approvers.length === 0 && <span className="note">Nobody chosen yet</span>}
                    <label className="sr" htmlFor={`la${i}`}>Add an approver to {l.name}</label>
                    <select id={`la${i}`} value="" onChange={(e) => addApprover(i, e.target.value)}>
                      <option value="">+ Add approver…</option>
                      <optgroup label="Everyone in a role">{opts.roles.map((r) => <option key={r.id} value={`role:${r.id}`}>{r.name}</option>)}</optgroup>
                      <optgroup label="A specific person">{opts.users.map((u) => <option key={u.id} value={`user:${u.id}`}>{u.name} ({u.role})</option>)}</optgroup>
                    </select>
                  </div>
                </div>
              </li>))}
          </ol>
          <div className="row"><button type="button" className="btn ghost" disabled={draft.levels.length >= 10} onClick={() => setLevels((ls) => [...ls, { name: `L${ls.length + 1}`, rule: 'any', approvers: [] }])}>Add level</button>
            <span className="note">Up to 10 levels. Requesters are never asked to approve their own request, and nobody is asked twice.</span></div>

          <label className="check" style={{ margin: '8px 0' }}><input type="checkbox" checked={draft.active} onChange={(e) => setDraft({ ...draft, active: e.target.checked })} /> Active</label>
          <div className="row">
            <button className="btn" type="submit" disabled={busy || !draft.name.trim() || (draft.kinds.length === 0 && draft.ticketTypeIds.length === 0) || draft.levels.some((l) => l.approvers.length === 0)}>{draft.id ? 'Save changes' : 'Create workflow'}</button>
            <button type="button" className="btn ghost" onClick={() => setDraft(null)}>Cancel</button>
            {draft.levels.some((l) => l.approvers.length === 0) && <span className="note">Every level needs at least one approver.</span>}
          </div>
        </form>)}

      <div className="wf-list">
        {list.map((w) => (
          <article key={w.id} className={`wf ${w.active ? '' : 'off'}`} aria-label={`Workflow ${w.name}`}>
            <header>
              <div><h3>{w.name}</h3>
                <p className="note" style={{ margin: 0 }}>{[...w.kinds.map((k) => KIND[k]), ...(w.ticketTypeIds ?? []).map((id) => `New ${opts?.ticketTypes.find((t) => t.id === id)?.name ?? 'ticket'}`)].join(', ')}{w.description ? ` · ${w.description}` : ''}</p></div>
              <div className="row" style={{ margin: 0 }}>
                <span className="role-badge" data-role={w.active ? 'Manager' : 'Custom'}>{w.active ? 'Active' : 'Off'}</span>
                <button className="btn ghost sm" onClick={() => toggle(w)}>{w.active ? 'Turn off' : 'Turn on'}</button>
                <button className="btn ghost sm" onClick={() => edit(w)}>Edit</button>
                <button className="link-btn" onClick={() => del(w)}>Delete</button>
              </div>
            </header>
            <Chain levels={w.levels} />
          </article>))}
      </div>
    </>
  );
}
