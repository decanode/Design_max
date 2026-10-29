'use client';
import { SettingsShell, useSectionHash, type SettingsGroup } from '../../components/SettingsShell';
import { WorkflowStudio } from '../../components/platform/WorkflowStudio';
import { TemplateAdmin } from '../../components/TemplateAdmin';
import { useCallback, useEffect, useState } from 'react';
import { Nav } from '../../components/Nav';
import { FieldAdmin } from '../../components/FieldAdmin';
import { ActivityList, api } from '../../components/consoleBits';
import { RolesAdmin } from '../../components/people/RolesAdmin';
import { ProjectsAdmin } from '../../components/platform/ProjectsAdmin';
import { PortfolioAdmin } from '../../components/platform/PortfolioAdmin';
import { UsersAdmin } from '../../components/platform/UsersAdmin';
import { TechCatalogAdmin } from '../../components/platform/TechCatalogAdmin';
import { NoAccess, useAuth, j } from '../../lib/auth';

type Tab = 'projects' | 'portfolio' | 'users' | 'roles' | 'fields' | 'stacks' | 'workflows' | 'documents' | 'activity';
type Flash = (kind: 'ok' | 'err', text: string) => void;

export default function Platform() {
  const { me, isSuper, loading } = useAuth();
  const [status, setStatus] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const flash = useCallback<Flash>((kind, text) => setStatus({ kind, text }), []);
  const groups: SettingsGroup<Tab>[] = [
    { label: 'Workspace', items: [{ key: 'projects', label: 'Projects', hint: 'Create projects, appoint their admins, step into one, or archive it.' }, { key: 'portfolio', label: 'Portfolio', hint: 'Every project side by side: open work, flow, approvals and source health.' }, { key: 'users', label: 'Users', hint: 'Everyone on the platform, their projects and roles.' }] },
    { label: 'Standards', items: [{ key: 'roles', label: 'Role catalog', hint: 'The standard roles every project starts from.' }, { key: 'fields', label: 'Default ticket fields', hint: 'Which ticket fields each standard role can see.' }, { key: 'stacks', label: 'Technology catalog', hint: 'The technologies a project can be limited to.' }] },
    { label: 'Building blocks', items: [{ key: 'workflows', label: 'Workflows', hint: 'Ticket types and their fields, methodologies and their transitions, project-type defaults.' }, { key: 'documents', label: 'Documents', hint: 'Word templates and the defaults for document style.' }] },
    { label: 'Audit', items: [{ key: 'activity', label: 'Activity', hint: 'A log of platform-wide changes.' }] },
  ];
  const { section: tab, choose: setTab, sub, setSub } = useSectionHash<Tab>(groups.flatMap((g) => g.items.map((i) => i.key)), 'projects');
  useEffect(() => { setStatus(null); }, [tab]);
  if (loading || !me) return <><Nav current="platform" /><main id="main"><p className="note">Loading…</p></main></>;
  if (!isSuper) return <><Nav current="platform" /><main id="main"><NoAccess what="the platform console" /></main></>;
  return (
    <>
      <Nav current="platform" />
      <main id="main">
        <div className="board-head"><div><h2>Platform</h2></div></div>
        <SettingsShell label="Platform" groups={groups} active={tab} onSelect={setTab} status={status && <p className={status.kind === 'err' ? 'err' : 'ok'} role={status.kind === 'err' ? 'alert' : 'status'} style={{ margin: 0 }}>{status.text}</p>}>
        {tab === 'projects' && <ProjectsAdmin flash={flash} sub={sub} onSub={setSub} />}
        {tab === 'portfolio' && <PortfolioAdmin flash={flash} />}
        {tab === 'users' && <UsersAdmin flash={flash} sub={sub} onSub={setSub} />}
        {tab === 'roles' && <RolesAdmin mode="platform" flash={flash} sub={sub} onSub={setSub} />}
        {tab === 'fields' && <FieldAdmin mode="platform" flash={flash} />}
        {tab === 'stacks' && <TechCatalogAdmin flash={flash} sub={sub} onSub={setSub} />}
        {tab === 'workflows' && <WorkflowStudio flash={flash} sub={sub} onSub={setSub} />}
        {tab === 'documents' && <TemplateAdmin flash={flash} />}
        {tab === 'activity' && <ActivityList path="/api/platform/audit" flash={flash} showProject />}
        </SettingsShell>
      </main>
    </>
  );
}
