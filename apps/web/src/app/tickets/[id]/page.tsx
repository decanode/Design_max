'use client';
import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { Nav } from '../../../components/Nav';
import { Markdown } from '../../../components/Markdown';
import { ApprovalPanel, type ApprovalRequest } from '../../../components/ApprovalPanel';
import { NoAccess, useAuth } from '../../../lib/auth';

const API = '';
const STATES = ['Requirement Verified', 'FS Drafted', 'FS Approved', 'TS Drafted', 'TS Approved', 'Development', 'QA', 'UAT', 'Deployed'];
type Kind = 'FS' | 'TS';
type Ver = { version: number; author: string | null; note: string | null; at: string };
type Overview = {
  ticket: { id: string; title: string; current_state: string; ai_summary: string | null; customer_name: string | null; consultant_name: string | null; consultant_id: string | null };
  docs: Record<Kind, { latest: { version_number: number; content_md: string }; versions: Ver[] } | null>;
  stacks?: string[]; stackWarnings?: { kind: Kind; stack: string; terms: string[] }[];
  approvals: { id: string; approver_id: string; kind: Kind; version_number: number; status: string; comment: string | null; approver: string; level_name: string | null }[];
  requests: ApprovalRequest[];
};
type DiffLine = { type: 'same' | 'add' | 'del'; text: string };

const j = (body: unknown) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

