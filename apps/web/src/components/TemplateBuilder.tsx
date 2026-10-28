'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { api, type Flash } from './consoleBits';
import { j } from '../lib/auth';
import { TONE_LABEL, type TypeField } from '../lib/workflow';

type CPhase = { id: number; name: string; tone: keyof typeof TONE_LABEL; position: number; defaultOn: boolean; locked: boolean };
type Edge = { ticketTypeId: number | null; from: number | null; to: number; gated: string | null };
type Template = { id: number; key: string; name: string; description: string; phases: CPhase[]; ticketTypeIds: number[]; edges: Edge[] };
type PType = { id: number; key: string; name: string; description: string; defaultTemplateId: number | null; ticketDefaults: { ticketTypeId: number; on: boolean; isDefault: boolean }[]; phaseDefaults: { phaseId: number; enabled: boolean }[] };
type CType = { id: number; key: string; name: string; short: string; description: string; fields: TypeField[] };
type Config = {
  projectTypeId: number; templateTypeId: number;
  phases: { phaseId: number; enabled: boolean; tickets: number }[]; ticketTypes: { ticketTypeId: number; enabled: boolean; isDefault: boolean; tickets: number }[];
  catalog: { projectTypes: PType[]; templates: Template[]; ticketTypes: CType[] };
};
interface Draft { ptId: number; ttId: number; phaseOn: Record<number, boolean>; typeOn: Record<number, boolean>; defaultType: number }

/** Defaults for a project type on a methodology: which phases start on, which ticket types, and which one is the default. */
function defaultsFor(cat: Config['catalog'], ptId: number, ttId: number): Draft {
  const pt = cat.projectTypes.find((p) => p.id === ptId)!, tpl = cat.templates.find((t) => t.id === ttId)!;
  const phaseOn = Object.fromEntries(tpl.phases.map((p) => [p.id, pt.phaseDefaults.find((d) => d.phaseId === p.id)?.enabled ?? p.defaultOn]));
  const typeOn = Object.fromEntries(tpl.ticketTypeIds.map((id) => [id, pt.ticketDefaults.find((d) => d.ticketTypeId === id)?.on ?? false]));
  let def = pt.ticketDefaults.find((d) => d.isDefault && typeOn[d.ticketTypeId])?.ticketTypeId ?? Number(Object.keys(typeOn).find((k) => typeOn[+k]));
  if (!Number.isFinite(def)) { const first = tpl.ticketTypeIds[0]; typeOn[first] = true; def = first; }
  return { ptId, ttId, phaseOn, typeOn, defaultType: def };
}

/** The same bypass rule the database applies: follow the methodology's transitions, walking through switched-off phases. */
function flowOf(tpl: Template, typeId: number, on: Record<number, boolean>) {
  const own = tpl.edges.some((e) => e.ticketTypeId === typeId);
  const edges = tpl.edges.filter((e) => (own ? e.ticketTypeId === typeId : e.ticketTypeId === null));
  const step = (from: number | null) => {
    const found = new Set<number>(); const seen = new Set<number>();
    const queue = edges.filter((e) => e.from === from).map((e) => e.to);
    while (queue.length) { const t = queue.shift()!; if (seen.has(t)) continue; seen.add(t); if (on[t]) found.add(t); else queue.push(...edges.filter((e) => e.from === t).map((e) => e.to)); }
    return found;
  };
  const reached: number[] = []; const stack = [...step(null)];
  while (stack.length) { const p = stack.shift()!; if (reached.includes(p)) continue; reached.push(p); stack.push(...step(p)); }
  const pos = new Map(tpl.phases.map((p) => [p.id, p.position]));
  return { start: step(null).size > 0, phases: reached.sort((a, b) => (pos.get(a) ?? 0) - (pos.get(b) ?? 0)), skipped: tpl.phases.filter((p) => !on[p.id]).map((p) => p.id) };
}

