'use client';
import { useCallback, useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { api, type Flash } from '../consoleBits';
import { j, useAuth } from '../../lib/auth';
import { Field } from '../people/shared';
import { modeName } from '../../lib/modes';

type Run = { status: 'running' | 'ok' | 'error'; started_at: string; finished_at: string | null; created: number; updated: number; unchanged: number; failed: number; removed: number; error: string | null; full_scan: boolean };
type Conn = { writebackEnabled: boolean; dryRun: boolean; queue: { pending: number; failed: number }; id: string; kind: 'jira' | 'servicenow'; name: string; baseUrl: string; username: string; config: Record<string, any>; enabled: boolean; syncIntervalMin: number; lastSyncAt: string | null; health: 'new' | 'ok' | 'error'; hasSecret: boolean; tickets: number; lastRun: Run | null };
const KIND = { jira: { name: 'Jira', icon: '🔷' }, servicenow: { name: 'ServiceNow', icon: '🟩' } } as const;
const when = (iso?: string | null) => (iso ? new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : 'never');
const HEALTH = { new: ['Not synced yet', 'off'], ok: ['Healthy', 'ok'], error: ['Needs attention', 'bad'] } as const;

/** Project settings → Integration: connect to the customer's Jira or ServiceNow, map their statuses, and see how the sync is going. Nothing here writes to the source. */
export function IntegrationAdmin({ flash, sub, onSub }: { flash: Flash; sub: string | null; onSub: (s: string | null) => void }) {
  const { me } = useAuth();
  const [list, setList] = useState<Conn[] | null>(null);
  const load = useCallback(async () => { try { setList(await api('/api/project/integrations')); } catch (e) { flash('err', (e as Error).message); } }, [flash]);
  useEffect(() => { load(); }, [load]);
  if (!list) return <div className="skeleton" style={{ height: 200 }} aria-busy="true" aria-label="Loading connections" />;
  const [kind, id] = (sub ?? '').split(':');
  const isSuper = !!me?.user.isSuperAdmin;
  const conn = list.find((c) => c.id === id);
  if (kind === 'conn' && (id === 'new' || conn)) return <ConnPage key={id} c={id === 'new' ? null : conn!} isSuper={isSuper} flash={flash} back={() => onSub(null)} done={async (newId) => { await load(); if (newId) onSub(`conn:${newId}`); }} />;
  if (kind === 'map' && conn) return <StatusMap key={id} c={conn} flash={flash} back={() => onSub(null)} />;
  if (kind === 'runs' && conn) return <Runs key={id} c={conn} back={() => onSub(null)} />;
  if (kind === 'send' && conn) return <SendBack key={id} c={conn} isSuper={isSuper} flash={flash} back={async () => { await load(); onSub(null); }} reload={load} />;
  return <ConnList list={list} isSuper={isSuper} mode={me?.project?.operatingMode} open={onSub} flash={flash} reload={load} />;
}

function ConnList({ list, isSuper, mode, open, flash, reload }: { list: Conn[]; isSuper: boolean; mode?: string; open: (s: string) => void; flash: Flash; reload: () => Promise<void> }) {
  const [busy, setBusy] = useState<string | null>(null);
  async function sync(c: Conn) {
    setBusy(c.id);
    try { const r = await api(`/api/project/integrations/${c.id}/sync`, j({})); flash(r.error ? 'err' : 'ok', r.error ? `Sync failed: ${r.error}` : `Synced ${c.name}: ${r.created} new, ${r.updated} updated, ${r.unchanged} unchanged${r.failed ? `, ${r.failed} failed` : ''}.`); await reload(); }
    catch (e) { flash('err', (e as Error).message); } finally { setBusy(null); }
  }
  return (
    <div className="tb">
      <section className="pane tech-banner limited" aria-label="How this project is connected">
        <span className="tech-banner-icon" aria-hidden>{mode === 'connected' ? '🔗' : '🪞'}</span>
        <div><h3>{modeName(mode)} project</h3><p className="note">{mode === 'connected' ? 'Tickets are pulled in from the customer’s tool. What is sent back is chosen separately.' : 'Tickets are pulled in read-only. Nothing is ever sent back to the customer’s tool.'}</p></div>
        {isSuper && <button type="button" className="btn" style={{ marginLeft: 'auto' }} onClick={() => open('conn:new')}>+ Add connection</button>}
      </section>
      {list.length === 0 && <section className="pane tb-sec"><p className="note" style={{ margin: 0 }}>No connection yet. {isSuper ? 'Add the customer’s Jira or ServiceNow to start pulling tickets in.' : 'A Super Admin has to add the connection and its credentials.'}</p></section>}
      <ul className="tech-grid">
        {list.map((c) => (
          <li key={c.id} className="tech-card cat">
            <div className="cat-open" style={{ cursor: 'default' }}>
              <span className="tech-name"><span aria-hidden>{KIND[c.kind].icon}</span> {c.name} {!c.enabled && <span className="note">(off)</span>}</span>
              <span className="note tech-desc">{KIND[c.kind].name} · {c.baseUrl}</span>
              <span className="cat-foot"><span className={`status ${HEALTH[c.health][1]}`}>{HEALTH[c.health][0]}</span><span className="note">{c.tickets} ticket{c.tickets === 1 ? '' : 's'} · last sync {when(c.lastSyncAt)}</span></span>
              {c.lastRun && <span className="note">Last run: {c.lastRun.created} new, {c.lastRun.updated} updated, {c.lastRun.unchanged} unchanged{c.lastRun.failed ? `, ${c.lastRun.failed} failed` : ''}{c.lastRun.error ? ` · ${c.lastRun.error}` : ''}</span>}
              <span className="row" style={{ margin: 0 }}>
                <button type="button" className="btn sm" disabled={busy === c.id || !c.enabled} onClick={() => sync(c)}>{busy === c.id ? 'Syncing…' : 'Sync now'}</button>
                <button type="button" className="btn ghost sm" onClick={() => open(`conn:${c.id}`)} aria-label={`Edit connection ${c.name}`}>Edit</button>
                <button type="button" className="btn ghost sm" onClick={() => open(`map:${c.id}`)} aria-label={`Status mapping for ${c.name}`}>Status mapping</button>
                <button type="button" className="btn ghost sm" onClick={() => open(`runs:${c.id}`)} aria-label={`Sync history for ${c.name}`}>Sync history</button>
                {mode === 'connected' && <button type="button" className="btn ghost sm" onClick={() => open(`send:${c.id}`)} aria-label={`Send back settings for ${c.name}`}>Send back{c.queue.failed ? ` · ${c.queue.failed} failed` : c.queue.pending ? ` · ${c.queue.pending} waiting` : ''}</button>}
              </span>
            </div>
          </li>))}
      </ul>
    </div>);
}

function ConnPage({ c, isSuper, flash, back, done }: { c: Conn | null; isSuper: boolean; flash: Flash; back: () => void; done: (id?: string) => Promise<void> }) {
  const isNew = !c;
  const [f, setF] = useState({ kind: (c?.kind ?? 'jira') as Conn['kind'], name: c?.name ?? '', baseUrl: c?.baseUrl ?? '', username: c?.username ?? '', secret: '', enabled: c?.enabled ?? true, syncIntervalMin: c?.syncIntervalMin ?? 15,
    flavor: (c?.config.flavor ?? 'cloud') as string, jql: (c?.config.jql ?? '') as string, ac: (c?.config.acceptanceCriteriaField ?? '') as string, tables: (c?.config.tables ?? ['incident', 'problem', 'change_request']) as string[], query: (c?.config.query ?? '') as string });
  const [busy, setBusy] = useState(false);
  const [test, setTest] = useState<{ ok: boolean; detail: string } | null>(null);
  const lockSuper = !isNew && !isSuper;
  const config = f.kind === 'jira' ? { flavor: f.flavor as 'cloud' | 'datacenter', ...(f.jql.trim() ? { jql: f.jql.trim() } : {}), ...(f.ac.trim() ? { acceptanceCriteriaField: f.ac.trim() } : {}) }
    : { tables: f.tables as ('incident' | 'problem' | 'change_request')[], ...(f.query.trim() ? { query: f.query.trim() } : {}) };

  async function save(e: React.FormEvent) {
    e.preventDefault(); setBusy(true); setTest(null);
    try {
      if (isNew) { const r = await api('/api/project/integrations', j({ kind: f.kind, name: f.name, baseUrl: f.baseUrl, username: f.username, secret: f.secret, config, syncIntervalMin: f.syncIntervalMin })); flash('ok', `Connection “${f.name}” added. Test it, then run the first sync.`); await done(r.id); return; }
      await api(`/api/project/integrations/${c!.id}`, j({ name: f.name, config, syncIntervalMin: f.syncIntervalMin, enabled: f.enabled, ...(isSuper ? { baseUrl: f.baseUrl, username: f.username, ...(f.secret ? { secret: f.secret } : {}) } : {}) }, 'PUT'));
      flash('ok', 'Connection saved.'); await done(); setF({ ...f, secret: '' });
    } catch (er) { flash('err', (er as Error).message); } finally { setBusy(false); }
  }
  async function runTest() { if (!c) return; setTest(await api(`/api/project/integrations/${c.id}/test`, j({}))); }
  async function remove() {
    if (!c || !confirm(`Remove the connection “${c.name}”? Its tickets stay here, but stop updating.`)) return;
    try { await api(`/api/project/integrations/${c.id}`, { method: 'DELETE' }); flash('ok', 'Connection removed.'); await done(); back(); } catch (er) { flash('err', (er as Error).message); }
  }
  return (
    <motion.form onSubmit={save} className="drill" aria-label={isNew ? 'New connection' : `Connection ${c!.name}`} initial={{ opacity: 0, x: 18 }} animate={{ opacity: 1, x: 0 }} transition={{ duration: 0.16 }}>
      <nav className="crumbs" aria-label="Breadcrumb"><button type="button" className="linklike" onClick={back}>Connections</button><span aria-hidden> › </span><span aria-current="page">{isNew ? 'New connection' : c!.name}</span></nav>
      {lockSuper && <p className="scope-warn unclear" role="note">The address and credentials can only be changed by a Super Admin. You can adjust what is pulled and how often.</p>}
      <div className="drill-grid">
        <section className="pane drill-card" aria-labelledby="cn-main">
          <h4 id="cn-main">The connection</h4>
          {isNew && <Field id="cn-kind" label="Tool"><select id="cn-kind" className="lc-select" value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value as Conn['kind'] })}><option value="jira">Jira</option><option value="servicenow">ServiceNow</option></select></Field>}
          <Field id="cn-name" label="Name" required><input id="cn-name" className="lc-input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required minLength={2} maxLength={60} /></Field>
          <Field id="cn-url" label="Address" required hint={f.kind === 'jira' ? 'For example https://yourcompany.atlassian.net' : 'For example https://yourcompany.service-now.com'}><input id="cn-url" className="lc-input" value={f.baseUrl} onChange={(e) => setF({ ...f, baseUrl: e.target.value })} required disabled={lockSuper} /></Field>
          <Field id="cn-user" label={f.kind === 'jira' ? 'Account email' : 'User name'} hint="An integration account with read access only is best."><input id="cn-user" className="lc-input" value={f.username} onChange={(e) => setF({ ...f, username: e.target.value })} disabled={lockSuper} autoComplete="off" /></Field>
          <Field id="cn-secret" label={f.kind === 'jira' ? 'API token' : 'Password'} required={isNew} hint={isNew ? 'Stored encrypted. It is never shown again.' : c!.hasSecret ? 'A credential is stored. Leave empty to keep it.' : 'No credential stored yet.'}>
            <input id="cn-secret" className="lc-input" type="password" value={f.secret} onChange={(e) => setF({ ...f, secret: e.target.value })} required={isNew} disabled={lockSuper} autoComplete="new-password" /></Field>
        </section>
        <section className="pane drill-card" aria-labelledby="cn-scope">
          <h4 id="cn-scope">What to pull</h4>
          {f.kind === 'jira' ? (<>
            <Field id="cn-flavor" label="Jira edition"><select id="cn-flavor" className="lc-select" value={f.flavor} onChange={(e) => setF({ ...f, flavor: e.target.value })}><option value="cloud">Cloud (atlassian.net)</option><option value="datacenter">Data Center / Server</option></select></Field>
            <Field id="cn-jql" label="Which issues (JQL)" hint="Leave empty for every issue the account can see. For example: project = PAY AND issuetype in (Bug, Story)."><textarea id="cn-jql" className="lc-input" rows={3} value={f.jql} onChange={(e) => setF({ ...f, jql: e.target.value })} /></Field>
            <Field id="cn-ac" label="Acceptance criteria field" hint="Optional custom field id, for example customfield_10040."><input id="cn-ac" className="lc-input" value={f.ac} onChange={(e) => setF({ ...f, ac: e.target.value })} /></Field>
          </>) : (<>
            <fieldset className="field"><legend>Which tables</legend>
              <div className="checks">{[['incident', 'Incidents'], ['problem', 'Problems'], ['change_request', 'Change requests']].map(([k, label]) => (
                <label key={k} className="check"><input type="checkbox" checked={f.tables.includes(k)} onChange={(e) => setF({ ...f, tables: e.target.checked ? [...f.tables, k] : f.tables.filter((x) => x !== k) })} /> {label}</label>))}</div></fieldset>
            <Field id="cn-q" label="Extra filter" hint="Optional encoded query, for example assignment_group=Payments."><input id="cn-q" className="lc-input" value={f.query} onChange={(e) => setF({ ...f, query: e.target.value })} /></Field>
          </>)}
          <Field id="cn-int" label="Check for changes every" hint="Minutes. The first run reads everything; later runs read only what changed."><input id="cn-int" className="lc-input" type="number" min={1} max={1440} value={f.syncIntervalMin} onChange={(e) => setF({ ...f, syncIntervalMin: Number(e.target.value) })} /></Field>
          {!isNew && <label className="ds-rule"><span className="ds-rule-text"><b>Sync automatically</b><span className="note">Switch off to pause. “Sync now” still needs it on.</span></span><span className="switch"><input type="checkbox" role="switch" aria-label="Sync automatically" checked={f.enabled} onChange={(e) => setF({ ...f, enabled: e.target.checked })} /><span className="track" aria-hidden /></span></label>}
        </section>
      </div>
      {test && <p role="status" className={test.ok ? 'ok' : 'err'}>{test.ok ? '✓ ' : '✕ '}{test.detail}</p>}
      {!isNew && isSuper && <section className="danger-zone" aria-label="Remove connection"><div><b>Remove this connection</b><p className="note" style={{ margin: 0 }}>Tickets already pulled in stay here, but they stop updating.</p></div><button type="button" className="btn danger" onClick={remove}>Remove</button></section>}
      <div className="tb-bar drill-bar" role="region" aria-label="Save changes">
        {!isNew && <button type="button" className="btn ghost" onClick={runTest} disabled={busy}>Test connection</button>}
        <button type="button" className="btn ghost" onClick={back} disabled={busy}>{isNew ? 'Cancel' : 'Back'}</button>
        <button className="btn" type="submit" disabled={busy || f.name.trim().length < 2 || (isNew && (!f.baseUrl || !f.secret)) || (f.kind === 'servicenow' && f.tables.length === 0)}>{busy ? 'Saving…' : isNew ? 'Add connection' : 'Save'}</button>
      </div>
    </motion.form>);
}

