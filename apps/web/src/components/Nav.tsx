'use client';
import { modeName } from '../lib/modes';
import Link from 'next/link';
import { useAuth } from '../lib/auth';

type Key = 'board' | 'planning' | 'chat' | 'dashboards' | 'mailbox' | 'admin' | 'platform' | 'none';

export function Nav({ current }: { current: Key }) {
  const { me, can, canAny, logout, isSuper, switchProject } = useAuth();
  const link = (href: string, key: Key, label: string, show: boolean) =>
    show ? <Link href={href} aria-current={current === key ? 'page' : undefined}>{label}</Link> : null;
  const inProject = !!me?.project;
  return (
    <header className="top">
      <Link href="/" className="brand" aria-label="Design Max home">
        <span className="brand-mark" aria-hidden>DM</span><span className="word">Design Max</span>
      </Link>
      {me && (me.projects.length > 1 || isSuper) && (
        <div className="proj-switch">
          <label className="sr" htmlFor="project-switch">Project</label>
          <select id="project-switch" value={me.project?.id ?? ''} onChange={(e) => e.target.value && switchProject(e.target.value)}>
            {!me.project && <option value="">Choose a project…</option>}
            {me.projects.map((p) => <option key={p.id} value={p.id}>{p.name}{p.role ? ` · ${p.role}` : ''}</option>)}
          </select>
        </div>)}
      {me && me.projects.length === 1 && !isSuper && <span className="proj-name" title="Your project">{me.project?.name}</span>}
      {me?.project && me.project.operatingMode && me.project.operatingMode !== 'full' && <span className={`mode-chip ${me.project.operatingMode}`} title={me.project.operatingMode === 'connected' ? 'Tickets come from the customer’s tool; chosen outcomes are sent back' : 'Read-only: tickets come from the customer’s tool and nothing is sent back'}>{modeName(me.project.operatingMode)}</span>}
      <nav aria-label="Primary">
        {inProject && link('/', 'board', 'Board', can('board.view'))}
        {inProject && link('/planning', 'planning', 'Planning', !!me?.project?.modules?.planning_module && can('planning.manage'))}
        {inProject && link('/dashboards', 'dashboards', 'Summary', can('report.view'))}
        {inProject && link('/chat', 'chat', 'Chat', canAny('chat.as_customer', 'chat.as_consultant', 'chat.view_all'))}
        {link('/mailbox', 'mailbox', 'Mailbox', isSuper)}
        {inProject && link('/admin', 'admin', 'Project settings', canAny('admin.roles', 'admin.users', 'admin.projects', 'admin.workflows'))}
        {link('/platform', 'platform', 'Platform', isSuper)}
      </nav>
      {me && (
        <div className="who">
          <span className="who-name">{me.user.name}</span>
          <span className="role-badge" data-role={me.user.role}>{me.user.role}</span>
          <button className="btn ghost sm" onClick={logout}>Sign out</button>
        </div>
      )}
    </header>
  );
}
