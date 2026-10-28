'use client';
import type { ReactNode } from 'react';

export type Team = { id: string; name: string };
export type MemberRow = {
  id: string; user_id: string; first_name: string | null; last_name: string | null; name: string; email: string; employee_id: string | null; phone: string | null; mobile: string | null;
  job_title: string | null; department: string | null; company: string | null; location: string | null; cost_center: string | null; manager_id: string | null; manager_name: string | null;
  time_zone: string | null; language: string | null; active: boolean; is_super_admin: boolean; role_id: number; role: string; created_at: string; added_by: string | null;
  teams: Team[]; open_tickets: number; projects: number; notes?: string | null; canEditIdentity?: boolean;
};

const HUES = [212, 262, 330, 24, 150, 190, 48, 290];
export const hueOf = (s: string) => HUES[[...s].reduce((a, c) => a + c.charCodeAt(0), 0) % HUES.length];
export const initials = (name: string) => name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join('') || '?';

export function Avatar({ name, size = 34 }: { name: string; size?: number }) {
  const h = hueOf(name);
  return <span className="avatar" aria-hidden style={{ width: size, height: size, fontSize: size * 0.38, background: `hsl(${h} 70% 92%)`, color: `hsl(${h} 55% 32%)`, borderColor: `hsl(${h} 50% 80%)` }}>{initials(name)}</span>;
}
export const RoleBadge = ({ role }: { role: string }) => <span className="role-pill" data-role={role}>{role}</span>;
export function TeamChips({ teams, max = 2 }: { teams: Team[]; max?: number }) {
  if (!teams.length) return <span className="note">—</span>;
  return <span className="chips">{teams.slice(0, max).map((t) => <span key={t.id} className="chip">{t.name}</span>)}{teams.length > max && <span className="chip more" title={teams.slice(max).map((t) => t.name).join(', ')}>+{teams.length - max}</span>}</span>;
}
export const dateOnly = (iso: string) => new Date(iso).toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric' });

export const TIME_ZONES: [string, string][] = [
  ['UTC', 'UTC'], ['Europe/London', 'London'], ['Europe/Dublin', 'Dublin'], ['Europe/Paris', 'Paris'], ['Europe/Berlin', 'Berlin'], ['Europe/Madrid', 'Madrid'], ['Europe/Amsterdam', 'Amsterdam'], ['Europe/Moscow', 'Moscow'],
  ['Africa/Cairo', 'Cairo'], ['Africa/Lagos', 'Lagos'], ['Africa/Johannesburg', 'Johannesburg'], ['Asia/Dubai', 'Dubai'], ['Asia/Kolkata', 'India (Kolkata)'], ['Asia/Dhaka', 'Dhaka'], ['Asia/Bangkok', 'Bangkok'],
  ['Asia/Singapore', 'Singapore'], ['Asia/Shanghai', 'China (Shanghai)'], ['Asia/Tokyo', 'Tokyo'], ['Asia/Seoul', 'Seoul'], ['Australia/Sydney', 'Sydney'], ['Pacific/Auckland', 'Auckland'],
  ['America/Sao_Paulo', 'São Paulo'], ['America/Argentina/Buenos_Aires', 'Buenos Aires'], ['America/New_York', 'New York'], ['America/Chicago', 'Chicago'], ['America/Denver', 'Denver'],
  ['America/Los_Angeles', 'Los Angeles'], ['America/Toronto', 'Toronto'], ['America/Mexico_City', 'Mexico City'],
];
export const LANGUAGES: [string, string][] = [['en', 'English'], ['en-GB', 'English (UK)'], ['en-US', 'English (US)'], ['de', 'Deutsch'], ['fr', 'Français'], ['es', 'Español'], ['pt-BR', 'Português (Brasil)'], ['hi', 'हिन्दी'], ['ta', 'தமிழ்'], ['te', 'తెలుగు'], ['ja', '日本語'], ['zh', '中文'], ['ar', 'العربية']];

export function Field({ id, label, error, hint, required, children, wide }: { id: string; label: string; error?: string; hint?: string; required?: boolean; children: ReactNode; wide?: boolean }) {
  return (
    <div className={`pf ${error ? 'invalid' : ''} ${wide ? 'wide' : ''}`}>
      <label htmlFor={id}>{label}{required && <span className="req" aria-hidden> *</span>}</label>
      {children}
      {hint && !error && <span className="note">{hint}</span>}
      {error && <span id={`${id}-e`} role="alert" className="err">{error}</span>}
    </div>);
}