type Observed = { status: string; tickets: number; phaseId: number | null; guess: string };
function StatusMap({ c, flash, back }: { c: Conn; flash: Flash; back: () => void }) {
  const [d, setD] = useState<{ observed: Observed[]; phases: { id: number; name: string; tone: string }[] } | null>(null);
  const [choice, setChoice] = useState<Record<string, number | null>>({});
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => { const r = await api(`/api/project/integrations/${c.id}/status-map`); setD(r); setChoice(Object.fromEntries(r.observed.map((o: Observed) => [o.status, o.phaseId]))); }, [c.id]);
  useEffect(() => { load().catch((e) => flash('err', e.message)); }, [load, flash]);
  if (!d) return <div className="skeleton" style={{ height: 160 }} aria-busy="true" />;
  async function save(apply: boolean) {
    setBusy(true);
    try {
      await api(`/api/project/integrations/${c.id}/status-map`, j({ maps: Object.entries(choice).map(([sourceStatus, phaseId]) => ({ sourceStatus, phaseId })) }, 'PUT'));
      if (apply) { const r = await api(`/api/project/integrations/${c.id}/status-map/apply`, j({})); flash('ok', `Saved. ${r.moved} ticket${r.moved === 1 ? '' : 's'} nobody had moved yet were updated.`); } else flash('ok', 'Status mapping saved. It applies to tickets that arrive from now on.');
      await load();
    } catch (e) { flash('err', (e as Error).message); } finally { setBusy(false); }
  }
  return (
    <div className="drill" role="region" aria-label={`Status mapping for ${c.name}`}>
      <nav className="crumbs" aria-label="Breadcrumb"><button type="button" className="linklike" onClick={back}>Connections</button><span aria-hidden> › </span><span aria-current="page">{c.name}: status mapping</span></nav>
      <p className="note" style={{ margin: 0 }}>Choose which of this project’s own phases each source status starts in. This only sets where a ticket starts here; the source’s status always stays visible next to it, and nothing is sent back.</p>
      <div className="data-wrap"><table className="data-table">
        <caption className="sr">Source statuses and the phase each starts in</caption>
        <thead><tr><th scope="col">Source status</th><th scope="col" style={{ textAlign: 'right' }}>Tickets</th><th scope="col">Starts in</th></tr></thead>
        <tbody>
          {d.observed.map((o) => (
            <tr key={o.status}><td><b>{o.status}</b><span className="note"> · looks like {o.guess}</span></td><td className="num">{o.tickets}</td>
              <td><label className="sr" htmlFor={`sm-${o.status}`}>Phase for {o.status}</label>
                <select id={`sm-${o.status}`} className="lc-select" style={{ width: 'auto' }} value={choice[o.status] ?? ''} onChange={(e) => setChoice({ ...choice, [o.status]: e.target.value ? Number(e.target.value) : null })}>
                  <option value="">Automatic (best guess)</option>{d.phases.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></td></tr>))}
          {d.observed.length === 0 && <tr><td colSpan={3} className="empty-row">No tickets yet. Run a sync first; the statuses found appear here.</td></tr>}
        </tbody></table></div>
      <div className="row"><button type="button" className="btn" disabled={busy} onClick={() => save(false)}>Save mapping</button>
        <button type="button" className="btn ghost" disabled={busy} onClick={() => confirm('Also move tickets that came from this connection and that nobody here has moved yet?') && save(true)}>Save and apply to tickets nobody has moved</button></div>
    </div>);
}

