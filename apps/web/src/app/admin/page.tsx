'use client';
import { useEffect, useState } from 'react';
import { Nav } from '../../components/Nav';
import { FieldAdmin } from '../../components/FieldAdmin';
import { ModulesAdmin } from '../../components/ModulesAdmin';
import { TemplateBuilder } from '../../components/TemplateBuilder';
import { DocSettingsAdmin } from '../../components/DocSettingsAdmin';
import { WorkflowAdmin } from '../../components/WorkflowAdmin';
import { ActivityList, MembersAdmin, ProjectTech, RoleMatrix } from '../../components/consoleBits';
import { NoAccess, NoProject, useAuth } from '../../lib/auth';

type Tab = 'members' | 'roles' | 'fields' | 'tech' | 'workflows' | 'template' | 'modules' | 'documents' | 'activity';

/** Project settings: what a Project Admin (or anyone they delegate to) controls, for the project they are working in. */
export default function ProjectSettings() {
  const { me, can, canAny, loading } = useAuth();
  const [tab, setTab] = useState<Tab | null>(null);
  const [status, setStatus] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const flash = (kind: 'ok' | 'err', text: string) => setStatus({ kind, text });

  const tabs: [Tab, string, boolean][] = [
    ['members', 'Members', can('admin.users')], ['roles', 'Roles & permissions', can('admin.roles')], ['fields', 'Ticket fields', can('admin.roles')],
    ['template', 'Template builder', can('admin.projects')], ['tech', 'Technology', can('admin.projects')], ['workflows', 'Approval workflows', can('admin.workflows')], ['modules', 'Modules', can('admin.projects')], ['documents', 'Documents', can('admin.projects')], ['activity', 'Activity', true],
  ];
  const first = tabs.find((t) => t[2])?.[0] ?? 'activity';
  useEffect(() => { if (me && !tab) setTab(first); }, [me, tab, first]);
  useEffect(() => { setStatus(null); }, [tab]);

  if (loading || !me) return <><Nav current="admin" /><main id="main"><p className="note">Loading…</p></main></>;
  if (!me.project) return <><Nav current="admin" /><main id="main"><NoProject /></main></>;
  if (!canAny('admin.roles', 'admin.users', 'admin.projects', 'admin.workflows')) return <><Nav current="admin" /><main id="main"><NoAccess what="project settings" /></main></>;
  const t = tab ?? first;

  return (
    <>
      <Nav current="admin" />
      <main id="main">
        <div className="board-head"><div><h2>Project settings <span className="note">· {me.project.name}</span></h2><p>The rules for this project only. Nothing here changes any other project.</p></div></div>
        <div className="tabs" role="tablist" aria-label="Project settings">
          {tabs.filter((x) => x[2]).map(([k, label]) => <button key={k} role="tab" className="tab" aria-selected={t === k} onClick={() => setTab(k)}>{label}</button>)}
        </div>
        <div aria-live="polite" style={{ minHeight: 24 }}>{status && <p className={status.kind === 'err' ? 'err' : 'ok'} role={status.kind === 'err' ? 'alert' : 'status'} style={{ margin: '0 0 10px' }}>{status.text}</p>}</div>

        {t === 'members' && can('admin.users') && <MembersAdmin flash={flash} meId={me.user.id} />}
        {t === 'roles' && can('admin.roles') && <RoleMatrix mode="project" flash={flash} />}
        {t === 'fields' && can('admin.roles') && <FieldAdmin mode="project" flash={flash} />}
        {t === 'template' && can('admin.projects') && <TemplateBuilder flash={flash} />}
        {t === 'tech' && can('admin.projects') && <ProjectTech flash={flash} />}
        {t === 'workflows' && can('admin.workflows') && <WorkflowAdmin flash={flash} />}
        {t === 'modules' && can('admin.projects') && <ModulesAdmin flash={flash} />}
        {t === 'documents' && can('admin.projects') && <DocSettingsAdmin flash={flash} />}
        {t === 'activity' && <ActivityList path="/api/project/audit" flash={flash} />}
      </main>
    </>
  );
}
