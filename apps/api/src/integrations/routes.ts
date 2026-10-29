import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool } from '../db.js';
import { need } from '../rbac/auth.js';
import { audit } from '../rbac/audit.js';
import { assertCap } from '../rbac/modes.js';
import { DocError } from '../errors.js';
import { boardPhases } from '../workflow/service.js';
import type { Fetcher } from '../etl/types.js';
import { encryptSecret } from './secrets.js';
import { validateBaseUrl } from './url.js';
import { connectorFor, runSync, toneOf, type ConnectionRow } from './sync.js';
import { drainConnection } from './outbox.js';
import { planFor } from './writeback.js';

const Id = z.object({ id: z.string().uuid() });
const Config = z.object({
  jql: z.string().max(2000).optional(), flavor: z.enum(['cloud', 'datacenter']).optional(), acceptanceCriteriaField: z.string().max(60).optional(),
  tables: z.array(z.enum(['incident', 'problem', 'change_request'])).max(3).optional(), query: z.string().max(500).optional(), pageSize: z.number().int().min(10).max(200).optional(),
}).strict();
const Create = z.object({
  kind: z.enum(['jira', 'servicenow']), name: z.string().trim().min(2).max(60), baseUrl: z.string().min(8).max(300), username: z.string().trim().max(200).default(''),
  secret: z.string().min(1).max(500), config: Config.default({}), syncIntervalMin: z.number().int().min(1).max(1440).default(15),
});

