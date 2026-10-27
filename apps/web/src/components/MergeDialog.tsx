'use client';
import { useEffect, useRef, useState } from 'react';
import type { Kind } from '../lib/docKinds';
import { j } from '../lib/auth';

type Side = { preview: string; blocks: number } | null;
type Sec = { id: number; title: string; match: 'exact' | 'similar' | 'new' | 'missing'; draft: Side; upload: Side };
type Choice = 'keep' | 'upload' | 'append' | 'skip';
const MATCH: Record<Sec['match'], string> = { exact: 'Matched', similar: 'Probably the same section', new: 'Only in your file', missing: 'Only in the draft' };

/** Upload your own Word file, see how it lines up with the draft section by section, and choose what to take. Nothing is saved until you confirm. */
export function MergeDialog({ ticketId, kind, onClose, onDone }: { ticketId: string; kind: Kind; onClose: () => void; onDone: (version: number) => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [plan, setPlan] = useState<{ uploadId: string; filename: string; notes: string[]; sections: Sec[] } | null>(null);
  const [choices, setChoices] = useState<Record<number, Choice>>({});
  const [err, setErr] = useState(''); const [busy, setBusy] = useState(false);
  useEffect(() => { ref.current?.showModal(); }, []);
  const base = `/api/tickets/${ticketId}/documents/${kind}`;

  async function pick(file: File) {
    setErr(''); setBusy(true);
    try {
      const buf = new Uint8Array(await file.arrayBuffer()); let bin = ''; for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
      const r = await fetch(`${base}/upload`, j({ filename: file.name, docxBase64: btoa(bin) }));
      const b = await r.json(); if (!r.ok) throw new Error(b.error ?? 'Could not read the file');
      setPlan(b);
      setChoices(Object.fromEntries((b.sections as Sec[]).map((s) => [s.id, s.match === 'exact' || s.match === 'similar' ? 'upload' : s.match === 'new' ? 'upload' : 'keep'])));
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }
  async function merge() {
    if (!plan) return; setErr(''); setBusy(true);
    try {
      const r = await fetch(`${base}/upload/${plan.uploadId}/merge`, j({ choices: Object.fromEntries(Object.entries(choices).map(([k, v]) => [k, v])) }));
      const b = await r.json(); if (!r.ok) throw new Error(b.error ?? 'Could not merge');
      onDone(b.version);
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }
  const options = (s: Sec): [Choice, string][] => s.match === 'new' ? [['upload', 'Add to the document'], ['skip', 'Leave out']] : s.match === 'missing' ? [['keep', 'Keep the draft']] : [['upload', 'Use my file’s version'], ['keep', 'Keep the draft'], ['append', 'Keep both']];

  return (
    <dialog ref={ref} className="merge-dialog" aria-labelledby="merge-title" onClose={onClose} onCancel={onClose}>
      <h3 id="merge-title" style={{ marginTop: 0 }}>Upload your Word file and merge</h3>
      {!plan ? (<>
        <p className="note">Your file is matched to the draft by section headings. You choose, section by section, what goes into the document. The current draft is saved as a version first, so you can always go back.</p>
        <label htmlFor="merge-file">Word file (.docx, up to 8 MB)</label><br />
        <input id="merge-file" type="file" accept=".docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document" disabled={busy} onChange={(e) => e.target.files?.[0] && pick(e.target.files[0])} />
        {busy && <p className="note">Reading the file…</p>}
      </>) : (<>
        <p className="note" style={{ marginTop: 0 }}><b>{plan.filename}</b>. Pick what to use for each section.{plan.notes.length ? ` Note: ${plan.notes.join('; ')}.` : ''}</p>
        <div className="merge-list" role="list">
          {plan.sections.map((s) => (
            <div key={s.id} className={`merge-row ${s.match}`} role="listitem">
              <div className="merge-head"><b>{s.title || '(Start of document)'}</b> <span className="note">{MATCH[s.match]}</span>
                <select aria-label={`What to do with ${s.title || 'the start of the document'}`} value={choices[s.id]} onChange={(e) => setChoices({ ...choices, [s.id]: e.target.value as Choice })}>
                  {options(s).map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></div>
              <div className="merge-cols">
                <div><div className="note">Draft</div><div className="merge-text">{s.draft?.preview || <em>Not in the draft</em>}</div></div>
                <div><div className="note">Your file</div><div className="merge-text">{s.upload?.preview || <em>Not in your file</em>}</div></div>
              </div>
            </div>))}
        </div>
      </>)}
      {err && <p role="alert" className="err">{err}</p>}
      <div className="row">
        {plan && <button className="btn" disabled={busy} onClick={merge}>Merge into the document</button>}
        <button className="btn ghost" type="button" onClick={() => ref.current?.close()}>Cancel</button>
      </div>
    </dialog>);
}
