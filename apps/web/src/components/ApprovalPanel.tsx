'use client';
import { useEffect, useState } from 'react';
import { Chain } from './WorkflowAdmin';
import { j } from '../lib/auth';

import { EDIT_IN, type Kind } from '../lib/docKinds';
export type ApprovalRequest = {
  id: string; kind: Kind | 'TICKET'; version: number; status: 'in_progress' | 'approved' | 'rejected' | 'superseded' | 'cancelled'; workflow: string; currentLevel: number;
  requestedBy: string | null; requestedById: string | null; requestedAt: string; completedAt: string | null;
  levels: { position: number; name: string; rule: 'any' | 'all'; state: 'done' | 'auto' | 'active' | 'waiting' | 'rejected' | 'stopped'; tasks: { id: string; approver: string; status: string; comment: string | null; decidedAt: string | null }[] }[];
};
type Plan = { workflow: { id: string; name: string } | null; levels: { position: number; name: string; rule: 'any' | 'all'; approvers: string[]; problem: string | null }[] };

const ICON = { done: '✓', auto: '✓', active: '●', waiting: '', rejected: '✕', stopped: '–' } as const;
const STATE_TEXT = { done: 'Approved', auto: 'Passed — already approved by the same person', active: 'Waiting for approval', waiting: 'Not started', rejected: 'Rejected', stopped: 'Stopped' } as const;
const TASK_TEXT: Record<string, string> = { approved: 'Approved', rejected: 'Rejected', pending: 'Waiting', skipped: 'Not needed', superseded: 'Withdrawn' };
const ago = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : '');

export function Timeline({ r }: { r: ApprovalRequest }) {
  return (
    <ol className="steps" aria-label="Approval progress">
      {r.levels.map((l) => (
        <li key={l.position} className="step" data-state={l.state}>
          <span className="step-dot" aria-hidden>{ICON[l.state] || l.position}</span>
          <div>
            <div className="step-title"><span>{l.name}</span><span className="note">{STATE_TEXT[l.state]}{l.tasks.length > 1 ? ` · ${l.rule === 'all' ? 'everyone must approve' : 'any one'}` : ''}</span></div>
            {l.tasks.length > 0 && (
              <ul className="step-who">{l.tasks.map((t) => (
                <li key={t.id}><span>{t.approver}</span> <span className={`st-${t.status}`}>{TASK_TEXT[t.status] ?? t.status}</span>
                  {t.decidedAt && <span className="note"> · {ago(t.decidedAt)}</span>}{t.comment && <span className="note"> — “{t.comment}”</span>}</li>))}</ul>)}
          </div>
        </li>))}
    </ol>
  );
}

/** The route a request will take, the live progress of one in flight, and what happened to the last one. */
export function ApprovalPanel({ ticketId, kind, state, dirty, busy, requests, meId, canRequest, isAdmin, run }: {
  ticketId: string; kind: Kind; state: string; dirty: boolean; busy: boolean; requests: ApprovalRequest[]; meId: string; canRequest: boolean; isAdmin: boolean;
  run: (fn: () => Promise<Response>, ok: string) => Promise<void>;
}) {
  const mine = requests.filter((r) => r.kind === kind);
  const active = mine.find((r) => r.status === 'in_progress');
  const last = mine[0];
  const drafted = EDIT_IN[kind].includes(state);
  const [plan, setPlan] = useState<Plan | null>(null);

  useEffect(() => {
    if (!canRequest || !drafted || active) return;
    let live = true;
    fetch(`/api/tickets/${ticketId}/approval-plan?kind=${kind}`).then((r) => r.ok && r.json()).then((p) => live && p && setPlan(p));
    return () => { live = false; };
  }, [ticketId, kind, canRequest, drafted, active, requests.length]);

  if (active) {
    const level = active.levels.find((l) => l.position === active.currentLevel);
    return (
      <section className="route" aria-label="Approval">
        <h3>Waiting for approval <span className="note">· {active.workflow} · v{active.version} · now at {level?.name}</span></h3>
        <Timeline r={active} />
        <p className="note" style={{ margin: '4px 0 8px' }}>Editing the document withdraws this request.</p>
        {(active.requestedById === meId || isAdmin) && (
          <button className="btn ghost sm" disabled={busy} onClick={() => run(() => fetch(`/api/tickets/${ticketId}/approvals/cancel`, j({ kind })), 'Approval request cancelled.')}>Cancel request</button>)}
      </section>);
  }

  return (
    <>
      {last?.status === 'rejected' && drafted && (
        <section className="route" aria-label="Last approval result">
          <h3>Last request was rejected <span className="note">· v{last.version}</span></h3>
          <Timeline r={last} />
          <p className="note" style={{ margin: 0 }}>Update the document, then request approval again.</p>
        </section>)}
      {canRequest && drafted && plan && (
        <section className="route" aria-label="Approval route">
          {plan.workflow ? (<>
            <h3>Approval route <span className="note">· {plan.workflow.name}</span></h3>
            <Chain levels={plan.levels.map((l) => ({ name: l.name, rule: l.rule, approvers: l.approvers.map((n) => ({ kind: 'user' as const, id: n, name: n })), eligible: l.problem ? 0 : 1 }))} compact />
            <div className="row" style={{ margin: '6px 0 0' }}>
              <button className="btn" disabled={busy || dirty || plan.levels.some((l) => l.problem)} onClick={() => run(() => fetch(`/api/tickets/${ticketId}/approvals`, j({ kind })), 'Approval requested.')}
                title={dirty ? 'Save your changes first' : undefined}>Request approval</button>
              {dirty && <span className="note">Save your changes first.</span>}
              {plan.levels.some((l) => l.problem) && <span className="note">A level has nobody who can approve. Ask an Admin to fix the workflow.</span>}
            </div></>) : (
            <p className="note" style={{ margin: 0 }}>No approval workflow covers this document yet. Ask an Admin to set one up.</p>)}
        </section>)}
    </>
  );
}
