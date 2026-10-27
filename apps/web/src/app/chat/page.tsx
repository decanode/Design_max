'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { io, type Socket } from 'socket.io-client';
import { Nav } from '../../components/Nav';
import { NoAccess, useAuth, j } from '../../lib/auth';

type Msg = { id: number; sender_role: 'customer' | 'consultant' | 'system'; sender_name: string; body: string };
type Draft = { title: string; summary: string; status: 'draft' | 'verified'; ticket_id: string | null; stack_fit?: 'in_scope' | 'unclear' | 'out_of_scope'; stack_note?: string; entities: { businessObjects?: string[]; vendors?: string[]; materialTypes?: string[] } };
type Project = { id: string; name: string; stacks: string[] };
type Convo = { id: string; project: string; customer: string | null; draft_title: string | null; draft_status: string | null; last_message: string | null; last_at: string };

export default function Chat() {
  const { me, can, canAny, loading } = useAuth();
  const [cid, setCid] = useState<string | null>(null);
  const [inbox, setInbox] = useState<Convo[]>([]);
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setProjectId] = useState('');
  const [current, setCurrent] = useState<Project | null>(null);
  const [role, setRole] = useState<'customer' | 'consultant'>('customer');
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const sock = useRef<Socket | null>(null);
  const end = useRef<HTMLLIElement>(null);

  const asCustomer = can('chat.as_customer'), asConsultant = can('chat.as_consultant');
  const mayChat = canAny('chat.as_customer', 'chat.as_consultant', 'chat.view_all');
  const canSend = asCustomer || asConsultant;

  useEffect(() => { setCid(new URLSearchParams(location.search).get('c')); }, []);
  useEffect(() => { setRole(asCustomer ? 'customer' : 'consultant'); }, [asCustomer]);

  const loadInbox = useCallback(async () => {
    const r = await fetch('/api/conversations');
    if (r.ok) setInbox(await r.json());
  }, []);
  useEffect(() => { if (mayChat) loadInbox(); }, [mayChat, loadInbox]);
  useEffect(() => {
    if (!asCustomer) return;
    fetch('/api/projects').then((r) => r.ok && r.json()).then((d: Project[] | false) => { if (d) { setProjects(d); setProjectId((p) => p || d[0]?.id || ''); } });
  }, [asCustomer]);

  useEffect(() => {
    if (!cid || !mayChat) return;
    setMsgs([]); setDraft(null); setCurrent(null); setError('');
    const s = io({ withCredentials: true }); sock.current = s;
    s.on('connect', () => s.emit('join', { conversationId: cid }, (r: any) => {
      if (r.error) return setError(r.error);
      setMsgs(r.messages); setDraft(r.draft); setCurrent(r.project); setError('');
    }));
    s.on('message', (m: Msg) => { setMsgs((p) => (p.some((x) => x.id === m.id) ? p : [...p, m])); loadInbox(); });
    s.on('draft', (d: Draft) => { setDraft(d); loadInbox(); });
    s.on('verified', (v: { draft: Draft }) => { setDraft(v.draft); loadInbox(); });
    s.on('observer:error', () => setError('The AI summary could not be updated. Your messages are safe.'));
    s.on('connect_error', (e) => setError(e.message === 'Sign in required' ? 'Your session expired. Please sign in again.' : 'Reconnecting to chat…'));
    return () => { s.close(); };
  }, [cid, mayChat, loadInbox]);

  useEffect(() => { end.current?.scrollIntoView({ block: 'end' }); }, [msgs]);

  function select(id: string) { history.replaceState(null, '', `?c=${id}`); setCid(id); }
  async function start() {
    const r = await fetch('/api/conversations', j(projectId ? { projectId } : {}));
    if (!r.ok) return setError('Could not start a conversation.');
    const { id } = await r.json(); await loadInbox(); select(id);
  }
  function send(e: React.FormEvent) {
    e.preventDefault();
    if (!text.trim() || !cid) return;
    sock.current?.emit('message', { conversationId: cid, role, body: text.trim() }, (r: any) => r?.error && setError(r.error));
    setText('');
  }
  function verify() {
    setBusy(true);
    sock.current?.emit('verify', { conversationId: cid }, (r: any) => { setBusy(false); if (r.error) setError(r.error); });
  }

  if (loading || !me) return <><Nav current="chat" /><main id="main"><p className="note">Loading…</p></main></>;
  if (!mayChat) return <><Nav current="chat" /><main id="main"><NoAccess what="chat" /></main></>;

  const verified = draft?.status === 'verified';
  const chips = (label: string, items?: string[]) => items?.length ? (
    <dl className="chips"><dt>{label}</dt>{items.map((i) => <dd key={i} className="chip" style={{ margin: 0 }}>{i}</dd>)}</dl>) : null;

  return (
    <>
      <Nav current="chat" />
      <main id="main">
        <div className="chat3">
          <aside className="pane inbox" aria-label="Conversations">
            <h2>{can('chat.view_all') ? 'All conversations' : 'My conversations'}</h2>
            {asCustomer && (
              <div style={{ padding: 10, display: 'grid', gap: 8 }}>
                {projects.length > 1 && (<>
                  <label className="sr" htmlFor="project">Project</label>
                  <select id="project" value={projectId} onChange={(e) => setProjectId(e.target.value)} style={{ padding: 8, borderRadius: 8, border: '1px solid var(--line)', background: 'var(--panel)', color: 'var(--text)' }}>
                    {projects.map((p) => <option key={p.id} value={p.id}>{p.name}{p.stacks.length ? ` · ${p.stacks.join(', ')}` : ''}</option>)}
                  </select></>)}
                <button className="btn" style={{ width: '100%' }} onClick={start}>Start a conversation</button>
              </div>)}
            <ul className="convos">
              {inbox.length === 0 && <li className="empty">{asCustomer ? 'No conversations yet.' : 'No conversations to show.'}</li>}
              {inbox.map((c) => (
                <li key={c.id}>
                  <button className="convo" aria-current={c.id === cid ? 'true' : undefined} onClick={() => select(c.id)}>
                    <b>{c.draft_title ?? c.last_message ?? 'New conversation'}</b>
                    <span className="note">{c.project} · {c.customer ?? 'Unknown'}{c.draft_status === 'verified' ? ' · verified' : ''}</span>
                  </button>
                </li>
              ))}
            </ul>
          </aside>

          {!cid ? (
            <section className="pane" style={{ gridColumn: 'span 2', padding: 32 }}>
              <h2 style={{ border: 0, padding: 0 }}>{asCustomer ? 'Describe what you need' : 'Pick a conversation'}</h2>
              <p className="note">{asCustomer
                ? 'Chat with your consultant. An AI assistant listens in and drafts the requirement for you to approve.'
                : 'Choose a conversation on the left to reply to the customer.'}</p>
            </section>
          ) : (<>
            <section className="pane" aria-label="Conversation">
              <h2>Conversation{current && <span className="scope"> · {current.name}{current.stacks.length > 0 && <> · <span className="stack-chips">{current.stacks.map((t) => <span key={t} className="chip">{t} only</span>)}</span></>}</span>}</h2>
              <ul className="log" role="log" aria-live="polite" aria-label="Chat history">
                {msgs.length === 0 && <li className="empty">No messages yet. Say hello.</li>}
                {msgs.map((m) => (
                  <li key={m.id} className={`msg ${m.sender_role}`}><small>{m.sender_name}</small>{m.body}</li>
                ))}
                <li ref={end} aria-hidden />
              </ul>
              {error && <p role="alert" className="err" style={{ margin: '0 16px' }}>{error}</p>}
              {canSend ? (
                <form className="composer" onSubmit={send}>
                  {asCustomer && asConsultant ? (<>
                    <label className="sr" htmlFor="role">Send as</label>
                    <select id="role" value={role} onChange={(e) => setRole(e.target.value as 'customer' | 'consultant')}>
                      <option value="customer">Customer</option><option value="consultant">Consultant</option>
                    </select></>) : <span className="note" style={{ alignSelf: 'center' }}>Replying as {asCustomer ? 'customer' : 'consultant'}</span>}
                  <label className="sr" htmlFor="msg">Message</label>
                  <input id="msg" value={text} onChange={(e) => setText(e.target.value)} placeholder="Type a message…" autoComplete="off" />
                  <button className="btn" type="submit" disabled={!text.trim()}>Send</button>
                </form>
              ) : <p className="note" style={{ padding: 12, margin: 0 }}>Your role can read this conversation but not reply.</p>}
            </section>
            <aside className="pane" aria-label="AI requirement summary">
              <h2>AI requirement summary</h2>
              {!draft ? <p className="empty">Once the customer describes a need, a draft summary appears here.</p> : (
                <div className="draft" aria-live="polite">
                  {verified && <span className="badge">✓ Verified &amp; logged</span>}
                  {draft.stack_fit && draft.stack_fit !== 'in_scope' && !verified && (
                    <div className={`scope-warn ${draft.stack_fit}`} role="alert">
                      <b>{draft.stack_fit === 'out_of_scope' ? 'Outside this project’s technology' : 'Check the technology scope'}</b>
                      <span>{draft.stack_note}</span>
                    </div>)}
                  <h3>{draft.title}</h3>
                  <p>{draft.summary}</p>
                  {chips('Business objects', draft.entities.businessObjects)}
                  {chips('Vendors', draft.entities.vendors)}
                  {chips('Material types', draft.entities.materialTypes)}
                  {verified
                    ? (draft.ticket_id && can('board.view') ? <Link href={`/tickets/${draft.ticket_id}`}>View ticket →</Link> : null)
                    : can('chat.verify')
                      ? <button className="btn verify" onClick={verify} disabled={busy || draft.stack_fit === 'out_of_scope'} title={draft.stack_fit === 'out_of_scope' ? 'This request is outside the project’s technology' : undefined}>Verify &amp; Approve</button>
                      : <p className="note" style={{ margin: 0 }}>Waiting for the customer to verify this summary.</p>}
                </div>
              )}
            </aside>
          </>)}
        </div>
      </main>
    </>
  );
}
