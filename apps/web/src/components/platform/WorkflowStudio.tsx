'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { motion } from 'framer-motion';
import { api, type Flash } from '../consoleBits';
import { j } from '../../lib/auth';
import { Field } from '../people/shared';
import { TONE_LABEL, type FieldKind } from '../../lib/workflow';

type TField = { key: string; label: string; kind: FieldKind; options: string[]; required: boolean; help: string };
type DocMode = 'off' | 'optional' | 'required';
type CType = { id: number; key: string; name: string; short: string; description: string; fields: TField[]; documents?: Record<string, DocMode> };
const DOCS: { kind: string; label: string }[] = [{ kind: 'FS', label: 'Functional Specification' }, { kind: 'TS', label: 'Technical Specification' }, { kind: 'TUT', label: 'Unit Test' }, { kind: 'CRC', label: 'Code Review Checklist' }];
const DEFAULT_DOCS: Record<string, DocMode> = { FS: 'optional', TS: 'optional', TUT: 'optional', CRC: 'optional' };
type CPhase = { id: number; name: string; tone: keyof typeof TONE_LABEL; position: number; defaultOn: boolean; locked: boolean };
type Edge = { ticketTypeId: number | null; from: number | null; to: number; gated: string | null };
type Template = { id: number; key: string; name: string; description: string; phases: CPhase[]; ticketTypeIds: number[]; edges: Edge[] };
type PType = { id: number; key: string; name: string; description: string; defaultTemplateId: number | null; ticketDefaults: { ticketTypeId: number; on: boolean; isDefault: boolean }[]; phaseDefaults: { phaseId: number; enabled: boolean }[] };
type Catalog = { projectTypes: PType[]; templates: Template[]; ticketTypes: CType[] };
type MPhase = { id: number; name: string; tone: keyof typeof TONE_LABEL };
type Usage = { ticketTypes: Record<number, { projects: number; tickets: number }>; templates: Record<number, { projects: number }>; projectTypes: Record<number, { projects: number }>; phases: Record<number, { methodologies: number; tickets: number }> };
type Ctx = { cat: Catalog; phases: MPhase[]; usage: Usage; reload: () => Promise<void>; flash: Flash };

const KINDS: { kind: FieldKind; label: string; icon: string }[] = [
  { kind: 'text', label: 'Short text', icon: 'Aa' }, { kind: 'textarea', label: 'Long text', icon: '¶' }, { kind: 'select', label: 'Choice', icon: '▾' },
  { kind: 'number', label: 'Number', icon: '#' }, { kind: 'date', label: 'Date', icon: '📅' }, { kind: 'checkbox', label: 'Yes / no', icon: '☑' },
];
const TONES = Object.keys(TONE_LABEL) as (keyof typeof TONE_LABEL)[];
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 28);
const P = (path: string, method: string, body?: unknown) => api(`/api/platform/workflow/${path}`, body !== undefined ? j(body, method) : { method });
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const ek = (from: number | null, to: number) => `${from ?? 'start'}>${to}`;

type Tab = 'types' | 'meths' | 'ptypes' | 'phases';
const TABS: { key: Tab; label: string }[] = [{ key: 'types', label: 'Ticket types' }, { key: 'meths', label: 'Methodologies' }, { key: 'ptypes', label: 'Project types' }, { key: 'phases', label: 'Phase library' }];

/** Platform → Workflows: the shared building blocks every project's lifecycle is made from, one list per kind and one page per item. */
export function WorkflowStudio({ flash, sub, onSub }: { flash: Flash; sub: string | null; onSub: (s: string | null) => void }) {
  const [cat, setCat] = useState<Catalog | null>(null);
  const [phases, setPhases] = useState<MPhase[]>([]);
  const [usage, setUsage] = useState<Usage | null>(null);
  const reload = useCallback(async () => {
    try { const [c, p, u] = await Promise.all([api('/api/platform/workflow/catalog'), api('/api/platform/workflow/phases'), api('/api/platform/workflow/usage')]); setCat(c); setPhases(p); setUsage(u); }
    catch (e) { flash('err', (e as Error).message); }
  }, [flash]);
  useEffect(() => { reload(); }, [reload]);
  if (!cat || !usage) return <div className="tb-skel" aria-busy="true" aria-label="Loading workflows"><div className="skeleton" style={{ height: 60 }} /><div className="skeleton" style={{ height: 260 }} /></div>;
  const ctx: Ctx = { cat, phases, usage, reload, flash };
  const [kind, id] = (sub ?? '').split(':');
  const tab: Tab = (kind === 'type' ? 'types' : kind === 'meth' ? 'meths' : kind === 'ptype' ? 'ptypes' : (TABS.find((t) => t.key === kind)?.key ?? 'types'));
  const back = () => onSub(tab);

  if (kind === 'type' && id) return <TypePage key={id} id={id} ctx={ctx} back={back} open={onSub} />;
  if (kind === 'meth' && id) return <MethPage key={id} id={id} ctx={ctx} back={back} open={onSub} />;
  if (kind === 'ptype' && id) return <PTypePage key={id} id={id} ctx={ctx} back={back} open={onSub} />;
  const counts: Record<Tab, number> = { types: cat.ticketTypes.length, meths: cat.templates.length, ptypes: cat.projectTypes.length, phases: phases.length };
  return (
    <div className="wfs">
      <div className="wfs-tabs" role="tablist" aria-label="Workflow building blocks">
        {TABS.map((t) => <button key={t.key} role="tab" type="button" aria-selected={tab === t.key} className="wfs-tab" onClick={() => onSub(t.key)}>{t.label}<span className="count">{counts[t.key]}</span></button>)}
      </div>
      {tab === 'types' && <TypesList ctx={ctx} open={onSub} />}
      {tab === 'meths' && <MethList ctx={ctx} open={onSub} />}
      {tab === 'ptypes' && <PTypeList ctx={ctx} open={onSub} />}
      {tab === 'phases' && <PhaseLibrary ctx={ctx} />}
    </div>);
}

const Intro = ({ children, action }: { children: React.ReactNode; action?: React.ReactNode }) => <div className="wfs-intro"><p className="note">{children}</p>{action}</div>;

