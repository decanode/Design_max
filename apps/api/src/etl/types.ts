import type { TicketState } from '../tickets.js';

export type LegacySource = 'jira' | 'servicenow';
export type Fetcher = typeof fetch;

export interface LegacyUser { legacyId: string; email?: string; name?: string }
export interface LegacyComment { legacyId: string; author?: LegacyUser; body: string; createdAt: string }
export interface LegacyAttachment { legacyId: string; filename: string; mimeType?: string; size?: number; url: string }

/** Source-agnostic record produced by every extractor. */
export interface LegacyRecord {
  source: LegacySource;
  legacyId: string;            // e.g. "PROJ-12" or "INC0010001"
  type: string;                // Epic / Story / Bug / incident / problem / change_request
  title: string;
  description?: string;
  status: string;              // raw legacy status
  reporter?: LegacyUser;
  assignee?: LegacyUser;
  resolutionNotes?: string;
  acceptanceCriteria?: string;
  comments: LegacyComment[];
  attachments: LegacyAttachment[];
}

export interface Extractor { extract(): AsyncGenerator<LegacyRecord> }

export interface MappedTicket {
  record: LegacyRecord;
  state: TicketState;
}
