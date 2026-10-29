'use client';
import { useCallback, useEffect, useState } from 'react';
import { api, type Flash } from './consoleBits';
import { j } from '../lib/auth';

type Tile = { key: string; name: string; description: string; icon: string; soon?: boolean };
/** Project settings → Modules, grouped. Parts that are not built yet carry a "Coming soon" tag; their switch records the choice for when they ship. */
const GROUPS: { label: string; tiles: Tile[] }[] = [
  { label: 'Project set-up', tiles: [
    { key: 'project_charter', name: 'Project charter', icon: '📜', description: 'Draft the objectives, scope and stakeholders with AI, edit them together, and approve the charter before work starts. Adds the Charter steps to Planning.' },
    { key: 'wbs', name: 'Work breakdown structure (WBS)', icon: '🧩', description: 'Break the approved charter into phases, deliverables and work packages, and rearrange them by drag and drop. Needs Project charter.' },
    { key: 'ritm_prep', name: 'RITM preparation steps', icon: '✅', description: 'Turn work packages into tickets (request items) with their preparation steps and details. Needs the Work breakdown structure.' },
  ] },
  { label: 'Planning & estimation', tiles: [
    { key: 'effort_estimation', name: 'Effort estimation', icon: '⏱', soon: true, description: 'Estimate the work in hours or days per ticket and phase, and compare estimates with what was actually spent.' },
    { key: 'cost_estimation', name: 'Cost estimation', icon: '💰', soon: true, description: 'Turn effort into cost with rate cards, track budget against forecast, and see the variance.' },
    { key: 'timesheets', name: 'Timesheets', icon: '🗓', soon: true, description: 'Let people record time against tickets and see utilisation per person and team.' },
    { key: 'milestones', name: 'Milestones & roadmap', icon: '🚩', soon: true, description: 'Plan key dates and dependencies on a roadmap that the whole project can see.' },
  ] },
  { label: 'Governance & control', tiles: [
    { key: 'risks', name: 'Risk register', icon: '⚠', soon: true, description: 'Log risks and issues with likelihood, impact and owners, and track the mitigation to closure.' },
    { key: 'raci', name: 'RACI matrix', icon: '👥', soon: true, description: 'Say who is Responsible, Accountable, Consulted and Informed for each deliverable and phase.' },
    { key: 'change_control', name: 'Change control log', icon: '📝', soon: true, description: 'Record scope changes with their impact on time and cost, and who agreed to them.' },
    { key: 'assumptions', name: 'Assumptions & dependencies', icon: '🔗', soon: true, description: 'Keep the assumptions and external dependencies the plan relies on in one place.' },
  ] },
];

/** Project settings → Modules: features a Project Admin switches on for this project only. */
export function ModulesAdmin({ flash }: { flash: Flash }) {
  const [on, setOn] = useState<Record<string, boolean> | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const load = useCallback(async () => { try { setOn((await api('/api/project/modules')).modules); } catch (e) { flash('err', (e as Error).message); } }, [flash]);
  useEffect(() => { load(); }, [load]);

  async function toggle(t: Tile, enabled: boolean) {
    setBusy(t.key);
    try {
      const d = await api('/api/project/modules', j({ key: t.key, enabled }, 'PUT'));
      setOn(d.modules);
      flash('ok', t.soon
        ? (enabled ? `${t.name} is chosen. It switches on for this project when it is released.` : `${t.name} is no longer chosen.`)
        : (enabled ? `${t.name} is on. It now appears in Planning for people who can plan.` : `${t.name} is off and hidden in Planning; nothing already planned is deleted.`));
    } catch (e) { flash('err', (e as Error).message); } finally { setBusy(null); }
  }
  if (!on) return <div className="skeleton" style={{ height: 120 }} aria-busy="true" />;
  return (
    <section className="pane tb-sec" aria-label="Module configuration">
      <h3>Module configuration</h3>
      {GROUPS.map((g) => (
        <div key={g.label} className="soon-group">
          <h4 className="mini">{g.label}</h4>
          <ul className="soon-grid">
            {g.tiles.map((t) => (
              <li key={t.key} className={`soon-card ${t.soon ? '' : 'live'} ${on[t.key] ? 'on' : ''}`}>
                <span className="soon-icon" aria-hidden>{t.icon}</span>
                <div className="soon-body">
                  <div className="soon-title"><b>{t.name}</b>{t.soon && <span className="soon-tag">Coming soon</span>}</div>
                  <p className="note">{t.description}</p>
                </div>
                <label className="switch">
                  <input type="checkbox" role="switch" aria-label={`Enable ${t.name}`} checked={!!on[t.key]} disabled={busy === t.key} onChange={(e) => toggle(t, e.target.checked)} />
                  <span className="track" aria-hidden />
                </label>
              </li>))}
          </ul>
        </div>))}
    </section>);
}
