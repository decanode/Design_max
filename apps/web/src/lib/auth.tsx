'use client';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import type { Caps, Mode } from './modes';

export type ProjectRef = { id: string; name: string; role?: string | null };
export type Me = {
  user: { id: string; email: string; name: string; role: string; roleId: number | null; isSuperAdmin: boolean };
  project: (ProjectRef & { modules?: Record<string, boolean>; operatingMode?: Mode; caps?: Caps }) | null; projects: ProjectRef[]; permissions: string[];
};
type Ctx = {
  me: Me | null; loading: boolean;
  can: (perm: string) => boolean; canAny: (...perms: string[]) => boolean;
  refresh: () => Promise<void>; logout: () => Promise<void>;
  isSuper: boolean; switchProject: (id: string) => Promise<void>;
};
const AuthCtx = createContext<Ctx | null>(null);
export const useAuth = () => { const c = useContext(AuthCtx); if (!c) throw new Error('useAuth outside AuthProvider'); return c; };

const PUBLIC = [/^\/login/, /^\/approve\//];

export function AuthProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);
  const router = useRouter();
  const path = usePathname();

  const refresh = useCallback(async () => {
    try { const r = await fetch('/api/auth/me'); setMe(r.ok ? await r.json() : null); }
    catch { /* API briefly unreachable: keep the current session view */ }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);
  // Permission changes made by an Admin show up when the user returns to the tab.
  useEffect(() => {
    const f = () => document.visibilityState === 'visible' && refresh();
    document.addEventListener('visibilitychange', f);
    return () => document.removeEventListener('visibilitychange', f);
  }, [refresh]);

  useEffect(() => {
    if (!loading && !me && !PUBLIC.some((p) => p.test(path))) router.replace('/login');
  }, [loading, me, path, router]);

  const value = useMemo<Ctx>(() => {
    const set = new Set(me?.permissions ?? []);
    return {
      me, loading, refresh,
      can: (p) => set.has(p), canAny: (...ps) => ps.some((p) => set.has(p)),
      isSuper: !!me?.user.isSuperAdmin,
      // Everything on screen belongs to one project, so switching reloads the page: nothing from the old project can linger.
      switchProject: async (id) => { const r = await fetch('/api/auth/project', j({ projectId: id })); if (r.ok) window.location.reload(); },
      logout: async () => { await fetch('/api/auth/logout', { method: 'POST' }); setMe(null); router.replace('/login'); },
    };
  }, [me, loading, refresh, router]);

  return <AuthCtx.Provider value={value}>{children}</AuthCtx.Provider>;
}

/** Shown to someone who can sign in but belongs to no project yet (a Super Admin can still use the Platform console). */
export function NoProject() {
  const { isSuper } = useAuth();
  return (
    <div className="pane" style={{ padding: 24, maxWidth: 560, margin: '24px auto' }}>
      <h2 style={{ marginTop: 0 }}>{isSuper ? 'Choose a project' : 'You are not in a project yet'}</h2>
      <p className="note" style={{ margin: 0 }}>{isSuper
        ? 'Pick one from the project menu at the top, or open the Platform console to create one.'
        : 'Ask a Project Admin to add you to a project. Once they do, it will appear in the project menu.'}</p>
    </div>
  );
}

/** Shown when a signed-in user's role lacks the feature. The server enforces this too. */
export function NoAccess({ what }: { what: string }) {
  return <div className="pane" style={{ padding: 24, maxWidth: 560 }}><h2 style={{ marginTop: 0 }}>No access</h2>
    <p className="note" style={{ margin: 0 }}>Your role doesn’t include {what}. Ask an Admin if you need it.</p></div>;
}

export const j = (body: unknown, method = 'POST') => ({ method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
