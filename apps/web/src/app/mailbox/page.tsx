'use client';
import { useEffect, useState } from 'react';
import { Nav } from '../../components/Nav';
import { NoAccess, useAuth } from '../../lib/auth';

const API = '';
type Mail = { id: number; to_email: string; subject: string; body: string; created_at: string };

/** Local stand-in for real email: lists what the system "sent" so approval links can be tested. */
export default function Mailbox() {
  const { can, me } = useAuth();
  const [mails, setMails] = useState<Mail[] | null>(null);
  useEffect(() => { if (can('mailbox.view')) fetch(`${API}/api/dev/outbox`).then((r) => r.json()).then(setMails).catch(() => setMails([])); }, [can]);
  const linkify = (t: string) => t.split(/(https?:\/\/\S+)/).map((p, i) => (/^https?:\/\//.test(p) ? <a key={i} href={p.replace(/^https?:\/\/[^/]+/, '')}>{p}</a> : p));
  if (!me) return <><Nav current="mailbox" /><main id="main"><p className="note">Loading…</p></main></>;
  if (!can('mailbox.view')) return <><Nav current="mailbox" /><main id="main"><NoAccess what="the mailbox" /></main></>;
  return (
    <>
      <Nav current="mailbox" />
      <main id="main" className="narrow">
        <h2 style={{ marginTop: 0 }}>Mailbox <span className="note">(development only — no real email is sent)</span></h2>
        {mails === null ? <p className="note">Loading…</p> : mails.length === 0 ? <p className="note">No emails yet.</p> :
          mails.map((m) => (<article key={m.id} className="mail"><strong>{m.subject}</strong><span className="note">To: {m.to_email} · {new Date(m.created_at).toLocaleString()}</span>{'\n'}{linkify(m.body)}</article>))}
      </main>
    </>
  );
}
