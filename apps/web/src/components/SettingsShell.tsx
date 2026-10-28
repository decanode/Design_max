'use client';
import { useEffect, useRef, useState, type ReactNode } from 'react';

export interface SettingsItem<K extends string> { key: K; label: string; hint?: string; show?: boolean }
export interface SettingsGroup<K extends string> { label: string; items: SettingsItem<K>[] }

/**
 * Layout for the settings consoles: a grouped navigation rail on the left and one section at a time on the right.
 * The rail is a vertical tab list (same roles and names as before), the open section is kept in the address (#section),
 * and on narrow screens the rail becomes a scrolling strip.
 */
export function SettingsShell<K extends string>({ label, groups, active, onSelect, status, children }: {
  label: string; groups: SettingsGroup<K>[]; active: K; onSelect: (k: K) => void; status: ReactNode; children: ReactNode;
}) {
  const visible = groups.map((g) => ({ ...g, items: g.items.filter((i) => i.show !== false) })).filter((g) => g.items.length);
  const all = visible.flatMap((g) => g.items);
  const current = all.find((i) => i.key === active) ?? all[0];
  const rail = useRef<HTMLDivElement>(null);
  // the side navigation is fixed just under the top bar, so it needs the bar's height
  useEffect(() => {
    const bar = document.querySelector('header.top') as HTMLElement | null;
    const set = () => document.documentElement.style.setProperty('--top-h', `${bar?.getBoundingClientRect().height ?? 64}px`);
    set(); window.addEventListener('resize', set);
    return () => window.removeEventListener('resize', set);
  }, []);

  // arrow keys move between sections, as in any tab list
  function onKey(e: React.KeyboardEvent) {
    const idx = all.findIndex((i) => i.key === current?.key);
    const next = e.key === 'ArrowDown' || e.key === 'ArrowRight' ? idx + 1 : e.key === 'ArrowUp' || e.key === 'ArrowLeft' ? idx - 1 : e.key === 'Home' ? 0 : e.key === 'End' ? all.length - 1 : null;
    if (next === null) return;
    e.preventDefault();
    const target = all[(next + all.length) % all.length];
    onSelect(target.key);
    requestAnimationFrame(() => rail.current?.querySelector<HTMLElement>(`[data-key="${target.key}"]`)?.focus());
  }

  return (
    <div className="settings">
      <nav className="settings-rail" aria-label={label}>
        <div ref={rail} role="tablist" aria-label={label} aria-orientation="vertical" onKeyDown={onKey}>
          {visible.map((g) => (
            <div key={g.label} className="rail-group" role="presentation">
              <span className="rail-label" aria-hidden>{g.label}</span>
              {g.items.map((i) => (
                <button key={i.key} role="tab" data-key={i.key} className="rail-item" aria-selected={current?.key === i.key} tabIndex={current?.key === i.key ? 0 : -1} onClick={() => onSelect(i.key)}>{i.label}</button>))}
            </div>))}
        </div>
      </nav>
      <section className="settings-body" role="tabpanel" aria-label={current?.label}>
        {current && <header className="settings-head"><h3>{current.label}</h3>{current.hint && <p>{current.hint}</p>}</header>}
        <div aria-live="polite" className="settings-status">{status}</div>
        {children}
      </section>
    </div>);
}

/**
 * Keeps the open section, and a drill-down inside it, in the address bar (#members, #members/new, #members/<id>) so a reload or
 * a shared link lands in the same place.
 */
export function useSectionHash<K extends string>(valid: K[], fallback: K): { section: K; choose: (k: K) => void; sub: string | null; setSub: (s: string | null) => void } {
  const [h, setH] = useState<{ section: K | null; sub: string | null }>({ section: null, sub: null });
  useEffect(() => {
    const read = () => { const [a, b] = decodeURIComponent(location.hash.slice(1)).split('/'); setH({ section: (a || null) as K | null, sub: b || null }); };
    read(); window.addEventListener('hashchange', read); return () => window.removeEventListener('hashchange', read);
  }, []);
  const section = h.section && valid.includes(h.section) ? h.section : fallback;
  const go = (sec: K, sub: string | null) => { setH({ section: sec, sub }); history.pushState(null, '', `#${sec}${sub ? `/${sub}` : ''}`); };
  return { section, choose: (k) => go(k, null), sub: h.section === section ? h.sub : null, setSub: (s) => go(section, s) };
}
