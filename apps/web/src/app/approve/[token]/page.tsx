'use client';
import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { Nav } from '../../../components/Nav';
import { Markdown } from '../../../components/Markdown';

const API = process.env.NEXT_PUBLIC_API_URL ?? '';
type View = { ticketTitle: string; kind: 'FS' | 'TS'; version: number; status: string; comment: string | null; content: string };

export default function Approve() {
  const { token } = useParams<{ token: string }>();
  const [v, setV] = useState<View | null>(null);
  const [error, setError] = useState('');
  const [comment, setComment] = useState('');
  const [done, setDone] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    fetch(`${API}/api/approvals/${token}`).then(async (r) => (r.ok ? setV(await r.json()) : setError((await r.json()).error)));
  }, [token]);

  async function decide(decision: 'approved' | 'rejected') {
    setBusy(true); setError('');
    const r = await fetch(`${API}/api/approvals/${token}/decision`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ decision, comment }) });
    const b = await r.json();
    setBusy(false);
    if (!r.ok) return setError(b.error);
    setDone(decision === 'approved' ? 'Approved. Thank you — the ticket has moved to the next phase.' : 'Rejected. The consultant has been given your comment.');
  }

  return (
    <>
      <Nav current="none" />
      <main id="main" className="narrow">
        {error && <p role="alert" className="err">{error}</p>}
        {v && (<>
          <h2 style={{ marginTop: 0 }}>{v.kind === 'FS' ? 'Functional' : 'Technical'} Specification: {v.ticketTitle}</h2>
          <p className="note">Version {v.version}</p>
          <Markdown>{v.content}</Markdown>
          {done ? <p role="status" className="ok">{done}</p> : v.status !== 'pending' ? (
            <p role="status" className="note">This request is {v.status}{v.comment ? ` — “${v.comment}”` : ''}. No action is needed.</p>
          ) : (
            <div style={{ marginTop: 16 }}>
              <label htmlFor="c">Comment (required to reject)</label>
              <textarea id="c" value={comment} onChange={(e) => setComment(e.target.value)} rows={3} style={{ width: '100%', margin: '6px 0 12px', padding: 10, borderRadius: 8, border: '1px solid var(--line)', background: 'var(--panel)', color: 'var(--text)' }} />
              <div className="row">
                <button className="btn verify" style={{ width: 'auto' }} disabled={busy} onClick={() => decide('approved')}>Approve</button>
                <button className="btn ghost" disabled={busy || !comment.trim()} onClick={() => decide('rejected')}>Reject</button>
              </div>
            </div>
          )}
        </>)}
      </main>
    </>
  );
}
