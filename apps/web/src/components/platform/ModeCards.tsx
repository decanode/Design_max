'use client';
import { MODE_LIST, OVERRIDES, type Mode } from '../../lib/modes';

/** Choose how much of the project lifecycle runs inside Design Max. */
export function ModeCards({ value, onChange, label = 'Operating mode' }: { value: Mode; onChange: (m: Mode) => void; label?: string }) {
  return (
    <div className="mode-cards" role="radiogroup" aria-label={label}>
      {MODE_LIST.map((m) => (
        <button key={m.key} type="button" role="radio" aria-checked={value === m.key} className={`mode-card ${value === m.key ? 'on' : ''}`} onClick={() => onChange(m.key)}>
          <span className="mode-icon" aria-hidden>{m.icon}</span>
          <b>{m.name}</b>
          <span className="note">{m.summary}</span>
          <ul>{m.bullets.map((b) => <li key={b}>{b}</li>)}</ul>
          {m.limits.length > 0 && <ul className="limits">{m.limits.map((b) => <li key={b}>{b}</li>)}</ul>}
        </button>))}
    </div>);
}

/** The few capabilities a Super Admin may adjust inside a mode. */
export function OverrideSwitches({ mode, caps, onChange }: { mode: Mode; caps: Record<string, boolean>; onChange: (key: string, on: boolean) => void }) {
  return (
    <ul className="pj-admins" aria-label="Adjustments for this project">
      {OVERRIDES.map((o) => (
        <li key={o.key}><span className="person-text"><b>{o.label}</b><span className="note">{o.hint}</span></span>
          <label className="switch" style={{ marginLeft: 'auto' }}><input type="checkbox" role="switch" aria-label={`${o.label} (${mode} mode)`} checked={!!caps[o.key]} onChange={(e) => onChange(o.key, e.target.checked)} /><span className="track" aria-hidden /></label></li>))}
    </ul>);
}
