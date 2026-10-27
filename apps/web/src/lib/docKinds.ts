export const KINDS = ['FS', 'TS', 'TUT', 'CRC'] as const;
export type Kind = (typeof KINDS)[number];
export const LABEL: Record<Kind, string> = { FS: 'Functional Spec', TS: 'Technical Spec', TUT: 'Unit Test', CRC: 'Code Review' };
export const FULL: Record<Kind, string> = { FS: 'Functional Specification', TS: 'Technical Specification', TUT: 'Technical Unit Test', CRC: 'Code Review Checklist' };
const DELIVERY = ['Development', 'QA', 'UAT'];
/** Mirrors the server's rules: when each document can be created and edited. */
export const GENERATE_IN: Record<Kind, string[]> = { FS: ['Requirement Verified'], TS: ['FS Approved'], TUT: DELIVERY, CRC: DELIVERY };
export const EDIT_IN: Record<Kind, string[]> = { FS: ['FS Drafted'], TS: ['TS Drafted'], TUT: DELIVERY, CRC: DELIVERY };
export const HINT: Record<Kind, string> = {
  FS: 'once the requirement is verified', TS: 'once the Functional Specification is approved', TUT: 'once the ticket is in Development', CRC: 'once the ticket is in Development',
};
