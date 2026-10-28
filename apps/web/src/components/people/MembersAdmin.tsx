'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { z } from 'zod';
import { api, type Flash } from '../consoleBits';
import { j } from '../../lib/auth';
import { Avatar, Field, LANGUAGES, RoleBadge, TIME_ZONES, TeamChips, dateOnly, type MemberRow, type Team } from './shared';

type Role = { id: number; name: string };
type SortKey = 'name' | 'role' | 'added' | 'tickets';

/** Members: a searchable table, and a drill-down page to add someone or change their details. */
export function MembersAdmin({ flash, meId, sub, onSub }: { flash: Flash; meId: string; sub: string | null; onSub: (s: string | null) => void }) {
  const [members, setMembers] = useState<MemberRow[] | null>(null);
  const [roles, setRoles] = useState<Role[]>([]);
  const [teams, setTeams] = useState<Team[]>([]);
  const load = useCallback(async () => {
    try { const [m, r, t] = await Promise.all([api('/api/project/members'), api('/api/project/roles'), api('/api/project/teams')]); setMembers(m); setRoles(r.roles.map((x: Role) => ({ id: x.id, name: x.name }))); setTeams(t.map((x: Team) => ({ id: x.id, name: x.name }))); }
    catch (e) { flash('err', (e as Error).message); }
  }, [flash]);
  useEffect(() => { load(); }, [load]);

  if (!members) return <div className="skeleton" style={{ height: 240 }} aria-busy="true" aria-label="Loading members" />;
  if (sub) return <MemberDetail key={sub} id={sub} meId={meId} members={members} roles={roles} teams={teams} flash={flash} back={() => onSub(null)} open={onSub} reload={load} />;
  return <MemberList members={members} roles={roles} teams={teams} meId={meId} open={(id) => onSub(id)} />;
}