export default function TicketPage() {
  const { id } = useParams<{ id: string }>();
  const { me, can, loading: authLoading } = useAuth();
  const [people, setPeople] = useState<{ id: string; name: string }[]>([]);
  const [decision, setDecision] = useState('');
  const [o, setO] = useState<Overview | null>(null);
  const [kind, setKind] = useState<Kind>('FS');
  const [text, setText] = useState('');
  const [viewing, setViewing] = useState<number | null>(null);   // historical version being viewed (read-only)
  const [diff, setDiff] = useState<DiffLine[] | null>(null);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const r = await fetch(`${API}/api/tickets/${id}`);
    if (!r.ok) return setMsg({ kind: 'err', text: 'Ticket not found.' });
    const data: Overview = await r.json();
    setO(data);
    return data;
  }, [id]);

  useEffect(() => { if (can('ticket.assign')) fetch(`${API}/api/users/assignable`).then((r) => r.ok && r.json()).then((d) => d && setPeople(d)); }, [can]);
  useEffect(() => { if (!me) return; load().then((d) => {
    if (!d) return;
    const k: Kind = d.docs.TS ? 'TS' : 'FS';
    setKind(k); setText(d.docs[k]?.latest.content_md ?? '');
  }); }, [load, me]);

  const doc = o?.docs[kind] ?? null;
  const latest = doc?.latest.version_number ?? 0;
  const state = o?.ticket.current_state ?? '';
  const editable = can('spec.edit') && state === `${kind} Drafted` && viewing === null;
  const dirty = editable && doc != null && text !== doc.latest.content_md;
  const canGenerate = can('spec.generate') && ((kind === 'FS' && state === 'Requirement Verified') || (kind === 'TS' && state === 'FS Approved'));
  const myApproval = o?.approvals.find((a) => a.kind === kind && a.status === 'pending' && a.approver_id === me?.user.id);

  function pick(k: Kind) { setKind(k); setViewing(null); setDiff(null); setText(o?.docs[k]?.latest.content_md ?? ''); setMsg(null); }

  async function run(fn: () => Promise<Response>, okText: string) {
    setBusy(true); setMsg(null);
    try {
      const r = await fn(); const b = await r.json().catch(() => ({}));
      if (!r.ok) setMsg({ kind: 'err', text: b.error ?? 'Request failed' }); else setMsg({ kind: 'ok', text: okText });
      const d = await load(); if (d) setText(d.docs[kind]?.latest.content_md ?? ''); setViewing(null); setDiff(null);
    } finally { setBusy(false); }
  }

  const generate = (k: Kind) => run(() => fetch(`${API}/api/tickets/${id}/documents/generate`, j({ kind: k })), 'Draft created.');
  const save = () => run(() => fetch(`${API}/api/tickets/${id}/documents/${kind}/versions`, j({ content: text, baseVersion: latest })), 'Saved as a new version.');
  async function claim() { await run(() => fetch(`${API}/api/tickets/${id}/claim`, { method: 'POST' }), 'You now own this ticket.'); }
  async function assign(consultantId: string) { await run(() => fetch(`${API}/api/tickets/${id}/assign`, j({ consultantId: consultantId || null })), 'Assignment updated.'); }
  async function decide(approvalId: string, d: 'approved' | 'rejected') {
    await run(() => fetch(`${API}/api/my/approvals/${approvalId}/decision`, j({ decision: d, comment: decision })), d === 'approved' ? 'Approved. The ticket moved on.' : 'Rejected with your comment.');
    setDecision('');
  }

  async function open(v: number) {
    if (v === latest) { setViewing(null); setDiff(null); setText(doc!.latest.content_md); return; }
    const r = await fetch(`${API}/api/tickets/${id}/documents/${kind}/versions/${v}`);
    setText((await r.json()).content_md); setViewing(v);
    const d = await fetch(`${API}/api/tickets/${id}/documents/${kind}/diff?from=${v}&to=${latest}`);
    setDiff(d.ok ? await d.json() : null);
  }

  const idx = STATES.indexOf(state);

  if (authLoading || !me) return <><Nav current="none" /><main id="main"><p className="note">Loading…</p></main></>;
  if (!o) return <><Nav current="none" /><main id="main">{msg ? <p role="alert" className="err">{msg.text}</p> : <p className="note">Loading…</p>}</main></>;

  return (
    <>
      <Nav current="none" />
      <main id="main">
        <h2 style={{ marginTop: 0 }}>{o.ticket.title}</h2>
        <div className="row" style={{ marginTop: -4 }}>
          <span className="note">Customer: {o.ticket.customer_name ?? '—'}</span>
          <span className="note">· Consultant: {o.ticket.consultant_name ?? 'Unassigned'}</span>
          {!o.ticket.consultant_id && can('ticket.claim') && <button className="btn sm" disabled={busy} onClick={claim}>Claim this ticket</button>}
          {can('ticket.assign') && (
            <select aria-label="Assign consultant" value={o.ticket.consultant_id ?? ''} onChange={(e) => assign(e.target.value)}>
              <option value="">Unassigned</option>{people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>)}
        </div>
        {(o.stacks?.length ?? 0) > 0 && <p className="note" style={{ marginTop: 0 }}>Project technology: <span className="stack-chips">{o.stacks!.map((t) => <span key={t} className="chip">{t}</span>)}</span></p>}
        {(o.stackWarnings?.length ?? 0) > 0 && (
          <div className="scope-warn unclear" role="alert" style={{ marginBottom: 14 }}>
            <b>Possible off-stack content</b>
            <span>{o.stackWarnings!.map((w) => `${w.kind} mentions ${w.stack} (${w.terms.join(', ')})`).join('; ')}. This project is limited to {o.stacks!.join(', ')}. Review before approving.</span>
          </div>)}
        <ol className="stepper" aria-label="Ticket lifecycle">
          {STATES.map((s, i) => <li key={s} className={i < idx ? 'done' : i === idx ? 'cur' : ''} aria-current={i === idx ? 'step' : undefined}>{s}</li>)}
        </ol>

        {!can('spec.view') ? <NoAccess what="the specifications" /> : (<>
        <div className="tabs" role="tablist" aria-label="Specification">
          {(['FS', 'TS'] as Kind[]).map((k) => (
            <button key={k} role="tab" className="tab" aria-selected={kind === k} onClick={() => pick(k)}>
              {k === 'FS' ? 'Functional Spec' : 'Technical Spec'}{o.docs[k] ? ` · v${o.docs[k]!.latest.version_number}` : ''}
            </button>
          ))}
        </div>

        {msg && <p role={msg.kind === 'err' ? 'alert' : 'status'} className={msg.kind === 'err' ? 'err' : 'ok'}>{msg.text}</p>}

        {!doc ? (
          <div className="pane" style={{ padding: 20 }}>
            {canGenerate ? (<>
              <p style={{ marginTop: 0 }}>No {kind === 'FS' ? 'Functional' : 'Technical'} Specification yet. Generate a first draft from {kind === 'FS' ? 'the intake conversation' : 'the approved Functional Specification'}.</p>
              <button className="btn" disabled={busy} onClick={() => generate(kind)}>Generate {kind} draft</button>
            </>) : <p className="note" style={{ margin: 0 }}>{kind === 'TS' ? 'The Technical Specification can be generated once the Functional Specification is approved.' : 'Not available at this stage.'}</p>}
          </div>
        ) : (
          <div className="doc">
            <section aria-label={`${kind} document`}>
              {viewing !== null && <p className="note">Viewing version {viewing} (read-only). <button className="btn ghost" onClick={() => open(latest)}>Back to latest</button></p>}
              {!editable && viewing === null && <p className="note">This document is locked ({state}).</p>}
              <div className="editor">
                {editable ? (<>
                  <textarea aria-label="Markdown editor" value={text} onChange={(e) => setText(e.target.value)} spellCheck />
                  <Markdown>{text}</Markdown>
                </>) : <div style={{ gridColumn: '1 / -1' }}><Markdown>{text}</Markdown></div>}
              </div>
              {diff && <><h3>Changes in the latest version</h3><div className="diff" role="region" aria-label="Diff">{diff.map((l, i) => <div key={i} className={l.type}>{l.type === 'add' ? '+ ' : l.type === 'del' ? '− ' : '  '}{l.text}</div>)}</div></>}
              {editable && (
                <div className="row">
                  <button className="btn" disabled={!dirty || busy} onClick={save}>Save new version</button>
                  {dirty && <span className="note">Unsaved changes</span>}
                </div>
              )}
              <ApprovalPanel ticketId={id} kind={kind} state={state} dirty={dirty} busy={busy} requests={o.requests ?? []} meId={me.user.id}
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
            <aside className="side" aria-label="History">
              <div>
                <h3>Versions</h3>
                <ul>{doc.versions.map((v) => (
                  <li key={v.version}><button aria-pressed={(viewing ?? latest) === v.version} onClick={() => open(v.version)}>
                    v{v.version}{v.version === latest ? ' (latest)' : ''}<br /><span className="note">{v.author ?? '—'}{v.note ? ` · ${v.note}` : ''}</span>
                  </button></li>))}</ul>
              </div>
            </aside>
          </div>
        )}
        </>)}
      </main>
    </>
  );
}
