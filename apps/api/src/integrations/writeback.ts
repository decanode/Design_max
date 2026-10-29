import type pg from 'pg';
import { projectMode } from '../rbac/modes.js';

type Q = Pick<pg.Pool, 'query'>;
export type WbEventType = 'phase_entered' | 'document_approved' | 'signoff_approved' | 'ticket_closed';
export interface WbEvent { type: WbEventType; ticketId: string; eventKey: string; phase?: string; docKind?: string; actorId?: string | null }
export interface Rule { id: string; event: WbEventType; action: 'status' | 'comment' | 'attach'; params: Record<string, any>; enabled: boolean }
const DOC: Record<string, string> = { FS: 'Functional Specification', TS: 'Technical Specification', TUT: 'Unit Test', CRC: 'Code Review Checklist' };

/** Fills {{placeholders}} in a comment template. Unknown placeholders are left out, never shown raw. */
export function renderTemplate(tpl: string, vars: Record<string, string>): string {
  return tpl.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, k) => vars[k] ?? '').replace(/[ \t]+\n/g, '\n').trim();
}
export const ruleMatches = (r: Rule, ev: WbEvent) =>
  r.enabled && r.event === ev.type && (r.event !== 'phase_entered' || !r.params.phase || String(r.params.phase).toLowerCase() === (ev.phase ?? '').toLowerCase())
  && (r.event !== 'document_approved' || !r.params.docKind || r.params.docKind === ev.docKind);

/** What each matching rule would send for this event, without sending or saving anything. */
export async function planFor(db: Q, connectionId: string, ev: WbEvent, ticket: { key: string; title: string; phase: string }) {
  const rules = (await db.query('SELECT id, event, action, params, enabled FROM writeback_rules WHERE connection_id=$1 ORDER BY position, id', [connectionId])).rows as Rule[];
  const vars = { 'ticket.key': ticket.key, 'ticket.title': ticket.title, phase: ev.phase ?? ticket.phase, doc: ev.docKind ? DOC[ev.docKind] ?? ev.docKind : '' };
  return rules.filter((r) => ruleMatches(r, ev)).map((r) => ({
    rule: r, action: r.action,
    payload: r.action === 'status' ? { status: String(r.params.status ?? '') }
      : r.action === 'comment' ? { body: renderTemplate(String(r.params.template ?? ''), vars) }
      : { kinds: ev.type === 'document_approved' && ev.docKind ? [ev.docKind] : (r.params.docKinds as string[] | undefined) ?? [] },
  })).filter((p) => (p.action === 'status' ? !!(p.payload as { status: string }).status : p.action === 'comment' ? !!(p.payload as { body: string }).body : (p.payload as { kinds: string[] }).kinds.length > 0));
}

/**
 * Called from inside the transaction that caused the event (a phase move, an approval, a sign-off), so the send is queued if and
 * only if the change happened. A problem here never undoes the change itself: it is skipped and the change stands.
 */
export async function enqueueEvent(db: Q, ev: WbEvent): Promise<number> {
  let saved = true;
  try { await db.query('SAVEPOINT wb_enqueue'); } catch { saved = false; }
  try {
    const t = (await db.query(
      `SELECT t.id, t.project_id, t.title, t.legacy_id, t.current_state, t.writeback_paused, c.id AS conn, c.enabled, c.writeback_enabled, c.dry_run
       FROM tickets t JOIN integration_connections c ON c.id = t.connection_id WHERE t.id=$1`, [ev.ticketId])).rows[0];
    if (!t || !t.enabled || !t.writeback_enabled || t.writeback_paused || !(await projectMode(t.project_id, db)).caps.writeback) { if (saved) await db.query('RELEASE SAVEPOINT wb_enqueue'); return 0; }
    let n = 0;
    for (const p of await planFor(db, t.conn, ev, { key: t.legacy_id, title: t.title, phase: t.current_state })) {
      const r = await db.query(
        `INSERT INTO outbound_queue (connection_id, project_id, ticket_id, rule_id, action, payload, actor_id, idempotency_key, dry_run) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (idempotency_key) DO NOTHING`,
        [t.conn, t.project_id, ev.ticketId, p.rule.id, p.action, JSON.stringify(p.payload), ev.actorId ?? null, `${p.rule.id}:${ev.ticketId}:${ev.eventKey}`, t.dry_run]);
      n += r.rowCount ?? 0;
    }
    if (saved) await db.query('RELEASE SAVEPOINT wb_enqueue');
    return n;
  } catch (e) {
    if (saved) await db.query('ROLLBACK TO SAVEPOINT wb_enqueue').catch(() => {});
    console.error('write-back could not be queued', (e as Error).message);
    return 0;
  }
}
