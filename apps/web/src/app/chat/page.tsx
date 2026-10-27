'use client';
import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { io, type Socket } from 'socket.io-client';
import { Nav } from '../../components/Nav';

const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';
type Msg = { id: number; sender_role: 'customer' | 'consultant' | 'system'; sender_name: string; body: string };
type Draft = { title: string; summary: string; status: 'draft' | 'verified'; ticket_id: string | null; entities: { businessObjects?: string[]; vendors?: string[]; materialTypes?: string[] } };

export default function Chat() {
  const [cid, setCid] = useState<string | null>(null);
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [role, setRole] = useState<'customer' | 'consultant'>('customer');
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const sock = useRef<Socket | null>(null);
  const end = useRef<HTMLLIElement>(null);

  useEffect(() => { setCid(new URLSearchParams(location.search).get('c')); }, []);

  useEffect(() => {
    if (!cid) return;
    const s = io(API); sock.current = s;
    s.on('connect', () => s.emit('join', { conversationId: cid }, (r: any) => {
      if (r.error) return setError(r.error);
      setMsgs(r.messages); setDraft(r.draft); setError('');
    }));
    s.on('message', (m: Msg) => setMsgs((p) => (p.some((x) => x.id === m.id) ? p : [...p, m])));
    s.on('draft', setDraft);
    s.on('verified', (v: { draft: Draft }) => setDraft(v.draft));
    s.on('observer:error', () => setError('The AI summary could not be updated. Your messages are safe.'));
    s.on('connect_error', () => setError('Reconnecting to chat…'));
    return () => { s.close(); };
  }, [cid]);

  useEffect(() => { end.current?.scrollIntoView({ block: 'end' }); }, [msgs]);

  async function start() {
    const r = await fetch(`${API}/api/conversations`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    const { id } = await r.json();
    history.replaceState(null, '', `?c=${id}`); setCid(id);
  }
  function send(e: React.FormEvent) {
    e.preventDefault();
    if (!text.trim() || !cid) return;
    sock.current?.emit('message', { conversationId: cid, role, name: role === 'customer' ? 'Customer' : 'Consultant', body: text.trim() }, (r: any) => r?.error && setError(r.error));
    setText('');
  }
  function verify() {
    setBusy(true);
    sock.current?.emit('verify', { conversationId: cid }, (r: any) => { setBusy(false); if (r.error) setError(r.error); });
  }

  const verified = draft?.status === 'verified';
  const chips = (label: string, items?: string[]) => items?.length ? (
    <dl className="chips"><dt>{label}</dt>{items.map((i) => <dd key={i} className="chip" style={{ margin: 0 }}>{i}</dd>)}</dl>) : null;

  return (
    <>
      <Nav current="chat" />
      <main id="main">
        {!cid ? (
          <section className="start">
            <h2>Describe what you need</h2>
            <p>Chat with your consultant. An AI assistant listens in and drafts the requirement for you to approve.</p>
            <button className="btn" onClick={start}>Start a conversation</button>
          </section>
        ) : (
          <div className="chat">
            <section className="pane" aria-label="Conversation">
              <h2>Conversation</h2>
              <ul className="log" role="log" aria-live="polite" aria-label="Chat history">
                {msgs.length === 0 && <li className="empty">No messages yet. Say hello.</li>}
                {msgs.map((m) => (
                  <li key={m.id} className={`msg ${m.sender_role}`}><small>{m.sender_name}</small>{m.body}</li>
                ))}
                <li ref={end} aria-hidden />
              </ul>
              {error && <p role="alert" className="err" style={{ margin: '0 16px' }}>{error}</p>}
              <form className="composer" onSubmit={send}>
                <label className="sr" htmlFor="role">Send as</label>
                <select id="role" value={role} onChange={(e) => setRole(e.target.value as 'customer' | 'consultant')}>
                  <option value="customer">Customer</option><option value="consultant">Consultant</option>
                </select>
                <label className="sr" htmlFor="msg">Message</label>
                <input id="msg" value={text} onChange={(e) => setText(e.target.value)} placeholder="Type a message…" autoComplete="off" />
                <button className="btn" type="submit" disabled={!text.trim()}>Send</button>
              </form>
            </section>
            <aside className="pane" aria-label="AI requirement summary">
              <h2>AI requirement summary</h2>
              {!draft ? <p className="empty">Once the customer describes a need, a draft summary appears here.</p> : (
                <div className="draft" aria-live="polite">
                  {verified && <span className="badge">✓ Verified &amp; logged</span>}
                  <h3>{draft.title}</h3>
                  <p>{draft.summary}</p>
                  {chips('Business objects', draft.entities.businessObjects)}
                  {chips('Vendors', draft.entities.vendors)}
                  {chips('Material types', draft.entities.materialTypes)}
                  {verified
                    ? <Link href="/">View ticket on the board →</Link>
                    : <button className="btn verify" onClick={verify} disabled={busy}>Verify &amp; Approve</button>}
                </div>
              )}
            </aside>
          </div>
        )}
      </main>
    </>
  );
}
