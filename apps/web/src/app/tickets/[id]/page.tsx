'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams } from 'next/navigation';
import { Nav } from '../../../components/Nav';
import { DocEditor, DocView, type EditorApi } from '../../../components/DocEditor';
import { MergeDialog } from '../../../components/MergeDialog';
import { CommentsPanel, useThreads } from '../../../components/CommentsPanel';
import { KINDS, LABEL, FULL, GENERATE_IN, EDIT_IN, HINT, type Kind } from '../../../lib/docKinds';
import { ApprovalPanel, Timeline, type ApprovalRequest } from '../../../components/ApprovalPanel';
import { TypeDetails } from '../../../components/TypeDetails';
import { useWorkflow, type TypeField } from '../../../lib/workflow';
import { TicketDetails, type DetailTicket } from '../../../components/TicketDetails';
import Link from 'next/link';
import { SourceCard } from '../../../components/ticket/SourceCard';
import { ActivityFeed } from '../../../components/ticket/ActivityFeed';
import { ClosurePanel, type Signoff } from '../../../components/ticket/ClosurePanel';
import { DetailsSidebar, PriorityBadge } from '../../../components/ticket/DetailsSidebar';
import { NoAccess, NoProject, useAuth } from '../../../lib/auth';

const API = '';
type Ver = { version: number; author: string | null; note: string | null; at: string };
type Overview = {
  ticketType?: { id: number; key: string; name: string; short: string; fields: TypeField[] } | null;
  ticket: DetailTicket & { dynamic_metadata?: Record<string, unknown>; type_short?: string; type_name?: string; team_id?: string | null; team_name?: string | null; current_state: string; approval_status?: 'none' | 'pending' | 'approved' | 'rejected'; key?: string; priority?: string; due_date?: string | null; created_at: string; updated_at: string; customer_name?: string | null; consultant_name?: string | null; consultant_id?: string | null; is_assigned?: boolean };
  fields: Record<string, 'hidden' | 'read' | 'write'>;
  docRules?: Record<string, 'off' | 'optional' | 'required'>; approvedKinds?: string[]; signoff?: Signoff;
  docs: Record<Kind, { latest: { version_number: number; content_md: string }; versions: Ver[] } | null>;
  stacks?: string[]; stackWarnings?: { kind: Kind; stack: string; terms: string[] }[];
  approvals: { id: string; approver_id: string; kind: Kind | 'TICKET'; version_number: number; status: string; comment: string | null; approver: string; level_name: string | null }[];
  requests: ApprovalRequest[];
};
type DiffLine = { type: 'same' | 'add' | 'del'; text: string };

const j = (body: unknown) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

