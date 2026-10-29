'use client';
import { useEffect, useState } from 'react';
import { Nav } from '../../components/Nav';
import { SettingsShell, useSectionHash, type SettingsGroup } from '../../components/SettingsShell';
import { FieldAdmin } from '../../components/FieldAdmin';
import { ModulesAdmin } from '../../components/ModulesAdmin';
import { TemplateBuilder } from '../../components/TemplateBuilder';
import { DocSettingsAdmin } from '../../components/DocSettingsAdmin';
import { LifecycleAdmin } from '../../components/LifecycleAdmin';
import { WorkflowAdmin } from '../../components/WorkflowAdmin';
import { TechnologyAdmin } from '../../components/TechnologyAdmin';
import { ActivityList } from '../../components/consoleBits';
import { RolesAdmin } from '../../components/people/RolesAdmin';
import { MembersAdmin } from '../../components/people/MembersAdmin';
import { TeamsAdmin } from '../../components/people/TeamsAdmin';
import { NoAccess, NoProject, useAuth } from '../../lib/auth';

type Tab = 'members' | 'teams' | 'roles' | 'fields' | 'tech' | 'lifecycles' | 'workflows' | 'template' | 'modules' | 'documents' | 'activity';

/** Project settings: what a Project Admin (or anyone they delegate to) controls, for the project they are working in. */
export default function ProjectSettings() {
  const { me, can, canAny, loading } = useAuth();
  const [status, setStatus] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const flash = (kind: 'ok' | 'err', text: string) => setStatus({ kind, text });

  const groups: SettingsGroup<Tab>[] = [
    { label: 'People & access', items: [
      { key: 'members', label: 'Members', show: can('admin.users') },
      { key: 'teams', label: 'Teams', hint: 'Groups of people. Team members can work the tickets assigned to their team.', show: can('admin.users') },
      { key: 'roles', label: 'Roles & permissions', hint: 'What each role can do and see in this project.', show: can('admin.roles') },
      { key: 'fields', label: 'Ticket fields', hint: 'Which ticket fields each role can see or edit.', show: can('admin.roles') }] },
    { label: 'How work flows', items: [
      { key: 'template', label: 'Template builder', hint: 'The project type, methodology, phases and the kinds of items people can create.', show: can('admin.projects') },
      { key: 'lifecycles', label: 'Lifecycles', hint: 'The statuses each kind of item moves through, and which moves are allowed.', show: can('admin.projects') },
      { key: 'workflows', label: 'Approval workflows', hint: 'Who approves documents, and in what order.', show: can('admin.workflows') },
      { key: 'tech', label: 'Technology', hint: 'The technologies this project works in; the AI stays within them.', show: can('admin.projects') }] },
    { label: 'Features & content', items: [
      { key: 'modules', label: 'Modules', hint: 'Optional capabilities you can switch on for this project.', show: can('admin.projects') },
      { key: 'documents', label: 'Documents', hint: 'How this project’s Word documents look, and delivery rules for them.', show: can('admin.projects') }] },
    { label: 'Audit', items: [{ key: 'activity', label: 'Activity', hint: 'A log of changes made in this project.' }] },
  ];
  const allowed = groups.flatMap((g) => g.items).filter((i) => i.show !== false).map((i) => i.key);
  const { section: t, choose: setTab, sub, setSub } = useSectionHash<Tab>(allowed, allowed[0] ?? 'activity');
  useEffect(() => { setStatus(null); }, [t]);

  if (loading || !me) return <><Nav current="admin" /><main id="main"><p className="note">Loading…</p></main></>;
  if (!me.project) return <><Nav current="admin" /><main id="main"><NoProject /></main></>;
  if (!canAny('admin.roles', 'admin.users', 'admin.projects', 'admin.workflows')) return <><Nav current="admin" /><main id="main"><NoAccess what="project settings" /></main></>;

  return (
    <>
      <Nav current="admin" />
      <main id="main">
        <div className="board-head"><div><h2>Project settings <span className="note">· {me.project.name}</span></h2></div></div>
        <SettingsShell label="Project settings" groups={groups} active={t} onSelect={setTab} status={status && <p className={status.kind === 'err' ? 'err' : 'ok'} role={status.kind === 'err' ? 'alert' : 'status'} style={{ margin: 0 }}>{status.text}</p>}>
        {t === 'members' && can('admin.users') && <MembersAdmin flash={flash} meId={me.user.id} sub={sub} onSub={setSub} />}
        {t === 'teams' && can('admin.users') && <TeamsAdmin flash={flash} sub={sub} onSub={setSub} />}
        {t === 'roles' && can('admin.roles') && <RolesAdmin mode="project" flash={flash} sub={sub} onSub={setSub} />}
        {t === 'fields' && can('admin.roles') && <FieldAdmin mode="project" flash={flash} />}
        {t === 'template' && can('admin.projects') && <TemplateBuilder flash={flash} />}
        {t === 'lifecycles' && can('admin.projects') && <LifecycleAdmin flash={flash} sub={sub} onSub={setSub} />}
        {t === 'tech' && can('admin.projects') && <TechnologyAdmin flash={flash} />}
        {t === 'workflows' && can('admin.workflows') && <WorkflowAdmin flash={flash} />}
        {t === 'modules' && can('admin.projects') && <ModulesAdmin flash={flash} />}
        {t === 'documents' && can('admin.projects') && <DocSettingsAdmin flash={flash} />}
        {t === 'activity' && <ActivityList path="/api/project/audit" flash={flash} />}
        </SettingsShell>
      </main>
    </>
  );
}
