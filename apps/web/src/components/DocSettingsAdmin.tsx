'use client';
import { useEffect, useState } from 'react';
import { api, type Flash } from './consoleBits';
import { KINDS, FULL, type Kind } from '../lib/docKinds';

type S = {
  displayName: string; clientName: string; headerText: string; footerText: string; confidentiality: string; docNumberFormat: string;
  bodyFont: string; headingFont: string; bodySize: number; h1Size: number; h2Size: number; h3Size: number;
  templateStack: string | null; qaGate: boolean; blockApprovalOnOpenComments: boolean;
};
const STACK_LABEL: Record<string, string> = { sap: 'SAP', dotnet: '.NET', java: 'Java', node: 'Node.js', generic: 'Generic' };

/** Project settings → Documents: how every Word document of this project looks and which delivery rules apply. */
export function DocSettingsAdmin({ flash }: { flash: Flash }) {
  const [s, setS] = useState<S | null>(null);
  const [saved, setSaved] = useState<S | null>(null);
  const [fonts, setFonts] = useState<string[]>([]);
  const [sets, setSets] = useState<string[]>([]);
  const [kind, setKind] = useState<Kind>('FS');
  const [busy, setBusy] = useState(false);

  useEffect(() => { api('/api/project/doc-settings').then((d) => { setS(d.settings); setSaved(d.settings); setFonts(d.fonts); setSets(d.templateSets); }).catch((e) => flash('err', e.message)); }, [flash]);
  if (!s || !saved) return <p className="note">Loading…</p>;
  const set = <K extends keyof S>(k: K, v: S[K]) => setS({ ...s, [k]: v });
  const dirty = JSON.stringify(s) !== JSON.stringify(saved);

  async function save(e: React.FormEvent) {
    e.preventDefault(); setBusy(true);
    try { const d = await api('/api/project/doc-settings', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(s) }); setS(d.settings); setSaved(d.settings); flash('ok', 'Document settings saved. New downloads use them.'); }
    catch (err) { flash('err', (err as Error).message); } finally { setBusy(false); }
  }
  async function sample() {
    const r = await fetch('/api/project/doc-settings/sample', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind, settings: s }) });
    if (!r.ok) return flash('err', 'Could not build the sample.');
    const url = URL.createObjectURL(await r.blob()); const a = document.createElement('a'); a.href = url; a.download = `${kind}_sample.docx`; a.click(); URL.revokeObjectURL(url);
  }
  const num = (k: 'bodySize' | 'h1Size' | 'h2Size' | 'h3Size', label: string, min: number, max: number) => (
    <div className="ds-field"><label htmlFor={`ds-${k}`}>{label}</label>
      <div className="ds-unit"><input id={`ds-${k}`} className="lc-input" type="number" min={min} max={max} step={0.5} value={s[k]} onChange={(e) => set(k, Number(e.target.value))} /><span className="note">pt</span></div></div>);
  const font = (k: 'bodyFont' | 'headingFont', label: string) => (
    <div className="ds-field"><label htmlFor={`ds-${k}`}>{label}</label>
      <select id={`ds-${k}`} className="lc-select" value={s[k]} onChange={(e) => set(k, e.target.value)}>{fonts.map((f) => <option key={f}>{f}</option>)}</select></div>);
  const txt = (k: 'displayName' | 'clientName' | 'headerText' | 'footerText' | 'confidentiality' | 'docNumberFormat', label: string, hint?: string) => (
    <div className="ds-field"><label htmlFor={`ds-${k}`}>{label}</label>
      <input id={`ds-${k}`} className="lc-input" value={s[k]} onChange={(e) => set(k, e.target.value)} />{hint && <span className="note">{hint}</span>}</div>);
  const rule = (k: 'qaGate' | 'blockApprovalOnOpenComments', title: string, text: string) => (
    <label className={`ds-rule ${s[k] ? 'on' : ''}`}>
      <span className="ds-rule-text"><b>{title}</b><span className="note">{text}</span></span>
      <span className="switch"><input type="checkbox" role="switch" checked={s[k]} onChange={(e) => set(k, e.target.checked)} aria-label={text} /><span className="track" aria-hidden /></span>
    </label>);
  const head = { fontFamily: `${s.headingFont}, system-ui, sans-serif`, fontWeight: 700 } as const;
  const docNo = s.docNumberFormat.replace('{PROJECT}', (s.displayName || 'PROJECT').replace(/\s+/g, '').toUpperCase()).replace('{TICKET}', 'T-0042').replace('{TYPE}', kind).replace('{VERSION}', '1');

  return (
    <form className="ds" onSubmit={save} aria-label="Document settings">
      <div className="ds-intro"><h3>Document settings</h3><p className="note">How every Word document this project downloads looks, and which delivery rules apply. Leave a name empty to use the project’s own name.</p></div>
      <div className="ds-layout">
        <div className="ds-col">
          <section className="pane ds-card" aria-label="Names and labels">
            <h4><span aria-hidden>🏷</span> Names &amp; labels</h4>
            <div className="ds-grid">
              {txt('displayName', 'Project name on documents')}{txt('clientName', 'Client name')}
              {txt('headerText', 'Extra header text')}{txt('footerText', 'Extra footer text')}
              {txt('confidentiality', 'Confidentiality line')}{txt('docNumberFormat', 'Document number format', 'Use {PROJECT} {TICKET} {TYPE} {VERSION}')}
            </div>
          </section>
          <section className="pane ds-card" aria-label="Fonts and sizes">
            <h4><span aria-hidden>🔤</span> Fonts &amp; sizes</h4>
            <div className="ds-grid">{font('bodyFont', 'Body font')}{font('headingFont', 'Heading font')}</div>
            <div className="ds-grid four">{num('bodySize', 'Body size', 8, 14)}{num('h1Size', 'Heading 1 size', 12, 28)}{num('h2Size', 'Heading 2 size', 11, 24)}{num('h3Size', 'Heading 3 size', 10, 20)}</div>
          </section>
          <section className="pane ds-card" aria-label="Templates">
            <h4><span aria-hidden>📑</span> Templates</h4>
            <div className="ds-field"><label htmlFor="ds-stack">Template set</label>
              <select id="ds-stack" className="lc-select" value={s.templateStack ?? ''} onChange={(e) => set('templateStack', e.target.value || null)}>
                <option value="">Follow the project’s technology</option>{sets.map((x) => <option key={x} value={x}>{STACK_LABEL[x] ?? x}</option>)}
              </select><span className="note">The section outline each specification starts from.</span></div>
          </section>
          <section className="pane ds-card" aria-label="Delivery rules">
            <h4><span aria-hidden>🛡</span> Delivery rules</h4>
            {rule('qaGate', 'Quality gate before QA', 'Unit Test and Code Review must be approved before a ticket can move to QA')}
            {rule('blockApprovalOnOpenComments', 'Resolve comments first', 'Approval cannot be requested while review comments are unresolved')}
          </section>
        </div>

        <aside className="ds-side" aria-label="Preview">
          <div className="pane ds-card">
            <h4><span aria-hidden>👁</span> Preview</h4>
            <div className="ds-sheet" style={{ fontFamily: `${s.bodyFont}, system-ui, sans-serif`, fontSize: `${s.bodySize}pt` }} aria-label="Preview of the document style">
              <div className="ds-head" style={{ fontFamily: `${s.headingFont}, system-ui, sans-serif` }}>{s.displayName || 'Project name'} · {FULL[kind]} · {docNo}{s.headerText ? ` · ${s.headerText}` : ''}</div>
              <div style={{ ...head, fontSize: `${s.h1Size}pt` }}>1. Business Requirement</div>
              <div style={{ ...head, fontSize: `${s.h2Size}pt` }}>1.1 Scope</div>
              <div style={{ ...head, fontSize: `${s.h3Size}pt` }}>Details</div>
              <p style={{ margin: '6px 0' }}>Blocked vendors must not appear in the purchase order value help.{s.clientName ? ` (Client: ${s.clientName})` : ''}</p>
              <div className="ds-foot">{s.confidentiality} {s.footerText} · Page 1 of 1</div>
            </div>
            <div className="ds-sample">
              <label htmlFor="ds-kind">Sample document type</label>
              <select id="ds-kind" className="lc-select" value={kind} onChange={(e) => setKind(e.target.value as Kind)}>{KINDS.map((k) => <option key={k} value={k}>{FULL[k]}</option>)}</select>
              <button type="button" className="btn ghost" onClick={sample}>Download a sample in this style</button>
              <span className="note">The sample includes changes you have not saved yet.</span>
            </div>
          </div>
        </aside>
      </div>

      <div className="tb-bar" role="region" aria-label="Save changes">
        <span className="note">{dirty ? 'You have unsaved changes.' : 'Everything is saved.'}</span>
        <button type="button" className="btn ghost" disabled={!dirty || busy} onClick={() => setS(saved)}>Discard</button>
        <button className="btn" disabled={!dirty || busy}>{busy ? 'Saving…' : 'Save settings'}</button>
      </div>
    </form>);
}