export function TemplateBuilder({ flash }: { flash: Flash }) {
  const [cfg, setCfg] = useState<Config | null>(null);
  const [d, setD] = useState<Draft | null>(null);
  const [saved, setSaved] = useState('');
  const [busy, setBusy] = useState(false);
  const [previewType, setPreviewType] = useState<number | null>(null);

  const fromServer = (c: Config): Draft => ({
    ptId: c.projectTypeId, ttId: c.templateTypeId,
    phaseOn: Object.fromEntries(c.phases.map((p) => [p.phaseId, p.enabled])),
    typeOn: Object.fromEntries(c.catalog.templates.find((t) => t.id === c.templateTypeId)!.ticketTypeIds.map((id) => [id, c.ticketTypes.find((t) => t.ticketTypeId === id)?.enabled ?? false])),
    defaultType: c.ticketTypes.find((t) => t.isDefault)?.ticketTypeId ?? c.ticketTypes.find((t) => t.enabled)!.ticketTypeId,
  });
  const load = useCallback(async () => {
    try { const c: Config = await api('/api/project/template'); setCfg(c); const dd = fromServer(c); setD(dd); setSaved(JSON.stringify(dd)); setPreviewType(dd.defaultType); }
    catch (e) { flash('err', (e as Error).message); }
  }, [flash]);
  useEffect(() => { load(); }, [load]);

  const tpl = useMemo(() => cfg?.catalog.templates.find((t) => t.id === d?.ttId), [cfg, d?.ttId]);
  if (!cfg || !d || !tpl) return <div className="tb-skel" aria-busy="true" aria-label="Loading the template builder"><div className="skeleton" style={{ height: 120 }} /><div className="skeleton" style={{ height: 220 }} /><div className="skeleton" style={{ height: 160 }} /></div>;
  const dirty = JSON.stringify(d) !== saved;
  const count = (id: number) => cfg.phases.find((p) => p.phaseId === id)?.tickets ?? 0;
  const typeCount = (id: number) => cfg.ticketTypes.find((t) => t.ticketTypeId === id)?.tickets ?? 0;
  const types = cfg.catalog.ticketTypes.filter((t) => tpl.ticketTypeIds.includes(t.id));
  const pType = cfg.catalog.projectTypes.find((p) => p.id === d.ptId)!;
  const preview = previewType && tpl.ticketTypeIds.includes(previewType) ? flowOf(tpl, previewType, d.phaseOn) : null;
  const phaseName = (id: number) => tpl.phases.find((p) => p.id === id)?.name ?? '';

  const pickProjectType = (p: PType) => { const ttId = p.defaultTemplateId ?? d.ttId; const nd = defaultsFor(cfg.catalog, p.id, ttId); setD(nd); setPreviewType(nd.defaultType); };
  const pickTemplate = (t: Template) => { const nd = defaultsFor(cfg.catalog, d.ptId, t.id); setD(nd); setPreviewType(nd.defaultType); };
  const toggleType = (id: number, on: boolean) => {
    const typeOn = { ...d.typeOn, [id]: on };
    const defaultType = !on && d.defaultType === id ? Number(Object.keys(typeOn).find((k) => typeOn[+k]) ?? id) : (on && !typeOn[d.defaultType] ? id : d.defaultType);
    setD({ ...d, typeOn, defaultType });
  };

  async function save() {
    setBusy(true);
    try {
      await api('/api/project/template', j({ projectTypeId: d!.ptId, templateTypeId: d!.ttId, phases: tpl!.phases.map((p) => ({ phaseId: p.id, enabled: !!d!.phaseOn[p.id] })), ticketTypes: Object.entries(d!.typeOn).map(([id, enabled]) => ({ ticketTypeId: Number(id), enabled })), defaultTicketTypeId: d!.defaultType }, 'PUT'));
      flash('ok', 'Template saved. The board and the create form now follow it.'); await load();
    } catch (e) { flash('err', (e as Error).message); } finally { setBusy(false); }
  }

  return (
    <div className="tb">
      <section className="pane tb-sec" aria-label="Project type">
        <h3>1 · What kind of project is this?</h3>
        <div className="tb-cards" role="radiogroup" aria-label="Project type">
          {cfg.catalog.projectTypes.map((p) => (
            <motion.button key={p.id} type="button" role="radio" aria-checked={p.id === d.ptId} className={`tb-card ${p.id === d.ptId ? 'on' : ''}`} whileHover={{ y: -2 }} whileTap={{ scale: 0.98 }} onClick={() => pickProjectType(p)}>
              <b>{p.name}</b><span className="note">{p.description}</span>
            </motion.button>))}
        </div>
      </section>

      <section className="pane tb-sec" aria-label="Methodology">
        <h3>2 · How does the work flow?</h3>
        <div className="tb-cards" role="radiogroup" aria-label="Methodology">
          {cfg.catalog.templates.map((t) => (
            <motion.button key={t.id} type="button" role="radio" aria-checked={t.id === d.ttId} className={`tb-card ${t.id === d.ttId ? 'on' : ''}`} whileHover={{ y: -2 }} whileTap={{ scale: 0.98 }} onClick={() => pickTemplate(t)}>
              <b>{t.name}</b><span className="note">{t.description}</span>
              <span className="tb-mini">{t.phases.slice(0, 6).map((p) => <i key={p.id} data-tone={p.tone} />)}{t.phases.length > 6 && <em>+{t.phases.length - 6}</em>}</span>
            </motion.button>))}
        </div>
      </section>

      <section className="pane tb-sec" aria-label="Phases">
        <h3>3 · Which phases does this project use?</h3>
        <p className="note" style={{ marginTop: 0 }}>Switch a phase off and tickets skip straight past it. Phases that carry documents and approvals are locked on.</p>
        <ul className="tb-phases">
          {tpl.phases.map((p) => (
            <motion.li key={p.id} layout className={`tb-phase ${d.phaseOn[p.id] ? '' : 'off'}`} data-tone={p.tone}>
              <label className="switch">
                <input type="checkbox" role="switch" aria-label={`${p.name} phase`} checked={!!d.phaseOn[p.id]} disabled={p.locked} onChange={(e) => setD({ ...d, phaseOn: { ...d.phaseOn, [p.id]: e.target.checked } })} />
                <span className="track" aria-hidden />
              </label>
              <span className="tb-phase-name">{p.name}</span>
              <span className="note">{TONE_LABEL[p.tone]}{p.locked ? ' · locked (documents)' : ''}{count(p.id) ? ` · ${count(p.id)} ticket${count(p.id) > 1 ? 's' : ''}` : ''}</span>
            </motion.li>))}
        </ul>
      </section>

      <section className="pane tb-sec" aria-label="Ticket types">
        <h3>4 · Which items can people create?</h3>
        <p className="note" style={{ marginTop: 0 }}>Defaults follow the project type ({pType.name}); change them freely. The default type is what the intake chat creates.</p>
        <div className="tb-cards">
          {types.map((t) => (
            <motion.div key={t.id} layout className={`tb-card type ${d.typeOn[t.id] ? 'on' : ''}`}>
              <div className="row" style={{ margin: 0, justifyContent: 'space-between' }}>
                <span><span className="type-tag">{t.short}</span> <b>{t.name}</b></span>
                <label className="switch"><input type="checkbox" role="switch" aria-label={`Allow ${t.name}`} checked={!!d.typeOn[t.id]} onChange={(e) => toggleType(t.id, e.target.checked)} /><span className="track" aria-hidden /></label>
              </div>
              <span className="note">{t.description}</span>
              {t.fields.length > 0 && <span className="tb-fields">{t.fields.map((f) => <i key={f.key} title={f.help}>{f.label}{f.required ? '*' : ''}</i>)}</span>}
              <label className="check"><input type="radio" name="defaultType" disabled={!d.typeOn[t.id]} checked={d.defaultType === t.id} onChange={() => setD({ ...d, defaultType: t.id })} /> Default{typeCount(t.id) ? ` · ${typeCount(t.id)} existing` : ''}</label>
            </motion.div>))}
        </div>
      </section>

      <section className="pane tb-sec" aria-label="Flow preview">
        <h3>Preview: how a ticket moves</h3>
        <div className="row" role="tablist" aria-label="Ticket type to preview">
          {types.filter((t) => d.typeOn[t.id]).map((t) => <button key={t.id} role="tab" className="tab" aria-selected={previewType === t.id} onClick={() => setPreviewType(t.id)}>{t.name}</button>)}
        </div>
        <AnimatePresence mode="wait">
          <motion.div key={`${previewType}-${JSON.stringify(d.phaseOn)}`} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.12 }}>
            {preview && !preview.start && <p role="alert" className="err">With these phases, {types.find((t) => t.id === previewType)?.name} has no starting phase.</p>}
            {preview && preview.start && (
              <ol className="tb-flow" aria-label="Phases in order">
                {preview.phases.map((id, i) => <li key={id} data-tone={tpl.phases.find((p) => p.id === id)?.tone}>{i > 0 && <span aria-hidden className="arrow">→</span>}<span className="chip">{phaseName(id)}</span></li>)}
              </ol>)}
            {preview && preview.skipped.length > 0 && <p className="note">Skipped: {preview.skipped.map(phaseName).join(', ')}</p>}
          </motion.div>
        </AnimatePresence>
      </section>

      <div className="tb-bar" role="region" aria-label="Save changes">
        <span className="note">{dirty ? 'You have unsaved changes.' : 'Everything is saved.'}</span>
        <button className="btn ghost" disabled={!dirty || busy} onClick={() => { const dd = JSON.parse(saved) as Draft; setD(dd); setPreviewType(dd.defaultType); }}>Discard</button>
        <button className="btn" disabled={!dirty || busy} onClick={save}>{busy ? 'Saving…' : 'Save template'}</button>
      </div>
    </div>);
}
