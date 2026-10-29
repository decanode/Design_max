'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { motion } from 'framer-motion';
import { api, type Flash } from '../consoleBits';
import { j } from '../../lib/auth';
import { Field } from '../people/shared';

type Stack = { id: number; name: string; description: string; keywords: string[]; projects: number };
const ICON: Record<string, string> = { SAP: '🏢', '.NET': '🟣', Java: '☕', 'Node.js': '🟢' };
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
/** The same whole-term, case-insensitive rule the server uses ("java" does not match "javascript"). */
const hits = (text: string, keywords: string[]) => keywords.filter((k) => { try { return new RegExp(`(?<![\\w])${esc(k)}(?![\\w])`, 'i').test(text); } catch { return false; } });

/** Platform → Technology catalog: the technologies projects can be limited to, what each covers, and the terms that identify it. */
export function TechCatalogAdmin({ flash, sub, onSub }: { flash: Flash; sub: string | null; onSub: (s: string | null) => void }) {
  const [list, setList] = useState<Stack[] | null>(null);
  const load = useCallback(async () => { try { setList(await api('/api/platform/stacks')); } catch (e) { flash('err', (e as Error).message); } }, [flash]);
  useEffect(() => { load(); }, [load]);
  if (!list) return <div className="skeleton" style={{ height: 220 }} aria-busy="true" aria-label="Loading technologies" />;
  if (sub === 'new') return <StackPage key="new" stack={null} flash={flash} back={() => onSub(null)} done={async () => { await load(); onSub(null); }} />;
  if (sub) {
    const s = list.find((x) => String(x.id) === sub);
    return s ? <StackPage key={sub} stack={s} flash={flash} back={() => onSub(null)} done={async () => { await load(); }} gone={async () => { await load(); onSub(null); }} />
      : <div className="pane" style={{ padding: 20 }}><p>That technology no longer exists.</p><button className="btn ghost" onClick={() => onSub(null)}>Back to the catalog</button></div>;
  }
  return (
    <>
      <div className="tbl-tools">
        <span className="note count-note" aria-live="polite">{list.length} {list.length === 1 ? 'technology' : 'technologies'}</span>
        <button type="button" className="btn" style={{ marginLeft: 'auto' }} onClick={() => onSub('new')}>+ Add technology</button>
      </div>
      <ul className="tech-grid">
        {list.map((s) => (
          <li key={s.id} className="tech-card cat">
            <button type="button" className="cat-open" onClick={() => onSub(String(s.id))} aria-label={`Open technology ${s.name}`}>
              <span className="tech-icon" aria-hidden>{ICON[s.name] ?? '⚙'}</span>
              <span className="tech-name">{s.name}</span>
              <span className="note tech-desc">{s.description || 'No description yet.'}</span>
              <span className="tech-kw">{s.keywords.slice(0, 6).map((k) => <i key={k}>{k}</i>)}{s.keywords.length > 6 && <em>+{s.keywords.length - 6} more</em>}{s.keywords.length === 0 && <em>No keywords yet</em>}</span>
              <span className="cat-foot"><span className={`status ${s.projects ? 'ok' : 'off'}`}>{s.projects ? `Used by ${s.projects} project${s.projects === 1 ? '' : 's'}` : 'Not used yet'}</span><span className="note">Edit ›</span></span>
            </button>
          </li>))}
        {list.length === 0 && <li className="note">No technologies yet. Add the first one.</li>}
      </ul>
    </>);
}

/** Keywords as removable chips: type a term and press Enter or comma. */
function KeywordEditor({ value, onChange }: { value: string[]; onChange: (v: string[]) => void }) {
  const [t, setT] = useState('');
  const add = (raw: string) => {
    const terms = raw.split(',').map((x) => x.trim()).filter(Boolean);
    if (!terms.length) return;
    onChange([...value, ...terms.filter((x, i) => !value.some((v) => v.toLowerCase() === x.toLowerCase()) && terms.findIndex((y) => y.toLowerCase() === x.toLowerCase()) === i)].slice(0, 60));
    setT('');
  };
  return (
    <div className="kw-editor">
      <ul className="kw-list" aria-label="Keywords">
        {value.map((k) => <li key={k}><span>{k}</span><button type="button" aria-label={`Remove keyword ${k}`} onClick={() => onChange(value.filter((x) => x !== k))}>×</button></li>)}
        {value.length === 0 && <li className="note">No keywords yet.</li>}
      </ul>
      <input id="kw-add" className="lc-input" value={t} placeholder="Type a term, press Enter (or paste a comma-separated list)" aria-label="Add a keyword"
        onChange={(e) => (e.target.value.includes(',') ? add(e.target.value) : setT(e.target.value))}
        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add(t); } }} onBlur={() => add(t)} />
    </div>);
}