/** Source-system connections for a project: set up, test, sync, and see how it is going. Nothing here ever writes to the source. */
export function registerIntegrationRoutes(app: FastifyInstance, deps: { fetch?: Fetcher } = {}) {
  const admin = need('admin.projects');
  const pid = (req: { user: { projectId: string | null } | null }) => req.user!.projectId!;
  const superOnly = (req: { user: { isSuper: boolean } | null }, what: string) => { if (!req.user!.isSuper) throw new DocError(`Only a Super Admin can ${what}. Ask one to do it.`, 403); };
  const load = async (req: Parameters<typeof pid>[0], id: string) => {
    const c = (await pool.query('SELECT * FROM integration_connections WHERE id=$1 AND project_id=$2', [id, pid(req)])).rows[0] as ConnectionRow | undefined;
    if (!c) throw new DocError('Connection not found', 404);
    return c;
  };
  const view = (c: Record<string, any>) => ({ id: c.id, kind: c.kind, name: c.name, baseUrl: c.base_url, username: c.username, config: c.config, enabled: c.enabled, syncIntervalMin: c.sync_interval_min, lastSyncAt: c.last_sync_at, health: c.health, hasSecret: !!c.secret_enc, tickets: c.tickets ?? 0, lastRun: c.last_run ?? null,
    writebackEnabled: c.writeback_enabled, dryRun: c.dry_run, queue: { pending: c.q_pending ?? 0, failed: c.q_failed ?? 0 } });

  app.get('/api/project/integrations', { preHandler: admin }, async (req) =>
    (await pool.query(
      `SELECT c.*, (SELECT count(*)::int FROM tickets t WHERE t.connection_id = c.id) AS tickets,
              (SELECT count(*)::int FROM outbound_queue q WHERE q.connection_id = c.id AND q.status = 'pending') AS q_pending, (SELECT count(*)::int FROM outbound_queue q WHERE q.connection_id = c.id AND q.status = 'failed') AS q_failed,
              (SELECT row_to_json(r) FROM (SELECT status, started_at, finished_at, created, updated, unchanged, failed, removed, error, full_scan FROM sync_runs s WHERE s.connection_id = c.id ORDER BY started_at DESC LIMIT 1) r) AS last_run
       FROM integration_connections c WHERE c.project_id=$1 ORDER BY c.name`, [pid(req)])).rows.map(view));

  app.post('/api/project/integrations', { preHandler: admin }, async (req, reply) => {
    superOnly(req, 'connect a project to a source system');
    await assertCap(pid(req), 'connector');
    const b = Create.parse(req.body);
    const baseUrl = validateBaseUrl(b.baseUrl);
    const r = (await pool.query(
      `INSERT INTO integration_connections (project_id, kind, name, base_url, username, secret_enc, config, sync_interval_min, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [pid(req), b.kind, b.name, baseUrl, b.username, encryptSecret(b.secret), JSON.stringify(b.config), b.syncIntervalMin, req.user!.id]).catch((e) => { if (e.code === '23505') throw new DocError('A connection with that name already exists', 409); throw e; })).rows[0];
    await audit(req, 'integration.create', { id: r.id, kind: b.kind, name: b.name });      // the credential itself is never logged
    return reply.code(201).send({ id: r.id });
  });

  app.put('/api/project/integrations/:id', { preHandler: admin }, async (req) => {
    const { id } = Id.parse(req.params); const c = await load(req, id);
    const b = Create.partial().extend({ enabled: z.boolean().optional() }).omit({ kind: true }).parse(req.body);
    if (b.secret !== undefined) superOnly(req, 'change the credentials of a connection');
    if (b.baseUrl !== undefined && b.baseUrl !== c.base_url) superOnly(req, 'change where a connection points');
    await pool.query(
      `UPDATE integration_connections SET name=COALESCE($2,name), base_url=COALESCE($3,base_url), username=COALESCE($4,username), secret_enc=COALESCE($5,secret_enc), config=COALESCE($6::jsonb,config),
         sync_interval_min=COALESCE($7,sync_interval_min), enabled=COALESCE($8,enabled) WHERE id=$1`,
      [id, b.name ?? null, b.baseUrl !== undefined ? validateBaseUrl(b.baseUrl) : null, b.username ?? null, b.secret ? encryptSecret(b.secret) : null, b.config ? JSON.stringify(b.config) : null, b.syncIntervalMin ?? null, b.enabled ?? null]);
    if (b.config) await pool.query(`UPDATE integration_connections SET cursor='{}' WHERE id=$1`, [id]);          // a different scope means a fresh full look
    await audit(req, 'integration.update', { id, fields: Object.keys(b).filter((k) => k !== 'secret') });
    return { ok: true };
  });

  app.delete('/api/project/integrations/:id', { preHandler: admin }, async (req) => {
    superOnly(req, 'remove a connection');
    const { id } = Id.parse(req.params); const c = await load(req, id);
    await pool.query('DELETE FROM integration_connections WHERE id=$1', [id]);     // tickets stay, no longer linked
    await audit(req, 'integration.delete', { id, name: c.name });
    return { ok: true };
  });

  app.post('/api/project/integrations/:id/test', { preHandler: admin }, async (req) => {
    const { id } = Id.parse(req.params); const c = await load(req, id);
    try { return { ok: true, ...(await connectorFor(c, deps.fetch).test()) }; } catch (e) { return { ok: false, detail: (e as Error).message }; }
  });

  app.post('/api/project/integrations/:id/sync', { preHandler: admin }, async (req) => {
    const { id } = Id.parse(req.params); const c = await load(req, id);
    if (!c.enabled) throw new DocError('This connection is switched off', 409);
    const running = (await pool.query(`SELECT 1 FROM sync_runs WHERE connection_id=$1 AND status='running' AND started_at > now() - interval '10 minutes'`, [id])).rowCount;
    if (running) throw new DocError('A sync is already running for this connection', 409);
    return runSync(c, { trigger: 'manual', fetch: deps.fetch });
  });

  app.get('/api/project/integrations/:id/runs', { preHandler: admin }, async (req) => {
    const { id } = Id.parse(req.params); await load(req, id);
    return (await pool.query(`SELECT id, trigger, full_scan, status, started_at, finished_at, created, updated, unchanged, failed, removed, error FROM sync_runs WHERE connection_id=$1 ORDER BY started_at DESC LIMIT 20`, [id])).rows;
  });
  app.get('/api/project/integrations/runs/:id/failures', { preHandler: admin }, async (req) => {
    const { id } = Id.parse(req.params);
    return (await pool.query(`SELECT f.source_key, f.error, f.at FROM sync_failures f JOIN sync_runs r ON r.id = f.run_id WHERE f.run_id=$1 AND r.project_id=$2 ORDER BY f.id LIMIT 200`, [id, pid(req)])).rows;
  });

  /** Every status the source has used on this connection's tickets, what we guess it means, and what the admin chose. */
  app.get('/api/project/integrations/:id/status-map', { preHandler: admin }, async (req) => {
    const { id } = Id.parse(req.params); await load(req, id);
    const observed = (await pool.query(
      `SELECT t.source_status AS status, count(*)::int AS tickets, m.phase_id AS "phaseId" FROM tickets t LEFT JOIN status_maps m ON m.connection_id = t.connection_id AND m.source_status = t.source_status
       WHERE t.connection_id=$1 AND t.source_status IS NOT NULL GROUP BY 1, 3 ORDER BY count(*) DESC, 1`, [id])).rows.map((r) => ({ ...r, guess: toneOf(r.status) }));
    const phases = (await boardPhases(pid(req))).filter((p) => p.enabled).map((p) => ({ id: p.id, name: p.name, tone: p.tone }));
    return { observed, phases };
  });
  app.put('/api/project/integrations/:id/status-map', { preHandler: admin }, async (req) => {
    const { id } = Id.parse(req.params); await load(req, id);
    const b = z.object({ maps: z.array(z.object({ sourceStatus: z.string().min(1).max(100), phaseId: z.number().int().nullable() })).max(200) }).parse(req.body);
    const ok = new Set((await boardPhases(pid(req))).map((p) => p.id));
    if (b.maps.some((m) => m.phaseId !== null && !ok.has(m.phaseId))) throw new DocError('One of the phases does not belong to this project', 400);
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query('DELETE FROM status_maps WHERE connection_id=$1', [id]);
      for (const m of b.maps) if (m.phaseId !== null) await c.query('INSERT INTO status_maps (connection_id, project_id, source_status, phase_id) VALUES ($1,$2,$3,$4)', [id, pid(req), m.sourceStatus, m.phaseId]);
      await c.query('COMMIT');
    } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
    await audit(req, 'integration.status_map', { id, count: b.maps.filter((m) => m.phaseId !== null).length });
    return { ok: true };
  });
  /** Applies the map to tickets that came from this connection and that nobody here has moved yet. */
  app.post('/api/project/integrations/:id/status-map/apply', { preHandler: admin }, async (req) => {
    const { id } = Id.parse(req.params); await load(req, id);
    const c = await pool.connect(); let moved = 0;
    try {
      await c.query('BEGIN'); await c.query(`SELECT set_config('app.sync_remap', 'on', true)`);
      moved = (await c.query(
        `UPDATE tickets t SET current_state = ph.name FROM status_maps m JOIN phases ph ON ph.id = m.phase_id
         WHERE t.connection_id=$1 AND m.connection_id = t.connection_id AND m.source_status = t.source_status AND t.current_state <> ph.name
           AND NOT EXISTS (SELECT 1 FROM ticket_transitions x WHERE x.ticket_id = t.id AND x.from_state IS NOT NULL)`, [id])).rowCount ?? 0;
      await c.query('COMMIT');
    } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
    await audit(req, 'integration.status_map.apply', { id, moved });
    return { moved };
  });
  /* ------------------------------------------------------------------ sending outcomes back (Connected projects) */
  const RuleIn = z.object({
    event: z.enum(['phase_entered', 'document_approved', 'signoff_approved', 'ticket_closed']), action: z.enum(['status', 'comment', 'attach']), enabled: z.boolean().default(true),
    params: z.object({ phase: z.string().max(60).optional(), docKind: z.enum(['FS', 'TS', 'TUT', 'CRC']).optional(), status: z.string().trim().max(100).optional(), template: z.string().max(2000).optional(), docKinds: z.array(z.enum(['FS', 'TS', 'TUT', 'CRC'])).max(4).optional() }).strict().default({}),
  }).superRefine((r, ctx) => {
    if (r.action === 'status' && !r.params.status) ctx.addIssue({ code: 'custom', message: 'Say which status to set in the source tool' });
    if (r.action === 'comment' && !r.params.template?.trim()) ctx.addIssue({ code: 'custom', message: 'Write the comment to send' });
    if (r.action === 'attach' && r.event !== 'document_approved' && !r.params.docKinds?.length) ctx.addIssue({ code: 'custom', message: 'Choose which documents to attach' });
  });

  app.put('/api/project/integrations/:id/writeback', { preHandler: admin }, async (req) => {
    const { id } = Id.parse(req.params); const c = await load(req, id);
    const b = z.object({ enabled: z.boolean().optional(), dryRun: z.boolean().optional() }).parse(req.body);
    if (b.enabled || b.dryRun === false || (b.enabled === undefined && b.dryRun === undefined)) await assertCap(pid(req), 'writeback');
    if (b.enabled === true && !c.secret_enc) throw new DocError('Add the connection’s credentials first', 409);
    if (b.enabled === true) superOnly(req, 'switch sending on');
    if (b.dryRun === false) superOnly(req, 'let a connection send for real');
    await pool.query('UPDATE integration_connections SET writeback_enabled=COALESCE($2,writeback_enabled), dry_run=COALESCE($3,dry_run) WHERE id=$1', [id, b.enabled ?? null, b.dryRun ?? null]);
    await audit(req, 'integration.writeback', { id, ...b });
    return { ok: true };
  });

  app.get('/api/project/integrations/:id/rules', { preHandler: admin }, async (req) => {
    const { id } = Id.parse(req.params); await load(req, id);
    return (await pool.query('SELECT id, event, action, params, enabled FROM writeback_rules WHERE connection_id=$1 ORDER BY position, id', [id])).rows;
  });
  app.put('/api/project/integrations/:id/rules', { preHandler: admin }, async (req) => {
    const { id } = Id.parse(req.params); await load(req, id); await assertCap(pid(req), 'writeback');
    const b = z.object({ rules: z.array(RuleIn).max(40) }).parse(req.body);
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query('DELETE FROM writeback_rules WHERE connection_id=$1', [id]);
      let pos = 0; for (const r of b.rules) await c.query('INSERT INTO writeback_rules (connection_id, project_id, event, action, params, enabled, position) VALUES ($1,$2,$3,$4,$5,$6,$7)', [id, pid(req), r.event, r.action, JSON.stringify(r.params), r.enabled, ++pos]);
      await c.query('COMMIT');
    } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
    await audit(req, 'integration.rules', { id, count: b.rules.length });
    return { ok: true };
  });

  /** What would be sent for this ticket if this happened, without sending or saving anything. */
  app.post('/api/project/integrations/:id/preview', { preHandler: admin }, async (req) => {
    const { id } = Id.parse(req.params); await load(req, id);
    const b = z.object({ ticketId: z.string().uuid(), event: z.enum(['phase_entered', 'document_approved', 'signoff_approved', 'ticket_closed']), phase: z.string().max(60).optional(), docKind: z.enum(['FS', 'TS', 'TUT', 'CRC']).optional() }).parse(req.body);
    const t = (await pool.query('SELECT title, legacy_id, current_state FROM tickets WHERE id=$1 AND connection_id=$2 AND project_id=$3', [b.ticketId, id, pid(req)])).rows[0];
    if (!t) throw new DocError('That ticket is not part of this connection', 404);
    return (await planFor(pool, id, { type: b.event, ticketId: b.ticketId, eventKey: 'preview', phase: b.phase, docKind: b.docKind }, { key: t.legacy_id, title: t.title, phase: t.current_state })).map((p) => ({ action: p.action, payload: p.payload }));
  });

  app.get('/api/project/integrations/:id/queue', { preHandler: admin }, async (req) => {
    const { id } = Id.parse(req.params); await load(req, id);
    return (await pool.query(
      `SELECT q.id, q.action, q.payload, q.status, q.dry_run AS "dryRun", q.attempts, q.last_error AS "lastError", q.result, q.created_at AS "createdAt", q.sent_at AS "sentAt", q.next_attempt_at AS "nextAttemptAt", t.id AS "ticketId", t.legacy_id AS "ticketKey", t.title
       FROM outbound_queue q JOIN tickets t ON t.id = q.ticket_id WHERE q.connection_id=$1 ORDER BY q.created_at DESC LIMIT 100`, [id])).rows;
  });
  const queueItem = async (req: Parameters<typeof pid>[0], qid: string) => {
    const q = (await pool.query('SELECT id, status FROM outbound_queue WHERE id=$1 AND project_id=$2', [qid, pid(req)])).rows[0];
    if (!q) throw new DocError('Item not found', 404);
    return q;
  };
  app.post('/api/project/integrations/queue/:id/retry', { preHandler: admin }, async (req) => {
    const { id } = Id.parse(req.params); const q = await queueItem(req, id);
    if (!['failed', 'skipped'].includes(q.status)) throw new DocError('Only items that failed or were skipped can be tried again', 409);
    await pool.query(`UPDATE outbound_queue SET status='pending', attempts=0, next_attempt_at=now(), last_error=NULL, result=NULL, dry_run=(SELECT dry_run FROM integration_connections c WHERE c.id = connection_id) WHERE id=$1`, [id]);
    return { ok: true };
  });
  app.post('/api/project/integrations/queue/:id/skip', { preHandler: admin }, async (req) => {
    const { id } = Id.parse(req.params); const q = await queueItem(req, id);
    if (!['pending', 'failed'].includes(q.status)) throw new DocError('That item is already finished', 409);
    await pool.query(`UPDATE outbound_queue SET status='cancelled' WHERE id=$1`, [id]);
    return { ok: true };
  });
  /** Send what is waiting now, instead of at the next scheduled pass. */
  app.post('/api/project/integrations/:id/send', { preHandler: admin }, async (req) => {
    const { id } = Id.parse(req.params); const c = await load(req, id); await assertCap(pid(req), 'writeback');
    return drainConnection(c, { fetch: deps.fetch });
  });
  app.post('/api/tickets/:id/writeback-pause', { preHandler: need('ticket.advance') }, async (req) => {
    const { id } = Id.parse(req.params); const { paused } = z.object({ paused: z.boolean() }).parse(req.body);
    const r = await pool.query('UPDATE tickets SET writeback_paused=$2 WHERE id=$1 AND project_id=$3 AND connection_id IS NOT NULL', [id, paused, pid(req)]);
    if (!r.rowCount) throw new DocError('This ticket is not linked to a source tool', 404);
    await audit(req, 'ticket.writeback_pause', { ticketId: id, paused });
    return { ok: true };
  });
}