export default function TicketPage() {
  const { id } = useParams<{ id: string }>();
  const { me, can, loading: authLoading } = useAuth();
  const [people, setPeople] = useState<{ id: string; name: string }[]>([]);
  const [teamOptions, setTeamOptions] = useState<{ id: string; name: string }[]>([]);
  const [decision, setDecision] = useState('');
  const wf = useWorkflow(!!me?.project);
  const [next, setNext] = useState<{ to: string; gated: string | null }[]>([]);
  const [o, setO] = useState<Overview | null>(null);
  const [kind, setKind] = useState<Kind>('FS');
  const [viewJson, setViewJson] = useState<unknown>(null);   // a saved version being viewed
  const [changed, setChanged] = useState(false);               // the shared draft is ahead of the latest version
  const [lock, setLock] = useState<string | null>(null);
  const [merging, setMerging] = useState(false);
  const [api, setApi] = useState<EditorApi | null>(null);
  const [hasSel, setHasSel] = useState(false);
  const [active, setActive] = useState<string | null>(null);
  const [orphans, setOrphans] = useState<string[]>([]);
  const [viewing, setViewing] = useState<number | null>(null);   // historical version being viewed (read-only)
  const [diff, setDiff] = useState<DiffLine[] | null>(null);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [activityTick, setActivityTick] = useState(0);

  const load = useCallback(async () => {
    const r = await fetch(`${API}/api/tickets/${id}`);
    if (!r.ok) return setMsg({ kind: 'err', text: 'Ticket not found.' });
    const data: Overview = await r.json();
    setO(data); setActivityTick((n) => n + 1);
    return data;
  }, [id]);

  useEffect(() => { if (can('ticket.assign')) { fetch(`${API}/api/users/assignable`).then((r) => r.ok && r.json()).then((d) => d && setPeople(d)); fetch(`${API}/api/project/team-options`).then((r) => r.ok && r.json()).then((d) => d && setTeamOptions(d)); } }, [can]);
  useEffect(() => { if (!me) return; load().then((d) => {
    if (!d) return;
    const usable = KINDS.filter((k) => d.docRules?.[k] !== 'off');
    setKind(([...usable].reverse().find((k) => d.docs[k]) ?? usable[0] ?? 'FS') as Kind);
  }); }, [load, me]);

  const doc = o?.docs[kind] ?? null;
  const latest = doc?.latest.version_number ?? 0;
  const state = o?.ticket.current_state ?? '';
  const editable = can('spec.edit') && EDIT_IN[kind].includes(state) && viewing === null && !lock;
  const dirty = editable && changed;
  const canGenerate = can('spec.generate') && GENERATE_IN[kind].includes(state);
  const { threads, unresolved, reload: reloadThreads } = useThreads(id, kind, !!doc && can('spec.view'));
  const onPass = useCallback((p: { lock: string | null }) => setLock(p.lock), []);
  const refreshStatus = useCallback(async () => {
    if (!doc) return;
    const r = await fetch(`${API}/api/tickets/${id}/documents/${kind}/draft-status`);
    if (r.ok) { const st = await r.json(); setChanged(st.changed); setLock(st.lock); }
  }, [id, kind, doc]);
  useEffect(() => { setChanged(false); if (!doc) return; refreshStatus(); const t = setInterval(refreshStatus, 4000); return () => clearInterval(t); }, [refreshStatus, doc]);
  const myApproval = o?.approvals.find((a) => a.kind === kind && a.status === 'pending' && a.approver_id === me?.user.id);

  function pick(k: Kind) { setKind(k); setViewing(null); setDiff(null); setViewJson(null); setLock(null); setMsg(null); }

  async function run(fn: () => Promise<Response>, okText: string) {
    setBusy(true); setMsg(null);
    try {
      const r = await fn(); const b = await r.json().catch(() => ({}));
      if (!r.ok) setMsg({ kind: 'err', text: b.error ?? 'Request failed' }); else setMsg({ kind: 'ok', text: okText });
      await load(); await refreshStatus(); setViewing(null); setDiff(null);
    } finally { setBusy(false); }
  }

  const generate = (k: Kind) => run(() => fetch(`${API}/api/tickets/${id}/documents/generate`, j({ kind: k })), 'Draft created.');
  const save = () => run(() => fetch(`${API}/api/tickets/${id}/documents/${kind}/snapshot`, j({})), 'Saved as a new version.');
  async function claim() { await run(() => fetch(`${API}/api/tickets/${id}/claim`, { method: 'POST' }), 'You now own this ticket.'); }
  async function assignTeam(teamId: string) { await run(() => fetch(`${API}/api/tickets/${id}/team`, j({ teamId: teamId || null })), 'Team updated.'); }
  async function assign(consultantId: string) { await run(() => fetch(`${API}/api/tickets/${id}/assign`, j({ consultantId: consultantId || null })), 'Assignment updated.'); }
  async function decide(approvalId: string, d: 'approved' | 'rejected') {
    await run(() => fetch(`${API}/api/my/approvals/${approvalId}/decision`, j({ decision: d, comment: decision })), d === 'approved' ? 'Approved. The ticket moved on.' : 'Rejected with your comment.');
    setDecision('');
  }

  async function open(v: number) {
    if (v === latest) { setViewing(null); setDiff(null); setViewJson(null); return; }
    const r = await fetch(`${API}/api/tickets/${id}/documents/${kind}/versions/${v}`);
    setViewJson((await r.json()).content_json); setViewing(v);
    const d = await fetch(`${API}/api/tickets/${id}/documents/${kind}/diff?from=${v}&to=${latest}`);
    setDiff(d.ok ? await d.json() : null);
  }

  const STATES = useMemo(() => {
    const names = (wf?.phases ?? []).filter((p) => p.enabled).map((p) => p.name);
    return names.includes(state) || !state ? names : [...names, state];
  }, [wf, state]);
  const idx = STATES.indexOf(state);
  useEffect(() => { if (o) fetch(`${API}/api/tickets/${id}/next`).then((r) => r.ok && r.json()).then((d) => d && setNext(d.options)); }, [id, o?.ticket.current_state]);   // eslint-disable-line react-hooks/exhaustive-deps

  if (authLoading || !me) return <><Nav current="none" /><main id="main"><p className="note">Loading…</p></main></>;
  if (!me.project) return <><Nav current="none" /><main id="main"><NoProject /></main></>;
  if (!o) return <><Nav current="none" /><main id="main">{msg ? <p role="alert" className="err">{msg.text}</p> : <p className="note">Loading…</p>}</main></>;

  return (
    <>
      <Nav current="none" />
      <main id="main" className="tk">
        <nav className="crumbs" aria-label="Breadcrumb"><Link href="/" className="linklike">Board</Link><span aria-hidden> › </span><span aria-current="page">{o.ticket.key ?? o.ticket.title}</span></nav>
        <header className="tk-head">
          <h2>{o.ticket.type_short && <span className="type-tag" title={o.ticket.type_name} style={{ marginRight: 8, verticalAlign: 'middle' }}>{o.ticket.type_short}</span>}{o.ticket.key && <span className="tk-key">{o.ticket.key}</span>}{o.ticket.title}</h2>
          <div className="tk-badges"><PriorityBadge p={o.ticket.priority} />{o.ticket.approval_status === 'pending' && <span className="tag warn">Awaiting approval</span>}{o.signoff?.latest?.status === 'pending' && <span className="tag warn">Awaiting customer</span>}</div>
        </header>
        {(o.stackWarnings?.length ?? 0) > 0 && (
          <div className="scope-warn unclear" role="alert" style={{ marginBottom: 14 }}>
            <b>Possible off-stack content</b>
            <span>{o.stackWarnings!.map((w) => `${w.kind} mentions ${w.stack} (${w.terms.join(', ')})`).join('; ')}. This project is limited to {o.stacks!.join(', ')}. Review before approving.</span>
          </div>)}
        <ol className="stepper" aria-label="Ticket lifecycle">
          {STATES.map((s, i) => <li key={s} className={i < idx ? 'done' : i === idx ? 'cur' : ''} aria-current={i === idx ? 'step' : undefined}>{s}</li>)}
        </ol>

        <div className="tk-grid">
        <div className="tk-main">
        <SourceCard t={o.ticket as never} />
        <TicketApproval o={o} meId={me.user.id} canResubmit={can('admin.workflows') || can('approval.request') || o.ticket.consultant_id === me.user.id || (o.ticket as { customer_id?: string }).customer_id === me.user.id} busy={busy} run={run} decision={decision} setDecision={setDecision} />
        {o.signoff && o.docRules && <ClosurePanel ticketId={id} docRules={o.docRules} approvedKinds={o.approvedKinds ?? []} signoff={o.signoff} canAsk={can('ticket.advance')} busy={busy} run={run} openDoc={(k) => { pick(k); document.getElementById('tk-docs')?.scrollIntoView({ behavior: 'smooth' }); }} />}
        <TicketDetails ticket={o.ticket} fields={o.fields} onSaved={() => load()} />
        {o.ticketType && <TypeDetails ticketId={id} typeName={o.ticketType.name} fields={o.ticketType.fields} values={o.ticket.dynamic_metadata} access={o.fields.details} onSaved={() => load()} />}

        {!can('spec.view') ? null : (<section id="tk-docs" className="tk-docs" aria-label="Documents">
        <div className="tabs" role="tablist" aria-label="Specification">
          {KINDS.filter((k) => o.docRules?.[k] !== 'off').map((k) => (
            <button key={k} role="tab" className="tab" data-required={o.docRules?.[k] === 'required' ? 'true' : undefined} aria-selected={kind === k} onClick={() => pick(k)}>
              {LABEL[k]}{o.docs[k] ? ` · v${o.docs[k]!.latest.version_number}` : ''}{k === kind && unresolved > 0 ? ` · ${unresolved} open` : ''}
            </button>
          ))}
        </div>

        {msg && <p role={msg.kind === 'err' ? 'alert' : 'status'} className={msg.kind === 'err' ? 'err' : 'ok'}>{msg.text}</p>}

        {!doc ? (
          <div className="pane" style={{ padding: 20 }}>
            {canGenerate ? (<>
              <p style={{ marginTop: 0 }}>No {FULL[kind]} yet. Generate a first draft{kind === 'FS' ? ' from the intake conversation' : kind === 'TS' ? ' from the approved Functional Specification' : ' from the approved specifications'}.</p>
              <button className="btn" disabled={busy} onClick={() => generate(kind)}>Generate {kind} draft</button>
            </>) : <p className="note" style={{ margin: 0 }}>The {FULL[kind]} can be generated {HINT[kind]}.</p>}
          </div>
        ) : (
          <div className="doc">
            <section aria-label={`${kind} document`}>
              {viewing !== null && <p className="note">Viewing version {viewing} (read-only). <button className="btn ghost" onClick={() => open(latest)}>Back to latest</button></p>}
              {viewing !== null ? <DocView json={viewJson} /> : <DocEditor key={`${kind}-${editable}`} ticketId={id} kind={kind} userName={me.user.name} onPass={onPass} threads={threads} activeId={active} onActivate={setActive} onOrphans={setOrphans} onReady={setApi} onSelection={setHasSel} />}
              {diff && <><h3>Changes in the latest version</h3><div className="diff" role="region" aria-label="Diff">{diff.map((l, i) => <div key={i} className={l.type}>{l.type === 'add' ? '+ ' : l.type === 'del' ? '− ' : '  '}{l.text}</div>)}</div></>}
              {editable && (
                <div className="row">
                  <button className="btn" disabled={!dirty || busy} onClick={save}>Save version</button>
                  {can('spec.edit') && <button className="btn ghost" disabled={busy} onClick={() => setMerging(true)}>Upload &amp; merge a Word file</button>}
                  {dirty && <span className="note">The shared draft has changes that are not in a saved version yet</span>}
                </div>
              )}
              <ApprovalPanel ticketId={id} kind={kind} state={state} dirty={false} busy={busy} requests={o.requests ?? []} meId={me.user.id}
                canRequest={can('approval.request') && viewing === null} isAdmin={can('admin.workflows')} run={run} />
              {myApproval && (
                <div className="pane" style={{ padding: 14, marginTop: 12 }}>
                  <h3 style={{ margin: '0 0 8px' }}>Your decision{myApproval.level_name ? ` at ${myApproval.level_name}` : ''} on v{myApproval.version_number}</h3>
                  <label className="sr" htmlFor="dec">Comment</label>
                  <textarea id="dec" rows={2} placeholder="Comment (required to reject)" value={decision} onChange={(e) => setDecision(e.target.value)}
                    style={{ width: '100%', padding: 10, borderRadius: 8, border: '1px solid var(--line)', background: 'var(--bg)', color: 'var(--text)' }} />
                  <div className="row">
                    <button className="btn verify" style={{ width: 'auto' }} disabled={busy} onClick={() => decide(myApproval.id, 'approved')}>Approve</button>
                    <button className="btn ghost" disabled={busy || !decision.trim()} onClick={() => decide(myApproval.id, 'rejected')}>Reject</button>
                  </div>
                </div>)}
            </section>
            {merging && <MergeDialog ticketId={id} kind={kind} onClose={() => setMerging(false)} onDone={(v) => { setMerging(false); setMsg({ kind: 'ok', text: `Merged. Saved as version ${v}.` }); load(); refreshStatus(); }} />}
            <aside className="side" aria-label="History">
              {can('doc.comment') || threads.length ? (
                <div className="cm-wrap" style={{ marginBottom: 16 }}>
                  <CommentsPanel ticketId={id} kind={kind} meId={me.user.id} threads={threads} reload={reloadThreads} api={api} hasSelection={hasSel} activeId={active} setActive={setActive} orphans={orphans}
                    canComment={can('doc.comment')} canEdit={can('spec.edit')} canReview={can('doc.review')} latest={latest} />
                </div>) : null}
              <div>
                <h3>Versions</h3>
                {can('spec.view') && (
                  <a className="btn ghost sm" style={{ textDecoration: 'none', display: 'inline-block', marginBottom: 8 }} download
                    href={`/api/tickets/${id}/documents/${kind}/export?version=${viewing ?? latest}`}>Download v{viewing ?? latest} as Word</a>)}
                <ul>{doc.versions.map((v) => (
                  <li key={v.version}><button aria-pressed={(viewing ?? latest) === v.version} onClick={() => open(v.version)}>
                    v{v.version}{v.version === latest ? ' (latest)' : ''}<br /><span className="note">{v.author ?? '—'}{v.note ? ` · ${v.note}` : ''}</span>
                  </button></li>))}</ul>
              </div>
            </aside>
          </div>
        )}
        </section>)}
        <ActivityFeed ticketId={id} version={activityTick} staff={can('ticket.view_all') || can('ticket.advance')} onPosted={() => load()} />
        </div>
        <DetailsSidebar t={{ ...o.ticket, id }} fields={o.fields} stacks={o.stacks} can={can} people={people} teamOptions={teamOptions} busy={busy} run={run}>
          <PhaseMoves next={next} state={state} can={can('ticket.advance') && (o.ticket.approval_status ?? 'none') !== 'pending' && o.ticket.approval_status !== 'rejected'} busy={busy} onMove={(to) => run(() => fetch(`${API}/api/tickets/${id}/transition`, j({ to })), `Moved to ${to}.`)} />
        </DetailsSidebar>
        </div>
      </main>
    </>
  );
}

