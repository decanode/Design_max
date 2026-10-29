'use client';
import { useCallback, useEffect, useState } from 'react';
import { Avatar } from '../people/shared';
import { j } from '../../lib/auth';

type Item = { id: string; type: 'created' | 'move' | 'note' | 'signoff' | 'approval'; at: string; actor: string | null; text: string; detail?: string | null; internal?: boolean };
const ICON: Record<Item['type'], string> = { created: '✦', move: '➜', note: '💬', signoff: '🤝', approval: '✔' };
const when = (iso: string) => new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

/** The conversation and everything that happened to the ticket, in one timeline, with a box to add to it. */
export function ActivityFeed({ ticketId, version, staff, onPosted }: { ticketId: string; version: number; staff: boolean; onPosted: () => void }) {
  const [items, setItems] = useState<Item[] | null>(null);
  const [text, setText] = useState('');
  const [internal, setInternal] = useState(false);
  const [filter, setFilter] = useState<'all' | 'notes'>('all');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const load = useCallback(async () => { const r = await fetch(`/api/tickets/${ticketId}/activity`); if (r.ok) setItems(await r.json()); }, [ticketId]);
  useEffect(() => { load(); }, [load, version]);

  async function post(e: React.FormEvent) {
    e.preventDefault(); if (!text.trim()) return;
    setBusy(true); setError('');
    const r = await fetch(`/api/tickets/${ticketId}/notes`, j({ body: text.trim(), internal }));
    setBusy(false);
    if (!r.ok) return setError((await r.json().catch(() => ({}))).error ?? 'Could not add that');
    setText(''); await load(); onPosted();
  }
  const shown = (items ?? []).filter((i) => filter === 'all' || i.type === 'note');

  return (
    <section className="pane tk-card" aria-label="Activity">
      <div className="row" style={{ justifyContent: 'space-between', margin: '0 0 10px' }}>
        <h3 style={{ margin: 0 }}>Activity</h3>
        <div className="wfs-tabs sm" role="tablist" aria-label="Show">
          <button type="button" role="tab" className="wfs-tab" aria-selected={filter === 'all'} onClick={() => setFilter('all')}>All</button>
          <button type="button" role="tab" className="wfs-tab" aria-selected={filter === 'notes'} onClick={() => setFilter('notes')}>Comments</button>
        </div>
      </div>
      <form className="tk-compose" onSubmit={post} aria-label="Add a comment">
        <label className="sr" htmlFor="tk-note">Comment</label>
        <textarea id="tk-note" className="lc-input" rows={2} value={text} onChange={(e) => setText(e.target.value)} placeholder={internal ? 'Write an internal note: only the team sees it' : 'Write a comment…'} maxLength={5000} />
        <div className="row" style={{ margin: 0 }}>
          {staff && <label className="check"><input type="checkbox" checked={internal} onChange={(e) => setInternal(e.target.checked)} /> Internal note <span className="note">(hidden from the customer)</span></label>}
          <button className="btn sm" style={{ marginLeft: 'auto' }} disabled={busy || !text.trim()}>{internal ? 'Add internal note' : 'Add comment'}</button>
        </div>
        {error && <p role="alert" className="err" style={{ margin: 0 }}>{error}</p>}
      </form>
      {!items ? <div className="skeleton" style={{ height: 80 }} aria-busy="true" /> : (
        <ol className="tl" aria-label="Timeline">
          {[...shown].reverse().map((i) => (
            <li key={i.id} className={`tl-item ${i.type} ${i.internal ? 'internal' : ''}`}>
              {i.type === 'note' && i.actor ? <Avatar name={i.actor} size={28} /> : <span className="tl-dot" aria-hidden>{ICON[i.type]}</span>}
              <div className="tl-body">
                <div className="tl-head"><b>{i.actor ?? 'System'}</b>{i.type !== 'note' && <span> {i.text.charAt(0).toLowerCase() + i.text.slice(1)}</span>}{i.internal && <span className="tag warn">Internal</span>}<span className="note"> · {when(i.at)}</span></div>
                {i.type === 'note' && <p className="tl-text">{i.text}</p>}
                {i.detail && <p className="tl-text note">“{i.detail}”</p>}
              </div>
            </li>))}
          {shown.length === 0 && <li className="note">Nothing here yet.</li>}
        </ol>)}
    </section>);
}
