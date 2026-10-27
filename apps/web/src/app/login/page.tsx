'use client';
import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth, j } from '../../lib/auth';

type DevUser = { id: string; name: string; email: string; role: string };
const BLURB: Record<string, string> = {
  Customer: 'Raise a requirement and follow your requests',
  Consultant: 'Answer chats, draft specifications',
  Lead: 'Assign work, see the whole team',
  Manager: 'Approve specifications, watch the portfolio',
  Admin: 'Everything, plus roles and users',
};

export default function Login() {
  const [users, setUsers] = useState<DevUser[] | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const { refresh } = useAuth();
  const router = useRouter();

  const load = useCallback(async () => {
    try {
      const r = await fetch('/api/auth/dev-users');
      if (r.ok) { setUsers(await r.json()); setError(''); }
      else {
        setUsers([]);
        setError(r.status === 404
          ? 'Development sign-in is turned off on this server.'
          : 'The server could not load accounts. The database may be stopped — check it is running, then reload.');
      }
    } catch { setUsers([]); setError('Cannot reach the server. Check the API is running, then reload.'); }
  }, []);
  useEffect(() => { load(); }, [load]);

  async function signIn(id: string) {
    setBusy(true); setError('');
    const r = await fetch('/api/auth/dev-login', j({ userId: id }));
    if (!r.ok) { setBusy(false); return setError('Could not sign in.'); }
    await refresh(); router.replace('/');
  }
  async function demo() {
    setBusy(true);
    const r = await fetch('/api/auth/bootstrap-demo', { method: 'POST' });
    setBusy(false);
    if (!r.ok) return setError('Could not create demo accounts.');
    load();
  }

  return (
    <main id="main" className="login">
      <div className="login-head">
        <span className="brand-mark big" aria-hidden>DM</span>
        <h1>Design Max</h1>
        <p>Choose an account to continue.</p>
        <p className="note">Development sign-in. Company single sign-on replaces this later.</p>
      </div>
      {error && <p role="alert" className="err">{error}</p>}
      {users === null && <p className="note">Loading…</p>}
      {users?.length === 0 && !error && (
        <div className="pane" style={{ padding: 20, textAlign: 'center' }}>
          <p style={{ marginTop: 0 }}>No accounts exist yet.</p>
          <button className="btn" disabled={busy} onClick={demo}>Create demo accounts</button>
          <p className="note">Creates one user per role (Admin, Lead, Manager, Consultant, Customer).</p>
        </div>
      )}
      <ul className="accounts">
        {users?.map((u) => (
          <li key={u.id}>
            <button className="account" disabled={busy} onClick={() => signIn(u.id)}>
              <span className="avatar" aria-hidden>{u.name.split(' ').map((p) => p[0]).slice(0, 2).join('')}</span>
              <span className="acc-text"><b>{u.name}</b><span className="note">{u.email}</span></span>
              <span className="role-badge" data-role={u.role}>{u.role}</span>
              <span className="note acc-blurb">{BLURB[u.role] ?? 'Custom role'}</span>
            </button>
          </li>
        ))}
      </ul>
    </main>
  );
}