/* ================================================================== ticket types */
function TypesList({ ctx, open }: { ctx: Ctx; open: (s: string) => void }) {
  return (<>
    <Intro action={<button type="button" className="btn" onClick={() => open('type:new')}>+ New ticket type</button>}>The kinds of item people can create, and the fields each one asks for. Projects choose which of these they allow.</Intro>
    <ul className="tech-grid">
      {ctx.cat.ticketTypes.map((t) => { const u = ctx.usage.ticketTypes[t.id]; return (
        <li key={t.id} className="tech-card cat"><button type="button" className="cat-open" onClick={() => open(`type:${t.id}`)} aria-label={`Open ticket type ${t.name}`}>
          <span className="tech-name"><span className="type-tag">{t.short}</span> {t.name}</span>
          <span className="note tech-desc">{t.description || 'No description yet.'}</span>
          <span className="tech-kw">{t.fields.slice(0, 5).map((f) => <i key={f.key}>{f.label}{f.required ? '*' : ''}</i>)}{t.fields.length > 5 && <em>+{t.fields.length - 5} more</em>}{!t.fields.length && <em>No extra fields</em>}</span>
          <span className="cat-foot"><span className={`status ${u?.projects ? 'ok' : 'off'}`}>{u?.projects ? `In ${plural(u.projects, 'project')}` : 'Not used yet'}</span><span className="note">{plural(u?.tickets ?? 0, 'ticket')} ›</span></span>
        </button></li>); })}
    </ul></>);
}

function TypePage({ id, ctx, back, open }: { id: string; ctx: Ctx; back: () => void; open: (s: string) => void }) {
  const isNew = id === 'new';
  const cur = ctx.cat.ticketTypes.find((t) => String(t.id) === id);
  const start = useMemo(() => ({ name: cur?.name ?? '', short: cur?.short ?? '', description: cur?.description ?? '', fields: (cur?.fields ?? []).map((f) => ({ ...f, options: [...f.options] })), documents: { ...DEFAULT_DOCS, ...(cur?.documents ?? {}) } as Record<string, DocMode> }), [cur]);
  const [d, setD] = useState(start);
  const [busy, setBusy] = useState(false);
  useEffect(() => { setD(start); }, [start]);
  const u = cur ? ctx.usage.ticketTypes[cur.id] : null;
  const dirty = JSON.stringify(d) !== JSON.stringify(start);
  if (!isNew && !cur) return <Gone what="ticket type" back={back} />;
  const leave = () => { if (!dirty || confirm('Discard your changes?')) back(); };
  const setField = (i: number, p: Partial<TField>) => setD({ ...d, fields: d.fields.map((f, k) => (k === i ? { ...f, ...p } : f)) });
  const move = (i: number, dir: -1 | 1) => { const f = [...d.fields]; const k = i + dir; if (k < 0 || k >= f.length) return; [f[i], f[k]] = [f[k], f[i]]; setD({ ...d, fields: f }); };

  async function save(e: React.FormEvent) {
    e.preventDefault(); setBusy(true);
    try {
      const body = { name: d.name, short: d.short, description: d.description, fields: d.fields, documents: d.documents };
      if (isNew) { const r = await P('ticket-types', 'POST', { ...body, key: slug(d.name) }); ctx.flash('ok', 'Ticket type saved.'); await ctx.reload(); open(`type:${r.id}`); }
      else { await P(`ticket-types/${cur!.id}`, 'PUT', body); ctx.flash('ok', 'Ticket type saved.'); await ctx.reload(); }
    } catch (er) { ctx.flash('err', (er as Error).message); } finally { setBusy(false); }
  }
  async function duplicate() {
    try { const r = await P('ticket-types', 'POST', { key: slug(`${d.name} copy ${Date.now() % 1000}`), name: `${d.name} copy`, short: d.short, description: d.description, fields: d.fields, documents: d.documents }); ctx.flash('ok', `Created “${d.name} copy”. Rename it and choose which methodologies carry it.`); await ctx.reload(); open(`type:${r.id}`); }
    catch (er) { ctx.flash('err', (er as Error).message); }
  }
  async function remove() {
    if (!cur || !confirm(`Delete the ticket type “${cur.name}”?`)) return;
    try { await P(`ticket-types/${cur.id}`, 'DELETE'); ctx.flash('ok', 'Ticket type deleted.'); await ctx.reload(); back(); } catch (er) { ctx.flash('err', (er as Error).message); }
  }
  const carriedBy = cur ? ctx.cat.templates.filter((t) => t.ticketTypeIds.includes(cur.id)) : [];

  return (
    <motion.form onSubmit={save} noValidate className="drill" aria-label={isNew ? 'New ticket type' : `Ticket type ${cur!.name}`} initial={{ opacity: 0, x: 18 }} animate={{ opacity: 1, x: 0 }} transition={{ duration: 0.16 }}>
      <Crumbs root="Ticket types" leave={leave} here={isNew ? 'New ticket type' : cur!.name} />
      {!isNew && <div className="drill-head"><span className="type-tag big">{cur!.short}</span><div className="drill-title"><h4>{cur!.name}</h4><p className="note">{plural(u?.projects ?? 0, 'project')} allow it · {plural(u?.tickets ?? 0, 'ticket')} exist · carried by {carriedBy.length ? carriedBy.map((t) => t.name).join(', ') : 'no methodology yet'}</p></div></div>}
      <div className="drill-grid">
        <section className="pane drill-card" aria-labelledby="tt-basics">
          <h4 id="tt-basics">The ticket type</h4>
          <Field id="tt-name" label="Name" required><input id="tt-name" className="lc-input" value={d.name} onChange={(e) => setD({ ...d, name: e.target.value })} required minLength={2} maxLength={60} /></Field>
          <Field id="tt-short" label="Short tag" required hint="Two to six letters shown on cards, for example INC."><input id="tt-short" className="lc-input" value={d.short} onChange={(e) => setD({ ...d, short: e.target.value })} required minLength={2} maxLength={6} /></Field>
          <Field id="tt-desc" label="Description"><textarea id="tt-desc" className="lc-input" rows={3} value={d.description} onChange={(e) => setD({ ...d, description: e.target.value })} /></Field>
        </section>
        <section className="pane drill-card" aria-labelledby="tt-prev">
          <h4 id="tt-prev">How the form looks</h4>
          <div className="form-preview" aria-label="Form preview">
            <div className="fp-row"><b>Title</b><span className="fp-box" /></div>
            {d.fields.map((f, i) => (
              <div key={i} className="fp-row"><b>{f.label || 'Untitled field'}{f.required && <span className="fp-req"> *</span>}</b>
                {f.kind === 'checkbox' ? <span className="fp-check" /> : f.kind === 'select' ? <span className="fp-box sel">{f.options[0] ?? 'Choose…'} ▾</span> : <span className={`fp-box ${f.kind === 'textarea' ? 'tall' : ''}`}>{f.kind === 'date' ? 'yyyy-mm-dd' : f.kind === 'number' ? '0' : ''}</span>}
                {f.help && <span className="note">{f.help}</span>}</div>))}
            {d.fields.length === 0 && <p className="note" style={{ margin: 0 }}>No extra fields yet: people only give a title.</p>}
          </div>
        </section>
        <section className="pane drill-card wide" aria-labelledby="tt-docs">
          <h4 id="tt-docs">Documents this kind of ticket uses</h4>
          <p className="note" style={{ marginTop: 0 }}>An incident usually needs only evidence that it was tested; a change or a new requirement needs the full set. <b>Required</b> documents must be approved before a ticket of this kind can be closed. <b>Off</b> hides the document from these tickets.</p>
          <ul className="doc-modes">
            {DOCS.map((x) => (
              <li key={x.kind}><span>{x.label}</span>
                <span className="seg" role="radiogroup" aria-label={`${x.label} for ${d.name || 'this ticket type'}`}>
                  {(['off', 'optional', 'required'] as DocMode[]).map((m) => <button key={m} type="button" role="radio" aria-checked={d.documents[x.kind] === m} onClick={() => setD({ ...d, documents: { ...d.documents, [x.kind]: m } })}>{m === 'off' ? 'Off' : m === 'optional' ? 'Optional' : 'Required to close'}</button>)}
                </span></li>))}
          </ul>
        </section>
        <section className="pane drill-card wide" aria-labelledby="tt-fields">
          <div className="row" style={{ justifyContent: 'space-between', margin: '0 0 8px' }}><h4 id="tt-fields" style={{ margin: 0 }}>Fields <span className="note">{d.fields.length}</span></h4>
            <button type="button" className="btn ghost sm" onClick={() => setD({ ...d, fields: [...d.fields, { key: '', label: '', kind: 'text', options: [], required: false, help: '' }] })}>Add a field</button></div>
          {u && u.tickets > 0 && <p className="scope-warn unclear" role="note">{plural(u.tickets, 'ticket')} of this type already exist. Existing values stay; a new required field only applies to tickets created or edited from now on.</p>}
          <ol className="fld-list">
            {d.fields.map((f, i) => (
              <li key={i} className="fld" role="group" aria-label={`Field ${i + 1}`}>
                <div className="fld-top">
                  <input className="lc-input" aria-label={`Field ${i + 1} label`} placeholder="Label, for example Impact" value={f.label} onChange={(e) => setField(i, { label: e.target.value, key: f.key && cur?.fields.some((x) => x.key === f.key) ? f.key : slug(e.target.value) })} />
                  <select className="lc-select" aria-label={`Field ${i + 1} kind`} value={f.kind} onChange={(e) => setField(i, { kind: e.target.value as FieldKind })}>{KINDS.map((k) => <option key={k.kind} value={k.kind}>{k.label}</option>)}</select>
                  <label className="check"><input type="checkbox" checked={f.required} onChange={(e) => setField(i, { required: e.target.checked })} /> Required</label>
                  <span className="fld-actions">
                    <button type="button" className="btn ghost sm" onClick={() => move(i, -1)} disabled={i === 0} aria-label={`Move field ${i + 1} up`}>↑</button>
                    <button type="button" className="btn ghost sm" onClick={() => move(i, 1)} disabled={i === d.fields.length - 1} aria-label={`Move field ${i + 1} down`}>↓</button>
                    <button type="button" className="btn ghost sm" onClick={() => setD({ ...d, fields: d.fields.filter((_, k) => k !== i) })} aria-label={`Remove field ${i + 1}`}>✕</button>
                  </span>
                </div>
                {f.kind === 'select' && <OptionsEditor i={i} value={f.options} onChange={(options) => setField(i, { options })} />}
                <input className="lc-input" aria-label={`Field ${i + 1} help`} placeholder="Help text shown under the field (optional)" value={f.help} onChange={(e) => setField(i, { help: e.target.value })} />
                {f.key && <span className="note fld-key">Stored as <code>{f.key}</code></span>}
              </li>))}
          </ol>
        </section>
      </div>
      {!isNew && (
        <section className="danger-zone" aria-label="More actions">
          <div><b>Duplicate or delete</b><p className="note" style={{ margin: 0 }}>{u?.tickets ? `${plural(u.tickets, 'ticket')} use this type, so it cannot be deleted.` : 'Nothing uses it, so it can be deleted.'}</p></div>
          <span className="row" style={{ margin: 0 }}><button type="button" className="btn ghost" onClick={duplicate}>Duplicate</button><button type="button" className="btn danger" disabled={!!u?.tickets} onClick={remove}>Delete</button></span>
        </section>)}
      <SaveBar dirty={dirty} isNew={isNew} busy={busy} what="ticket type" leave={leave} canSave={d.name.trim().length >= 2 && d.short.trim().length >= 2} />
    </motion.form>);
}

