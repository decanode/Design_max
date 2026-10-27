/** The fixed catalog of permissions, grouped by feature. Roles are arbitrary subsets of these keys. */
/** `platform` permissions belong to Super Admins only; `project` permissions can be given to roles inside a project. */
export type Scope = 'platform' | 'project';
export interface PermissionDef { key: string; label: string; description: string; scope?: Scope }
export interface FeatureDef { feature: string; permissions: PermissionDef[] }

export const CATALOG: FeatureDef[] = [
  { feature: 'Board', permissions: [
    { key: 'board.view', label: 'View the board', description: 'Open the board and see tickets they are allowed to see.' }] },
  { feature: 'Tickets', permissions: [
    { key: 'ticket.view_all', label: 'See all tickets', description: 'Every ticket in the system.' },
    { key: 'ticket.view_own', label: 'See own tickets', description: 'Tickets where they are the customer or the assigned consultant.' },
    { key: 'ticket.view_unassigned', label: 'See unassigned tickets', description: 'The intake queue of tickets with no consultant yet.' },
    { key: 'ticket.create', label: 'Create tickets manually', description: 'Add a ticket directly from the board.' },
    { key: 'ticket.claim', label: 'Claim tickets', description: 'Take an unassigned ticket; also makes the user assignable.' },
    { key: 'ticket.assign', label: 'Assign tickets', description: 'Assign or reassign a ticket to a consultant.' },
    { key: 'ticket.advance', label: 'Advance delivery phases', description: 'Move tickets through Development, QA, UAT and Deployed.' }] },
  { feature: 'Chat', permissions: [
    { key: 'chat.as_customer', label: 'Chat as customer', description: 'Start conversations and send customer messages.' },
    { key: 'chat.as_consultant', label: 'Chat as consultant', description: 'Reply in conversations as a consultant.' },
    { key: 'chat.view_all', label: 'See all conversations', description: 'Open any conversation, not just their own.' },
    { key: 'chat.verify', label: 'Verify & Approve summaries', description: 'Confirm the AI requirement summary to log a ticket.' }] },
  { feature: 'Specifications', permissions: [
    { key: 'spec.view', label: 'View specifications', description: 'Read FS/TS documents and their history.' },
    { key: 'spec.generate', label: 'Generate drafts', description: 'Create the first FS or TS draft.' },
    { key: 'spec.edit', label: 'Edit specifications', description: 'Edit the shared draft and save new document versions.' },
    { key: 'doc.comment', label: 'Comment on documents', description: 'Add review comments and replies on a document, even without edit access.' },
    { key: 'doc.review', label: 'Review documents', description: 'Request changes or confirm a document looks good, and resolve anyone\'s comments.' }] },
  { feature: 'Approvals', permissions: [
    { key: 'approval.request', label: 'Request approvals', description: 'Send a specification for approval through its workflow, and cancel their own requests.' }] },
  { feature: 'Dashboards', permissions: [
    { key: 'dashboard.team', label: 'Team dashboard', description: 'Workload per consultant and the unassigned queue.' },
    { key: 'dashboard.portfolio', label: 'Portfolio dashboard', description: 'Tickets by phase and pending approvals across projects.' }] },
  { feature: 'Reports & dashboards', permissions: [
    { key: 'report.view', label: 'View dashboards & reports', description: 'Open shared dashboards and reports. Numbers only ever include tickets the person may see.' },
    { key: 'report.build', label: 'Build reports & dashboards', description: 'Create, change, copy and share their own reports and dashboards.' },
    { key: 'report.manage_all', label: 'Manage everyone\'s reports', description: 'Edit or delete any report or dashboard, including the built-in ones.' }] },
  { feature: 'Developer tools', permissions: [
    { key: 'mailbox.view', label: 'View the dev mailbox', description: 'Inspect emails the system "sent" (development only). Spans all projects, so Super Admins only.', scope: 'platform' }] },
  { feature: 'Administration', permissions: [
    { key: 'admin.users', label: 'Manage project members', description: 'Add people to this project and choose their roles in it.' },
    { key: 'admin.projects', label: 'Manage project settings', description: 'Choose which technology stacks the AI may work in for this project.' },
    { key: 'admin.workflows', label: 'Manage approval workflows', description: 'Define the approval levels (L1, L2, L3…) and who approves at each.' },
    { key: 'admin.roles', label: 'Tune roles for this project', description: 'Change what each role can do, and see, inside this project.' }] },
  { feature: 'Platform', permissions: [
    { key: 'platform.projects', label: 'Manage projects', description: 'Create and archive projects and appoint their Project Admins.', scope: 'platform' },
    { key: 'platform.users', label: 'Manage all users', description: 'Create users, deactivate them, and grant Super Admin.', scope: 'platform' },
    { key: 'platform.roles', label: 'Manage the role and stack catalogs', description: 'Define the standard roles, their default access and the technology stacks.', scope: 'platform' }] },
];

export const ALL_KEYS: string[] = CATALOG.flatMap((f) => f.permissions.map((p) => p.key));
export const PLATFORM_KEYS: string[] = CATALOG.flatMap((f) => f.permissions.filter((p) => p.scope === 'platform').map((p) => p.key));
/** Everything a Project Admin holds inside their project (and the only keys a project role may ever carry). */
export const PROJECT_KEYS: string[] = ALL_KEYS.filter((k) => !PLATFORM_KEYS.includes(k));
export const PROJECT_ADMIN_ROLE = 'Project Admin';
export const isKnownKey = (k: string) => ALL_KEYS.includes(k);

