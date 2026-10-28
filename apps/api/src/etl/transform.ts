import type { TicketState } from '../tickets.js';
import type { LegacyRecord, MappedTicket } from './types.js';

const JIRA_STATE: Record<string, TicketState> = {
  'to do': 'Requirement Verified', backlog: 'Requirement Verified', open: 'Requirement Verified',
  'in progress': 'Development', 'in development': 'Development',
  'in review': 'QA', 'in qa': 'QA', qa: 'QA', testing: 'QA',
  uat: 'UAT', 'ready for uat': 'UAT',
  done: 'Deployed', closed: 'Deployed', resolved: 'Deployed',
};

// ServiceNow numeric `state` values (incident baseline; problem/change reuse the common ones).
const SNOW_STATE: Record<string, TicketState> = {
  '1': 'Requirement Verified', '2': 'Development', '3': 'Development',
  '6': 'Deployed', '7': 'Deployed', '8': 'Deployed',
};

export function mapState(r: Pick<LegacyRecord, 'source' | 'status'>): TicketState {
  const s = r.source === 'jira' ? JIRA_STATE[r.status.toLowerCase()] : SNOW_STATE[r.status];
  return s ?? 'Requirement Verified';
}

export const toMapped = (record: LegacyRecord): MappedTicket => ({ record, state: mapState(record) });
