import type { Fetcher } from '../etl/types.js';

export type SourceKind = 'jira' | 'servicenow';
export interface SourceUser { id: string; email?: string; name?: string }
export interface SourceComment { id: string; author?: SourceUser; body: string; createdAt: string }
export interface SourceAttachment { id: string; filename: string; mimeType?: string; size?: number; url: string }
export interface SourceStep { at: string; from: string | null; to: string; actor?: string }

/** One ticket as the source tool describes it, in a tool-independent shape. */
export interface SourceTicket {
  source: SourceKind; key: string; type: string; title: string; description?: string; status: string; priority?: string; dueDate?: string;
  reporter?: SourceUser; assignee?: SourceUser; resolutionNotes?: string; acceptanceCriteria?: string;
  comments: SourceComment[]; attachments: SourceAttachment[]; createdAt: string; updatedAt: string; url?: string; history: SourceStep[];
}

export interface Connector {
  /** Checks the address and credentials. */
  test(): Promise<{ detail: string }>;
  /** Everything changed at or after `since` (null = everything), oldest change first. */
  pull(since: string | null): AsyncGenerator<SourceTicket>;
}
export interface ConnectorConfig { baseUrl: string; username: string; secret: string; config: Record<string, unknown>; fetch?: Fetcher }