function OptionsEditor({ i, value, onChange }: { i: number; value: string[]; onChange: (v: string[]) => void }) {
  const [t, setT] = useState('');
  const add = (raw: string) => { const terms = raw.split(',').map((x) => x.trim()).filter(Boolean); if (terms.length) onChange([...value, ...terms.filter((x) => !value.includes(x))]); setT(''); };
  return (
    <div className="kw-editor">
      <ul className="kw-list" aria-label={`Field ${i + 1} choices`}>{value.map((o) => <li key={o}><span>{o}</span><button type="button" aria-label={`Remove choice ${o}`} onClick={() => onChange(value.filter((x) => x !== o))}>×</button></li>)}{!value.length && <li className="note">Add at least one choice.</li>}</ul>
      <input className="lc-input" aria-label={`Field ${i + 1} options`} placeholder="Type a choice and press Enter (or paste a comma-separated list)" value={t}
        onChange={(e) => (e.target.value.includes(',') ? add(e.target.value) : setT(e.target.value))} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add(t); } }} onBlur={() => add(t)} />
    </div>);
}

/* ================================================================== methodologies */
function MethList({ ctx, open }: { ctx: Ctx; open: (s: string) => void }) {
  return (<>
    <Intro action={<button type="button" className="btn" onClick={() => open('meth:new')}>+ New methodology</button>}>A methodology is the set of phases a project works through and how tickets move between them. Steps that carry documents and approvals stay fixed.</Intro>
    <ul className="tech-grid">
      {ctx.cat.templates.map((t) => (
        <li key={t.id} className="tech-card cat"><button type="button" className="cat-open" onClick={() => open(`meth:${t.id}`)} aria-label={`Open methodology ${t.name}`}>
          <span className="tech-name">{t.name}</span><span className="note tech-desc">{t.description || 'No description yet.'}</span>
          <span className="flow-mini" aria-hidden>{t.phases.map((p) => <i key={p.id} data-tone={p.tone} title={p.name} />)}</span>
          <span className="cat-foot"><span className={`status ${ctx.usage.templates[t.id]?.projects ? 'ok' : 'off'}`}>{ctx.usage.templates[t.id]?.projects ? `Used by ${plural(ctx.usage.templates[t.id].projects, 'project')}` : 'Not used yet'}</span><span className="note">{t.phases.length} phases · {t.ticketTypeIds.length} types ›</span></span>
        </button></li>))}
    </ul></>);
}

