'use client';
import { useCallback, useEffect, useState } from 'react';
import { api, type Flash } from './consoleBits';
import { j } from '../lib/auth';
import type { FieldKind } from '../lib/workflow';

type Field = { key: string; label: string; kind: FieldKind; options: string[]; required: boolean; help: string };
type CType = { id: number; key: string; name: string; short: string; description: string; fields: Field[] };
type CPhase = { id: number; name: string; tone: string; position: number; defaultOn: boolean; locked: boolean };
type Edge = { ticketTypeId: number | null; from: number | null; to: number; gated: string | null };
type Template = { id: number; key: string; name: string; description: string; phases: CPhase[]; ticketTypeIds: number[]; edges: Edge[] };
type PType = { id: number; key: string; name: string; description: string; defaultTemplateId: number | null; ticketDefaults: { ticketTypeId: number; on: boolean; isDefault: boolean }[]; phaseDefaults: { phaseId: number; enabled: boolean }[] };
type Catalog = { projectTypes: PType[]; templates: Template[]; ticketTypes: CType[] };
const KINDS: FieldKind[] = ['text', 'textarea', 'select', 'number', 'date', 'checkbox'];
const TONES = ['intake', 'spec', 'build', 'review', 'done'];
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 28);
const P = (path: string, method: string, body?: unknown) => api(`/api/platform/workflow/${path}`, { ...(body !== undefined ? j(body, method) : { method }) });

/** Platform console → Workflows: the shared building blocks every project's template is made from. */
export function WorkflowMasters({ flash }: { flash: Flash }) {
  const [cat, setCat] = useState<Catalog | null>(null);
  const [allPhases, setAllPhases] = useState<{ id: number; name: string; tone: string }[]>([]);
  const load = useCallback(async () => {
    try { const c: Catalog = await api('/api/platform/workflow/catalog'); setCat(c); const s = await api('/api/platform/workflow/phases'); setAllPhases(s); }
    catch (e) { flash('err', (e as Error).message); }
  }, [flash]);
  useEffect(() => { load(); }, [load]);
  if (!cat) return <div className="skeleton" style={{ height: 200 }} aria-busy="true" />;
  return (
    <div style={{ display: 'grid', gap: 18 }}>
      <TicketTypes cat={cat} reload={load} flash={flash} />
      <Methodologies cat={cat} allPhases={allPhases} reload={load} flash={flash} />
      <ProjectTypes cat={cat} reload={load} flash={flash} />
    </div>);
}

