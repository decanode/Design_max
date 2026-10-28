'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { io, type Socket } from 'socket.io-client';
import { Nav } from '../../components/Nav';
import { Markdown } from '../../components/Markdown';
import { NoAccess, NoProject, useAuth, j } from '../../lib/auth';

type Msg = { id: number; sender_role: 'customer' | 'consultant' | 'assistant' | 'system'; sender_name: string; body: string };
type Draft = { title: string; summary: string; scope_md: string | null; status: 'draft' | 'verified'; ticket_id: string | null; ready: boolean; missing: string[]; deliverable: 'ticket' | 'solution' | 'undecided'; ticket_type_key: string | null; stack_fit?: 'in_scope' | 'unclear' | 'out_of_scope'; stack_note?: string };
type Conversation = { id: string; persona: 'customer' | 'team'; stage: string; outcome: string | null; suggestions: string[] };
type Project = { id: string; name: string; stacks: string[] };
type Convo = { id: string; outcome: string | null; project: string; customer: string | null; draft_title: string | null; draft_status: string | null; last_message: string | null; last_at: string };

export default function Chat() {
  const { me, can, canAny, loading } = useAuth();
  const [cid, setCid] = useState<string | null>(null);
  const [inbox, setInbox] = useState<Convo[]>([]);
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [current, setCurrent] = useState<Project | null>(null);
  const [sendAs, setSendAs] = useState<'customer' | 'consultant' | null>(null);
  const [working, setWorking] = useState(false);
  const [convo, setConvo] = useState<Conversation | null>(null);
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const sock = useRef<Socket | null>(null);
  const end = useRef<HTMLLIElement>(null);

  const asCustomer = can('chat.as_customer'), asConsultant = can('chat.as_consultant');
  const mayChat = canAny('chat.as_customer', 'chat.as_consultant', 'chat.view_all');
  const canSend = asCustomer || asConsultant;

  useEffect(() => { setCid(new URLSearchParams(location.search).get('c')); }, []);

  const loadInbox = useCallback(async () => {
    const r = await fetch('/api/conversations');
    if (r.ok) setInbox(await r.json());
  }, []);
  useEffect(() => { if (mayChat) loadInbox(); }, [mayChat, loadInbox]);

  useEffect(() => {
    if (!cid || !mayChat) return;
    setMsgs([]); setDraft(null); setCurrent(null); setConvo(null); setError('');
    const s = io({ withCredentials: true }); sock.current = s;
    s.on('connect', () => s.emit('join', { conversationId: cid }, (r: any) => {
      if (r.error) return setError(r.error);
      setMsgs(r.messages); setDraft(r.draft); setCurrent(r.project); setSendAs(r.sendAs); setConvo(r.conversation); setError('');
    }));
    s.on('message', (m: Msg) => { setMsgs((p) => (p.some((x) => x.id === m.id) ? p : [...p, m])); if (m.sender_role === 'assistant') setWorking(false); loadInbox(); });
    s.on('assistant:working', () => setWorking(true));
    s.on('conversation', (c: Conversation) => setConvo(c));
    s.on('draft', (d: Draft) => { setDraft(d); setWorking(false); loadInbox(); });
    s.on('verified', (v: { draft: Draft }) => { setDraft(v.draft); loadInbox(); });
    s.on('assistant:error', () => { setWorking(false); setError('The assistant could not answer. Your messages are safe.'); });
    s.on('connect_error', (e) => setError(e.message === 'Sign in required' ? 'Your session expired. Please sign in again.' : 'Reconnecting to chat…'));
    return () => { s.close(); };
  }, [cid, mayChat, loadInbox]);

  useEffect(() => { end.current?.scrollIntoView({ block: 'end' }); }, [msgs, working]);

  function select(id: string) { history.replaceState(null, '', `?c=${id}`); setCid(id); }
  async function start() {
    const r = await fetch('/api/conversations', j({}));
    if (!r.ok) return setError('Could not start a conversation.');
    const { id } = await r.json(); await loadInbox(); select(id);
  }
  function post(body: string) {
    if (!body.trim() || !cid) return;
    sock.current?.emit('message', { conversationId: cid, body: body.trim() }, (r: any) => r?.error && setError(r.error));
  }
  function send(e: React.FormEvent) { e.preventDefault(); post(text); setText(''); }
  function verify() {
    setBusy(true);
    sock.current?.emit('verify', { conversationId: cid }, (r: any) => { setBusy(false); if (r.error) setError(r.error); });
  }

  if (loading || !me) return <><Nav current="chat" /><main id="main"><p className="note">Loading…</p></main></>;
  if (!me.project) return <><Nav current="chat" /><main id="main"><NoProject /></main></>;
  if (!mayChat) return <><Nav current="chat" /><main id="main"><NoAccess what="chat" /></main></>;

  const verified = draft?.status === 'verified';
  const team = convo?.persona === 'team';
  const mine = convo ? sendAs !== null && (team ? sendAs === 'consultant' : sendAs === 'customer') : false;
  const finished = convo?.stage === 'done';
  const quick = !finished && mine && !working ? (convo?.suggestions ?? []) : [];

  return (
    <>
      <Nav current="chat" />
      <main id="main">
        <div className="chat3">
          <aside className="pane inbox" aria-label="Conversations">
            <h2>{can('chat.view_all') ? 'All conversations' : 'My conversations'}</h2>
            {canSend && (
              <div style={{ padding: 10, display: 'grid', gap: 8 }}>
                <button className="btn" style={{ width: '100%' }} onClick={start}>Start a conversation</button>
              </div>)}
            <ul className="convos">
              {inbox.length === 0 && <li className="empty">{canSend ? 'No conversations yet.' : 'No conversations to show.'}</li>}
              {inbox.map((c) => (
                <li key={c.id}>
                  <button className="convo" aria-current={c.id === cid ? 'true' : undefined} onClick={() => select(c.id)}>
                    <b>{c.draft_title ?? c.last_message ?? 'New chat'}</b>
                    <span className="note">{c.project} · {c.customer ?? 'Unknown'}{c.outcome === 'ticket_created' ? ' · ticket created' : c.outcome === 'self_resolved' ? ' · solved' : c.outcome === 'solution_given' ? ' · answered' : ''}</span>
                  </button>
                </li>
              ))}
            </ul>
          </aside>

          {!cid ? (
            <section className="pane" style={{ gridColumn: 'span 2', padding: 32 }}>
              <h2 style={{ border: 0, padding: 0 }}>{canSend ? 'How can I help?' : 'Pick a conversation'}</h2>
              <p className="note">{canSend
                ? (asConsultant ? 'Start a chat to scope a requirement, design a solution or prepare a ticket. The assistant asks the questions, shows you the full scope, and only creates a ticket when you confirm.' : 'Start a chat to report a problem, ask how something works or request a change. The assistant will help you solve it, and raises a ticket only if you want one.')
                : 'Choose a conversation on the left to read it.'}</p>
            </section>
          ) : (<>
            <section className="pane" aria-label="Conversation">
              <h2>Conversation{current && <span className="scope"> · {current.name}{current.stacks.length > 0 && <> · <span className="stack-chips">{current.stacks.map((t) => <span key={t} className="chip">{t} only</span>)}</span></>}</span>}</h2>
              <ul className="log" role="log" aria-live="polite" aria-label="Chat history">
                {msgs.length === 0 && <li className="empty">Opening the conversation…</li>}
                {msgs.map((m) => (
                  <li key={m.id} className={`msg ${m.sender_role}`}><small>{m.sender_name}</small>{m.sender_role === 'assistant' ? <Markdown>{m.body}</Markdown> : m.body}</li>
                ))}
                {working && <li className="msg assistant typing" role="status" aria-label="The assistant is typing"><small>Design Max</small><span className="dots"><i /><i /><i /></span></li>}
                <li ref={end} aria-hidden />
              </ul>
              {error && <p role="alert" className="err" style={{ margin: '0 16px' }}>{error}</p>}
              {quick.length > 0 && (
                <div className="quick" role="group" aria-label="Quick replies">
                  {quick.map((q) => <button key={q} type="button" className="chip quick-reply" onClick={() => post(q)}>{q}</button>)}
                </div>)}
              {canSend ? (
                <form className="composer" onSubmit={send}>
                  <label className="sr" htmlFor="msg">Message</label>
                  <input id="msg" value={text} onChange={(e) => setText(e.target.value)} placeholder={finished ? 'This chat is finished. Start a new one for something else.' : 'Type a message…'} autoComplete="off" />
                  <button className="btn" type="submit" disabled={!text.trim()}>Send</button>
                </form>
              ) : <p className="note" style={{ padding: 12, margin: 0 }}>Your role can read this conversation but not reply.</p>}
            </section>
            <aside className="pane" aria-label="Scope">
              <h2>{team ? 'Scope' : 'Your request'}</h2>
              {!draft ? <p className="empty" role="status">{convo?.outcome === 'self_resolved' ? 'Solved on your own. Nothing was raised.' : convo?.outcome === 'solution_given' ? 'Answered without a ticket.' : 'As we talk, the full scope appears here for you to review before anything is created.'}</p> : (
                <div className="draft" aria-live="polite">
                  {verified && <span className="badge">✓ Ticket created</span>}
                  {draft.stack_fit && draft.stack_fit !== 'in_scope' && !verified && (
                    <div className={`scope-warn ${draft.stack_fit}`} role="alert">
                      <b>{draft.stack_fit === 'out_of_scope' ? 'Outside this project’s technology' : 'Check the technology scope'}</b>
                      <span>{draft.stack_note}</span>
                    </div>)}
                  <h3>{draft.title}</h3>
                  {draft.ticket_type_key && <p className="note">Proposed ticket type: <b>{draft.ticket_type_key}</b></p>}
                  <Markdown>{draft.scope_md ?? draft.summary}</Markdown>
                  {!verified && draft.missing.length > 0 && <p className="note">Still needed: {draft.missing.join(', ')}</p>}
                  {verified
                    ? (draft.ticket_id && can('board.view') ? <Link href={`/tickets/${draft.ticket_id}`}>View ticket →</Link> : null)
                    : can('chat.verify')
                      ? <button className="btn verify" onClick={verify} disabled={busy || !draft.ready || draft.stack_fit === 'out_of_scope'} title={!draft.ready ? 'Finish the conversation first: I will ask you to confirm the full scope' : undefined}>Create ticket</button>
                      : <p className="note" style={{ margin: 0 }}>Your role cannot confirm tickets.</p>}
                </div>
              )}
            </aside>
          </>)}
        </div>
      </main>
    </>
  );
}
