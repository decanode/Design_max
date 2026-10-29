'use client';
import { useState } from 'react';
import { j } from '../../lib/auth';
import { FULL, type Kind } from '../../lib/docKinds';

export type Signoff = { required: boolean; mine: boolean; latest: { id: string; status: 'pending' | 'approved' | 'rejected' | 'cancelled'; requested_at: string; decided_at: string | null; comment: string | null; customer: string | null } | null };
type Run = (fn: () => Promise<Response>, okText: string) => Promise<void>;

/** What stands between this ticket and "closed": the documents its type requires, and the confirmation of the customer who raised it. */
export function ClosurePanel({ ticketId, docRules, approvedKinds, signoff, canAsk, busy, run, openDoc }: {
  ticketId: string; docRules: Record<string, string>; approvedKinds: string[]; signoff: Signoff; canAsk: boolean; busy: boolean; run: Run; openDoc: (k: Kind) => void;
}) {
  const [comment, setComment] = useState('');
  const required = (Object.keys(docRules) as Kind[]).filter((k) => docRules[k] === 'required');
  const last = signoff.latest;
  if (!required.length && !signoff.required) return null;
  const done = required.every((k) => approvedKinds.includes(k)) && (!signoff.required || last?.status === 'approved');
  const answer = (decision: 'approved' | 'rejected') => { run(() => fetch(`/api/tickets/${ticketId}/signoff/decision`, j({ decision, comment: comment.trim() || undefined })), decision === 'approved' ? 'Thank you. The team can now close this ticket.' : 'Thanks, we have told the team it is not resolved.'); setComment(''); };

  return (
    <section className={`pane tk-card closure ${done ? 'ready' : ''}`} aria-label="Closing checklist">
      <h3 style={{ margin: '0 0 4px' }}>To close this ticket {done && <span className="status ok">Ready to close</span>}</h3>
      <ul className="checklist">
        {required.map((k) => (
          <li key={k} className={approvedKinds.includes(k) ? 'ok' : ''}>
            <span className="cl-mark" aria-hidden>{approvedKinds.includes(k) ? '✓' : '○'}</span>
            <span>{FULL[k]} approved</span>
            {!approvedKinds.includes(k) && <button type="button" className="linklike" onClick={() => openDoc(k)}>Open</button>}
          </li>))}
        {signoff.required && (
          <li className={last?.status === 'approved' ? 'ok' : last?.status === 'rejected' ? 'bad' : ''}>
            <span className="cl-mark" aria-hidden>{last?.status === 'approved' ? '✓' : last?.status === 'rejected' ? '✕' : '○'}</span>
            <span>
              {last?.status === 'approved' ? `${last.customer ?? 'The customer'} confirmed it is resolved` : last?.status === 'pending' ? `Waiting for ${last.customer ?? 'the customer'} to confirm` : last?.status === 'rejected' ? `${last.customer ?? 'The customer'} says it is not resolved` : 'The customer who raised it must confirm it is resolved'}
              {last?.comment && last.status !== 'pending' && <span className="note"> — “{last.comment}”</span>}
            </span>
            {canAsk && (!last || last.status === 'rejected' || last.status === 'cancelled') && <button type="button" className="btn sm" disabled={busy} onClick={() => run(() => fetch(`/api/tickets/${ticketId}/signoff/request`, j({})), 'The customer has been asked to confirm.')}>Ask the customer to confirm</button>}
            {canAsk && last?.status === 'pending' && <button type="button" className="btn ghost sm" disabled={busy} onClick={() => run(() => fetch(`/api/tickets/${ticketId}/signoff/cancel`, j({})), 'Request withdrawn.')}>Withdraw request</button>}
          </li>)}
      </ul>
      {signoff.mine && last?.status === 'pending' && (
        <div className="closure-ask">
          <b>The team believes this is resolved. Does it work for you?</b>
          <label className="sr" htmlFor="so-c">Comment</label>
          <textarea id="so-c" className="lc-input" rows={2} placeholder="Add a comment (required if it is not resolved)" value={comment} onChange={(e) => setComment(e.target.value)} />
          <div className="row" style={{ margin: 0 }}>
            <button className="btn verify" style={{ width: 'auto' }} disabled={busy} onClick={() => answer('approved')}>Yes, it is resolved</button>
            <button className="btn ghost" disabled={busy || !comment.trim()} onClick={() => answer('rejected')}>No, it is not resolved</button>
          </div>
        </div>)}
    </section>);
}
