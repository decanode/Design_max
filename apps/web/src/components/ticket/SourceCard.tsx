'use client';

type T = { legacy_source?: string | null; legacy_id?: string | null; source_url?: string | null; source_status?: string | null; source_updated_at?: string | null; source_removed_at?: string | null; current_state: string };
const NAME: Record<string, string> = { jira: 'Jira', servicenow: 'ServiceNow' };

/** Where a mirrored ticket comes from, what the source says about it, and how that differs from our own status. */
export function SourceCard({ t }: { t: T }) {
  if (!t.legacy_source || !t.source_status) return null;
  const same = t.source_status.toLowerCase() === t.current_state.toLowerCase();
  return (
    <section className="pane tk-card source-card" aria-label="Source ticket">
      <div className="row" style={{ justifyContent: 'space-between', margin: 0 }}>
        <h3 style={{ margin: 0 }}>{NAME[t.legacy_source] ?? t.legacy_source} · {t.legacy_id}</h3>
        {t.source_url && <a className="btn ghost sm" href={t.source_url} target="_blank" rel="noreferrer noopener" style={{ textDecoration: 'none' }}>Open in {NAME[t.legacy_source] ?? 'source'} ↗</a>}
      </div>
      <dl className="src-grid">
        <div><dt>{NAME[t.legacy_source] ?? 'Source'} says</dt><dd><span className="state-pill src">{t.source_status}</span></dd></div>
        <div><dt>Our status</dt><dd><span className="state-pill">{t.current_state}</span></dd></div>
        <div><dt>Last read from source</dt><dd>{t.source_updated_at ? new Date(t.source_updated_at).toLocaleString() : '—'}</dd></div>
      </dl>
      <p className="note" style={{ margin: 0 }}>{same ? 'Both agree.' : 'Our status is our own working status. It is never sent to the source tool unless your project is set up to do so.'}</p>
      {t.source_removed_at && <p className="scope-warn unclear" role="note" style={{ margin: 0 }}><b>No longer found in the source.</b> It was missing from the last full read ({new Date(t.source_removed_at).toLocaleDateString()}). It may have been deleted or moved.</p>}
    </section>);
}
