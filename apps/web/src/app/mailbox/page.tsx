'use client';
import { useEffect, useState } from 'react';
import { Nav } from '../../components/Nav';

const API = process.env.NEXT_PUBLIC_API_URL ?? '';
type Mail = { id: number; to_email: string; subject: string; body: string; created_at: string };

/** Local stand-in for real email: lists what the system "sent" so approval links can be tested. */
export default function Mailbox() {
  const [mails, setMails] = useState<Mail[] | null>(null);
  useEffect(() => { fetch(`${API}/api/dev/outbox`).then((r) => r.json()).then(setMails).catch(() => setMails([])); }, []);
  const linkify = (t: string) => t.split(/(https?:\/\/\S+)/).map((p, i) => (/^https?:\/\//.test(p) ? <a key={i} href={p.replace(/^https?:\/\/[^/]+/, '')}>{p}</a> : p));
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