type MDraft = { name: string; description: string; phases: { id: number; defaultOn: boolean }[]; types: number[]; edges: Edge[] };

function MethPage({ id, ctx, back, open }: { id: string; ctx: Ctx; back: () => void; open: (s: string) => void }) {
  const isNew = id === 'new';
  const tpl = ctx.cat.templates.find((t) => String(t.id) === id);
  const toDraft = (t?: Template): MDraft => ({ name: t?.name ?? '', description: t?.description ?? '', phases: t?.phases.map((p) => ({ id: p.id, defaultOn: p.defaultOn })) ?? [], types: [...(t?.ticketTypeIds ?? [])], edges: t?.edges.map((e) => ({ ...e })) ?? [] });
  const [d, setD] = useState<MDraft>(toDraft(tpl));
  const [scope, setScope] = useState<number | null>(null);
  const [copyFrom, setCopyFrom] = useState(0);
  const [np, setNp] = useState({ name: '', tone: 'build' as keyof typeof TONE_LABEL });
  const [busy, setBusy] = useState(false);
  useEffect(() => { setD(toDraft(tpl)); }, [tpl]);   // eslint-disable-line react-hooks/exhaustive-deps
  const phase = (pid: number) => ctx.phases.find((p) => p.id === pid);
  const nm = (pid: number | null) => (pid === null ? 'New ticket' : phase(pid)?.name ?? '?');
  const locked = useMemo(() => new Set(tpl?.phases.filter((p) => p.locked).map((p) => p.id)), [tpl]);
  const dirty = !isNew && JSON.stringify(d) !== JSON.stringify(toDraft(tpl));
  const usedBy = tpl ? ctx.usage.templates[tpl.id]?.projects ?? 0 : 0;
  if (!isNew && !tpl) return <Gone what="methodology" back={back} />;
  const leave = () => { if (!(dirty || (isNew && (d.name || copyFrom))) || confirm('Discard your changes?')) back(); };

  // ---- the flow of the chosen scope (a ticket type with edges of its own uses only those)
  const hasOwn = (t: number) => d.edges.some((e) => e.ticketTypeId === t);
  const flowEdges = d.edges.filter((e) => e.ticketTypeId === scope);
  const ids = d.phases.map((p) => p.id);
  const has = (from: number | null, to: number) => flowEdges.some((e) => e.from === from && e.to === to);
  const toggle = (from: number | null, to: number, on: boolean) => setD({ ...d, edges: on ? [...d.edges, { ticketTypeId: scope, from, to, gated: null }] : d.edges.filter((e) => !(e.ticketTypeId === scope && e.from === from && e.to === to)) });
  const health = useMemo(() => {
    const out: string[] = [];
    if (scope !== null && !hasOwn(scope)) return out;
    if (!flowEdges.some((e) => e.from === null)) { out.push('No starting phase: choose where a new ticket starts.'); return out; }
    const reach = new Set<number>(); const q = flowEdges.filter((e) => e.from === null).map((e) => e.to);
    while (q.length) { const t = q.shift()!; if (reach.has(t)) continue; reach.add(t); q.push(...flowEdges.filter((e) => e.from === t).map((e) => e.to)); }
    const lost = ids.filter((p) => !reach.has(p) && flowEdges.some((e) => e.from === p || e.to === p));
    if (lost.length) out.push(`${lost.map((p) => nm(p)).join(', ')} can never be reached.`);
    const stuck = [...reach].filter((p) => phase(p)?.tone !== 'done' && !flowEdges.some((e) => e.from === p));
    if (stuck.length) out.push(`${stuck.map((p) => nm(p)).join(', ')} ${stuck.length > 1 ? 'are dead ends' : 'is a dead end'}: tickets cannot leave ${stuck.length > 1 ? 'them' : 'it'}.`);
    if (![...reach].some((p) => phase(p)?.tone === 'done')) out.push('No finishing phase is reachable, so tickets can never be completed.');
    return out;
  }, [flowEdges, scope, ids.join(',')]);   // eslint-disable-line react-hooks/exhaustive-deps
  const order = useMemo(() => { const seen: number[] = []; const q = flowEdges.filter((e) => e.from === null).map((e) => e.to); while (q.length) { const t = q.shift()!; if (seen.includes(t)) continue; seen.push(t); q.push(...flowEdges.filter((e) => e.from === t).map((e) => e.to)); } return seen; }, [flowEdges]);

  const movePhase = (i: number, dir: -1 | 1) => { const p = [...d.phases]; const k = i + dir; if (k < 0 || k >= p.length) return; [p[i], p[k]] = [p[k], p[i]]; setD({ ...d, phases: p }); };
  const removePhase = (pid: number) => setD({ ...d, phases: d.phases.filter((x) => x.id !== pid), edges: d.edges.filter((e) => e.from !== pid && e.to !== pid) });
  const typeName = (t: number) => ctx.cat.ticketTypes.find((x) => x.id === t)?.name ?? '?';
  const scopeTypes = ctx.cat.ticketTypes.filter((t) => d.types.includes(t.id));
  const unused = ctx.phases.filter((p) => !d.phases.some((x) => x.id === p.id));

  async function save() {
    setBusy(true);
    try {
      await P(`templates/${tpl!.id}`, 'PUT', { name: d.name, description: d.description, phases: d.phases.map((p) => ({ phaseId: p.id, defaultOn: p.defaultOn })), ticketTypeIds: d.types, edges: d.edges.filter((e) => !e.gated).map((e) => ({ ticketTypeId: e.ticketTypeId, from: e.from, to: e.to })) });
      ctx.flash('ok', `Methodology saved.${usedBy ? ` ${plural(usedBy, 'project')} using it follow${usedBy === 1 ? 's' : ''}.` : ''}`); await ctx.reload();
    } catch (er) { ctx.flash('err', (er as Error).message); } finally { setBusy(false); }
  }
  async function create(e: React.FormEvent) {
    e.preventDefault(); setBusy(true);
    try { const r = await P('templates', 'POST', { key: slug(d.name), name: d.name, description: d.description, copyFrom: copyFrom || undefined }); ctx.flash('ok', 'Methodology created.'); await ctx.reload(); open(`meth:${r.id}`); }
    catch (er) { ctx.flash('err', (er as Error).message); } finally { setBusy(false); }
  }
  async function duplicate() {
    try { const r = await P('templates', 'POST', { key: slug(`${d.name} copy ${Date.now() % 1000}`), name: `${d.name} copy`, copyFrom: tpl!.id }); ctx.flash('ok', `Created “${d.name} copy”.`); await ctx.reload(); open(`meth:${r.id}`); }
    catch (er) { ctx.flash('err', (er as Error).message); }
  }
  async function remove() {
    if (!tpl || !confirm(`Delete the methodology “${tpl.name}”?`)) return;
    try { await P(`templates/${tpl.id}`, 'DELETE'); ctx.flash('ok', 'Methodology deleted.'); await ctx.reload(); back(); } catch (er) { ctx.flash('err', (er as Error).message); }
  }
  async function createPhase(e: React.FormEvent) {
    e.preventDefault();
    try { const r = await P('phases', 'POST', np); setD({ ...d, phases: [...d.phases, { id: r.id, defaultOn: true }] }); setNp({ name: '', tone: 'build' }); ctx.flash('ok', `Phase “${np.name}” created and added. Save to keep it in ${d.name || 'this methodology'}.`); await ctx.reload(); }
    catch (er) { ctx.flash('err', (er as Error).message); }
  }

  if (isNew) return (
    <motion.form onSubmit={create} className="drill" aria-label="New methodology" initial={{ opacity: 0, x: 18 }} animate={{ opacity: 1, x: 0 }} transition={{ duration: 0.16 }}>
      <Crumbs root="Methodologies" leave={leave} here="New methodology" />
      <section className="pane drill-card narrow" aria-labelledby="nm">
        <h4 id="nm">New methodology</h4>
        <Field id="nm-name" label="Name" required><input id="nm-name" className="lc-input" value={d.name} onChange={(e) => setD({ ...d, name: e.target.value })} required minLength={2} maxLength={60} /></Field>
        <Field id="nm-desc" label="Description"><textarea id="nm-desc" className="lc-input" rows={2} value={d.description} onChange={(e) => setD({ ...d, description: e.target.value })} /></Field>
        <Field id="nm-from" label="Start from" hint="Copying keeps the phases, ticket types and moves, which you can then change."><select id="nm-from" className="lc-select" value={copyFrom} onChange={(e) => setCopyFrom(Number(e.target.value))}><option value={0}>Empty</option>{ctx.cat.templates.map((t) => <option key={t.id} value={t.id}>A copy of {t.name}</option>)}</select></Field>
      </section>
      <SaveBar dirty isNew busy={busy} what="methodology" leave={leave} canSave={d.name.trim().length >= 2} />
    </motion.form>);

  return (
    <motion.div className="drill" role="region" aria-label={`Methodology ${tpl!.name}`} initial={{ opacity: 0, x: 18 }} animate={{ opacity: 1, x: 0 }} transition={{ duration: 0.16 }}>
      <Crumbs root="Methodologies" leave={leave} here={tpl!.name} />
      <div className="drill-head"><div className="drill-title"><h4>{tpl!.name}</h4><p className="note">{usedBy ? `Used by ${plural(usedBy, 'project')}. Changes reach them when you save.` : 'Not used by any project yet.'}</p></div></div>
      {usedBy > 0 && dirty && <p className="scope-warn unclear" role="note"><b>This methodology is live.</b> Saving changes the phases and moves for {plural(usedBy, 'project')}. Tickets in a phase you remove block the save.</p>}
      <div className="drill-grid">
        <section className="pane drill-card" aria-labelledby="mp-basics">
          <h4 id="mp-basics">The methodology</h4>
          <Field id="mt-name" label="Name"><input id="mt-name" className="lc-input" value={d.name} onChange={(e) => setD({ ...d, name: e.target.value })} /></Field>
          <Field id="mt-desc" label="Description"><textarea id="mt-desc" className="lc-input" rows={2} value={d.description} onChange={(e) => setD({ ...d, description: e.target.value })} /></Field>
          <h4 style={{ marginTop: 14 }}>Ticket types it can carry</h4>
          <div className="pj-stacks" role="group" aria-label="Ticket types it can carry">
            {ctx.cat.ticketTypes.map((t) => (
              <label key={t.id} className={`person-check ${d.types.includes(t.id) ? 'on' : ''}`}>
                <input type="checkbox" aria-label={t.name} checked={d.types.includes(t.id)} onChange={(e) => { setD({ ...d, types: e.target.checked ? [...d.types, t.id] : d.types.filter((x) => x !== t.id), edges: e.target.checked ? d.edges : d.edges.filter((x) => x.ticketTypeId !== t.id) }); if (!e.target.checked && scope === t.id) setScope(null); }} />
                <span className="type-tag">{t.short}</span> <b>{t.name}</b></label>))}
          </div>
        </section>
        <section className="pane drill-card" aria-labelledby="mp-phases">
          <h4 id="mp-phases">Phases, in board order <span className="note">{d.phases.length}</span></h4>
          <ol className="mp-list">
            {d.phases.map((p, i) => { const info = phase(p.id); return (
              <li key={p.id} className="tb-phase" data-tone={info?.tone}>
                <span className="tb-phase-name">{nm(p.id)}</span><span className="note">{info ? TONE_LABEL[info.tone] : ''}{locked.has(p.id) ? ' · documents' : ''}</span>
                <label className="switch" title="Switched on when a new project starts"><input type="checkbox" role="switch" aria-label={`${nm(p.id)} on by default`} checked={p.defaultOn} onChange={(e) => setD({ ...d, phases: d.phases.map((x) => (x.id === p.id ? { ...x, defaultOn: e.target.checked } : x)) })} /><span className="track" aria-hidden /></label>
                <span className="fld-actions">
                  <button type="button" className="btn ghost sm" onClick={() => movePhase(i, -1)} disabled={i === 0} aria-label={`Move ${nm(p.id)} earlier`}>↑</button>
                  <button type="button" className="btn ghost sm" onClick={() => movePhase(i, 1)} disabled={i === d.phases.length - 1} aria-label={`Move ${nm(p.id)} later`}>↓</button>
                  <button type="button" className="btn ghost sm" disabled={locked.has(p.id)} title={locked.has(p.id) ? 'Documents and approvals depend on this phase' : ''} onClick={() => removePhase(p.id)} aria-label={`Remove ${nm(p.id)}`}>✕</button>
                </span>
              </li>); })}
          </ol>
          <p className="note" style={{ margin: '4px 0 8px' }}>The switch says whether a new project starts with the phase on.</p>
          <label className="sr" htmlFor="mp-add">Add an existing phase</label>
          <select id="mp-add" className="lc-select" value="" onChange={(e) => e.target.value && setD({ ...d, phases: [...d.phases, { id: Number(e.target.value), defaultOn: true }] })} disabled={!unused.length}>
            <option value="">{unused.length ? '+ Add an existing phase…' : 'Every phase is already here'}</option>{unused.map((p) => <option key={p.id} value={p.id}>{p.name} · {TONE_LABEL[p.tone]}</option>)}</select>
          <form className="row" onSubmit={createPhase} aria-label="Create a phase" style={{ marginTop: 10 }}>
            <input className="lc-input" aria-label="New phase name" placeholder="New phase name" value={np.name} onChange={(e) => setNp({ ...np, name: e.target.value })} style={{ flex: '1 1 160px' }} />
            <select className="lc-select" aria-label="New phase category" value={np.tone} onChange={(e) => setNp({ ...np, tone: e.target.value as typeof np.tone })} style={{ width: 'auto' }}>{TONES.map((t) => <option key={t} value={t}>{TONE_LABEL[t]}</option>)}</select>
            <button className="btn ghost sm" disabled={np.name.trim().length < 1}>Create phase</button>
          </form>
        </section>
        <section className="pane drill-card wide" aria-labelledby="mp-flow">
          <h4 id="mp-flow">How tickets move</h4>
          <div className="wfs-tabs sm" role="tablist" aria-label="Moves for">
            <button role="tab" type="button" className="wfs-tab" aria-selected={scope === null} onClick={() => setScope(null)}>General flow</button>
            {scopeTypes.map((t) => <button key={t.id} role="tab" type="button" className="wfs-tab" aria-selected={scope === t.id} onClick={() => setScope(t.id)}>{t.name}{hasOwn(t.id) && <span className="count">own</span>}</button>)}
          </div>
          {scope === null
            ? <p className="note">The flow every ticket type follows unless it has one of its own. Pick a ticket type above to give it a different flow.</p>
            : hasOwn(scope)
              ? <div className="row" style={{ margin: '0 0 8px' }}><p className="note" style={{ margin: 0 }}>{typeName(scope)} has its <b>own flow</b>: only these moves apply to it.</p><button type="button" className="btn ghost sm" onClick={() => { if (confirm(`Remove ${typeName(scope)}'s own flow? It will follow the general flow again.`)) setD({ ...d, edges: d.edges.filter((e) => e.ticketTypeId !== scope) }); }}>Use the general flow instead</button></div>
              : <div className="row" style={{ margin: '0 0 8px' }}><p className="note" style={{ margin: 0 }}>{typeName(scope)} follows the <b>general flow</b>.</p><button type="button" className="btn sm" onClick={() => setD({ ...d, edges: [...d.edges, ...d.edges.filter((e) => e.ticketTypeId === null).map((e) => ({ ...e, ticketTypeId: scope }))] })}>Give it its own flow (a copy of the general one)</button></div>}
          {(scope === null || hasOwn(scope)) && (<>
            <div className="flow-health" aria-live="polite">
              {health.length === 0 ? <span className="tech-good">✓ This flow is complete: it has a start, every phase is reachable, nothing is a dead end.</span> : health.map((h) => <span key={h} className="tech-warn">⚠ {h}</span>)}
            </div>
            {order.length > 0 && <ol className="tb-flow" aria-label="Order of phases">{order.map((p, i) => <li key={p} data-tone={phase(p)?.tone}>{i > 0 && <span aria-hidden className="arrow">→</span>}<span className="chip">{nm(p)}</span></li>)}</ol>}
            <div className="moves-grid">
              {[null, ...ids].map((from) => (
                <fieldset key={from ?? 'start'} className="lc-moves">
                  <legend>{from === null ? 'A new ticket starts at' : `From ${nm(from)} a ticket can go to`}</legend>
                  {ids.filter((t) => t !== from).map((t) => { const g = d.edges.find((e) => e.ticketTypeId === scope && e.from === from && e.to === t)?.gated; return (
                    <label key={t} className={`check lc-opt ${has(from, t) ? 'on' : ''}`} title={g ?? undefined}>
                      <input type="checkbox" aria-label={`${from === null ? 'Start' : nm(from)} to ${nm(t)}`} checked={has(from, t)} disabled={!!g} onChange={(e) => toggle(from, t, e.target.checked)} /> {nm(t)}{g ? ' (document step)' : ''}</label>); })}
                </fieldset>))}
            </div>
          </>)}
        </section>
      </div>
      <section className="danger-zone" aria-label="More actions">
        <div><b>Duplicate or delete</b><p className="note" style={{ margin: 0 }}>{usedBy ? `${plural(usedBy, 'project')} use it, so it cannot be deleted.` : 'No project uses it, so it can be deleted.'}</p></div>
        <span className="row" style={{ margin: 0 }}><button type="button" className="btn ghost" onClick={duplicate}>Duplicate</button><button type="button" className="btn danger" disabled={usedBy > 0} onClick={remove}>Delete</button></span>
      </section>
      <div className="tb-bar drill-bar" role="region" aria-label="Save changes">
        <span className="note">{dirty ? 'You have unsaved changes.' : 'Everything is saved.'}</span>
        <button type="button" className="btn ghost" disabled={!dirty || busy} onClick={() => setD(toDraft(tpl))}>Discard</button>
        <button type="button" className="btn" disabled={!dirty || busy} onClick={save}>{busy ? 'Saving…' : 'Save methodology'}</button>
      </div>
    </motion.div>);
}