function StackPage({ stack, flash, back, done, gone }: { stack: Stack | null; flash: Flash; back: () => void; done: () => Promise<void>; gone?: () => Promise<void> }) {
  const isNew = !stack;
  const start = useMemo(() => ({ name: stack?.name ?? '', description: stack?.description ?? '', keywords: stack?.keywords ?? [] }), [stack]);
  const [f, setF] = useState(start);
  const [sample, setSample] = useState('');
  const [nameErr, setNameErr] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { setF(start); }, [start]);
  const dirty = JSON.stringify(f) !== JSON.stringify(start);
  const leave = () => { if (!dirty || confirm('Discard your changes?')) back(); };
  const found = sample.trim() ? hits(sample, f.keywords) : null;

  async function save(e: React.FormEvent) {
    e.preventDefault(); setNameErr('');
    if (!f.name.trim()) { setNameErr('Give the technology a name'); return; }
    setBusy(true);
    try {
      if (isNew) { await api('/api/platform/stacks', j({ name: f.name.trim(), description: f.description, keywords: f.keywords })); flash('ok', `Added the ${f.name.trim()} technology.`); await done(); }
      else { await api(`/api/platform/stacks/${stack!.id}`, j({ description: f.description, keywords: f.keywords }, 'PATCH')); flash('ok', `Saved ${stack!.name}.`); await done(); }
    } catch (er) { const m = (er as Error).message; if (/name/i.test(m)) setNameErr(m); flash('err', m); } finally { setBusy(false); }
  }
  async function remove() {
    if (!stack || !confirm(`Delete the ${stack.name} technology? This cannot be undone.`)) return;
    try { await api(`/api/platform/stacks/${stack.id}`, { method: 'DELETE' }); flash('ok', `Deleted ${stack.name}.`); await gone?.(); } catch (e) { flash('err', (e as Error).message); }
  }

  return (
    <motion.form onSubmit={save} noValidate className="drill" aria-label={isNew ? 'Add a technology' : `Technology ${stack!.name}`} initial={{ opacity: 0, x: 18 }} animate={{ opacity: 1, x: 0 }} transition={{ duration: 0.16 }}>
      <nav className="crumbs" aria-label="Breadcrumb"><button type="button" className="linklike" onClick={leave}>Technology catalog</button><span aria-hidden> › </span><span aria-current="page">{isNew ? 'New technology' : stack!.name}</span></nav>
      {!isNew && <div className="drill-head"><span className="tech-icon" aria-hidden style={{ fontSize: 34 }}>{ICON[stack!.name] ?? '⚙'}</span><div className="drill-title"><h4>{stack!.name}</h4><p className="note">{stack!.projects ? `Used by ${stack!.projects} project${stack!.projects === 1 ? '' : 's'}` : 'Not used by any project yet'}</p></div></div>}
      <div className="drill-grid">
        <section className="pane drill-card" aria-labelledby="st-main">
          <h4 id="st-main">The technology</h4>
          <Field id="st-name" label="Name" required error={nameErr} hint={isNew ? 'How it appears to Project Admins, for example Salesforce.' : 'The name cannot be changed.'}>
            <input id="st-name" className="lc-input" value={f.name} maxLength={40} disabled={!isNew} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
          <Field id="st-desc" label="What it covers" hint="Told to the AI as guidance, so be specific: languages, frameworks, tools.">
            <textarea id="st-desc" className="lc-input" rows={4} maxLength={400} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} />
            <span className="note" style={{ justifySelf: 'end' }}>{f.description.length}/400</span></Field>
        </section>
        <section className="pane drill-card" aria-labelledby="st-kw">
          <h4 id="st-kw">Keywords that identify it <span className="note">{f.keywords.length}/60</span></h4>
          <p className="note" style={{ marginTop: 0 }}>When a request or draft contains one of these terms, it is treated as this technology. Whole words only: “java” does not match “javascript”.</p>
          <KeywordEditor value={f.keywords} onChange={(keywords) => setF({ ...f, keywords })} />
        </section>
        <section className="pane drill-card wide" aria-labelledby="st-try">
          <h4 id="st-try">Test a sentence</h4>
          <p className="note" style={{ marginTop: 0 }}>See what these keywords would catch, using your changes before you save them.</p>
          <label className="sr" htmlFor="st-sample">Sentence to test</label>
          <textarea id="st-sample" className="lc-input" rows={2} value={sample} onChange={(e) => setSample(e.target.value)} placeholder="For example: add a BAPI check to the purchase order" style={{ width: '100%', boxSizing: 'border-box' }} />
          {found && (found.length
            ? <div className="tech-verdict ok" role="status"><b>Recognised as {f.name || 'this technology'}</b><span className="tech-kw">{found.map((k) => <i key={k}>{k}</i>)}</span></div>
            : <div className="tech-verdict warn" role="status"><b>Not recognised</b><span>None of the keywords appear in that sentence as whole words.</span></div>)}
        </section>
      </div>
      {!isNew && (
        <section className="danger-zone" aria-label="Delete technology">
          <div><b>Delete this technology</b><p className="note" style={{ margin: 0 }}>{stack!.projects ? `${stack!.projects} project${stack!.projects === 1 ? ' uses' : 's use'} it. Remove it from them first.` : 'Nothing uses it, so it can be removed.'}</p></div>
          <button type="button" className="btn danger" disabled={stack!.projects > 0} onClick={remove}>Delete</button>
        </section>)}
      <div className="tb-bar drill-bar" role="region" aria-label="Save changes">
        <span className="note">{isNew ? 'It is added when you press Add technology.' : dirty ? 'You have unsaved changes.' : 'Everything is saved.'}</span>
        <button type="button" className="btn ghost" onClick={leave} disabled={busy}>{isNew ? 'Cancel' : 'Back to catalog'}</button>
        <button className="btn" type="submit" disabled={busy || (!isNew && !dirty) || (isNew && !f.name.trim())}>{busy ? 'Saving…' : isNew ? 'Add technology' : 'Save'}</button>
      </div>
    </motion.form>);
}
