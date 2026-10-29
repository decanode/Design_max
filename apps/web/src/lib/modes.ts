/** The operating modes, as the screens describe them. The server (apps/api/src/rbac/modes.ts) is the source of truth for what each allows. */
export type Mode = 'full' | 'connected' | 'mirror';
export type Caps = Record<'native_ticket_create' | 'customer_intake' | 'ticket_creation_approval' | 'closing_gates' | 'customer_signoff' | 'planning_convert' | 'work_gate' | 'connector' | 'writeback', boolean>;

export const MODE_LIST: { key: Mode; name: string; short: string; summary: string; icon: string; bullets: string[]; limits: string[] }[] = [
  { key: 'full', name: 'Full adoption', short: 'Full', icon: '🏢', summary: 'The whole project lifecycle lives in Design Max, from intake to closing.',
    bullets: ['Customers raise requests through the assistant', 'Tickets are created, approved, worked and closed here', 'Documents, approvals, customer sign-off and planning'], limits: [] },
  { key: 'connected', name: 'Connected', short: 'Connected', icon: '🔗', summary: 'The customer keeps Jira or ServiceNow. Tickets are pulled in, the team works them here, and the outcomes you choose are sent back.',
    bullets: ['Tickets arrive from the source tool and stay in sync', 'Documents, approvals, work breakdown and reports work as usual', 'You choose what is sent back: status, comments, document files'], limits: ['Tickets cannot be created here', 'No customer chat intake'] },
  { key: 'mirror', name: 'Mirror (read-only)', short: 'Mirror', icon: '🪞', summary: 'Tickets are pulled in read-only. The team works locally (status, tasks, documents) and nothing is ever sent back.',
    bullets: ['Source status is shown next to our own local status', 'Documents, approvals, work breakdown and reports work as usual', 'Safe: nothing is written to the customer’s tool'], limits: ['Tickets cannot be created here', 'No customer chat intake', 'Closing gates and customer sign-off are off by default'] },
];
export const modeName = (m?: string) => MODE_LIST.find((x) => x.key === m)?.short ?? 'Full';

/** What a Super Admin can adjust for one project, with plain-language labels. */
export const OVERRIDES: { key: 'closing_gates' | 'customer_signoff' | 'planning_convert' | 'work_gate'; label: string; hint: string }[] = [
  { key: 'closing_gates', label: 'Required documents before closing', hint: 'A ticket cannot be closed until the documents its type requires are approved.' },
  { key: 'customer_signoff', label: 'Customer sign-off before closing', hint: 'The customer who raised a ticket must confirm it is resolved.' },
  { key: 'work_gate', label: 'All tasks done before closing', hint: 'A ticket cannot be closed while any of its work items is not done.' },
  { key: 'planning_convert', label: 'Turn work packages into tickets', hint: 'Creates tickets here from the planning work breakdown (they will not exist in the source tool).' },
];
