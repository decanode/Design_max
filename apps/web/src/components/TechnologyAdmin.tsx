'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { motion } from 'framer-motion';
import { api, type Flash } from './consoleBits';
import { j } from '../lib/auth';

type Stack = { id: number; name: string; description: string; keywords: string[] };
type Check = { fit: 'in_scope' | 'unclear' | 'out_of_scope'; note: string; foreign: { stack: string; terms: string[] }[]; restricted: boolean; allowedNames: string[] };
type Impact = { checked: number; flagged: number; examples: { id: string; title: string; fit: string; stacks: string[] }[] };
const ICON: Record<string, string> = { SAP: '🏢', '.NET': '🟣', Java: '☕', 'Node.js': '🟢' };
const VERDICT = { in_scope: { label: 'In scope', cls: 'ok' }, unclear: { label: 'Check the scope', cls: 'warn' }, out_of_scope: { label: 'Outside the technology', cls: 'bad' } } as const;

/** Project settings → Technology: which technologies this project works in, what that changes, and a way to try a choice before saving it. */
export function TechnologyAdmin({ flash }: { flash: Flash }) {
  const [cat, setCat] = useState<Stack[] | null>(null);
  const [sel, setSel] = useState<number[]>([]);
  const [saved, setSaved] = useState<number[]>([]);
  const [busy, setBusy] = useState(false);
  const [impact, setImpact] = useState<Impact | null>(null);
  const [text, setText] = useState('');
  const [result, setResult] = useState<Check | null>(null);

  const load = useCallback(async () => { const d = await api('/api/project/stacks'); setCat(d.catalog); setSel(d.selected); setSaved(d.selected); }, []);
  useEffect(() => { load().catch((e) => flash('err', e.message)); }, [load, flash]);

  const key = [...sel].sort().join(',');
  const dirty = key !== [...saved].sort().join(',');
  // What the choice would mean for tickets that already exist (looked at as the choice changes, never saved by looking)
  useEffect(() => {
    if (!cat) return;
    const t = setTimeout(() => { api('/api/project/stacks/impact', j({ stackIds: sel })).then(setImpact).catch(() => setImpact(null)); }, 250);
    return () => clearTimeout(t);
  }, [key, cat]);   // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { setResult(null); }, [key]);

  const names = useMemo(() => (cat ?? []).filter((s) => sel.includes(s.id)).map((s) => s.name), [cat, sel]);
  if (!cat) return <div className="tb-skel" aria-busy="true" aria-label="Loading technology"><div className="skeleton" style={{ height: 120 }} /><div className="skeleton" style={{ height: 220 }} /></div>;

  const toggle = (id: number, on: boolean) => setSel((p) => (on ? [...p, id] : p.filter((x) => x !== id)));
  async function save() {
    setBusy(true);
    try {
      await api('/api/project/stacks', j({ stackIds: sel }, 'PUT'));
      setSaved(sel);
      flash('ok', sel.length ? 'Saved. The AI works only in the ticked technologies for this project.' : 'Saved. This project has no technology restriction.');
    } catch (e) { flash('err', (e as Error).message); load(); } finally { setBusy(false); }
  }
  async function tryIt(e: React.FormEvent) {
    e.preventDefault();
    if (!text.trim()) return;
    try { setResult(await api('/api/project/stacks/check', j({ text, stackIds: sel }))); } catch (er) { flash('err', (er as Error).message); }
  }

  return (
    <div className="tb tech">
      <section className={`pane tech-banner ${names.length ? 'limited' : ''}`} aria-label="Current scope" aria-live="polite">
        <span className="tech-banner-icon" aria-hidden>{names.length ? '🔒' : '🌐'}</span>
        <div>
          <h3>{names.length ? `Limited to ${names.join(', ')}` : 'No technology restriction'}</h3>
          <p className="note">{names.length
            ? 'The chat assistant and the document generators stay inside these technologies, and anything that needs another one is flagged.'
            : 'Tick one or more technologies to keep the AI, the specifications and the chat inside them. Until you do, anything goes.'}</p>
        </div>
        <span className="tech-actions">
          <button type="button" className="btn ghost sm" onClick={() => setSel(cat.map((s) => s.id))} disabled={sel.length === cat.length}>Select all</button>
          <button type="button" className="btn ghost sm" onClick={() => setSel([])} disabled={!sel.length}>Clear (no restriction)</button>
        </span>
      </section>

      <section className="pane tb-sec" aria-label="Allowed technology">
        <h3>Allowed technology for this project</h3>
        <ul className="tech-grid">
          {cat.map((s) => (
            <motion.li key={s.id} layout className={`tech-card ${sel.includes(s.id) ? 'on' : ''}`}>
              <label>
                <input type="checkbox" aria-label={s.name} checked={sel.includes(s.id)} onChange={(e) => toggle(s.id, e.target.checked)} />
                <span className="tech-check" aria-hidden>✓</span>
                <span className="tech-icon" aria-hidden>{ICON[s.name] ?? '⚙'}</span>
                <span className="tech-name">{s.name}</span>
                <span className="note tech-desc">{s.description}</span>
                <span className="tech-kw" aria-label={`${s.name} terms the system recognises`}>
                  {s.keywords.slice(0, 7).map((k) => <i key={k}>{k}</i>)}{s.keywords.length > 7 && <em>+{s.keywords.length - 7} more</em>}
                </span>
              </label>
            </motion.li>))}
        </ul>
      </section>

      <div className="tech-two">
        <section className="pane tb-sec" aria-label="Effect on existing tickets">
          <h3>What this means for existing tickets</h3>
          {!impact ? <p className="note">Checking…</p> : !sel.length ? <p className="note">With no restriction nothing is flagged.</p> : impact.flagged === 0
            ? <p className="tech-good">✓ None of the {impact.checked} existing ticket{impact.checked === 1 ? '' : 's'} mention technology outside this choice.</p>
            : (<>
              <p className="tech-warn"><b>{impact.flagged}</b> of {impact.checked} existing ticket{impact.checked === 1 ? '' : 's'} mention technology outside this choice. They stay as they are; new work and documents are checked against it.</p>
              <ul className="tech-examples">{impact.examples.map((x) => <li key={x.id}><Link href={`/tickets/${x.id}`}>{x.title}</Link> <span className="note">· {x.stacks.join(', ')}</span></li>)}</ul>
            </>)}
        </section>

        <section className="pane tb-sec" aria-label="Try a request">
          <h3>Try a request</h3>
          <p className="note" style={{ marginTop: 0 }}>Paste something a customer might ask for and see how it would be judged with the technologies ticked above, before you save.</p>
          <form onSubmit={tryIt} className="tech-try">
            <label className="sr" htmlFor="tech-text">Request to check</label>
            <textarea id="tech-text" className="lc-input" rows={3} value={text} onChange={(e) => { setText(e.target.value); setResult(null); }} placeholder="For example: build a C# web API for our vendor data" />
            <button className="btn" type="submit" disabled={!text.trim()}>Check it</button>
          </form>
          {result && (
            <div className={`tech-verdict ${VERDICT[result.fit].cls}`} role="status">
              <b>{result.restricted ? VERDICT[result.fit].label : 'No restriction: everything is allowed'}</b>
              {result.note && <span>{result.note}</span>}
              {result.foreign.length > 0 && <span className="tech-kw">{result.foreign.flatMap((f) => f.terms.map((t) => <i key={f.stack + t}>{f.stack}: {t}</i>))}</span>}
            </div>)}
        </section>
      </div>

      <section className="pane tb-sec" aria-label="Where it applies">
        <h3>Where this applies</h3>
        <ul className="tech-applies">
          <li><b>Chat assistant</b><span className="note">Stays within the technologies, and flags requests that need another one. Out-of-scope requests cannot be turned into a ticket.</span></li>
          <li><b>Specifications &amp; documents</b><span className="note">FS, TS, unit test and code review drafts are written for these technologies, with their section outlines and checklists.</span></li>
          <li><b>Ticket pages</b><span className="note">Show a warning when a draft mentions technology outside the choice, so reviewers see it before approving.</span></li>
        </ul>
      </section>

      <div className="tb-bar" role="region" aria-label="Save changes">
        <span className="note">{dirty ? 'You have unsaved changes.' : 'Everything is saved.'}</span>
        <button type="button" className="btn ghost" disabled={!dirty || busy} onClick={() => setSel(saved)}>Discard</button>
        <button type="button" className="btn" disabled={!dirty || busy} onClick={save}>{busy ? 'Saving…' : 'Save technology'}</button>
      </div>
    </div>);
}
