export const STATES = [
  'Requirement Verified', 'FS Drafted', 'FS Approved', 'TS Drafted',
  'TS Approved', 'Development', 'QA', 'UAT', 'Deployed',
] as const;
export type TicketState = (typeof STATES)[number];

/** States whose exit requires an approval (FS / TS sign-off gates). */
export const APPROVAL_GATES: ReadonlySet<TicketState> = new Set(['FS Drafted', 'TS Drafted']);

export function nextState(s: TicketState): TicketState | null {
  const i = STATES.indexOf(s);
  return i >= 0 && i < STATES.length - 1 ? STATES[i + 1] : null;
}

export function canTransition(from: TicketState, to: TicketState): boolean {
  return nextState(from) === to;
}
