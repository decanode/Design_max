'use client';
import { useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { z } from 'zod';
import { j } from '../../lib/auth';
import type { Charter, PlanningState } from '../../lib/planning';

const Answers = z.object({
  problem: z.string().trim().min(10, 'Describe the business problem in a sentence or two'),
  sponsor: z.string().trim().min(2, 'Name the sponsor'),
  goals: z.string().trim().min(10, 'Add at least one goal'),
  constraints: z.string().trim(),
});
type A = z.infer<typeof Answers>;
const STEPS = [
  { key: 'problem', title: 'The problem', question: 'What is the business problem?', hint: 'What hurts today, for whom, and what it costs. Plain words are fine.', fields: ['problem'] },
  { key: 'sponsor', title: 'The sponsor', question: 'Who is the sponsor?', hint: 'The person who owns the outcome and funds the work, with their role.', fields: ['sponsor'] },
  { key: 'goals', title: 'Goals & constraints', question: 'What are the high-level goals and known constraints?', hint: 'Goals say what success looks like. Constraints are limits: dates, budget, systems, people.', fields: ['goals', 'constraints'] },
  { key: 'review', title: 'Review', question: 'Ready to draft the charter?', hint: 'Check your answers, then let the AI write the first draft. You can edit every word afterwards.', fields: [] },
] as const;
const PROGRESS = ['Reading your answers…', 'Drafting the executive summary…', 'Working out scope and stakeholders…', 'Thinking through milestones and risks…', 'Formatting the charter…'];

/** Three questions, a review, then the AI drafts the charter. Answers are kept if anything goes wrong. */
export function CharterWizard({ charter, ai, onDone }: { charter: Charter | null; ai: PlanningState['ai']; onDone: (s: PlanningState) => void }) {
  const [step, setStep] = useState(0);
  const [dir, setDir] = useState(1);
  const [a, setA] = useState<A>({ problem: '', sponsor: '', goals: '', constraints: '' });
  const [errs, setErrs] = useState<Partial<Record<keyof A, string>>>({});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [confirmReplace, setConfirmReplace] = useState(false);
  const [tick, setTick] = useState(0);
  const locked = charter?.status === 'Approved';
  useEffect(() => { if (charter?.intake) setA((x) => ({ problem: charter.intake.problem ?? x.problem, sponsor: charter.intake.sponsor ?? x.sponsor, goals: charter.intake.goals ?? x.goals, constraints: charter.intake.constraints ?? x.constraints })); }, [charter?.intake]);
  useEffect(() => { if (!busy) return; setTick(0); const t = setInterval(() => setTick((n) => Math.min(n + 1, PROGRESS.length - 1)), 2600); return () => clearInterval(t); }, [busy]);

  const cur = STEPS[step];
  function validate(fields: readonly string[]) {
    const r = Answers.safeParse(a);
    const e: Partial<Record<keyof A, string>> = {};
    if (!r.success) for (const i of r.error.issues) { const k = i.path[0] as keyof A; if (fields.includes(k) && !e[k]) e[k] = i.message; }
    setErrs(e); return Object.keys(e).length === 0;
  }
  const go = (n: number) => { setDir(n > step ? 1 : -1); setStep(n); setErr(''); };
  const next = () => { if (validate(cur.fields)) go(step + 1); };

  async function generate(replace = false) {
    if (!validate(['problem', 'sponsor', 'goals'])) { go(0); return; }
    setBusy(true); setErr(''); setConfirmReplace(false);
    try {
      const r = await fetch('/api/planning/charter/generate', j({ ...a, replace }));
      const b = await r.json().catch(() => ({}));
      if (r.status === 409 && b.exists) { setConfirmReplace(true); return; }
      if (!r.ok) throw new Error(b.details?.[0]?.message ?? b.error ?? 'Could not draft the charter');
      onDone(b);
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }

  const field = (k: keyof A, label: string, multi: boolean, rows = 5) => (
    <div className={`field ${errs[k] ? 'invalid' : ''}`}>
      <label htmlFor={`w-${k}`}>{label}</label>
      {multi
        ? <textarea id={`w-${k}`} rows={rows} value={a[k]} maxLength={4000} aria-invalid={!!errs[k]} onChange={(e) => { setA({ ...a, [k]: e.target.value }); if (errs[k]) setErrs({ ...errs, [k]: undefined }); }} />
        : <input id={`w-${k}`} value={a[k]} maxLength={300} aria-invalid={!!errs[k]} onChange={(e) => { setA({ ...a, [k]: e.target.value }); if (errs[k]) setErrs({ ...errs, [k]: undefined }); }} />}
      <span className="count" aria-hidden>{a[k].length}{multi ? ' / 4000' : ''}</span>
      {errs[k] && <span role="alert" className="err">{errs[k]}</span>}
    </div>);

  return (
    <section className="pane wizard" aria-label="Charter intake">
      <ol className="wizard-steps" aria-label="Wizard progress">
        {STEPS.map((s, i) => <li key={s.key} className={i === step ? 'cur' : i < step ? 'done' : ''} aria-current={i === step ? 'step' : undefined}><button type="button" disabled={i > step || busy} onClick={() => go(i)}><span className="n">{i < step ? '✓' : i + 1}</span>{s.title}</button></li>)}
      </ol>
      <div className="wizard-body">
        {locked && <p className="scope-warn unclear" role="note" style={{ margin: '0 0 14px' }}>The charter is approved. Reopen it on the Charter step to draft a new one.</p>}
        <AnimatePresence mode="wait" custom={dir}>
          <motion.div key={cur.key} initial={{ opacity: 0, x: 24 * dir }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -24 * dir }} transition={{ duration: 0.18 }}>
            <h3 style={{ marginTop: 0 }}>{cur.question}</h3>
            <p className="note" style={{ marginTop: 0 }}>{cur.hint}</p>
            {cur.key === 'problem' && field('problem', 'Business problem', true)}
            {cur.key === 'sponsor' && field('sponsor', 'Sponsor', false)}
            {cur.key === 'goals' && <>{field('goals', 'High-level goals', true, 4)}{field('constraints', 'Known constraints (optional)', true, 3)}</>}
            {cur.key === 'review' && (
              <dl className="review">
                {([['Business problem', a.problem], ['Sponsor', a.sponsor], ['Goals', a.goals], ['Constraints', a.constraints || 'None stated']] as const).map(([l, v], i) => (
                  <div key={l}><dt>{l} <button type="button" className="linklike" onClick={() => go(i === 3 ? 2 : i)}>Edit</button></dt><dd>{v}</dd></div>))}
              </dl>)}
          </motion.div>
        </AnimatePresence>
        {err && <p role="alert" className="err">{err} <span className="note">Your answers are kept.</span></p>}
        {confirmReplace && (
          <div className="scope-warn unclear" role="alertdialog" aria-label="Replace the draft?">
            <b>A charter draft already exists.</b><span>Drafting again replaces it, including your edits.</span>
            <div className="row"><button className="btn" onClick={() => generate(true)}>Replace the draft</button><button className="btn ghost" onClick={() => setConfirmReplace(false)}>Keep the current draft</button></div>
          </div>)}
        <div className="row wizard-nav">
          <button type="button" className="btn ghost" disabled={step === 0 || busy} onClick={() => go(step - 1)}>Back</button>
          {step < STEPS.length - 1
            ? <button type="button" className="btn" onClick={next}>Continue</button>
            : <button type="button" className="btn gen" disabled={busy || locked} onClick={() => generate(false)}>{busy ? 'Drafting…' : `Draft the charter with ${ai.provider === 'gemini' ? 'Gemini' : 'the offline template'}`}</button>}
          <span className="note" style={{ marginLeft: 'auto' }}>{ai.provider === 'gemini' ? `AI: ${ai.model}` : 'No Gemini key is configured: a simple template is used'}</span>
        </div>
      </div>
      <AnimatePresence>
        {busy && (
          <motion.div className="gen-overlay" role="status" aria-live="polite" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
            <div className="gen-card"><div className="gen-spinner" aria-hidden /><b>{PROGRESS[tick]}</b><span className="note">This usually takes 10 to 40 seconds.</span><div className="gen-bar" aria-hidden><i /></div></div>
          </motion.div>)}
      </AnimatePresence>
    </section>);
}
