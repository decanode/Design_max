'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams } from 'next/navigation';
import { Nav } from '../../../components/Nav';
import { Markdown } from '../../../components/Markdown';

const API = process.env.NEXT_PUBLIC_API_URL ?? '';
const STATES = ['Requirement Verified', 'FS Drafted', 'FS Approved', 'TS Drafted', 'TS Approved', 'Development', 'QA', 'UAT', 'Deployed'];
type Kind = 'FS' | 'TS';
type Ver = { version: number; author: string | null; note: string | null; at: string };
type Overview = {
  ticket: { id: string; title: string; current_state: string; ai_summary: string | null };
  docs: Record<Kind, { latest: { version_number: number; content_md: string }; versions: Ver[] } | null>;
  approvals: { kind: Kind; version_number: number; status: string; comment: string | null; approver: string }[];
};
type DiffLine = { type: 'same' | 'add' | 'del'; text: string };

const j = (body: unknown) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

export default function TicketPage() {
  const { id } = useParams<{ id: string }>();
  const [o, setO] = useState<Overview | null>(null);
  const [kind, setKind] = useState<Kind>('FS');
  const [text, setText] = useState('');
  const [viewing, setViewing] = useState<number | null>(null);   // historical version being viewed (read-only)
  const [diff, setDiff] = useState<DiffLine[] | null>(null);
  const [approver, setApprover] = useState('');
  const [author, setAuthor] = useState('Consultant');
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const r = await fetch(`${API}/api/tickets/${id}`);
    if (!r.ok) return setMsg({ kind: 'err', text: 'Ticket not found.' });
    const data: Overview = await r.json();
    setO(data);
    return data;
  }, [id]);

  useEffect(() => { load().then((d) => {
    if (!d) return;
    const k: Kind = d.docs.TS ? 'TS' : 'FS';
    setKind(k); setText(d.docs[k]?.latest.content_md ?? '');
  }); }, [load]);

  const doc = o?.docs[kind] ?? null;
  const latest = doc?.latest.version_number ?? 0;
  const state = o?.ticket.current_state ?? '';
  const editable = state === `${kind} Drafted` && viewing === null;
  const dirty = editable && doc != null && text !== doc.latest.content_md;
  const pending = o?.approvals.find((a) => a.kind === kind && a.status === 'pending');
  const canGenerate = (kind === 'FS' && state === 'Requirement Verified') || (kind === 'TS' && state === 'FS Approved');

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
  const save = () => run(() => fetch(`${API}/api/tickets/${id}/documents/${kind}/versions`, j({ content: text, baseVersion: latest, author })), 'Saved as a new version.');
  const request = () => run(() => fetch(`${API}/api/tickets/${id}/approvals`, j({ kind, approverEmail: approver })), `Approval link sent to ${approver}. See the Mailbox.`);

  async function open(v: number) {
    if (v === latest) { setViewing(null); setDiff(null); setText(doc!.latest.content_md); return; }
    const r = await fetch(`${API}/api/tickets/${id}/documents/${kind}/versions/${v}`);
    setText((await r.json()).content_md); setViewing(v);
    const d = await fetch(`${API}/api/tickets/${id}/documents/${kind}/diff?from=${v}&to=${latest}`);
    setDiff(d.ok ? await d.json() : null);
  }

  const idx = STATES.indexOf(state);
  const approvalNote = useMemo(() => o?.approvals.filter((a) => a.kind === kind).map((a) =>
    `v${a.version_number} · ${a.approver} · ${a.status}${a.comment ? ` — “${a.comment}”` : ''}`) ?? [], [o, kind]);

  if (!o) return <><Nav current="none" /><main id="main">{msg ? <p role="alert" className="err">{msg.text}</p> : <p className="note">Loading…</p>}</main></>;

  return (
    <>
      <Nav current="none" />
      <main id="main">
        <h2 style={{ marginTop: 0 }}>{o.ticket.title}</h2>
        <ol className="stepper" aria-label="Ticket lifecycle">
          {STATES.map((s, i) => <li key={s} className={i < idx ? 'done' : i === idx ? 'cur' : ''} aria-current={i === idx ? 'step' : undefined}>{s}</li>)}
        </ol>

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
                  <label className="sr" htmlFor="author">Your name</label>
                  <input id="author" value={author} onChange={(e) => setAuthor(e.target.value)} placeholder="Your name" style={{ minWidth: 140 }} />
                  <button className="btn" disabled={!dirty || busy || !author.trim()} onClick={save}>Save new version</button>
                  {dirty && <span className="note">Unsaved changes</span>}
                </div>
              )}
              {editable && !pending && (
                <div className="row">
                  <label className="sr" htmlFor="approver">Approver email</label>
                  <input id="approver" type="email" value={approver} onChange={(e) => setApprover(e.target.value)} placeholder="approver@company.com" />
                  <button className="btn ghost" disabled={busy || dirty || !approver} onClick={request} title={dirty ? 'Save your changes first' : undefined}>Request approval</button>
                </div>
              )}
              {pending && <p className="note">Waiting for approval from {pending.approver} (v{pending.version_number}). Editing will cancel the request.</p>}
            </section>
            <aside className="side" aria-label="History">
              <div>
                <h3>Versions</h3>
                <ul>{doc.versions.map((v) => (
                  <li key={v.version}><button aria-pressed={(viewing ?? latest) === v.version} onClick={() => open(v.version)}>
                    v{v.version}{v.version === latest ? ' (latest)' : ''}<br /><span className="note">{v.author ?? '—'}{v.note ? ` · ${v.note}` : ''}</span>
                  </button></li>))}</ul>
              </div>
              {approvalNote.length > 0 && <div><h3>Approvals</h3><ul>{approvalNote.map((n) => <li key={n} className="note">{n}</li>)}</ul></div>}
            </aside>
          </div>
        )}
      </main>
    </>
  );
}
