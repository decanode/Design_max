'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { j } from '../../lib/auth';
import { cleanValues, type TicketType, type Workflow } from '../../lib/workflow';
import type { Wbs } from '../../lib/planning';

type Result = { type: { name: string }; created: { elementId: string; ticketId: string }[]; skipped: { elementId: string; reason: string }[]; wbs: Wbs[] };

/** Turn work packages into tickets: choose the kind, give the fields once (use {title}, {phase} or {deliverable} to vary them per package). */
export function ConvertDialog({ wf, count, elementIds, rows, userName, onClose, onDone }: {
  wf: Workflow; count: number; elementIds: string[]; rows: Wbs[]; userName: string; onClose: () => void; onDone: (r: Result) => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const types = wf.ticketTypes.filter((t) => t.enabled);
  const [typeId, setTypeId] = useState<number>((types.find((t) => t.key === 'ritm') ?? types.find((t) => t.isDefault) ?? types[0]).id);
  const type = types.find((t) => t.id === typeId) as TicketType;
  const [vals, setVals] = useState<Record<string, unknown>>({});
  const [errs, setErrs] = useState<Record<string, string>>({});
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { ref.current?.showModal(); }, []);
  useEffect(() => {      // sensible starting values: who it is for, and the package's own title
    setErrs({}); setErr('');
    setVals(Object.fromEntries(type.fields.map((f) => [f.key, f.key === 'requested_for' ? userName : f.key === 'catalog_item' ? '{title}' : f.kind === 'checkbox' ? false : ''])));
  }, [type, userName]);
  const preview = useMemo(() => rows.find((r) => elementIds.includes(r.id)) ?? rows.find((r) => r.level === 3 && !r.ticket), [rows, elementIds]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const miss: Record<string, string> = {};
    for (const f of type.fields) if (f.required && f.kind !== 'checkbox' && (vals[f.key] === '' || vals[f.key] == null)) miss[f.key] = `${f.label} is required`;
    setErrs(miss); if (Object.keys(miss).length) return;
    setBusy(true); setErr('');
    const r = await fetch('/api/planning/convert', j({ elementIds: elementIds.length ? elementIds : undefined, ticketTypeId: type.id, fields: cleanValues(type.fields, vals) }));
    const b = await r.json().catch(() => ({})); setBusy(false);
    if (!r.ok) { if (b.fieldErrors) setErrs(b.fieldErrors); setErr(b.error ?? 'Could not create the tickets'); return; }
    onDone(b); ref.current?.close();
  }

  return (
    <dialog ref={ref} className="create-dialog" aria-labelledby="conv-title" onClose={onClose} onCancel={onClose}>
      <form onSubmit={submit} noValidate>
        <h3 id="conv-title" style={{ marginTop: 0 }}>Convert to tickets</h3>
        <p className="note" style={{ marginTop: 0 }}>{count} work package{count === 1 ? '' : 's'} will become tickets in this project and appear on the board. Each keeps its title, description and effort.</p>
        <div className="field"><label htmlFor="conv-type">Ticket type</label>
          <select id="conv-type" value={typeId} onChange={(e) => setTypeId(Number(e.target.value))}>{types.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select></div>
        {type.fields.length > 0 && <h4 className="mini" style={{ margin: '12px 0 8px' }}>{type.name} details, applied to every ticket</h4>}
        <div className="dyn-fields">
          {type.fields.map((f) => (
            <div key={f.key} className={`field ${errs[f.key] ? 'invalid' : ''} ${f.kind === 'textarea' ? 'wide' : ''}`}>
              {f.kind === 'checkbox' ? <label className="check"><input type="checkbox" checked={!!vals[f.key]} onChange={(e) => setVals({ ...vals, [f.key]: e.target.checked })} /> {f.label}</label> : <label htmlFor={`cv-${f.key}`}>{f.label}{f.required && <span className="req" aria-hidden> *</span>}</label>}
              {f.kind === 'select' ? <select id={`cv-${f.key}`} value={String(vals[f.key] ?? '')} onChange={(e) => setVals({ ...vals, [f.key]: e.target.value })}><option value="">Choose…</option>{f.options.map((o) => <option key={o}>{o}</option>)}</select>
                : f.kind === 'textarea' ? <textarea id={`cv-${f.key}`} rows={3} value={String(vals[f.key] ?? '')} onChange={(e) => setVals({ ...vals, [f.key]: e.target.value })} />
                : f.kind !== 'checkbox' && <input id={`cv-${f.key}`} type={f.kind === 'number' ? 'number' : f.kind === 'date' ? 'date' : 'text'} value={String(vals[f.key] ?? '')} onChange={(e) => setVals({ ...vals, [f.key]: e.target.value })} />}
              {errs[f.key] && <span role="alert" className="err">{errs[f.key]}</span>}
            </div>))}
        </div>
        {type.fields.length > 0 && <p className="note">Use <code>{'{title}'}</code>, <code>{'{phase}'}</code> or <code>{'{deliverable}'}</code> to fill in each package’s own details.{preview && <> For “{preview.title}” a field set to <code>{'{title}'}</code> becomes “{preview.title}”.</>}</p>}
        {err && <p role="alert" className="err">{err}</p>}
        <div className="row"><button className="btn" disabled={busy}>{busy ? 'Creating…' : `Create ${count} ${type.name}${count === 1 ? '' : 's'}`}</button><button type="button" className="btn ghost" onClick={() => ref.current?.close()}>Cancel</button></div>
      </form>
    </dialog>);
}