function Runs({ c, back }: { c: Conn; back: () => void }) {
  const [runs, setRuns] = useState<(Run & { id: string; trigger: string })[] | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [fails, setFails] = useState<{ source_key: string; error: string }[]>([]);
  useEffect(() => { api(`/api/project/integrations/${c.id}/runs`).then(setRuns).catch(() => setRuns([])); }, [c.id]);
  useEffect(() => { if (open) api(`/api/project/integrations/runs/${open}/failures`).then(setFails).catch(() => setFails([])); }, [open]);
  return (
    <div className="drill" role="region" aria-label={`Sync history for ${c.name}`}>
      <nav className="crumbs" aria-label="Breadcrumb"><button type="button" className="linklike" onClick={back}>Connections</button><span aria-hidden> › </span><span aria-current="page">{c.name}: sync history</span></nav>
      <div className="data-wrap"><table className="data-table">
        <caption className="sr">Recent syncs</caption>
        <thead><tr><th scope="col">Started</th><th scope="col">Kind</th><th scope="col">Result</th><th scope="col" style={{ textAlign: 'right' }}>New</th><th scope="col" style={{ textAlign: 'right' }}>Updated</th><th scope="col" style={{ textAlign: 'right' }}>Unchanged</th><th scope="col" style={{ textAlign: 'right' }}>Failed</th><th scope="col" style={{ textAlign: 'right' }}>Gone</th></tr></thead>
        <tbody>
          {(runs ?? []).map((r) => (
            <tr key={r.id} className={r.failed || r.error ? 'clickable' : ''} onClick={() => r.failed && setOpen(r.id)}>
              <td>{when(r.started_at)}</td><td className="note">{r.full_scan ? 'Full' : 'Changes'} · {r.trigger}</td>
              <td><span className={`status ${r.status === 'ok' ? 'ok' : r.status === 'error' ? 'bad' : 'off'}`}>{r.status === 'ok' ? 'Done' : r.status === 'error' ? 'Failed' : 'Running'}</span>{r.error && <span className="note"> {r.error}</span>}</td>
              <td className="num">{r.created}</td><td className="num">{r.updated}</td><td className="num">{r.unchanged}</td><td className="num">{r.failed || '—'}</td><td className="num">{r.removed || '—'}</td></tr>))}
          {runs && runs.length === 0 && <tr><td colSpan={8} className="empty-row">No syncs yet.</td></tr>}
        </tbody></table></div>
      {open && <section className="pane drill-card" aria-label="Failed tickets"><h4>Tickets that could not be mirrored</h4><ul>{fails.map((f) => <li key={f.source_key + f.error}><b>{f.source_key}</b> <span className="note">{f.error}</span></li>)}</ul></section>}
    </div>);
}


