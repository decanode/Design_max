'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { AnimatePresence, motion } from 'framer-motion';
import { Nav } from '../../components/Nav';
import { DocEditor, type EditorApi } from '../../components/DocEditor';
import { WbsBoard, type WbsActions } from '../../components/WbsBoard';
import { CharterWizard } from '../../components/planning/CharterWizard';
import { ConvertDialog } from '../../components/planning/ConvertDialog';
import { NoAccess, NoProject, j, useAuth } from '../../lib/auth';
import { applyMove, children, effortOf, fmtDays, LEVEL_NAME, type PlanningState, type Wbs } from '../../lib/planning';
import { useWorkflow } from '../../lib/workflow';

type Step = 'intake' | 'charter' | 'wbs' | 'tickets';
const STEP_LABEL: Record<Step, string> = { intake: 'Intake', charter: 'Charter', wbs: 'Work breakdown', tickets: 'Tickets' };
const ago = (iso: string) => new Date(iso).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });

/** The AI planning co-pilot: charter intake, a live-editable charter, a drag-and-drop work breakdown, and the tickets that come from it. */
export default function Planning() {
  const { me, can, loading } = useAuth();
  const mods = me?.project?.modules ?? {};
  const charterOn = !!mods.project_charter, wbsOn = !!mods.wbs, ritmOn = !!mods.ritm_prep;      // each Planning section is switched on separately under Project settings → Modules
  const enabled = charterOn || wbsOn || ritmOn;
  const steps = useMemo(() => (Object.keys(STEP_LABEL) as Step[]).filter((s) => (s === 'intake' || s === 'charter' ? charterOn : s === 'wbs' ? wbsOn : ritmOn)), [charterOn, wbsOn, ritmOn]);
  const [data, setData] = useState<PlanningState | null>(null);
  const [step, setStep] = useState<Step>('intake');
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [editingId, setEditingId] = useState<string | null>(null);
  const [converting, setConverting] = useState(false);
  const [askReplace, setAskReplace] = useState(false);
  const [editorApi, setEditorApi] = useState<EditorApi | null>(null);
  const wf = useWorkflow(enabled);
  const flash = useCallback((kind: 'ok' | 'err', text: string) => setMsg({ kind, text }), []);

  const load = useCallback(async () => {
    const r = await fetch('/api/planning');
    if (!r.ok) { flash('err', (await r.json().catch(() => ({}))).error ?? 'Could not load the plan'); return null; }
    const d: PlanningState = await r.json(); setData(d); return d;
  }, [flash]);
  useEffect(() => {
    if (!me?.project || !enabled || !can('planning.manage')) return;
    load().then((d) => { if (d) setStep(d.wbs.length && wbsOn ? 'wbs' : d.charter && charterOn ? 'charter' : steps[0] ?? 'intake'); });
  }, [me?.project, enabled, can, load, wbsOn, charterOn, steps]);

  const wbs = data?.wbs ?? [];
  const charter = data?.charter ?? null;
  const approved = charter?.status === 'Approved';
  const wps = wbs.filter((r) => r.level === 3);
  const converted = wps.filter((r) => r.ticket);
  const status: Record<Step, 'done' | 'todo' | 'locked'> = useMemo(() => ({
    intake: charter?.hasContent ? 'done' : 'todo', charter: !charter ? 'locked' : approved ? 'done' : 'todo',
    wbs: !approved ? 'locked' : wbs.length ? 'done' : 'todo', tickets: !wbs.length ? 'locked' : converted.length ? 'done' : 'todo',
  }), [charter, approved, wbs.length, converted.length]);

  /* ---- server calls; the board updates first and reconciles with the server's answer */
  const call = useCallback(async (path: string, init: RequestInit) => {
    const r = await fetch(path, init); const b = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(b.error ?? 'That did not work'), { body: b });
    return b;
  }, []);
  const setWbs = (rows: Wbs[]) => setData((d) => (d ? { ...d, wbs: rows } : d));

  const actions: WbsActions = useMemo(() => ({
    add: async (parentId) => {
      const level = parentId ? (wbs.find((r) => r.id === parentId)?.level ?? 0) + 1 : 1;
      try {
        const b = await call('/api/planning/wbs', j({ parentId, title: `New ${LEVEL_NAME[level as 1 | 2 | 3].toLowerCase()}` }));
        setWbs(b.wbs); setEditingId(b.id); return b.id as string;
      } catch (e) { flash('err', (e as Error).message); return null; }
    },
    update: async (id, patch) => {
      const prev = wbs;
      setWbs(wbs.map((r) => (r.id === id ? { ...r, ...(patch.title !== undefined ? { title: patch.title } : {}), ...(patch.description !== undefined ? { description: patch.description } : {}), ...(patch.effort !== undefined ? { effort: patch.effort } : {}) } : r)));
      try { setWbs((await call(`/api/planning/wbs/${id}`, j(patch, 'PATCH'))).wbs); } catch (e) { setWbs(prev); flash('err', (e as Error).message); }
    },
    move: async (id, parentId, index) => {
      const prev = wbs; setWbs(applyMove(wbs, id, parentId, index));
      try { setWbs((await call(`/api/planning/wbs/${id}/move`, j({ parentId, index }))).wbs); } catch (e) { setWbs(prev); flash('err', (e as Error).message); }
    },
    remove: async (id) => {
      try { setWbs((await call(`/api/planning/wbs/${id}`, { method: 'DELETE' })).wbs); setSelected((s) => { const n = new Set(s); n.delete(id); return n; }); } catch (e) { flash('err', (e as Error).message); }
    },
  }), [wbs, call, flash]);

  async function generateWbs(replace = false) {
    setBusy(true); setMsg(null); setAskReplace(false);
    try { const d = await call('/api/planning/wbs/generate', j({ replace })); setData(d); setSelected(new Set()); flash('ok', 'Work breakdown drafted. Edit, drag and add anything you need.'); }
    catch (e) { if ((e as { body?: { exists?: boolean } }).body?.exists) setAskReplace(true); else flash('err', (e as Error).message); }
    finally { setBusy(false); }
  }
  async function charterAction(path: 'approve' | 'reopen') {
    setBusy(true); setMsg(null);
    try {
      if (path === 'approve') await editorApi?.whenSynced();         // the last keystrokes must be on the server before it reads the charter
      const d = await call(`/api/planning/charter/${path}`, { method: 'POST' }); setData(d); flash('ok', path === 'approve' ? 'Charter approved. You can now generate the work breakdown.' : 'Charter reopened for editing.'); }
    catch (e) { flash('err', (e as Error).message); } finally { setBusy(false); }
  }

  if (loading || !me) return <><Nav current="planning" /><main id="main"><p className="note">Loading…</p></main></>;
  if (!me.project) return <><Nav current="planning" /><main id="main"><NoProject /></main></>;
  if (!enabled) return <><Nav current="planning" /><main id="main"><div className="pane" style={{ padding: 24 }}><h2 style={{ marginTop: 0 }}>Planning is not switched on</h2><p>Project charter, Work breakdown and RITM preparation are all off for this project. {can('admin.projects') ? <>Switch it on in <Link href="/admin">Project settings → Modules</Link>.</> : 'Ask a Project Admin to switch it on.'}</p></div></main></>;
  if (!can('planning.manage')) return <><Nav current="planning" /><main id="main"><NoAccess what="project planning" /></main></>;

  const selectedWps = [...selected].filter((id) => wps.some((w) => w.id === id && !w.ticket));
  const toConvert = selectedWps.length || wps.filter((w) => !w.ticket).length;

  return (
    <>
      <Nav current="planning" />
      <main id="main" className="planning">
        <div className="board-head">
          <div><h2>Planning <span className="note">· {me.project.name}</span></h2><p>{[charterOn && 'Draft the charter', wbsOn && 'break it down', ritmOn && 'turn the plan into tickets'].filter(Boolean).join(', ').replace(/^./, (c) => c.toUpperCase())}.</p></div>
          {data && <span className="ai-badge" title={data.ai.provider === 'gemini' ? 'Drafts are written by Google Gemini' : 'No Gemini key is configured; a simple template is used'}>{data.ai.provider === 'gemini' ? `✦ Gemini · ${data.ai.model}` : 'Offline template'}</span>}
        </div>

        <ol className="plan-steps" aria-label="Planning steps">
          {steps.map((s, i) => (
            <li key={s} className={`${step === s ? 'cur' : ''} ${status[s]}`} aria-current={step === s ? 'step' : undefined}>
              <button type="button" disabled={status[s] === 'locked'} onClick={() => setStep(s)}>
                <span className="n">{status[s] === 'done' ? '✓' : i + 1}</span><span>{STEP_LABEL[s]}</span>
              </button>
            </li>))}
        </ol>

        <div aria-live="polite" style={{ minHeight: 24 }}>{msg && <p role={msg.kind === 'err' ? 'alert' : 'status'} className={msg.kind === 'err' ? 'err' : 'ok'} style={{ margin: '0 0 10px' }}>{msg.text}</p>}</div>
        {!data && <div className="skeleton" style={{ height: 260 }} aria-busy="true" />}

        <AnimatePresence mode="wait">
          {data && step === 'intake' && (
            <motion.div key="intake" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ duration: 0.15 }}>
              <CharterWizard charter={charter} ai={data.ai} onDone={(d) => { setData(d); setStep('charter'); flash('ok', 'Charter drafted. Read it through, change anything, then approve it.'); }} />
            </motion.div>)}

          {data && step === 'charter' && charter && (
            <motion.div key="charter" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ duration: 0.15 }}>
              <div className="plan-bar">
                <span className={`status-chip ${approved ? 'ok' : ''}`}>{charter.status}</span>
                <span className="note">{charter.generatedBy ? `Drafted by ${charter.generatedBy}` : 'Written by hand'} · saved {ago(charter.updatedAt)}{approved && charter.approvedBy ? ` · approved by ${charter.approvedBy}` : ''}</span>
                <span style={{ marginLeft: 'auto' }} className="row">
                  {!approved && <button className="btn ghost" disabled={busy} onClick={() => setStep('intake')}>Draft again…</button>}
                  {!approved && <button className="btn" disabled={busy} onClick={() => charterAction('approve')}>Approve charter</button>}
                  {approved && <button className="btn ghost" disabled={busy} onClick={() => charterAction('reopen')}>Reopen to edit</button>}
                  {approved && <button className="btn" onClick={() => setStep('wbs')}>Continue to the work breakdown →</button>}
                </span>
              </div>
              <p className="note" style={{ margin: '0 0 8px' }}>{approved ? 'The charter is approved and read-only.' : 'Everyone with planning access edits this charter live. Changes save by themselves.'}</p>
              <DocEditor key={charter.status} ticketId="charter" kind="CHARTER" label="Project charter" tokenUrl="/api/planning/charter/collab-token" userName={me.user.name} onReady={setEditorApi} />
            </motion.div>)}

          {data && step === 'wbs' && (
            <motion.div key="wbs" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ duration: 0.15 }}>
              <div className="plan-bar">
                <button className="btn gen" disabled={busy || !approved || converted.length > 0} title={converted.length ? 'Some work packages are already tickets, so the plan can only be edited by hand' : ''}
                  onClick={() => (wbs.length ? setAskReplace(true) : generateWbs(false))}>{busy ? 'Drafting…' : wbs.length ? 'Regenerate WBS with Gemini' : 'Generate WBS with Gemini'}</button>
                <span className="note">{wbs.length ? `${children(wbs, null).length} phases · ${wbs.filter((r) => r.level === 2).length} deliverables · ${wps.length} work packages · ${fmtDays(wbs.length ? children(wbs, null).reduce((n, p) => n + effortOf(wbs, p.id), 0) : 0)} person-days` : 'Generate a first draft, or start with Add phase.'}</span>
                <span style={{ marginLeft: 'auto' }} className="row">
                  {ritmOn && wps.length > 0 && <button className="btn ghost sm" onClick={() => setSelected(new Set(wps.filter((w) => !w.ticket).map((w) => w.id)))}>Select all</button>}
                  {ritmOn && selected.size > 0 && <button className="btn ghost sm" onClick={() => setSelected(new Set())}>Clear</button>}
                  {ritmOn && <button className="btn" disabled={busy || toConvert === 0} onClick={() => setConverting(true)}>{selectedWps.length ? `Convert ${selectedWps.length} to tickets` : 'Convert to tickets'}</button>}
                </span>
              </div>
              {askReplace && (
                <div className="scope-warn unclear" role="alertdialog" aria-label="Replace the work breakdown?" style={{ marginBottom: 12 }}>
                  <b>Replace the current work breakdown?</b><span>Gemini will draft a new one from the approved charter. Your edits to the current plan are lost.</span>
                  <div className="row"><button className="btn" onClick={() => generateWbs(true)}>Replace it</button><button className="btn ghost" onClick={() => setAskReplace(false)}>Keep it</button></div>
                </div>)}
              {busy && <div className="gen-inline" role="status"><div className="gen-spinner" aria-hidden /><b>Gemini is breaking the charter into phases, deliverables and work packages…</b></div>}
              {!approved && <p className="scope-warn unclear" role="note">Approve the charter first: the work breakdown is built from it. <button className="linklike" onClick={() => setStep('charter')}>Go to the charter</button></p>}
              <WbsBoard rows={wbs} actions={actions} selected={selected} setSelected={setSelected} editingId={editingId} clearEditing={() => setEditingId(null)} />
              <p className="note">Drag the ⋮⋮ handles to reorder or move things, or use each item’s <b>Move to…</b> menu. Click any title, description or effort to edit it.</p>
            </motion.div>)}

          {data && step === 'tickets' && (
            <motion.div key="tickets" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ duration: 0.15 }}>
              <section className="pane" style={{ padding: 18 }} aria-label="Tickets from the plan">
                <h3 style={{ marginTop: 0 }}>Tickets from the plan</h3>
                {converted.length === 0
                  ? <p className="note">No work packages have become tickets yet. Convert them from the Work breakdown step.</p>
                  : <table className="grid users"><thead><tr><th>Work package</th><th>Where it sits in the plan</th><th>Ticket</th><th>Phase</th></tr></thead>
                    <tbody>{converted.map((w) => { const d = wbs.find((x) => x.id === w.parentId), p = d && wbs.find((x) => x.id === d.parentId); return (
                      <tr key={w.id}><td>{w.title}</td><td className="note">{[p?.title, d?.title].filter(Boolean).join(' › ')}</td><td><Link href={`/tickets/${w.ticket!.id}`}>Open ticket</Link></td><td>{w.ticket!.state}</td></tr>); })}</tbody></table>}
                <p className="note">{wps.length - converted.length} work package{wps.length - converted.length === 1 ? '' : 's'} not converted yet. <Link href="/">Open the board</Link></p>
              </section>
            </motion.div>)}
        </AnimatePresence>

        {converting && wf && <ConvertDialog wf={wf} rows={wbs} count={toConvert} elementIds={selectedWps} userName={me.user.name} onClose={() => setConverting(false)}
          onDone={(r) => { setWbs(r.wbs); setSelected(new Set()); setStep('tickets'); flash('ok', `${r.created.length} ticket${r.created.length === 1 ? '' : 's'} created as ${r.type.name}${r.skipped.length ? `; ${r.skipped.length} skipped` : ''}.`); }} />}
      </main>
    </>
  );
}