/* ------------------------------------------------------------------ ticket types */
function TicketTypes({ cat, reload, flash }: { cat: Catalog; reload: () => void; flash: Flash }) {
  const [sel, setSel] = useState<number | 'new' | null>(null);
  const cur = typeof sel === 'number' ? cat.ticketTypes.find((t) => t.id === sel) : null;
  const [d, setD] = useState<{ key: string; name: string; short: string; description: string; fields: Field[] }>({ key: '', name: '', short: '', description: '', fields: [] });
  useEffect(() => { if (cur) setD({ key: cur.key, name: cur.name, short: cur.short, description: cur.description, fields: cur.fields.map((f) => ({ ...f, options: [...f.options] })) }); if (sel === 'new') setD({ key: '', name: '', short: '', description: '', fields: [] }); }, [sel, cur]);
  const setField = (i: number, patch: Partial<Field>) => setD({ ...d, fields: d.fields.map((f, k) => (k === i ? { ...f, ...patch } : f)) });
  const move = (i: number, dir: -1 | 1) => { const f = [...d.fields]; const k = i + dir; if (k < 0 || k >= f.length) return; [f[i], f[k]] = [f[k], f[i]]; setD({ ...d, fields: f }); };

  async function save(e: React.FormEvent) {
    e.preventDefault();
    try {
      const body = { name: d.name, short: d.short, description: d.description, fields: d.fields };
      if (sel === 'new') { const r = await P('ticket-types', 'POST', { ...body, key: d.key || slug(d.name) }); setSel(r.id); } else await P(`ticket-types/${sel}`, 'PUT', body);
      flash('ok', 'Ticket type saved.'); reload();
    } catch (er) { flash('err', (er as Error).message); }
  }
  async function remove() {
    if (!cur || !confirm(`Delete the ticket type “${cur.name}”?`)) return;
    try { await P(`ticket-types/${cur.id}`, 'DELETE'); setSel(null); flash('ok', 'Ticket type deleted.'); reload(); } catch (er) { flash('err', (er as Error).message); }
  }

  return (
    <section className="pane tb-sec" aria-label="Ticket types">
      <div className="row" style={{ justifyContent: 'space-between', margin: 0 }}><h3 style={{ margin: 0 }}>Ticket types</h3><button className="btn sm" onClick={() => setSel('new')}>New ticket type</button></div>
      <p className="note">What people can create, and the fields each kind asks for. Projects choose which of these they allow.</p>
      <div className="tb-cards">
        {cat.ticketTypes.map((t) => (
          <button key={t.id} type="button" className={`tb-card ${sel === t.id ? 'on' : ''}`} onClick={() => setSel(t.id)}>
            <span><span className="type-tag">{t.short}</span> <b>{t.name}</b></span><span className="note">{t.fields.length} field{t.fields.length === 1 ? '' : 's'}</span>
          </button>))}
      </div>
      {sel !== null && (
        <form onSubmit={save} aria-label={sel === 'new' ? 'New ticket type' : `Edit ${cur?.name}`} style={{ marginTop: 14 }}>
          <div className="wf-grid">
            <div className="field"><label htmlFor="tt-name">Name</label><input id="tt-name" value={d.name} onChange={(e) => setD({ ...d, name: e.target.value })} required minLength={2} /></div>
            <div className="field"><label htmlFor="tt-short">Short tag</label><input id="tt-short" value={d.short} onChange={(e) => setD({ ...d, short: e.target.value })} required minLength={2} maxLength={6} /></div>
            <div className="field"><label htmlFor="tt-desc">Description</label><input id="tt-desc" value={d.description} onChange={(e) => setD({ ...d, description: e.target.value })} /></div>
          </div>
          <h4 className="mini">Fields</h4>
          {d.fields.length === 0 && <p className="note">No extra fields yet.</p>}
          {d.fields.map((f, i) => (
            <div key={i} className="field-row" role="group" aria-label={`Field ${i + 1}`}>
              <input aria-label={`Field ${i + 1} label`} placeholder="Label" value={f.label} onChange={(e) => setField(i, { label: e.target.value, key: f.key && cur?.fields.some((x) => x.key === f.key) ? f.key : slug(e.target.value) })} />
              <select aria-label={`Field ${i + 1} kind`} value={f.kind} onChange={(e) => setField(i, { kind: e.target.value as FieldKind })}>{KINDS.map((k) => <option key={k}>{k}</option>)}</select>
              {f.kind === 'select' && <input aria-label={`Field ${i + 1} options`} placeholder="Options, comma separated" value={f.options.join(', ')} onChange={(e) => setField(i, { options: e.target.value.split(',').map((x) => x.trim()).filter(Boolean) })} />}
              <label className="check"><input type="checkbox" checked={f.required} onChange={(e) => setField(i, { required: e.target.checked })} /> Required</label>
              <input aria-label={`Field ${i + 1} help`} placeholder="Help text" value={f.help} onChange={(e) => setField(i, { help: e.target.value })} />
              <button type="button" className="btn ghost sm" onClick={() => move(i, -1)} aria-label={`Move field ${i + 1} up`}>↑</button>
              <button type="button" className="btn ghost sm" onClick={() => move(i, 1)} aria-label={`Move field ${i + 1} down`}>↓</button>
              <button type="button" className="btn ghost sm" onClick={() => setD({ ...d, fields: d.fields.filter((_, k) => k !== i) })} aria-label={`Remove field ${i + 1}`}>✕</button>
            </div>))}
          <div className="row">
            <button type="button" className="btn ghost sm" onClick={() => setD({ ...d, fields: [...d.fields, { key: '', label: '', kind: 'text', options: [], required: false, help: '' }] })}>Add a field</button>
            <button className="btn">Save ticket type</button>
            {cur && <button type="button" className="btn ghost" onClick={remove}>Delete</button>}
            <button type="button" className="btn ghost" onClick={() => setSel(null)}>Close</button>
          </div>
        </form>)}
    </section>);
}

