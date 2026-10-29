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

/** What the source says about one ticket right now. */
export interface SourceNow { status: string; updatedAt: string }
export interface Connector {
  /** Checks the address and credentials. */
  test(): Promise<{ detail: string }>;
  /** Everything changed at or after `since` (null = everything), oldest change first. */
  pull(since: string | null): AsyncGenerator<SourceTicket>;
  /** Sending outcomes back. Only ever called for a Connected project, by the outbound queue. */
  current?(ref: { key: string; type: string }): Promise<SourceNow>;
  transitionTo?(ref: { key: string; type: string }, status: string): Promise<{ detail: string }>;
  addComment?(ref: { key: string; type: string }, body: string): Promise<{ detail: string }>;
  attach?(ref: { key: string; type: string }, file: { filename: string; mime: string; data: Buffer }): Promise<{ detail: string }>;
}
export interface ConnectorConfig { baseUrl: string; username: string; secret: string; config: Record<string, unknown>; fetch?: Fetcher }