/* ================================================================== project types */
function PTypeList({ ctx, open }: { ctx: Ctx; open: (s: string) => void }) {
  return (<>
    <Intro action={<button type="button" className="btn" onClick={() => open('ptype:new')}>+ New project type</button>}>What a new project of each kind starts with: its methodology, the ticket types switched on, and which phases are on. Project Admins can still change their own project afterwards.</Intro>
    <ul className="tech-grid">
      {ctx.cat.projectTypes.map((p) => { const tpl = ctx.cat.templates.find((t) => t.id === p.defaultTemplateId); return (
        <li key={p.id} className="tech-card cat"><button type="button" className="cat-open" onClick={() => open(`ptype:${p.id}`)} aria-label={`Open project type ${p.name}`}>
          <span className="tech-name">{p.name}</span><span className="note tech-desc">{p.description || 'No description yet.'}</span>
          <span className="tech-kw"><i>Methodology: {tpl?.name ?? '—'}</i>{p.ticketDefaults.filter((x) => x.on).slice(0, 3).map((x) => <i key={x.ticketTypeId}>{ctx.cat.ticketTypes.find((t) => t.id === x.ticketTypeId)?.short}</i>)}</span>
          <span className="cat-foot"><span className={`status ${ctx.usage.projectTypes[p.id]?.projects ? 'ok' : 'off'}`}>{ctx.usage.projectTypes[p.id]?.projects ? `${plural(ctx.usage.projectTypes[p.id].projects, 'project')}` : 'No projects yet'}</span><span className="note">Edit ›</span></span>
        </button></li>); })}
    </ul></>);
}

