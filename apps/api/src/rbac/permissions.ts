/** The fixed catalog of permissions, grouped by feature. Roles are arbitrary subsets of these keys. */
export interface PermissionDef { key: string; label: string; description: string }
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
    { key: 'spec.edit', label: 'Edit specifications', description: 'Save new document versions.' }] },
  { feature: 'Approvals', permissions: [
    { key: 'approval.request', label: 'Request approvals', description: 'Send a specification for approval.' },
    { key: 'approval.decide', label: 'Decide approvals', description: 'Approve or reject specifications addressed to them.' }] },
  { feature: 'Dashboards', permissions: [
    { key: 'dashboard.team', label: 'Team dashboard', description: 'Workload per consultant and the unassigned queue.' },
    { key: 'dashboard.portfolio', label: 'Portfolio dashboard', description: 'Tickets by phase and pending approvals across projects.' }] },
  { feature: 'Developer tools', permissions: [
    { key: 'mailbox.view', label: 'View the dev mailbox', description: 'Inspect emails the system "sent" (development only).' }] },
  { feature: 'Administration', permissions: [
    { key: 'admin.users', label: 'Manage users', description: 'Create users and assign their roles.' },
    { key: 'admin.roles', label: 'Manage roles', description: 'Create roles and choose their permissions per feature.' }] },
];

export const ALL_KEYS: string[] = CATALOG.flatMap((f) => f.permissions.map((p) => p.key));
export const isKnownKey = (k: string) => ALL_KEYS.includes(k);
export const ADMIN_ROLE = 'Admin';
