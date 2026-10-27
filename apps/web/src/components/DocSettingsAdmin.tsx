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
    <div className="field"><label htmlFor={`ds-${k}`}>{label} <span className="note">(pt)</span></label>
      <input id={`ds-${k}`} type="number" min={min} max={max} step={0.5} value={s[k]} onChange={(e) => set(k, Number(e.target.value))} /></div>);
  const font = (k: 'bodyFont' | 'headingFont', label: string) => (
    <div className="field"><label htmlFor={`ds-${k}`}>{label}</label>
      <select id={`ds-${k}`} value={s[k]} onChange={(e) => set(k, e.target.value)}>{fonts.map((f) => <option key={f}>{f}</option>)}</select></div>);
  const txt = (k: 'displayName' | 'clientName' | 'headerText' | 'footerText' | 'confidentiality' | 'docNumberFormat', label: string, hint?: string) => (
    <div className="field"><label htmlFor={`ds-${k}`}>{label}{hint && <span className="note"> · {hint}</span>}</label>
      <input id={`ds-${k}`} value={s[k]} onChange={(e) => set(k, e.target.value)} /></div>);

  return (
    <form className="pane build" onSubmit={save} aria-label="Document settings" style={{ padding: 16 }}>
      <h3 style={{ marginTop: 0 }}>Document settings</h3>
      <p className="note" style={{ marginTop: 0 }}>These apply to every Word document this project downloads. Leave a name empty to use the project’s own name.</p>

      <h4 className="mini">Names & labels</h4>
      <div className="wf-grid">
        {txt('displayName', 'Project name on documents')}{txt('clientName', 'Client name')}
        {txt('headerText', 'Extra header text')}{txt('footerText', 'Extra footer text')}
        {txt('confidentiality', 'Confidentiality line')}{txt('docNumberFormat', 'Document number format', 'use {PROJECT} {TICKET} {TYPE} {VERSION}')}
      </div>

      <h4 className="mini">Fonts & sizes</h4>
      <div className="wf-grid">
        {font('bodyFont', 'Body font')}{font('headingFont', 'Heading font')}
        {num('bodySize', 'Body size', 8, 14)}{num('h1Size', 'Heading 1 size', 12, 28)}{num('h2Size', 'Heading 2 size', 11, 24)}{num('h3Size', 'Heading 3 size', 10, 20)}
      </div>

      <h4 className="mini">Templates</h4>
      <div className="field"><label htmlFor="ds-stack">Template set</label>
        <select id="ds-stack" value={s.templateStack ?? ''} onChange={(e) => set('templateStack', e.target.value || null)}>
          <option value="">Follow the project’s technology</option>{sets.map((x) => <option key={x} value={x}>{STACK_LABEL[x] ?? x}</option>)}
        </select></div>

      <h4 className="mini">Delivery rules</h4>
      <label className="check"><input type="checkbox" checked={s.qaGate} onChange={(e) => set('qaGate', e.target.checked)} /> Unit Test and Code Review must be approved before a ticket can move to QA</label>
      <label className="check"><input type="checkbox" checked={s.blockApprovalOnOpenComments} onChange={(e) => set('blockApprovalOnOpenComments', e.target.checked)} /> Approval cannot be requested while review comments are unresolved</label>

      <h4 className="mini">Preview</h4>
      <div className="ds-preview" style={{ fontFamily: `${s.bodyFont}, system-ui, sans-serif`, fontSize: `${s.bodySize}pt` }} aria-label="Preview of the document style">
        <div className="ds-head" style={{ fontFamily: `${s.headingFont}, system-ui, sans-serif` }}>{s.displayName || 'Project name'} · {FULL[kind]} · {s.docNumberFormat.replace('{PROJECT}', (s.displayName || 'PROJECT').replace(/\s+/g, '').toUpperCase()).replace('{TICKET}', 'A1B2C3D4').replace('{TYPE}', kind).replace('{VERSION}', 'v1')} {s.headerText}</div>
        <div style={{ fontFamily: `${s.headingFont}, system-ui, sans-serif`, fontSize: `${s.h1Size}pt`, fontWeight: 700 }}>1. Business Requirement</div>
        <div style={{ fontFamily: `${s.headingFont}, system-ui, sans-serif`, fontSize: `${s.h2Size}pt`, fontWeight: 700 }}>1.1 Scope</div>
        <div style={{ fontFamily: `${s.headingFont}, system-ui, sans-serif`, fontSize: `${s.h3Size}pt`, fontWeight: 700 }}>Details</div>
        <p style={{ margin: '6px 0' }}>Blocked vendors must not appear in the purchase order value help.{s.clientName ? ` (Client: ${s.clientName})` : ''}</p>
        <div className="ds-foot">{s.confidentiality} {s.footerText} · Page 1 of 1</div>
      </div>

      <div className="row">
        <button className="btn" disabled={!dirty || busy}>Save settings</button>
        <label className="sr" htmlFor="ds-kind">Sample document type</label>
        <select id="ds-kind" value={kind} onChange={(e) => setKind(e.target.value as Kind)}>{KINDS.map((k) => <option key={k} value={k}>{FULL[k]}</option>)}</select>
        <button type="button" className="btn ghost" onClick={sample}>Download a sample in this style</button>
        {dirty && <span className="note">Unsaved changes (the sample includes them)</span>}
      </div>
    </form>);
}
