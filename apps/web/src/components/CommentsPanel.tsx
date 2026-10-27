'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { EditorApi } from './DocEditor';
import type { Kind } from '../lib/docKinds';
import { j } from '../lib/auth';

export type Reply = { id: string; author: string; body: string; createdAt: string; editedAt: string | null };
export type Thread = Reply & { authorId: string; quote: string | null; anchor: { from: unknown; to: unknown } | null; status: 'open' | 'addressed' | 'resolved'; resolvedBy: string | null; version: number | null; replies: Reply[] };
type Review = { id: string; reviewer: string; decision: 'changes_requested' | 'looks_good'; note: string | null; version: number; createdAt: string };
type Person = { id: string; name: string };
const ago = (d: string) => new Date(d).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });

export function useThreads(ticketId: string, kind: Kind, enabled: boolean) {
  const [threads, setThreads] = useState<Thread[]>([]);
  const [unresolved, setUnresolved] = useState(0);
  const load = useCallback(async () => {
    if (!enabled) return;
    const r = await fetch(`/api/tickets/${ticketId}/documents/${kind}/comments`);
    if (r.ok) { const b = await r.json(); setThreads(b.threads); setUnresolved(b.unresolved); }
  }, [ticketId, kind, enabled]);
  useEffect(() => { setThreads([]); load(); const t = setInterval(load, 5000); return () => clearInterval(t); }, [load]);
  return { threads, unresolved, reload: load };
}

function Composer({ placeholder, people, onSend, label = 'Comment', autoFocus }: { placeholder: string; people: Person[]; onSend: (body: string, mentions: string[]) => Promise<void>; label?: string; autoFocus?: boolean }) {
  const [body, setBody] = useState(''); const [mentions, setMentions] = useState<Person[]>([]); const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { if (autoFocus) ref.current?.focus(); }, [autoFocus]);
  const send = async () => { setBusy(true); try { await onSend(body.trim(), mentions.filter((m) => body.includes(`@${m.name}`)).map((m) => m.id)); setBody(''); setMentions([]); } finally { setBusy(false); } };
  return (
    <div className="cm-form">
      <label className="sr" htmlFor={`cm-${label}-${placeholder}`}>{label}</label>
      <textarea ref={ref} id={`cm-${label}-${placeholder}`} placeholder={placeholder} value={body} onChange={(e) => setBody(e.target.value)} maxLength={4000} />
      <div className="row">
        <button className="btn sm" disabled={!body.trim() || busy} onClick={send}>{label}</button>
        {people.length > 0 && (
          <select aria-label="Mention someone" value="" onChange={(e) => { const p = people.find((x) => x.id === e.target.value); if (p) { setBody((b) => `${b}${b && !b.endsWith(' ') ? ' ' : ''}@${p.name} `); setMentions((m) => [...m, p]); } }}>
            <option value="">@ Mention…</option>{people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>)}
      </div>
    </div>);
}