/* ------------------------------------------------------------------ the table */
function MemberList({ members, roles, teams, meId, open }: { members: MemberRow[]; roles: Role[]; teams: Team[]; meId: string; open: (id: string) => void }) {
  const [q, setQ] = useState(''); const [role, setRole] = useState(''); const [team, setTeam] = useState('');
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: 'name', dir: 1 });
  const rows = useMemo(() => {
    const n = q.trim().toLowerCase();
    const f = members.filter((m) => (!role || String(m.role_id) === role) && (!team || m.teams.some((t) => t.id === team)) &&
      (!n || [m.name, m.email, m.user_id, m.job_title, m.department, m.phone, m.employee_id, m.location, ...m.teams.map((t) => t.name)].some((v) => v?.toLowerCase().includes(n))));
    const val = (m: MemberRow) => (sort.key === 'name' ? m.name.toLowerCase() : sort.key === 'role' ? m.role.toLowerCase() : sort.key === 'added' ? m.created_at : m.open_tickets);
    return [...f].sort((a, b) => (val(a) < val(b) ? -1 : val(a) > val(b) ? 1 : 0) * sort.dir);
  }, [members, q, role, team, sort]);
  const th = (key: SortKey, label: string) => (
    <th scope="col" aria-sort={sort.key === key ? (sort.dir === 1 ? 'ascending' : 'descending') : 'none'}>
      <button type="button" className="th-sort" onClick={() => setSort({ key, dir: sort.key === key ? (sort.dir === 1 ? -1 : 1) : 1 })}>{label}<span aria-hidden>{sort.key === key ? (sort.dir === 1 ? ' ↑' : ' ↓') : ''}</span></button>
    </th>);
  const filtered = q || role || team;

  return (
    <>
      <div className="tbl-tools">
        <div className="search-wrap"><label className="sr" htmlFor="mem-q">Search members</label>
          <input id="mem-q" type="search" placeholder="Search name, email, user ID, title, team…" value={q} onChange={(e) => setQ(e.target.value)} /></div>
        <label className="sr" htmlFor="mem-role">Filter by role</label>
        <select id="mem-role" value={role} onChange={(e) => setRole(e.target.value)}><option value="">All roles</option>{roles.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</select>
        <label className="sr" htmlFor="mem-team">Filter by team</label>
        <select id="mem-team" value={team} onChange={(e) => setTeam(e.target.value)}><option value="">All teams</option>{teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select>
        <span className="note count-note" aria-live="polite">{rows.length} of {members.length} {members.length === 1 ? 'person' : 'people'}</span>
        <button type="button" className="btn" onClick={() => open('new')}>+ Add member</button>
      </div>
      <div className="data-wrap">
        <table className="data-table">
          <caption className="sr">Project members. Select a person to see and change their details.</caption>
          <thead><tr>
            {th('name', 'Person')}<th scope="col">User ID</th>{th('role', 'Role')}<th scope="col">Job & department</th><th scope="col">Teams</th><th scope="col">Phone</th>{th('tickets', 'Open tickets')}{th('added', 'Added')}
          </tr></thead>
          <tbody>
            {rows.map((m) => (
              <tr key={m.id} className={`${m.active ? '' : 'inactive'} clickable`} onClick={() => open(m.id)}>
                <td><button type="button" className="person" onClick={(e) => { e.stopPropagation(); open(m.id); }} aria-label={`Open ${m.name}`}>
                  <Avatar name={m.name} /><span className="person-text"><b>{m.name}{m.id === meId && <span className="you"> you</span>}{!m.active && <span className="you off"> deactivated</span>}</b><span className="note">{m.email}</span></span></button></td>
                <td><code className="uid">{m.user_id}</code></td>
                <td><RoleBadge role={m.role} /></td>
                <td>{m.job_title || m.department ? <span className="two"><span>{m.job_title ?? '—'}</span><span className="note">{m.department ?? ''}</span></span> : <span className="note">—</span>}</td>
                <td><TeamChips teams={m.teams} /></td>
                <td>{m.phone ?? <span className="note">—</span>}</td>
                <td className="num">{m.open_tickets || <span className="note">0</span>}</td>
                <td className="note">{dateOnly(m.created_at)}</td>
              </tr>))}
            {rows.length === 0 && <tr><td colSpan={8} className="empty-row">{filtered ? 'Nobody matches those filters.' : 'No members yet.'}</td></tr>}
          </tbody>
        </table>
      </div>
    </>);
}

/* ------------------------------------------------------------------ one person: add or change */
const Form = z.object({
  firstName: z.string().trim().max(60), lastName: z.string().trim().max(60),
  email: z.string().trim().email('Enter a valid email address'),
  userId: z.string().trim().refine((v) => v === '' || /^[A-Za-z0-9._-]{3,40}$/.test(v), 'Use 3 to 40 letters, digits, dots, dashes or underscores'),
  employeeId: z.string().trim().max(40),
  phone: z.string().trim().refine((v) => v === '' || /^[+(\d][\d\s().-]{4,29}$/.test(v), 'Enter a phone number such as +91 98765 43210'),
  mobile: z.string().trim().refine((v) => v === '' || /^[+(\d][\d\s().-]{4,29}$/.test(v), 'Enter a phone number such as +91 98765 43210'),
  jobTitle: z.string().trim().max(120), department: z.string().trim().max(120), company: z.string().trim().max(120), location: z.string().trim().max(120), costCenter: z.string().trim().max(60),
  managerId: z.string(), timeZone: z.string(), language: z.string(), notes: z.string().max(2000), roleId: z.string().min(1, 'Choose a role'), teamIds: z.array(z.string()),
});
type FormState = z.infer<typeof Form>;
const BLANK: FormState = { firstName: '', lastName: '', email: '', userId: '', employeeId: '', phone: '', mobile: '', jobTitle: '', department: '', company: '', location: '', costCenter: '', managerId: '', timeZone: '', language: '', notes: '', roleId: '', teamIds: [] };
const fromMember = (m: MemberRow): FormState => ({
  firstName: m.first_name ?? m.name, lastName: m.last_name ?? '', email: m.email, userId: m.user_id ?? '', employeeId: m.employee_id ?? '', phone: m.phone ?? '', mobile: m.mobile ?? '', jobTitle: m.job_title ?? '',
  department: m.department ?? '', company: m.company ?? '', location: m.location ?? '', costCenter: m.cost_center ?? '', managerId: m.manager_id ?? '', timeZone: m.time_zone ?? '', language: m.language ?? '',
  notes: m.notes ?? '', roleId: String(m.role_id), teamIds: m.teams.map((t) => t.id),
});

function MemberDetail({ id, meId, members, roles, teams, flash, back, open, reload }: {
  id: string; meId: string; members: MemberRow[]; roles: Role[]; teams: Team[]; flash: Flash; back: () => void; open: (id: string | null) => void; reload: () => Promise<void>;
}) {
  const isNew = id === 'new';
  const [member, setMember] = useState<MemberRow | null>(null);
  const [f, setF] = useState<FormState>(BLANK);
  const [base, setBase] = useState<FormState>(BLANK);
  const [errs, setErrs] = useState<Partial<Record<keyof FormState, string>>>({});
  const [banner, setBanner] = useState('');
  const [busy, setBusy] = useState(false);
  const [missing, setMissing] = useState(false);

  useEffect(() => {
    if (isNew) return;
    api(`/api/project/members/${id}`).then((m: MemberRow) => { setMember(m); const s = fromMember(m); setF(s); setBase(s); }).catch(() => setMissing(true));
  }, [id, isNew]);

  const dirty = JSON.stringify(f) !== JSON.stringify(base);
  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => { setF((x) => ({ ...x, [k]: v })); if (errs[k]) setErrs((e) => ({ ...e, [k]: undefined })); };
  const lockedIdentity = !isNew && member && !member.canEditIdentity;
  const leave = () => { if (!dirty || confirm('Discard your changes?')) back(); };

  async function save(e: React.FormEvent) {
    e.preventDefault(); setBanner('');
    const r = Form.safeParse(f);
    if (!isNew && !f.firstName.trim()) { setErrs({ firstName: 'First name is needed' }); setBanner('Some details need attention.'); return; }
    if (!r.success) { const m: Partial<Record<keyof FormState, string>> = {}; for (const i of r.error.issues) { const k = i.path[0] as keyof FormState; if (!m[k]) m[k] = i.message; } setErrs(m); setBanner('Some details need attention.'); document.querySelector<HTMLElement>('.pf.invalid input, .pf.invalid select')?.focus(); return; }
    setBusy(true);
    try {
      if (isNew) {
        const body: Record<string, unknown> = { roleId: Number(f.roleId), teamIds: f.teamIds, email: f.email, lastName: f.lastName || null };
        if (f.firstName.trim()) body.firstName = f.firstName;
        for (const k of ['userId', 'employeeId', 'phone', 'mobile', 'jobTitle', 'department', 'company', 'location', 'costCenter', 'timeZone', 'language', 'notes'] as const) if (f[k]) body[k] = f[k];
        if (f.managerId) body.managerId = f.managerId;
        const res = await api('/api/project/members', j(body));
        flash('ok', res.created ? `${`${f.firstName} ${f.lastName}`.trim() || f.email} was added and can now sign in to this project.` : `${f.email} already had an account, so they joined this project with their existing profile.`);
        await reload(); open(res.userId);
      } else {
        const body: Record<string, unknown> = {};
        for (const k of Object.keys(f) as (keyof FormState)[]) {
          if (JSON.stringify(f[k]) === JSON.stringify(base[k])) continue;
          body[k] = k === 'roleId' ? Number(f[k]) : k === 'managerId' ? (f[k] || null) : f[k];
        }
        const res: MemberRow = await api(`/api/project/members/${id}`, j(body, 'PATCH'));
        flash('ok', `${res.name}’s details were saved.`); setMember({ ...member!, ...res, canEditIdentity: member!.canEditIdentity, notes: f.notes }); const s = fromMember({ ...res, notes: f.notes }); setF(s); setBase(s);
        await reload();
      }
    } catch (er) {
      const msg = (er as Error).message;
      const m: Partial<Record<keyof FormState, string>> = {};
      if (/user ID/i.test(msg)) m.userId = msg; else if (/email/i.test(msg) && /account|address/i.test(msg)) m.email = msg;
      setErrs(m); setBanner(msg);
    } finally { setBusy(false); }
  }

  async function remove() {
    if (!member || !confirm(`Remove ${member.name} from this project? Their account stays; they just lose access here and leave its teams.`)) return;
    try { await api(`/api/project/members/${member.id}`, { method: 'DELETE' }); flash('ok', `${member.name} was removed from this project.`); await reload(); back(); } catch (e) { setBanner((e as Error).message); }
  }

  if (missing) return <div className="pane" style={{ padding: 20 }}><p>That person is not in this project.</p><button className="btn ghost" onClick={back}>Back to members</button></div>;
  if (!isNew && !member) return <div className="skeleton" style={{ height: 300 }} aria-busy="true" />;
  const name = isNew ? 'New member' : member!.name;
  const managers = members.filter((m) => m.id !== id);
  const zones = f.timeZone && !TIME_ZONES.some(([v]) => v === f.timeZone) ? [[f.timeZone, f.timeZone] as [string, string], ...TIME_ZONES] : TIME_ZONES;
  const input = (k: keyof FormState, label: string, o: { type?: string; required?: boolean; hint?: string; disabled?: boolean; wide?: boolean; autoComplete?: string } = {}) => (
    <Field id={`m-${k}`} label={label} error={errs[k] as string | undefined} hint={o.hint} required={o.required} wide={o.wide}>
      <input id={`m-${k}`} type={o.type ?? 'text'} value={f[k] as string} disabled={o.disabled} autoComplete={o.autoComplete ?? 'off'} aria-invalid={!!errs[k]} aria-describedby={errs[k] ? `m-${k}-e` : undefined} onChange={(e) => set(k, e.target.value as never)} />
    </Field>);

  return (
    <motion.form onSubmit={save} noValidate className="drill" aria-label={isNew ? 'Add a member' : `Details of ${name}`} initial={{ opacity: 0, x: 18 }} animate={{ opacity: 1, x: 0 }} transition={{ duration: 0.16 }}>
      <nav className="crumbs" aria-label="Breadcrumb"><button type="button" className="linklike" onClick={leave}>Members</button><span aria-hidden> › </span><span aria-current="page">{name}</span></nav>
      <header className="drill-head">
        {isNew ? <span className="avatar big add" aria-hidden>+</span> : <Avatar name={name} size={56} />}
        <div className="drill-title"><h4>{isNew ? 'Add a member' : name}</h4>
          {isNew ? <p className="note">Add someone new, or someone who already has an account on the platform.</p>
            : <p className="note">{member!.email} · <code className="uid">{member!.user_id}</code>{member!.id === meId ? ' · you' : ''}</p>}</div>
        {!isNew && <div className="drill-badges"><RoleBadge role={member!.role} />{!member!.active && <span className="status off">Deactivated</span>}{member!.projects > 1 && <span className="status" title="This person has access to other projects too">In {member!.projects} projects</span>}</div>}
      </header>
      {banner && <p role="alert" className="err banner">{banner}</p>}

      <div className="drill-grid">
        <section className="pane drill-card" aria-labelledby="sec-id">
          <h4 id="sec-id">Identity</h4>
          <div className="pf-grid">
            {input('firstName', 'First name', { required: !isNew, hint: isNew ? 'Optional for people who already have an account' : undefined, autoComplete: 'given-name' })}{input('lastName', 'Last name', { autoComplete: 'family-name' })}
            {input('email', 'Email', { type: 'email', required: true, disabled: !!lockedIdentity, autoComplete: 'off' })}
            {input('userId', 'User ID', { disabled: !!lockedIdentity, hint: isNew ? 'Left empty, it is made from the email address' : undefined })}
            {input('employeeId', 'Employee ID')}
          </div>
          {lockedIdentity && <p className="note lock-note">{member!.name} also works in {member!.projects - 1} other project{member!.projects > 2 ? 's' : ''}, so only a Super Admin can change their email and user ID.</p>}
        </section>

        <section className="pane drill-card" aria-labelledby="sec-contact">
          <h4 id="sec-contact">Contact</h4>
          <div className="pf-grid">
            {input('phone', 'Phone', { type: 'tel', autoComplete: 'off' })}{input('mobile', 'Mobile', { type: 'tel', autoComplete: 'off' })}
            {input('location', 'Location')}
            <Field id="m-timeZone" label="Time zone"><select id="m-timeZone" value={f.timeZone} onChange={(e) => set('timeZone', e.target.value)}><option value="">Not set</option>{zones.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></Field>
            <Field id="m-language" label="Language"><select id="m-language" value={f.language} onChange={(e) => set('language', e.target.value)}><option value="">Not set</option>{LANGUAGES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></Field>
          </div>
        </section>

        <section className="pane drill-card" aria-labelledby="sec-org">
          <h4 id="sec-org">Organisation</h4>
          <div className="pf-grid">
            {input('jobTitle', 'Job title')}{input('department', 'Department')}{input('company', 'Company')}{input('costCenter', 'Cost center')}
            <Field id="m-managerId" label="Manager"><select id="m-managerId" value={f.managerId} onChange={(e) => set('managerId', e.target.value)}><option value="">No manager</option>{managers.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}</select></Field>
          </div>
        </section>

        <section className="pane drill-card access" aria-labelledby="sec-access">
          <h4 id="sec-access">Access in this project</h4>
          <Field id="m-roleId" label="Role" required error={errs.roleId}>
            <select id="m-roleId" value={f.roleId} onChange={(e) => set('roleId', e.target.value)} aria-invalid={!!errs.roleId}><option value="">Choose a role…</option>{roles.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</select>
          </Field>
          <fieldset className="team-pick"><legend>Teams</legend>
            {teams.length === 0 ? <p className="note">No teams yet. Create them under Teams in this section.</p> : (
              <div className="team-checks">{teams.map((t) => (
                <label key={t.id} className={`team-check ${f.teamIds.includes(t.id) ? 'on' : ''}`}>
                  <input type="checkbox" checked={f.teamIds.includes(t.id)} onChange={(e) => set('teamIds', e.target.checked ? [...f.teamIds, t.id] : f.teamIds.filter((x) => x !== t.id))} />{t.name}</label>))}</div>)}
            <p className="note">Team members can see and work the tickets assigned to their team, within what their role allows.</p>
          </fieldset>
          {!isNew && <dl className="facts"><div><dt>Added</dt><dd>{dateOnly(member!.created_at)}{member!.added_by ? ` by ${member!.added_by}` : ''}</dd></div><div><dt>Open tickets</dt><dd>{member!.open_tickets}</dd></div></dl>}
        </section>

        <section className="pane drill-card wide" aria-labelledby="sec-notes">
          <h4 id="sec-notes">Notes <span className="note">visible to project admins only</span></h4>
          <Field id="m-notes" label="Notes" error={errs.notes}><textarea id="m-notes" rows={3} value={f.notes} maxLength={2000} onChange={(e) => set('notes', e.target.value)} /></Field>
        </section>
      </div>

      {!isNew && member!.id !== meId && (
        <section className="danger-zone" aria-label="Remove from project">
          <div><b>Remove from this project</b><p className="note" style={{ margin: 0 }}>Their account stays and any other projects are not affected.</p></div>
          <button type="button" className="btn ghost danger" onClick={remove}>Remove {member!.first_name ?? 'member'}</button>
        </section>)}

      <div className="tb-bar drill-bar" role="region" aria-label="Save changes">
        <span className="note">{isNew ? 'The person is added when you save.' : dirty ? 'You have unsaved changes.' : 'No changes.'}</span>
        <button type="button" className="btn ghost" onClick={leave} disabled={busy}>{isNew ? 'Cancel' : 'Back to members'}</button>
        {!isNew && <button type="button" className="btn ghost" disabled={!dirty || busy} onClick={() => { setF(base); setErrs({}); setBanner(''); }}>Discard</button>}
        <button className="btn" disabled={busy || (!isNew && !dirty)}>{busy ? 'Saving…' : isNew ? 'Add member' : 'Save changes'}</button>
      </div>
    </motion.form>);
}