type Rule = { event: 'phase_entered' | 'document_approved' | 'signoff_approved' | 'ticket_closed'; action: 'status' | 'comment' | 'attach'; enabled: boolean; params: { phase?: string; docKind?: string; status?: string; template?: string; docKinds?: string[] } };
type QItem = { id: string; action: string; payload: any; status: 'pending' | 'sent' | 'failed' | 'skipped' | 'cancelled'; dryRun: boolean; attempts: number; lastError: string | null; result: any; createdAt: string; sentAt: string | null; ticketId: string; ticketKey: string; title: string };
const EVENTS: Record<Rule['event'], string> = { phase_entered: 'a ticket enters a phase', document_approved: 'a document is approved', signoff_approved: 'the customer confirms it is resolved', ticket_closed: 'a ticket is closed here' };
const ACTIONS: Record<Rule['action'], string> = { status: 'set the status in the source tool to', comment: 'add a comment saying', attach: 'attach the approved document' };
const DOCS: Record<string, string> = { FS: 'Functional Specification', TS: 'Technical Specification', TUT: 'Unit Test', CRC: 'Code Review Checklist' };
const QSTATE = { pending: ['Waiting', 'off'], sent: ['Sent', 'ok'], failed: ['Failed', 'bad'], skipped: ['Not sent', 'off'], cancelled: ['Cancelled', 'off'] } as const;

