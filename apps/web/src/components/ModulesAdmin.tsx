'use client';
import { useCallback, useEffect, useState } from 'react';
import { api, type Flash } from './consoleBits';
import { j } from '../lib/auth';

type Mod = { key: string; name: string; description: string };

/** Project settings → Modules: features a Project Admin switches on for this project only. */
export function ModulesAdmin({ flash }: { flash: Flash }) {
  const [mods, setMods] = useState<Mod[] | null>(null);
  const [on, setOn] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const load = useCallback(async () => { try { const d = await api('/api/project/modules'); setMods(d.available); setOn(d.modules); } catch (e) { flash('err', (e as Error).message); } }, [flash]);
  useEffect(() => { load(); }, [load]);

  async function toggle(m: Mod, enabled: boolean) {
    setBusy(m.key);
    try {
      const d = await api('/api/project/modules', j({ key: m.key, enabled }, 'PUT'));
      setOn(d.modules);
      flash('ok', enabled ? `${m.name} is on. The Planning tab is now available to people who can plan.` : `${m.name} is off. The tab is hidden; nothing already planned is deleted.`);
    } catch (e) { flash('err', (e as Error).message); } finally { setBusy(null); }
  }
  if (!mods) return <div className="skeleton" style={{ height: 120 }} aria-busy="true" />;
  return (
    <section className="pane tb-sec" aria-label="Module configuration">
      <h3>Module configuration</h3>
      <ul className="mod-list">
        {mods.map((m) => (
          <li key={m.key} className={`mod ${on[m.key] ? 'on' : ''}`}>
            <div><b>{m.name}</b><p className="note" style={{ margin: '4px 0 0' }}>{m.description}</p></div>
            <label className="switch">
              <input type="checkbox" role="switch" aria-label={`Enable ${m.name}`} checked={!!on[m.key]} disabled={busy === m.key} onChange={(e) => toggle(m, e.target.checked)} />
              <span className="track" aria-hidden />
            </label>
          </li>))}
      </ul>
    </section>);
}