export function CommentsPanel({ ticketId, kind, meId, threads, reload, api, hasSelection, activeId, setActive, orphans, canComment, canEdit, canReview, latest }: {
  ticketId: string; kind: Kind; meId: string; threads: Thread[]; reload: () => void; api: EditorApi | null; hasSelection: boolean; activeId: string | null; setActive: (id: string | null) => void;
  orphans: string[]; canComment: boolean; canEdit: boolean; canReview: boolean; latest: number;
}) {
  const [people, setPeople] = useState<Person[]>([]);
  const [reviews, setReviews] = useState<Review[]>([]);
  const [err, setErr] = useState('');
  const [replying, setReplying] = useState<string | null>(null);
  const [filter, setFilter] = useState<'open' | 'all'>('open');
  const [verdictNote, setVerdictNote] = useState('');
  const base = `/api/tickets/${ticketId}/documents/${kind}`;

  useEffect(() => { if (canComment) fetch(`/api/tickets/${ticketId}/mentionable`).then((r) => r.ok && r.json()).then((p) => p && setPeople(p)); }, [ticketId, canComment]);
  const loadReviews = useCallback(() => fetch(`${base}/reviews`).then((r) => r.ok && r.json()).then((x) => x && setReviews(x)), [base]);
  useEffect(() => { loadReviews(); }, [loadReviews, threads.length]);

  async function post(body: string, mentions: string[], extra: Record<string, unknown> = {}) {
    setErr('');
    const r = await fetch(`${base}/comments`, j({ body, mentions, ...extra }));
    if (!r.ok) setErr((await r.json().catch(() => ({}))).error ?? 'Could not post the comment'); else reload();
  }
  async function patch(id: string, status: string) {
    setErr(''); const r = await fetch(`/api/doc-comments/${id}`, { ...j({ status }), method: 'PATCH' });
    if (!r.ok) setErr((await r.json().catch(() => ({}))).error ?? 'Not allowed'); else reload();
  }
  async function verdict(decision: 'changes_requested' | 'looks_good') {
    setErr(''); const r = await fetch(`${base}/reviews`, j({ decision, note: verdictNote }));
    if (!r.ok) setErr((await r.json().catch(() => ({}))).error ?? 'Could not record the review'); else { setVerdictNote(''); loadReviews(); }
  }
  const shown = threads.filter((t) => filter === 'all' || t.status !== 'resolved');
  const lastReview = reviews[0];

  return (
    <section className="cm-panel" aria-label="Review comments">
      <h3 style={{ margin: 0 }}>Review comments</h3>
      {lastReview && <p className="note" style={{ margin: 0 }}>Latest review: <b>{lastReview.decision === 'looks_good' ? 'Looks good' : 'Changes requested'}</b> by {lastReview.reviewer} on v{lastReview.version}{lastReview.note ? ` — ${lastReview.note}` : ''}</p>}
      {err && <p role="alert" className="err" style={{ margin: 0 }}>{err}</p>}

      {canComment && (
        <div className="cm-thread">
          {hasSelection
            ? <Composer key="sel" autoFocus placeholder="Comment on the selected text" people={people} label="Comment on selection" onSend={async (body, m) => { const s = api?.selection(); if (!s) return setErr('Select some text first'); await post(body, m, { anchor: s.anchor, quote: s.quote }); }} />
            : <><p className="note" style={{ marginTop: 0 }}>Select text in the document to comment on it, or add a general comment.</p>
                <Composer key="gen" placeholder="General comment on this document" people={people} onSend={(b, m) => post(b, m)} /></>}
        </div>)}

      <div className="row" style={{ justifyContent: 'space-between' }}>
        <div role="group" aria-label="Show">
          <button className="btn ghost sm" aria-pressed={filter === 'open'} onClick={() => setFilter('open')}>Open</button>{' '}
          <button className="btn ghost sm" aria-pressed={filter === 'all'} onClick={() => setFilter('all')}>All ({threads.length})</button>
        </div>
      </div>

      {shown.length === 0 && <p className="note" style={{ margin: 0 }}>{threads.length ? 'Nothing open. All comments are resolved.' : 'No comments yet.'}</p>}
      <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: 10 }}>
        {shown.map((t) => (
          <li key={t.id} className={`cm-thread ${t.status} ${activeId === t.id ? 'active' : ''}`} onClick={() => { setActive(t.id); if (t.anchor) api?.scrollTo(t.id); }}>
            <div className="cm-meta"><b style={{ color: 'var(--text)' }}>{t.author}</b><span>{ago(t.createdAt)}</span><span className={`cm-chip ${t.status}`}>{t.status === 'open' ? 'Open' : t.status === 'addressed' ? 'Addressed' : 'Resolved'}</span>
              {t.version != null && t.version < latest && <span>on v{t.version}</span>}</div>
            {t.quote && <blockquote className="cm-quote">{t.quote}{orphans.includes(t.id) && <em className="note"> — the text was removed or changed</em>}</blockquote>}
            <p className="cm-body">{t.body}</p>
            {t.replies.map((r) => (
              <div key={r.id} className="cm-reply"><div className="cm-meta"><b style={{ color: 'var(--text)' }}>{r.author}</b><span>{ago(r.createdAt)}</span></div><p className="cm-body">{r.body}</p></div>))}
            <div className="row" onClick={(e) => e.stopPropagation()}>
              {canComment && <button className="btn ghost sm" onClick={() => setReplying(replying === t.id ? null : t.id)}>Reply</button>}
              {t.status === 'open' && (canEdit || t.authorId === meId) && <button className="btn ghost sm" onClick={() => patch(t.id, 'addressed')}>Mark addressed</button>}
              {t.status !== 'resolved' && (canReview || t.authorId === meId) && <button className="btn ghost sm" onClick={() => patch(t.id, 'resolved')}>Resolve</button>}
              {t.status === 'resolved' && (canReview || t.authorId === meId) && <button className="btn ghost sm" onClick={() => patch(t.id, 'open')}>Reopen</button>}
            </div>
            {replying === t.id && <div onClick={(e) => e.stopPropagation()}><Composer autoFocus label="Reply" placeholder="Write a reply" people={people} onSend={async (b, m) => { await post(b, m, { parentId: t.id }); setReplying(null); }} /></div>}
          </li>))}
      </ul>

      {canReview && (
        <div className="cm-thread">
          <h4 className="mini" style={{ margin: '0 0 6px' }}>Your review of v{latest}</h4>
          <label className="sr" htmlFor="verdict-note">Review note</label>
          <input id="verdict-note" style={{ width: '100%' }} placeholder="Optional note to the editor" value={verdictNote} onChange={(e) => setVerdictNote(e.target.value)} />
          <div className="row">
            <button className="btn ghost sm" onClick={() => verdict('changes_requested')}>Request changes</button>
            <button className="btn sm" onClick={() => verdict('looks_good')}>Looks good</button>
          </div>
        </div>)}
    </section>);
}