/* ------------------------------------------------------------------ methodologies */
function Methodologies({ cat, allPhases, reload, flash }: { cat: Catalog; allPhases: { id: number; name: string; tone: string }[]; reload: () => void; flash: Flash }) {
  const [id, setId] = useState<number>(cat.templates[0]?.id);
  const tpl = cat.templates.find((t) => t.id === id) ?? cat.templates[0];
  const [d, setD] = useState<{ name: string; description: string; phases: { id: number; defaultOn: boolean }[]; types: number[]; edges: { ticketTypeId: number | null; from: number | null; to: number; gated: string | null }[] } | null>(null);
  const [scope, setScope] = useState<number | null>(null);
  const [newPhase, setNewPhase] = useState({ name: '', tone: 'build' });
  const [fresh, setFresh] = useState({ name: '', copyFrom: 0 });
  useEffect(() => { if (tpl) { setD({ name: tpl.name, description: tpl.description, phases: tpl.phases.map((p) => ({ id: p.id, defaultOn: p.defaultOn })), types: [...tpl.ticketTypeIds], edges: tpl.edges.map((e) => ({ ...e })) }); setScope(null); } }, [tpl]);
  if (!tpl || !d) return null;
  const phaseName = (pid: number | null) => (pid === null ? 'New ticket' : allPhases.find((p) => p.id === pid)?.name ?? '?');
  const locked = new Set(tpl.phases.filter((p) => p.locked).map((p) => p.id));
  const shown = d.edges.map((e, i) => ({ e, i })).filter(({ e }) => e.ticketTypeId === scope);
  const dirty = JSON.stringify(d) !== JSON.stringify({ name: tpl.name, description: tpl.description, phases: tpl.phases.map((p) => ({ id: p.id, defaultOn: p.defaultOn })), types: tpl.ticketTypeIds, edges: tpl.edges });

  const movePhase = (i: number, dir: -1 | 1) => { const p = [...d.phases]; const k = i + dir; if (k < 0 || k >= p.length) return; [p[i], p[k]] = [p[k], p[i]]; setD({ ...d, phases: p }); };
  const setEdge = (i: number, patch: Partial<Edge>) => setD({ ...d, edges: d.edges.map((e, k) => (k === i ? { ...e, ...patch } : e)) });

  async function save() {
    try {
      await P(`templates/${tpl.id}`, 'PUT', { name: d!.name, description: d!.description, phases: d!.phases.map((p) => ({ phaseId: p.id, defaultOn: p.defaultOn })), ticketTypeIds: d!.types,
        edges: d!.edges.filter((e) => !e.gated).map((e) => ({ ticketTypeId: e.ticketTypeId, from: e.from, to: e.to })) });
      flash('ok', 'Methodology saved. Projects using it follow.'); reload();
    } catch (er) { flash('err', (er as Error).message); }
  }
  async function addPhase(e: React.FormEvent) {
    e.preventDefault();
    try { const r = await P('phases', 'POST', newPhase); setD({ ...d!, phases: [...d!.phases, { id: r.id, defaultOn: true }] }); setNewPhase({ name: '', tone: 'build' }); flash('ok', `Phase added. Save to put it in ${tpl.name}.`); await reload(); }
    catch (er) { flash('err', (er as Error).message); }
  }
  async function create(e: React.FormEvent) {
    e.preventDefault();
    try { const r = await P('templates', 'POST', { key: slug(fresh.name), name: fresh.name, copyFrom: fresh.copyFrom || undefined }); setFresh({ name: '', copyFrom: 0 }); await reload(); setId(r.id); flash('ok', 'Methodology created.'); }
    catch (er) { flash('err', (er as Error).message); }
  }
  const unused = allPhases.filter((p) => !d.phases.some((x) => x.id === p.id));
  const scopeTypes = cat.ticketTypes.filter((t) => d.types.includes(t.id));

  return (
    <section className="pane tb-sec" aria-label="Methodologies">
      <h3>Methodologies</h3>
      <p className="note">The phases a kind of project can have and how tickets move between them. Steps that carry documents and approvals are part of the product and stay locked.</p>
      <div className="row" role="tablist" aria-label="Methodology">
        {cat.templates.map((t) => <button key={t.id} role="tab" className="tab" aria-selected={t.id === tpl.id} onClick={() => setId(t.id)}>{t.name}</button>)}
      </div>
      <div className="wf-grid">
        <div className="field"><label htmlFor="mt-name">Name</label><input id="mt-name" value={d.name} onChange={(e) => setD({ ...d, name: e.target.value })} /></div>
        <div className="field"><label htmlFor="mt-desc">Description</label><input id="mt-desc" value={d.description} onChange={(e) => setD({ ...d, description: e.target.value })} /></div>
      </div>

      <h4 className="mini">Phases, in board order</h4>
      <ol className="mp-phases">
        {d.phases.map((p, i) => (
          <li key={p.id}>
            <span className="tb-phase-name">{phaseName(p.id)}</span>
            <label className="check"><input type="checkbox" checked={p.defaultOn} onChange={(e) => setD({ ...d, phases: d.phases.map((x) => (x.id === p.id ? { ...x, defaultOn: e.target.checked } : x)) })} /> On by default</label>
            <button type="button" className="btn ghost sm" onClick={() => movePhase(i, -1)} aria-label={`Move ${phaseName(p.id)} earlier`}>↑</button>
            <button type="button" className="btn ghost sm" onClick={() => movePhase(i, 1)} aria-label={`Move ${phaseName(p.id)} later`}>↓</button>
            <button type="button" className="btn ghost sm" disabled={locked.has(p.id)} title={locked.has(p.id) ? 'Documents and approvals depend on this phase' : ''} onClick={() => setD({ ...d, phases: d.phases.filter((x) => x.id !== p.id), edges: d.edges.filter((e) => e.from !== p.id && e.to !== p.id) })} aria-label={`Remove ${phaseName(p.id)}`}>Remove</button>
          </li>))}
      </ol>
      <div className="row">
        {unused.length > 0 && <select aria-label="Add an existing phase" value="" onChange={(e) => e.target.value && setD({ ...d, phases: [...d.phases, { id: Number(e.target.value), defaultOn: true }] })}><option value="">Add an existing phase…</option>{unused.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>}
      </div>
      <form className="row" onSubmit={addPhase} aria-label="Create a phase">
        <input aria-label="New phase name" placeholder="New phase name" value={newPhase.name} onChange={(e) => setNewPhase({ ...newPhase, name: e.target.value })} />
        <select aria-label="New phase kind" value={newPhase.tone} onChange={(e) => setNewPhase({ ...newPhase, tone: e.target.value })}>{TONES.map((t) => <option key={t}>{t}</option>)}</select>
        <button className="btn ghost sm" disabled={newPhase.name.trim().length < 1}>Create phase</button>
      </form>

      <h4 className="mini">Ticket types this methodology can carry</h4>
      <div className="checks">{cat.ticketTypes.map((t) => <label key={t.id} className="check"><input type="checkbox" checked={d.types.includes(t.id)} onChange={(e) => setD({ ...d, types: e.target.checked ? [...d.types, t.id] : d.types.filter((x) => x !== t.id), edges: e.target.checked ? d.edges : d.edges.filter((x) => x.ticketTypeId !== t.id) })} /> {t.name}</label>)}</div>

      <h4 className="mini">Transitions</h4>
      <div className="row" role="tablist" aria-label="Transitions for">
        <button role="tab" className="tab" aria-selected={scope === null} onClick={() => setScope(null)}>General flow</button>
        {scopeTypes.map((t) => <button key={t.id} role="tab" className="tab" aria-selected={scope === t.id} onClick={() => setScope(t.id)}>{t.name} only</button>)}
      </div>
      <p className="note" style={{ marginTop: 0 }}>{scope === null ? 'Used by every ticket type that has no flow of its own.' : 'When a ticket type has its own flow, it uses only these transitions.'} “New ticket” is where a ticket starts.</p>
      <table className="grid users" aria-label="Transitions">
        <thead><tr><th>From</th><th>To</th><th><span className="sr">Actions</span></th></tr></thead>
        <tbody>
          {shown.map(({ e, i }) => (
            <tr key={i}>
              <td>{e.gated ? phaseName(e.from) : <select aria-label={`Transition ${i + 1} from`} value={e.from ?? ''} onChange={(ev) => setEdge(i, { from: ev.target.value ? Number(ev.target.value) : null })}><option value="">New ticket</option>{d.phases.map((p) => <option key={p.id} value={p.id}>{phaseName(p.id)}</option>)}</select>}</td>
              <td>{e.gated ? phaseName(e.to) : <select aria-label={`Transition ${i + 1} to`} value={e.to} onChange={(ev) => setEdge(i, { to: Number(ev.target.value) })}>{d.phases.map((p) => <option key={p.id} value={p.id}>{phaseName(p.id)}</option>)}</select>}</td>
              <td>{e.gated ? <span className="note" title={e.gated}>Locked: documents and approvals</span> : <button type="button" className="btn ghost sm" onClick={() => setD({ ...d, edges: d.edges.filter((_, k) => k !== i) })} aria-label={`Remove transition ${i + 1}`}>Remove</button>}</td>
            </tr>))}
          {shown.length === 0 && <tr><td colSpan={3} className="note">No transitions in this flow yet.</td></tr>}
        </tbody>
      </table>
      <div className="row">
        <button type="button" className="btn ghost sm" onClick={() => setD({ ...d, edges: [...d.edges, { ticketTypeId: scope, from: d.phases[0]?.id ?? null, to: d.phases[1]?.id ?? d.phases[0]?.id, gated: null }] })}>Add a transition</button>
        <button className="btn" disabled={!dirty} onClick={save}>Save methodology</button>
        {dirty && <button type="button" className="btn ghost" onClick={() => setD({ name: tpl.name, description: tpl.description, phases: tpl.phases.map((p) => ({ id: p.id, defaultOn: p.defaultOn })), types: [...tpl.ticketTypeIds], edges: tpl.edges.map((e) => ({ ...e })) })}>Discard</button>}
      </div>
      <form className="row" onSubmit={create} aria-label="New methodology">
        <input aria-label="New methodology name" placeholder="New methodology name" value={fresh.name} onChange={(e) => setFresh({ ...fresh, name: e.target.value })} />
        <select aria-label="Start from" value={fresh.copyFrom} onChange={(e) => setFresh({ ...fresh, copyFrom: Number(e.target.value) })}><option value={0}>Start empty</option>{cat.templates.map((t) => <option key={t.id} value={t.id}>Copy of {t.name}</option>)}</select>
        <button className="btn ghost sm" disabled={fresh.name.trim().length < 2}>Create methodology</button>
      </form>
    </section>);
}

/* ------------------------------------------------------------------ project types */
function ProjectTypes({ cat, reload, flash }: { cat: Catalog; reload: () => void; flash: Flash }) {
  const [id, setId] = useState<number>(cat.projectTypes[0]?.id);
  const pt = cat.projectTypes.find((p) => p.id === id) ?? cat.projectTypes[0];
  const [d, setD] = useState<{ name: string; description: string; templateTypeId: number; tickets: Record<number, { on: boolean; isDefault: boolean }>; phases: Record<number, boolean> } | null>(null);
  useEffect(() => {
    if (!pt) return;
    setD({ name: pt.name, description: pt.description, templateTypeId: pt.defaultTemplateId ?? cat.templates[0].id,
      tickets: Object.fromEntries(pt.ticketDefaults.map((t) => [t.ticketTypeId, { on: t.on, isDefault: t.isDefault }])), phases: Object.fromEntries(pt.phaseDefaults.map((p) => [p.phaseId, p.enabled])) });
  }, [pt, cat.templates]);
  if (!pt || !d) return null;
  const tpl = cat.templates.find((t) => t.id === d.templateTypeId)!;
  async function save() {
    try {
      await P(`project-types/${pt.id}`, 'PUT', { name: d!.name, description: d!.description, templateTypeId: d!.templateTypeId,
        ticketDefaults: tpl.ticketTypeIds.map((t) => ({ ticketTypeId: t, on: !!d!.tickets[t]?.on, isDefault: !!d!.tickets[t]?.isDefault && !!d!.tickets[t]?.on })),
        phaseDefaults: Object.entries(d!.phases).filter(([p]) => tpl.phases.some((x) => x.id === Number(p))).map(([p, enabled]) => ({ phaseId: Number(p), enabled })) });
      flash('ok', 'Project type saved. New projects of this type start from it.'); reload();
    } catch (er) { flash('err', (er as Error).message); }
  }
  return (
    <section className="pane tb-sec" aria-label="Project types">
      <h3>Project types</h3>
      <p className="note">What a new project of each kind starts with. Project Admins can still change their own project afterwards.</p>
      <div className="row" role="tablist" aria-label="Project type">{cat.projectTypes.map((p) => <button key={p.id} role="tab" className="tab" aria-selected={p.id === pt.id} onClick={() => setId(p.id)}>{p.name}</button>)}</div>
      <div className="wf-grid">
        <div className="field"><label htmlFor="pt-name">Name</label><input id="pt-name" value={d.name} onChange={(e) => setD({ ...d, name: e.target.value })} /></div>
        <div className="field"><label htmlFor="pt-tpl">Recommended methodology</label><select id="pt-tpl" value={d.templateTypeId} onChange={(e) => setD({ ...d, templateTypeId: Number(e.target.value) })}>{cat.templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select></div>
      </div>
      <h4 className="mini">Ticket types switched on at the start</h4>
      <div className="checks">{cat.ticketTypes.filter((t) => tpl.ticketTypeIds.includes(t.id)).map((t) => (
        <span key={t.id} className="check">
          <label><input type="checkbox" checked={!!d.tickets[t.id]?.on} onChange={(e) => setD({ ...d, tickets: { ...d.tickets, [t.id]: { on: e.target.checked, isDefault: d.tickets[t.id]?.isDefault ?? false } } })} /> {t.name}</label>
          <label className="note"><input type="radio" name="pt-default" disabled={!d.tickets[t.id]?.on} checked={!!d.tickets[t.id]?.isDefault} onChange={() => setD({ ...d, tickets: Object.fromEntries(Object.entries({ ...d.tickets, [t.id]: { on: true, isDefault: false } }).map(([k, v]) => [k, { ...v, isDefault: Number(k) === t.id }])) })} /> default</label>
        </span>))}</div>
      <h4 className="mini">Phases that start switched off or on</h4>
      <div className="checks">{tpl.phases.map((p) => <label key={p.id} className="check"><input type="checkbox" disabled={p.locked} checked={d.phases[p.id] ?? p.defaultOn} onChange={(e) => setD({ ...d, phases: { ...d.phases, [p.id]: e.target.checked } })} /> {p.name}</label>)}</div>
      <div className="row"><button className="btn" onClick={save}>Save project type</button></div>
    </section>);
}