/** Where this ticket can go next. Steps that belong to documents and approvals say what they need instead of offering a button. */
function PhaseMoves({ next, state, can, busy, onMove }: { next: { to: string; gated: string | null }[]; state: string; can: boolean; busy: boolean; onMove: (to: string) => void }) {
  if (!next.length) return <p className="note" style={{ margin: '0 0 12px' }}>{state} is the last phase of this ticket's workflow.</p>;
  return (
    <section className="phase-moves" aria-label="Next phase">
      <span className="note">Next:</span>
      {next.map((n) => n.gated
        ? <span key={n.to} className="tag" title={n.gated}>{n.to} · {n.gated}</span>
        : can ? <button key={n.to} className="btn sm" disabled={busy} onClick={() => onMove(n.to)}>Move to {n.to}</button> : <span key={n.to} className="tag">{n.to}</span>)}
    </section>);
}


/** A ticket whose creation needs approval: where it stands, who must decide, and (when refused) the way to send it again. */
function TicketApproval({ o, meId, canResubmit, busy, run, decision, setDecision }: {
  o: Overview; meId: string; canResubmit: boolean; busy: boolean; run: (fn: () => Promise<Response>, okText: string) => Promise<void>; decision: string; setDecision: (v: string) => void;
}) {
  const st = o.ticket.approval_status ?? 'none';
  const req = o.requests.find((r) => r.kind === 'TICKET');
  const mine = o.approvals.find((a) => a.kind === 'TICKET' && a.status === 'pending' && a.approver_id === meId);
  if (st === 'none' || !req) return null;
  const refusal = req.levels.flatMap((l) => l.tasks).find((t) => t.status === 'rejected');
  return (
    <section className={`ticket-approval ${st}`} aria-label="Ticket approval">
      <h3>{st === 'pending' ? 'Waiting for approval' : st === 'approved' ? 'Approved' : 'Not approved'} <span className="note">· {req.workflow}</span></h3>
      {st === 'pending' && <p className="note" style={{ margin: 0 }}>Work on this ticket starts once every level below has approved. Phase moves and documents are on hold until then.</p>}
      {st === 'rejected' && <p style={{ margin: 0 }}>{refusal ? `${refusal.approver} did not approve${refusal.comment ? `: “${refusal.comment}”` : ''}.` : 'The request was withdrawn.'} Update the ticket if needed, then send it again.</p>}
      <Timeline r={req} />
      {mine && (
        <div>
          <label htmlFor="t-dec">Comment <span className="note">(required to reject)</span></label>
          <textarea id="t-dec" rows={2} value={decision} onChange={(e) => setDecision(e.target.value)} style={{ width: '100%', margin: '6px 0 10px', padding: 10, borderRadius: 8, border: '1px solid var(--line)', background: 'var(--panel)', color: 'var(--text)' }} />
          <div className="row" style={{ margin: 0 }}>
            <button className="btn verify" style={{ width: 'auto' }} disabled={busy} onClick={() => { run(() => fetch(`/api/my/approvals/${mine.id}/decision`, j({ decision: 'approved', comment: decision })), 'Approved.'); setDecision(''); }}>Approve</button>
            <button className="btn ghost" disabled={busy || !decision.trim()} onClick={() => { run(() => fetch(`/api/my/approvals/${mine.id}/decision`, j({ decision: 'rejected', comment: decision })), 'Rejected with your comment.'); setDecision(''); }}>Reject</button>
          </div>
        </div>)}
      {st === 'rejected' && canResubmit && <button className="btn" style={{ width: 'auto' }} disabled={busy} onClick={() => run(() => fetch(`/api/tickets/${o.ticket.id}/approvals/resubmit`, j({})), 'Sent for approval again.')}>Send for approval again</button>}
      {st === 'pending' && canResubmit && <button className="btn ghost sm" disabled={busy} onClick={() => run(() => fetch(`/api/tickets/${o.ticket.id}/approvals/cancel`, j({ kind: 'TICKET' })), 'Approval request withdrawn. The ticket is on hold.')}>Withdraw request</button>}
    </section>);
}
