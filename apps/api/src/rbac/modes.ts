import type pg from 'pg';
import { pool } from '../db.js';
import { DocError } from '../errors.js';

/**
 * Operating modes: how much of the lifecycle a project runs inside Design Max.
 * One table decides it. Everything else (permissions, route guards, screens) asks this file.
 */
export const MODES = ['full', 'connected', 'mirror'] as const;
export type Mode = (typeof MODES)[number];

export const MODE_INFO: Record<Mode, { name: string; summary: string }> = {
  full: { name: 'Full adoption', summary: 'The whole project lifecycle lives in Design Max, from intake to closing.' },
  connected: { name: 'Connected', summary: 'The customer keeps Jira or ServiceNow. Tickets are pulled in, the team works them here, and the outcomes you choose are sent back.' },
  mirror: { name: 'Mirror (read-only)', summary: 'Tickets are pulled in read-only. The team works locally (status, tasks, documents) and nothing is ever sent back.' },
};

/** Everything a mode can switch on or off. */
export const CAPABILITIES = [
  'native_ticket_create',      // create tickets here (board, chat, planning conversion)
  'customer_intake',           // customers talk to the assistant and raise tickets
  'ticket_creation_approval',  // approval of new tickets before work starts
  'closing_gates',             // documents required to close a ticket
  'customer_signoff',          // the raising customer confirms before close
  'planning_convert',          // turn work packages into tickets
  'work_gate',                 // all work items must be done before a ticket can close
  'connector',                 // a source system connection (pull sync)
  'writeback',                 // send outcomes back to the source system
] as const;
export type Capability = (typeof CAPABILITIES)[number];
export type Caps = Record<Capability, boolean>;

const DEFAULTS: Record<Mode, Caps> = {
  full:      { native_ticket_create: true,  customer_intake: true,  ticket_creation_approval: true,  closing_gates: true,  customer_signoff: true,  planning_convert: true,  work_gate: false, connector: true,  writeback: false },
  connected: { native_ticket_create: false, customer_intake: false, ticket_creation_approval: false, closing_gates: true,  customer_signoff: true,  planning_convert: false, work_gate: false, connector: true,  writeback: true },
  mirror:    { native_ticket_create: false, customer_intake: false, ticket_creation_approval: false, closing_gates: false, customer_signoff: false, planning_convert: false, work_gate: false, connector: true,  writeback: false },
};

/** What a Super Admin may change for one project. Everything else is fixed by the mode: it would break what the mode means. */
export const OVERRIDABLE: Capability[] = ['closing_gates', 'customer_signoff', 'planning_convert', 'work_gate'];

export type Overrides = Partial<Record<Capability, boolean>>;

/** The capabilities of a mode, with the Super Admin's allowed adjustments applied. Pure. */
export function capabilitiesOf(mode: Mode, overrides: Overrides = {}): Caps {
  const caps = { ...DEFAULTS[mode] };
  for (const k of OVERRIDABLE) if (typeof overrides[k] === 'boolean') caps[k] = overrides[k]!;
  return caps;
}

/** Permission keys that stop existing for people in a project when a capability is off, so routes and screens follow without per-route edits. */
const PERMS_BY_CAP: Partial<Record<Capability, string[]>> = {
  native_ticket_create: ['ticket.create', 'chat.verify'],
  customer_intake: ['chat.as_customer'],
};
export const removedPermissions = (caps: Caps): Set<string> =>
  new Set((Object.keys(PERMS_BY_CAP) as Capability[]).filter((c) => !caps[c]).flatMap((c) => PERMS_BY_CAP[c]!));

/** Checks overrides from a request: only known, overridable capabilities, booleans only. */
export function validateOverrides(input: unknown): Overrides {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) throw new DocError('Overrides must be an object', 400);
  const out: Overrides = {};
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    if (!OVERRIDABLE.includes(k as Capability)) throw new DocError(`“${k}” cannot be changed for a project`, 400);
    if (typeof v !== 'boolean') throw new DocError(`“${k}” must be on or off`, 400);
    out[k as Capability] = v;
  }
  return out;
}

type Db = Pick<pg.Pool, 'query'>;
export async function projectMode(projectId: string, db: Db = pool): Promise<{ mode: Mode; overrides: Overrides; caps: Caps }> {
  const r = (await db.query('SELECT operating_mode, mode_overrides FROM projects WHERE id=$1', [projectId])).rows[0];
  const mode: Mode = r?.operating_mode ?? 'full';
  const overrides: Overrides = r?.mode_overrides ?? {};
  return { mode, overrides, caps: capabilitiesOf(mode, overrides) };
}

/** Domain-level guard: used inside the functions that change things, so chat, planning and imports cannot go around the mode. */
export async function assertCap(projectId: string, cap: Capability, db: Db = pool): Promise<void> {
  const { mode, caps } = await projectMode(projectId, db);
  if (!caps[cap]) throw new DocError(MESSAGES[cap](MODE_INFO[mode].name), 409, { code: 'MODE_RESTRICTED', capability: cap, mode });
}
const MESSAGES: Record<Capability, (mode: string) => string> = {
  native_ticket_create: (m) => `This project runs in ${m} mode: tickets come from the source system, so they cannot be created here.`,
  customer_intake: (m) => `Customer intake is not used in ${m} mode.`,
  ticket_creation_approval: (m) => `Ticket-creation approval is not used in ${m} mode.`,
  closing_gates: (m) => `Closing gates are off in ${m} mode.`,
  customer_signoff: (m) => `Customer sign-off is off in ${m} mode.`,
  planning_convert: (m) => `Turning work packages into tickets is not available in ${m} mode.`,
  work_gate: (m) => `Requiring all work items to be done is off in ${m} mode.`,
  connector: (m) => `A source connection is not available in ${m} mode.`,
  writeback: (m) => `Sending changes back to the source system is not available in ${m} mode.`,
};