function PTypePage({ id, ctx, back, open }: { id: string; ctx: Ctx; back: () => void; open: (s: string) => void }) {
  const isNew = id === 'new';
  const pt = ctx.cat.projectTypes.find((p) => String(p.id) === id);
  const firstTpl = ctx.cat.templates[0]?.id ?? 0;
  const toDraft = (p?: PType) => ({ name: p?.name ?? '', description: p?.description ?? '', templateTypeId: p?.defaultTemplateId ?? firstTpl,
    tickets: Object.fromEntries((p?.ticketDefaults ?? []).map((t) => [t.ticketTypeId, { on: t.on, isDefault: t.isDefault }])) as Record<number, { on: boolean; isDefault: boolean }>,
    phases: Object.fromEntries((p?.phaseDefaults ?? []).map((x) => [x.phaseId, x.enabled])) as Record<number, boolean> });
  const [d, setD] = useState(toDraft(pt));
  const [busy, setBusy] = useState(false);
  useEffect(() => { setD(toDraft(pt)); }, [pt]);   // eslint-disable-line react-hooks/exhaustive-deps
  const tpl = ctx.cat.templates.find((t) => t.id === d.templateTypeId);
  const usedBy = pt ? ctx.usage.projectTypes[pt.id]?.projects ?? 0 : 0;
  const dirty = JSON.stringify(d) !== JSON.stringify(toDraft(pt));
  if (!isNew && !pt) return <Gone what="project type" back={back} />;
  if (!tpl) return null;
  const leave = () => { if (!(dirty && (!isNew || d.name)) || confirm('Discard your changes?')) back(); };
  const types = ctx.cat.ticketTypes.filter((t) => tpl.ticketTypeIds.includes(t.id));
  const phaseOn = (p: CPhase) => (d.phases[p.id] ?? p.defaultOn);
  const onTypes = types.filter((t) => d.tickets[t.id]?.on);
  const defaultType = onTypes.find((t) => d.tickets[t.id]?.isDefault) ?? onTypes[0];

  async function save(e: React.FormEvent) {
    e.preventDefault(); setBusy(true);
    try {
      if (isNew) { const r = await P('project-types', 'POST', { key: slug(d.name), name: d.name, description: d.description, templateTypeId: d.templateTypeId }); ctx.flash('ok', 'Project type created. Now choose what its projects start with.'); await ctx.reload(); open(`ptype:${r.id}`); return; }
      await P(`project-types/${pt!.id}`, 'PUT', { name: d.name, description: d.description, templateTypeId: d.templateTypeId,
        ticketDefaults: types.map((t) => ({ ticketTypeId: t.id, on: !!d.tickets[t.id]?.on, isDefault: !!d.tickets[t.id]?.isDefault && !!d.tickets[t.id]?.on })),
        phaseDefaults: tpl!.phases.map((p) => ({ phaseId: p.id, enabled: phaseOn(p) })) });
      ctx.flash('ok', 'Project type saved. New projects of this type start from it.'); await ctx.reload();
    } catch (er) { ctx.flash('err', (er as Error).message); } finally { setBusy(false); }
  }
  async function remove() {
    if (!pt || !confirm(`Delete the project type “${pt.name}”?`)) return;
    try { await P(`project-types/${pt.id}`, 'DELETE'); ctx.flash('ok', 'Project type deleted.'); await ctx.reload(); back(); } catch (er) { ctx.flash('err', (er as Error).message); }
  }
  const setType = (tid: number, on: boolean) => {
    const next = { ...d.tickets, [tid]: { on, isDefault: on ? (d.tickets[tid]?.isDefault ?? false) : false } };
    if (on && !Object.values(next).some((v) => v.on && v.isDefault)) next[tid] = { on: true, isDefault: true };
    setD({ ...d, tickets: next });
  };

  return (
    <motion.form onSubmit={save} noValidate className="drill" aria-label={isNew ? 'New project type' : `Project type ${pt!.name}`} initial={{ opacity: 0, x: 18 }} animate={{ opacity: 1, x: 0 }} transition={{ duration: 0.16 }}>
      <Crumbs root="Project types" leave={leave} here={isNew ? 'New project type' : pt!.name} />
      <div className="drill-grid">
        <section className="pane drill-card" aria-labelledby="pt-basics">
          <h4 id="pt-basics">The project type</h4>
          <Field id="pt-name" label="Name" required><input id="pt-name" className="lc-input" value={d.name} onChange={(e) => setD({ ...d, name: e.target.value })} required minLength={2} maxLength={60} /></Field>
          <Field id="pt-desc" label="Description"><textarea id="pt-desc" className="lc-input" rows={2} value={d.description} onChange={(e) => setD({ ...d, description: e.target.value })} /></Field>
          <Field id="pt-tpl" label="Recommended methodology" hint={usedBy ? 'Applies to new projects only; existing ones keep theirs.' : undefined}>
            <select id="pt-tpl" className="lc-select" value={d.templateTypeId} onChange={(e) => setD({ ...d, templateTypeId: Number(e.target.value) })}>{ctx.cat.templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select></Field>
        </section>
        {!isNew && (
          <section className="pane drill-card" aria-labelledby="pt-prev">
            <h4 id="pt-prev">A new project of this type starts with</h4>
            <p className="note" style={{ marginTop: 0 }}>Methodology <b>{tpl.name}</b></p>
            <ol className="tb-flow" aria-label="Phases a new project starts with">{tpl.phases.filter(phaseOn).map((p, i) => <li key={p.id} data-tone={p.tone}>{i > 0 && <span aria-hidden className="arrow">→</span>}<span className="chip">{p.name}</span></li>)}</ol>
            <p className="note">Allows: {onTypes.length ? onTypes.map((t) => t.name).join(', ') : 'nothing yet (switch on at least one ticket type)'}{defaultType ? ` · default ${defaultType.name}` : ''}</p>
          </section>)}
        {!isNew && (<>
          <section className="pane drill-card" aria-labelledby="pt-types">
            <h4 id="pt-types">Ticket types switched on at the start</h4>
            <ul className="pj-admins">
              {types.map((t) => (
                <li key={t.id}><span className="type-tag">{t.short}</span><span className="person-text"><b>{t.name}</b></span>
                  <label className="check" style={{ marginLeft: 'auto' }}><input type="radio" name="pt-default" disabled={!d.tickets[t.id]?.on} checked={!!d.tickets[t.id]?.isDefault && !!d.tickets[t.id]?.on} onChange={() => setD({ ...d, tickets: Object.fromEntries(Object.entries({ ...d.tickets, [t.id]: { on: true, isDefault: true } }).map(([k, v]) => [k, { ...v, isDefault: Number(k) === t.id }])) })} /> Default</label>
                  <label className="switch"><input type="checkbox" role="switch" aria-label={`${t.name} on at the start`} checked={!!d.tickets[t.id]?.on} onChange={(e) => setType(t.id, e.target.checked)} /><span className="track" aria-hidden /></label></li>))}
            </ul>
          </section>
          <section className="pane drill-card" aria-labelledby="pt-phases">
            <h4 id="pt-phases">Phases switched on at the start</h4>
            <ul className="pj-admins">
              {tpl.phases.map((p) => (
                <li key={p.id} className="tb-phase" data-tone={p.tone}><span className="tb-phase-name">{p.name}</span><span className="note">{TONE_LABEL[p.tone]}{p.locked ? ' · documents' : ''}</span>
                  <label className="switch" style={{ marginLeft: 'auto' }}><input type="checkbox" role="switch" aria-label={`${p.name} on at the start`} disabled={p.locked} checked={phaseOn(p)} onChange={(e) => setD({ ...d, phases: { ...d.phases, [p.id]: e.target.checked } })} /><span className="track" aria-hidden /></label></li>))}
            </ul>
          </section>
        </>)}
      </div>
      {!isNew && <section className="danger-zone" aria-label="Delete project type"><div><b>Delete this project type</b><p className="note" style={{ margin: 0 }}>{usedBy ? `${plural(usedBy, 'project')} are of this type, so it cannot be deleted.` : 'No project is of this type, so it can be deleted.'}</p></div><button type="button" className="btn danger" disabled={usedBy > 0} onClick={remove}>Delete</button></section>}
      <SaveBar dirty={dirty} isNew={isNew} busy={busy} what="project type" leave={leave} canSave={d.name.trim().length >= 2} />
    </motion.form>);
}

/* ================================================================== phase library */
function PhaseLibrary({ ctx }: { ctx: Ctx }) {
  const [np, setNp] = useState({ name: '', tone: 'build' as keyof typeof TONE_LABEL });
  const [tone, setTone] = useState<'all' | keyof typeof TONE_LABEL>('all');
  const shown = ctx.phases.filter((p) => tone === 'all' || p.tone === tone);
  async function create(e: React.FormEvent) {
    e.preventDefault();
    try { await P('phases', 'POST', np); ctx.flash('ok', `Phase “${np.name}” created. Add it to a methodology to use it.`); setNp({ name: '', tone: 'build' }); await ctx.reload(); } catch (er) { ctx.flash('err', (er as Error).message); }
  }
  async function remove(p: MPhase) {
    if (!confirm(`Delete the phase “${p.name}”?`)) return;
    try { await P(`phases/${p.id}`, 'DELETE'); ctx.flash('ok', `Deleted ${p.name}.`); await ctx.reload(); } catch (er) { ctx.flash('err', (er as Error).message); }
  }
  return (<>
    <Intro>Every phase that methodologies can use. A phase belongs to a category, which sets its colour and whether a ticket in it still counts as open (only <b>Done</b> phases finish a ticket).</Intro>
    <form className="pane drill-card" onSubmit={create} aria-label="Create a phase in the library" style={{ marginBottom: 12 }}>
      <div className="row" style={{ margin: 0 }}>
        <input className="lc-input" aria-label="Library phase name" placeholder="New phase name" value={np.name} onChange={(e) => setNp({ ...np, name: e.target.value })} style={{ flex: '1 1 200px' }} />
        <select className="lc-select" aria-label="Library phase category" value={np.tone} onChange={(e) => setNp({ ...np, tone: e.target.value as typeof np.tone })} style={{ width: 'auto' }}>{TONES.map((t) => <option key={t} value={t}>{TONE_LABEL[t]}</option>)}</select>
        <button className="btn" disabled={!np.name.trim()}>Create phase</button>
      </div>
    </form>
    <div className="tbl-tools"><label className="sr" htmlFor="ph-tone">Category</label>
      <select id="ph-tone" className="lc-select" style={{ width: 'auto' }} value={tone} onChange={(e) => setTone(e.target.value as typeof tone)}><option value="all">All categories</option>{TONES.map((t) => <option key={t} value={t}>{TONE_LABEL[t]}</option>)}</select>
      <span className="note count-note">{plural(shown.length, 'phase')}</span></div>
    <div className="data-wrap"><table className="data-table">
      <caption className="sr">Phase library</caption>
      <thead><tr><th scope="col">Phase</th><th scope="col">Category</th><th scope="col">Used in</th><th scope="col" style={{ textAlign: 'right' }}>Tickets in it</th><th scope="col"><span className="sr">Actions</span></th></tr></thead>
      <tbody>{shown.map((p) => { const u = ctx.usage.phases[p.id]; const used = (u?.methodologies ?? 0) + (u?.tickets ?? 0) > 0; return (
        <tr key={p.id}><td><span className="tb-phase-name tone-dot" data-tone={p.tone}>{p.name}</span></td><td>{TONE_LABEL[p.tone]}</td><td>{plural(u?.methodologies ?? 0, 'methodology', 'methodologies')}</td><td className="num">{u?.tickets ?? 0}</td>
          <td style={{ textAlign: 'right' }}><button type="button" className="btn ghost sm" disabled={used} title={used ? 'In use by a methodology or by tickets' : ''} onClick={() => remove(p)} aria-label={`Delete phase ${p.name}`}>Delete</button></td></tr>); })}
        {shown.length === 0 && <tr><td colSpan={5} className="empty-row">No phases in this category.</td></tr>}</tbody>
    </table></div></>);
}

/* ================================================================== shared bits */
function Crumbs({ root, leave, here }: { root: string; leave: () => void; here: string }) {
  return <nav className="crumbs" aria-label="Breadcrumb"><button type="button" className="linklike" onClick={leave}>{root}</button><span aria-hidden> › </span><span aria-current="page">{here}</span></nav>;
}
function Gone({ what, back }: { what: string; back: () => void }) { return <div className="pane" style={{ padding: 20 }}><p>That {what} no longer exists.</p><button className="btn ghost" onClick={back}>Back</button></div>; }
function SaveBar({ dirty, isNew, busy, what, leave, canSave }: { dirty: boolean; isNew: boolean; busy: boolean; what: string; leave: () => void; canSave: boolean }) {
  return (
    <div className="tb-bar drill-bar" role="region" aria-label="Save changes">
      <span className="note">{isNew ? `The ${what} is created when you save.` : dirty ? 'You have unsaved changes.' : 'Everything is saved.'}</span>
      <button type="button" className="btn ghost" onClick={leave} disabled={busy}>{isNew ? 'Cancel' : 'Back'}</button>
      <button className="btn" type="submit" disabled={busy || (!isNew && !dirty) || !canSave}>{busy ? 'Saving…' : isNew ? `Create ${what}` : `Save ${what}`}</button>
    </div>);
}
