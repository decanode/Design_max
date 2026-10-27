'use client';
import { useCallback, useEffect, useState } from 'react';
import { api, type Flash } from './consoleBits';
import { KINDS, FULL, type Kind } from '../lib/docKinds';

type Tpl = { id: string; stack: string | null; docType: Kind; name: string; version: number; active: boolean; createdAt: string; createdBy: string | null; bytes: number };
const STACKS: [string, string][] = [['generic', 'Generic (any stack)'], ['sap', 'SAP'], ['dotnet', '.NET'], ['java', 'Java'], ['node', 'Node.js']];
const label = (s: string | null) => STACKS.find(([k]) => k === (s ?? 'generic'))?.[1] ?? s;
type Defaults = { bodyFont?: string; headingFont?: string; bodySize?: number; h1Size?: number; h2Size?: number; h3Size?: number; confidentiality?: string; docNumberFormat?: string; headerText?: string; footerText?: string };

/** Platform console → Documents: the Word designs every project draws from, and the defaults projects start with. */
export function TemplateAdmin({ flash }: { flash: Flash }) {
  const [tpls, setTpls] = useState<Tpl[]>([]); const [tokens, setTokens] = useState<string[]>([]);
  const [d, setD] = useState<Defaults | null>(null); const [fonts, setFonts] = useState<string[]>([]);
  const [stack, setStack] = useState('sap'); const [docType, setDocType] = useState<Kind>('TS'); const [name, setName] = useState(''); const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try { const t = await api('/api/platform/doc-templates'); setTpls(t.templates); setTokens(t.tokens); const x = await api('/api/platform/doc-defaults'); setD(x.settings); setFonts(x.fonts); }
    catch (e) { flash('err', (e as Error).message); }
  }, [flash]);
  useEffect(() => { load(); }, [load]);

  async function upload(e: React.FormEvent) {
    e.preventDefault(); if (!file) return; setBusy(true);
    try {
      const buf = new Uint8Array(await file.arrayBuffer()); let bin = ''; for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
      const r = await api('/api/platform/doc-templates', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ stack, docType, name: name || file.name.replace(/\.docx$/i, ''), docxBase64: btoa(bin) }) });
      flash('ok', `Template saved as version ${r.version}.${r.unknownTokens.length ? ` These placeholders are not recognised and will be left empty: ${r.unknownTokens.join(', ')}` : ''}`);
      setFile(null); setName(''); load();
    } catch (err) { flash('err', (err as Error).message); } finally { setBusy(false); }
  }
  const act = async (id: string, path: string, method = 'POST') => { try { await api(`/api/platform/doc-templates/${id}${path}`, { method }); load(); } catch (e) { flash('err', (e as Error).message); } };
  async function saveDefaults(e: React.FormEvent) {
    e.preventDefault();
    try { const r = await api('/api/platform/doc-defaults', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(d) }); setD(r.settings); flash('ok', 'Defaults saved. Projects that have not set their own use these.'); }
    catch (err) { flash('err', (err as Error).message); }
  }
  if (!d) return <p className="note">Loading…</p>;
  const field = (k: keyof Defaults, text: string, type: 'text' | 'number' = 'text') => (
    <div className="field"><label htmlFor={`pd-${k}`}>{text}</label>
      <input id={`pd-${k}`} type={type} value={(d[k] as string | number | undefined) ?? ''} step={type === 'number' ? 0.5 : undefined}
        onChange={(e) => { const v = e.target.value; const nd = { ...d }; if (v === '') delete nd[k]; else (nd as Record<string, unknown>)[k] = type === 'number' ? Number(v) : v; setD(nd); }} /></div>);
  const fontSel = (k: 'bodyFont' | 'headingFont', text: string) => (
    <div className="field"><label htmlFor={`pd-${k}`}>{text}</label>
      <select id={`pd-${k}`} value={d[k] ?? ''} onChange={(e) => { const nd = { ...d }; if (e.target.value) nd[k] = e.target.value; else delete nd[k]; setD(nd); }}><option value="">Built-in</option>{fonts.map((f) => <option key={f}>{f}</option>)}</select></div>);

  return (
    <div style={{ display: 'grid', gap: 18 }}>
      <form className="pane build" onSubmit={upload} aria-label="Upload a template" style={{ padding: 16 }}>
        <h3 style={{ marginTop: 0 }}>Word templates</h3>
        <p className="note" style={{ marginTop: 0 }}>Upload the Word file that gives a document its design (cover page, headers, styles). Put <code>{'{{BODY}}'}</code> alone on a line where the content goes, and use placeholders such as {tokens.slice(0, 4).map((t) => <code key={t}>{`{{${t}}}`} </code>)}… for details filled in automatically. A new upload becomes the active version; earlier versions are kept.</p>
        <div className="wf-grid">
          <div className="field"><label htmlFor="tp-stack">Technology</label><select id="tp-stack" value={stack} onChange={(e) => setStack(e.target.value)}>{STACKS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></div>
          <div className="field"><label htmlFor="tp-type">Document</label><select id="tp-type" value={docType} onChange={(e) => setDocType(e.target.value as Kind)}>{KINDS.map((k) => <option key={k} value={k}>{FULL[k]}</option>)}</select></div>
          <div className="field"><label htmlFor="tp-name">Name <span className="note">(optional)</span></label><input id="tp-name" value={name} onChange={(e) => setName(e.target.value)} /></div>
          <div className="field"><label htmlFor="tp-file">Word file (.docx)</label><input id="tp-file" type="file" accept=".docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document" onChange={(e) => setFile(e.target.files?.[0] ?? null)} /></div>
        </div>
        <div className="row"><button className="btn" disabled={!file || busy}>Upload template</button></div>
        <details style={{ marginTop: 8 }}><summary>Placeholders you can use</summary><p className="note">{tokens.map((t) => <code key={t}>{`{{${t}}} `}</code>)}<code>{'{{BODY}} {{APPROVALS}} {{REVISIONS}}'}</code></p></details>
        {tpls.length === 0 ? <p className="note">No templates uploaded yet. Documents use the built-in design.</p> : (
          <table className="grid users" style={{ marginTop: 10 }}>
            <thead><tr><th>Document</th><th>Technology</th><th>Name</th><th>Version</th><th>Status</th><th><span className="sr">Actions</span></th></tr></thead>
            <tbody>{tpls.map((t) => (
              <tr key={t.id}><td>{FULL[t.docType]}</td><td>{label(t.stack)}</td><td>{t.name}</td><td>v{t.version}</td><td>{t.active ? <b>Active</b> : 'Inactive'}</td>
                <td><a className="btn ghost sm" href={`/api/platform/doc-templates/${t.id}/download`} download>Download</a>{' '}
                  {t.active ? <button type="button" className="btn ghost sm" onClick={() => act(t.id, '', 'DELETE')}>Deactivate</button> : <button type="button" className="btn ghost sm" onClick={() => act(t.id, '/activate')}>Make active</button>}</td></tr>))}</tbody>
          </table>)}
      </form>

      <form className="pane build" onSubmit={saveDefaults} aria-label="Document defaults" style={{ padding: 16 }}>
        <h3 style={{ marginTop: 0 }}>Defaults for all projects</h3>
        <p className="note" style={{ marginTop: 0 }}>A project’s own document settings win over these. Empty means the built-in value.</p>
        <div className="wf-grid">
          {fontSel('bodyFont', 'Body font')}{fontSel('headingFont', 'Heading font')}
          {field('bodySize', 'Body size (pt)', 'number')}{field('h1Size', 'Heading 1 size (pt)', 'number')}{field('h2Size', 'Heading 2 size (pt)', 'number')}{field('h3Size', 'Heading 3 size (pt)', 'number')}
          {field('confidentiality', 'Confidentiality line')}{field('docNumberFormat', 'Document number format')}{field('headerText', 'Extra header text')}{field('footerText', 'Extra footer text')}
        </div>
        <div className="row"><button className="btn">Save defaults</button></div>
      </form>
    </div>);
}