/** What a Connected project sends back to the source tool: the switches, the rules, and everything that is waiting or was sent. */
function SendBack({ c, isSuper, flash, back, reload }: { c: Conn; isSuper: boolean; flash: Flash; back: () => void; reload: () => Promise<void> }) {
  const [rules, setRules] = useState<Rule[] | null>(null);
  const [saved, setSaved] = useState('');
  const [phases, setPhases] = useState<string[]>([]);
  const [queue, setQueue] = useState<QItem[]>([]);
  const [busy, setBusy] = useState(false);
  const loadQueue = useCallback(async () => setQueue(await api(`/api/project/integrations/${c.id}/queue`)), [c.id]);
  useEffect(() => {
    Promise.all([api(`/api/project/integrations/${c.id}/rules`), api(`/api/project/integrations/${c.id}/status-map`), loadQueue()])
      .then(([r, m]) => { const list = r.map((x: Rule & { id: string }) => ({ event: x.event, action: x.action, enabled: x.enabled, params: x.params })); setRules(list); setSaved(JSON.stringify(list)); setPhases(m.phases.map((p: { name: string }) => p.name)); })
      .catch((e) => flash('err', e.message));
  }, [c.id, flash, loadQueue]);
  if (!rules) return <div className="skeleton" style={{ height: 160 }} aria-busy="true" />;
  const dirty = JSON.stringify(rules) !== saved;
  const set = (i: number, patch: Partial<Rule>) => setRules(rules.map((r, k) => (k === i ? { ...r, ...patch } : r)));
  const setParams = (i: number, p: Rule['params']) => set(i, { params: { ...rules[i].params, ...p } });

  async function saveRules() { setBusy(true); try { await api(`/api/project/integrations/${c.id}/rules`, j({ rules }, 'PUT')); setSaved(JSON.stringify(rules)); flash('ok', 'Rules saved.'); } catch (e) { flash('err', (e as Error).message); } finally { setBusy(false); } }
  async function toggle(body: object, ok: string) { try { await api(`/api/project/integrations/${c.id}/writeback`, j(body, 'PUT')); flash('ok', ok); await reload(); } catch (e) { flash('err', (e as Error).message); } }
  async function act(path: string, ok: string) { try { await api(path, j({})); flash('ok', ok); await loadQueue(); await reload(); } catch (e) { flash('err', (e as Error).message); } }
  async function sendNow() { setBusy(true); try { const r = await api(`/api/project/integrations/${c.id}/send`, j({})); flash('ok', `Sent ${r.sent}, not sent ${r.skipped}, failed ${r.failed}, will retry ${r.retry}.`); await loadQueue(); await reload(); } catch (e) { flash('err', (e as Error).message); } finally { setBusy(false); } }

  return (
    <div className="drill" role="region" aria-label={`Send back settings for ${c.name}`}>
      <nav className="crumbs" aria-label="Breadcrumb"><button type="button" className="linklike" onClick={back}>Connections</button><span aria-hidden> › </span><span aria-current="page">{c.name}: send back</span></nav>
      <section className="pane drill-card" aria-labelledby="sb-sw">
        <h4 id="sb-sw">Sending</h4>
        <label className="ds-rule"><span className="ds-rule-text"><b>Send changes back to {c.name}</b><span className="note">The master switch. Anyone who manages the project can switch it off; a Super Admin switches it on.</span></span>
          <span className="switch"><input type="checkbox" role="switch" aria-label="Send changes back" checked={c.writebackEnabled} disabled={!isSuper && !c.writebackEnabled} onChange={(e) => toggle({ enabled: e.target.checked }, e.target.checked ? 'Sending is on.' : 'Sending is off. Nothing leaves while it is off.')} /><span className="track" aria-hidden /></span></label>
        <label className="ds-rule"><span className="ds-rule-text"><b>Trial run</b><span className="note">While on, nothing is sent: each item is recorded with what would have been sent, so you can check the rules first. Only a Super Admin can turn it off.</span></span>
          <span className="switch"><input type="checkbox" role="switch" aria-label="Trial run" checked={c.dryRun} disabled={!isSuper && c.dryRun} onChange={(e) => toggle({ dryRun: e.target.checked }, e.target.checked ? 'Trial run is on: nothing is sent.' : 'Trial run is off: matching changes are sent for real.')} /><span className="track" aria-hidden /></span></label>
        {c.writebackEnabled && !c.dryRun && <p className="scope-warn unclear" role="note" style={{ margin: 0 }}><b>Live.</b> Changes matching the rules below are sent to {c.name}.</p>}
      </section>

      <section className="pane drill-card" aria-labelledby="sb-rules">
        <div className="row" style={{ justifyContent: 'space-between', margin: '0 0 8px' }}><h4 id="sb-rules" style={{ margin: 0 }}>What to send</h4>
          <button type="button" className="btn ghost sm" onClick={() => setRules([...rules, { event: 'phase_entered', action: 'status', enabled: true, params: {} }])}>+ Add a rule</button></div>
        <p className="note" style={{ marginTop: 0 }}>Only what you list here is ever sent. Internal notes and our own working status never leave.</p>
        <ol className="rule-list">
          {rules.map((r, i) => (
            <li key={i} className={`rule ${r.enabled ? '' : 'off'}`} role="group" aria-label={`Rule ${i + 1}`}>
              <span className="rule-w">When</span>
              <select className="lc-select" aria-label={`Rule ${i + 1} event`} value={r.event} onChange={(e) => set(i, { event: e.target.value as Rule['event'], params: {} })}>{Object.entries(EVENTS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
              {r.event === 'phase_entered' && <select className="lc-select" aria-label={`Rule ${i + 1} phase`} value={r.params.phase ?? ''} onChange={(e) => setParams(i, { phase: e.target.value || undefined })}><option value="">any phase</option>{phases.map((p) => <option key={p}>{p}</option>)}</select>}
              {r.event === 'document_approved' && <select className="lc-select" aria-label={`Rule ${i + 1} document`} value={r.params.docKind ?? ''} onChange={(e) => setParams(i, { docKind: e.target.value || undefined })}><option value="">any document</option>{Object.entries(DOCS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>}
              <span className="rule-w">then</span>
              <select className="lc-select" aria-label={`Rule ${i + 1} action`} value={r.action} onChange={(e) => set(i, { action: e.target.value as Rule['action'] })}>{Object.entries(ACTIONS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
              {r.action === 'status' && <input className="lc-input" aria-label={`Rule ${i + 1} status`} placeholder={c.kind === 'jira' ? 'for example Done' : 'for example Resolved'} value={r.params.status ?? ''} onChange={(e) => setParams(i, { status: e.target.value })} />}
              {r.action === 'comment' && <input className="lc-input" style={{ minWidth: 260 }} aria-label={`Rule ${i + 1} comment`} placeholder="{{ticket.key}} reached {{phase}}" value={r.params.template ?? ''} onChange={(e) => setParams(i, { template: e.target.value })} />}
              {r.action === 'attach' && r.event !== 'document_approved' && <span className="checks">{Object.entries(DOCS).map(([k, v]) => <label key={k} className="check"><input type="checkbox" checked={!!r.params.docKinds?.includes(k)} onChange={(e) => setParams(i, { docKinds: e.target.checked ? [...(r.params.docKinds ?? []), k] : (r.params.docKinds ?? []).filter((x) => x !== k) })} /> {v}</label>)}</span>}
              <span className="fld-actions">
                <label className="switch" title="Rule on or off"><input type="checkbox" role="switch" aria-label={`Rule ${i + 1} on`} checked={r.enabled} onChange={(e) => set(i, { enabled: e.target.checked })} /><span className="track" aria-hidden /></label>
                <button type="button" className="btn ghost sm" aria-label={`Remove rule ${i + 1}`} onClick={() => setRules(rules.filter((_, k) => k !== i))}>✕</button></span>
            </li>))}
          {rules.length === 0 && <li className="note">No rules yet, so nothing is sent.</li>}
        </ol>
        <div className="row"><button type="button" className="btn" disabled={!dirty || busy} onClick={saveRules}>Save rules</button>{dirty && <span className="note">Unsaved changes</span>}</div>
      </section>

      <section className="pane drill-card" aria-labelledby="sb-q">
        <div className="row" style={{ justifyContent: 'space-between', margin: '0 0 8px' }}><h4 id="sb-q" style={{ margin: 0 }}>What is waiting and what was sent</h4>
          <button type="button" className="btn ghost sm" disabled={busy || !c.writebackEnabled} onClick={sendNow}>Send now</button></div>
        <div className="data-wrap"><table className="data-table">
          <caption className="sr">Outbound queue</caption>
          <thead><tr><th scope="col">Ticket</th><th scope="col">What</th><th scope="col">State</th><th scope="col">Detail</th><th scope="col"><span className="sr">Actions</span></th></tr></thead>
          <tbody>
            {queue.map((q) => (
              <tr key={q.id}>
                <td><a href={`/tickets/${q.ticketId}`}><b>{q.ticketKey}</b></a><span className="note"> {q.title}</span></td>
                <td>{q.action === 'status' ? `Set status to “${q.payload.status}”` : q.action === 'comment' ? `Comment: ${q.payload.body}` : `Attach ${(q.payload.kinds ?? []).map((k: string) => DOCS[k] ?? k).join(', ')}`}</td>
                <td><span className={`status ${QSTATE[q.status][1]}`}>{QSTATE[q.status][0]}</span>{q.dryRun && <span className="note"> (trial)</span>}</td>
                <td className="note">{q.lastError ?? q.result?.reason ?? (q.result?.dryRun ? 'Would have been sent' : q.result?.detail ?? (q.result?.attached ? `Attached ${q.result.attached.join(', ')}` : ''))}</td>
                <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                  {['failed', 'skipped'].includes(q.status) && <button type="button" className="btn ghost sm" onClick={() => act(`/api/project/integrations/queue/${q.id}/retry`, 'Queued to try again.')}>Try again</button>}{' '}
                  {['pending', 'failed'].includes(q.status) && <button type="button" className="btn ghost sm" onClick={() => act(`/api/project/integrations/queue/${q.id}/skip`, 'Cancelled.')}>Cancel</button>}</td>
              </tr>))}
            {queue.length === 0 && <tr><td colSpan={5} className="empty-row">Nothing queued yet.</td></tr>}
          </tbody></table></div>
      </section>
    </div>);
}
