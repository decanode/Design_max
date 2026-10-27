'use client';
import { useCallback, useEffect, useState } from 'react';
import { Nav } from '../components/Nav';

const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';
type Ticket = { id: string; title: string; current_state: string };

export default function Board() {
  const [states, setStates] = useState<string[]>([]);
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [title, setTitle] = useState('');
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      const [s, t] = await Promise.all([fetch(`${API}/api/states`), fetch(`${API}/api/tickets`)]);
      setStates(await s.json()); setTickets(await t.json()); setError('');
    } catch { setError('Cannot reach the API.'); }
  }, []);
  useEffect(() => { load(); }, [load]);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim()) return;
    let pid: string | undefined = (await (await fetch(`${API}/api/projects`)).json())[0]?.id;
    if (!pid) pid = (await (await fetch(`${API}/api/projects`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Default' }) })).json()).id;
    await fetch(`${API}/api/tickets`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ projectId: pid, title }) });
    setTitle(''); load();
  }
  async function advance(t: Ticket) {
    const to = states[states.indexOf(t.current_state) + 1];
    const r = await fetch(`${API}/api/tickets/${t.id}/transition`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ to }) });
    if (!r.ok) setError((await r.json()).error);
    load();
  }

  return (
    <>
      <Nav current="board" />
      <main id="main">
        <form className="new" onSubmit={create}>
          <input aria-label="New ticket title" placeholder="New ticket title" value={title} onChange={(e) => setTitle(e.target.value)} />
          <button type="submit">Create ticket</button>
        </form>
        {error && <p role="alert" className="err">{error}</p>}
        <div className="board">
          {states.map((s, i) => {
            const items = tickets.filter((t) => t.current_state === s);
            return (
              <section className="col" key={s} aria-label={s}>
                <h2><span>{s}</span><span>{items.length}</span></h2>
                {items.map((t) => (
                  <article className="card" key={t.id}>
                    {t.title}
                    {i < states.length - 1 && <div><button onClick={() => advance(t)}>Advance → {states[i + 1]}</button></div>}
                  </article>
                ))}
              </section>
            );
          })}
        </div>
      </main>
    </>
  );
}
