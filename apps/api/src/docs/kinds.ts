import type { TicketState } from '../stateMachine.js';

/** The document types. FS and TS drive the ticket's lifecycle gates; TUT and CRC are produced while the ticket is in delivery. */
export const KINDS = ['FS', 'TS', 'TUT', 'CRC'] as const;
export type DocKind = (typeof KINDS)[number];
export const isKind = (k: string): k is DocKind => (KINDS as readonly string[]).includes(k);

export const LABEL: Record<DocKind, string> = {
  FS: 'Functional Specification', TS: 'Technical Specification', TUT: 'Technical Unit Test', CRC: 'Code Review Checklist',
};
export const SHORT: Record<DocKind, string> = { FS: 'Functional spec', TS: 'Technical spec', TUT: 'Unit test', CRC: 'Code review' };

const DELIVERY: TicketState[] = ['Development', 'QA', 'UAT'];

/** When each type can be created and edited, and which lifecycle step (if any) it drives. */
export const RULES: Record<DocKind, { generateIn: TicketState[]; editIn: TicketState[]; onGenerate?: TicketState; onApprove?: TicketState; lockedWhenApproved: boolean }> = {
  FS: { generateIn: ['Requirement Verified'], editIn: ['FS Drafted'], onGenerate: 'FS Drafted', onApprove: 'FS Approved', lockedWhenApproved: false },
  TS: { generateIn: ['FS Approved'], editIn: ['TS Drafted'], onGenerate: 'TS Drafted', onApprove: 'TS Approved', lockedWhenApproved: false },
  TUT: { generateIn: DELIVERY, editIn: DELIVERY, lockedWhenApproved: true },
  CRC: { generateIn: DELIVERY, editIn: DELIVERY, lockedWhenApproved: true },
};

export const generateHint = (k: DocKind) =>
  k === 'FS' ? 'once the requirement is verified' : k === 'TS' ? 'once the Functional Specification is approved' : 'once the ticket is in Development';
