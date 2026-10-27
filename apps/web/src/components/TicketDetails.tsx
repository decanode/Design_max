'use client';
import { useState } from 'react';
import { j } from '../lib/auth';

type Level = 'hidden' | 'read' | 'write';
export type DetailTicket = {
  id: string; title: string; ai_summary?: string | null; resolution_notes?: string | null; acceptance_criteria?: string | null;
  project_name?: string | null; legacy_id?: string | null; legacy_source?: string | null; legacy_type?: string | null; legacy_status?: string | null;
};

const ROWS = [
  { key: 'title', patch: 'title', label: 'Title', col: 'title', multiline: false },
  { key: 'ai_summary', patch: 'aiSummary', label: 'Requirement summary', col: 'ai_summary', multiline: true },
  { key: 'resolution_notes', patch: 'resolutionNotes', label: 'Resolution notes', col: 'resolution_notes', multiline: true },
  { key: 'acceptance_criteria', patch: 'acceptanceCriteria', label: 'Acceptance criteria', col: 'acceptance_criteria', multiline: true },
] as const;

/**
 * Shows only the fields this role may read (the server has already removed the rest) and lets them edit the ones
 * their role allows. Hidden fields leave no trace: no label, no placeholder.
 */
export function TicketDetails({ ticket, fields, onSaved }: { ticket: DetailTicket; fields: Record<string, Level>; onSaved: () => void }) {
  const visible = ROWS.filter((r) => fields[r.key] && fields[r.key] !== 'hidden' && r.col in ticket);
  const editable = visible.filter((r) => fields[r.key] === 'write');
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const t = ticket as unknown as Record<string, string | null | undefined>;

  const showLegacy = fields.legacy && fields.legacy !== 'hidden' && ticket.legacy_id;
  const showProject = fields.project && fields.project !== 'hidden' && ticket.project_name;
  if (!visible.filter((r) => r.key !== 'title').length && !showLegacy && !showProject && !editable.length) return null;

  const start = () => { setDraft(Object.fromEntries(editable.map((r) => [r.key, t[r.col] ?? '']))); setError(''); setEditing(true); };
  async function save() {
    const body: Record<string, string> = {};
    for (const r of editable) if ((draft[r.key] ?? '') !== (t[r.col] ?? '')) body[r.patch] = draft[r.key] ?? '';
    if (!Object.keys(body).length) return setEditing(false);
    setBusy(true); setError('');
    const res = await fetch(`/api/tickets/${ticket.id}`, j(body, 'PATCH')); const b = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) return setError(b.error ?? 'Could not save');
    setEditing(false); onSaved();
  }

  return (
    <section className="details" aria-label="Ticket details">
      <div className="row" style={{ margin: '0 0 8px', justifyContent: 'space-between' }}>
        <h3 style={{ margin: 0 }}>Details</h3>
        {editable.length > 0 && !editing && <button className="btn ghost sm" onClick={start}>Edit details</button>}
      </div>
      {error && <p role="alert" className="err" style={{ margin: '0 0 8px' }}>{error}</p>}
      <dl className="dl">
        {visible.filter((r) => r.key !== 'title' || editing).map((r) => {
          const can = fields[r.key] === 'write';
          return (
            <div key={r.key} style={r.multiline ? { gridColumn: '1 / -1' } : undefined}>
              <dt>{r.label}{!can && editable.length > 0 && <span className="ro-tag">read only</span>}</dt>
              {editing && can ? (
                r.multiline
                  ? <dd><textarea aria-label={r.label} rows={3} value={draft[r.key] ?? ''} onChange={(e) => setDraft({ ...draft, [r.key]: e.target.value })} /></dd>
                  : <dd><input aria-label={r.label} value={draft[r.key] ?? ''} onChange={(e) => setDraft({ ...draft, [r.key]: e.target.value })} /></dd>
              ) : <dd className={t[r.col] ? '' : 'empty'}>{t[r.col] || 'Not recorded'}</dd>}
            </div>);
        })}
        {showProject && <div><dt>Project</dt><dd>{ticket.project_name}</dd></div>}
        {showLegacy && <div><dt>Legacy reference</dt><dd>{ticket.legacy_id}{[ticket.legacy_source, ticket.legacy_type, ticket.legacy_status].filter(Boolean).length > 0 && ` · ${[ticket.legacy_source, ticket.legacy_type, ticket.legacy_status].filter(Boolean).join(' · ')}`}</dd></div>}
      </dl>
      {editing && <div className="row" style={{ marginBottom: 0 }}>
        <button className="btn" disabled={busy} onClick={save}>Save details</button>
        <button className="btn ghost" disabled={busy} onClick={() => setEditing(false)}>Cancel</button></div>}
    </section>
  );
}
