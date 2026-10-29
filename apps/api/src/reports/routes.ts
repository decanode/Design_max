import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { pool } from '../db.js';
import { need, type SessionUser } from '../rbac/auth.js';
import { membersWithPermission } from '../rbac/effective.js';
import { DocError } from '../docs/service.js';
import { ReportDefinition, FILTER_FIELD, datasetMeta, runReport, toCsv, type ReportDef } from './engine.js';
import { FIELD_KEYS, canRead } from '../tickets/fields.js';

const Layout = z.array(z.object({ id: z.string().uuid(), reportId: z.string().uuid(), size: z.union([z.literal(1), z.literal(2), z.literal(3)]) })).max(40);
const Visibility = z.enum(['private', 'shared']);
const Id = z.object({ id: z.string().uuid() });

interface Row { id: string; owner_id: string | null; visibility: string; is_system: boolean; project_id: string | null }
const manage = (u: SessionUser) => u.perms.has('report.manage_all');
/** Built-ins (no project) are shared templates; everything else belongs to one project and never crosses it. */
const inScope = (u: SessionUser, r: Row) => r.project_id === null || r.project_id === u.projectId;
/** Who can open an item: within the project, shared ones, their own, or anyone who manages all. */
const canSee = (u: SessionUser, r: Row) => inScope(u, r) && (r.visibility === 'shared' || r.owner_id === u.id || manage(u));
/** Who can change it: never a built-in (copy it instead: it is shared by every project); otherwise the owner or a manager of the project's reports. */
const canEdit = (u: SessionUser, r: Row) => !r.is_system && inScope(u, r) && (manage(u) || (r.owner_id === u.id && u.perms.has('report.build')));

const notFound = (what: string) => new DocError(`${what} not found`, 404);
const forbidden = () => new DocError('You can’t change this. Make your own copy first.', 403);

async function loadReport(id: string) {
  const r = (await pool.query('SELECT r.*, u.display_name AS owner FROM reports r LEFT JOIN users u ON u.id = r.owner_id WHERE r.id = $1', [id])).rows[0];
  if (!r) throw notFound('Report');
  return r;
}
async function loadDashboard(id: string) {
  const d = (await pool.query('SELECT d.*, u.display_name AS owner FROM dashboards d LEFT JOIN users u ON u.id = d.owner_id WHERE d.id = $1', [id])).rows[0];
  if (!d) throw notFound('Dashboard');
  return d;
}

/** A report may be run by someone who can see it, or who can see a dashboard that contains it. */
async function canRun(u: SessionUser, rep: Row) {
  if (canSee(u, rep)) return true;
  return !!(await pool.query(
    `SELECT 1 FROM dashboards WHERE layout @> $1::jsonb AND (project_id IS NULL OR project_id = $3) AND (visibility = 'shared' OR owner_id = $2) LIMIT 1`, [JSON.stringify([{ reportId: rep.id }]), u.id, u.projectId])).rowCount;
}

const summary = (u: SessionUser, r: any) => ({
  id: r.id, name: r.name, description: r.description, visibility: r.visibility, isSystem: r.is_system,
  owner: r.owner, mine: r.owner_id === u.id, canEdit: canEdit(u, r), updatedAt: r.updated_at,
});

export function registerReportRoutes(app: FastifyInstance) {
  const view = need('report.view');
  const build = need('report.build');

  app.get('/api/reports/meta', { preHandler: view }, async (req) => ({
    datasets: datasetMeta(req.user!.perms),
    readableFields: FIELD_KEYS.filter((f) => canRead(req.user!.fields, f)),   // groupings/filters on other fields are refused by the engine
    filterFields: FILTER_FIELD,
    // Filter choices are only needed (and only offered) to people who build reports.
    people: req.user!.perms.has('report.build') ? (await membersWithPermission(pool, req.user!.projectId!, 'ticket.claim')).map(({ id, name }) => ({ id, name })) : [],
  }));

  // ---------------- reports
  app.get('/api/reports', { preHandler: view }, async (req) => {
    const u = req.user!;
    const rows = (await pool.query('SELECT r.*, o.display_name AS owner FROM reports r LEFT JOIN users o ON o.id = r.owner_id ORDER BY r.is_system DESC, r.name')).rows;
    return rows.filter((r) => canSee(u, r)).map((r) => ({ ...summary(u, r), definition: r.definition }));
  });

  app.post('/api/reports/preview', { preHandler: build }, async (req) => {
    const def = ReportDefinition.parse((req.body as any)?.definition);
    return runReport(def, req.user!);
  });

  app.post('/api/reports', { preHandler: build }, async (req, reply) => {
    const b = z.object({ name: z.string().trim().min(1).max(80), description: z.string().max(300).default(''), definition: ReportDefinition, visibility: Visibility.default('private') }).parse(req.body);
    const id = (await pool.query('INSERT INTO reports (name, description, definition, owner_id, visibility, project_id) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id',
      [b.name, b.description, JSON.stringify(b.definition), req.user!.id, b.visibility, req.user!.projectId])).rows[0].id;
    return reply.code(201).send({ id });
  });

  app.get('/api/reports/:id', { preHandler: view }, async (req) => {
    const r = await loadReport(Id.parse(req.params).id);
    if (!(await canRun(req.user!, r))) throw notFound('Report');
    return { ...summary(req.user!, r), definition: r.definition };
  });

  app.put('/api/reports/:id', { preHandler: build }, async (req) => {
    const { id } = Id.parse(req.params);
    const r = await loadReport(id);
    if (!canSee(req.user!, r)) throw notFound('Report');
    if (!canEdit(req.user!, r)) throw forbidden();
    const b = z.object({ name: z.string().trim().min(1).max(80).optional(), description: z.string().max(300).optional(), definition: ReportDefinition.optional(), visibility: Visibility.optional() }).parse(req.body);
    await pool.query('UPDATE reports SET name=COALESCE($2,name), description=COALESCE($3,description), definition=COALESCE($4,definition), visibility=COALESCE($5,visibility), updated_at=now() WHERE id=$1',
      [id, b.name ?? null, b.description ?? null, b.definition ? JSON.stringify(b.definition) : null, b.visibility ?? null]);
    return { ok: true };
  });

  app.post('/api/reports/:id/duplicate', { preHandler: build }, async (req, reply) => {
    const r = await loadReport(Id.parse(req.params).id);
    if (!(await canRun(req.user!, r))) throw notFound('Report');
    const id = (await pool.query('INSERT INTO reports (name, description, definition, owner_id, project_id) VALUES ($1,$2,$3,$4,$5) RETURNING id',
      [`Copy of ${r.name}`.slice(0, 80), r.description, r.definition, req.user!.id, req.user!.projectId])).rows[0].id;
    return reply.code(201).send({ id });
  });

  app.delete('/api/reports/:id', { preHandler: build }, async (req) => {
    const { id } = Id.parse(req.params);
    const r = await loadReport(id);
    if (!canSee(req.user!, r)) throw notFound('Report');
    if (!canEdit(req.user!, r)) throw forbidden();
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      // Remove its widgets from every dashboard so none is left pointing at nothing.
      await c.query(`UPDATE dashboards SET layout = COALESCE((SELECT jsonb_agg(w) FROM jsonb_array_elements(layout) w WHERE w->>'reportId' <> $1), '[]'::jsonb) WHERE layout @> $2::jsonb`, [id, JSON.stringify([{ reportId: id }])]);
      await c.query('DELETE FROM reports WHERE id=$1', [id]);
      await c.query('COMMIT');
    } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
    return { ok: true };
  });

  const run = async (req: FastifyRequest) => {
    const r = await loadReport(Id.parse(req.params).id);
    if (!(await canRun(req.user!, r))) throw notFound('Report');
    return { r, result: await runReport(ReportDefinition.parse(r.definition) as ReportDef, req.user!) };
  };
  app.get('/api/reports/:id/data', { preHandler: view }, async (req) => (await run(req)).result);
  app.get('/api/reports/:id/csv', { preHandler: view }, async (req, reply) => {
    const { r, result } = await run(req);
    const file = r.name.replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-').toLowerCase() || 'report';
    return reply.header('content-type', 'text/csv; charset=utf-8').header('content-disposition', `attachment; filename="${file}.csv"`).send(toCsv(result));
  });

  // ---------------- dashboards
  app.get('/api/dashboards', { preHandler: view }, async (req) => {
    const u = req.user!;
    const rows = (await pool.query('SELECT d.*, o.display_name AS owner FROM dashboards d LEFT JOIN users o ON o.id = d.owner_id ORDER BY d.is_system DESC, d.name')).rows;
    return rows.filter((d) => canSee(u, d)).map((d) => ({ ...summary(u, d), widgets: (d.layout as unknown[]).length }));
  });

  app.get('/api/dashboards/:id', { preHandler: view }, async (req) => {
    const u = req.user!;
    const d = await loadDashboard(Id.parse(req.params).id);
    if (!canSee(u, d)) throw notFound('Dashboard');
    const layout = Layout.parse(d.layout);
    const reps = layout.length ? (await pool.query('SELECT id, name, description, definition FROM reports WHERE id = ANY($1::uuid[])', [layout.map((w) => w.reportId)])).rows : [];
    const byId = new Map(reps.map((r) => [r.id, r]));
    return {
      ...summary(u, d),
      widgets: layout.filter((w) => byId.has(w.reportId)).map((w) => ({ ...w, report: byId.get(w.reportId) })),
    };
  });

  app.post('/api/dashboards', { preHandler: build }, async (req, reply) => {
    const b = z.object({ name: z.string().trim().min(1).max(80), description: z.string().max(300).default(''), visibility: Visibility.default('private'), layout: Layout.default([]) }).parse(req.body);
    await assertReportsExist(b.layout, req.user!.projectId);
    const id = (await pool.query('INSERT INTO dashboards (name, description, layout, owner_id, visibility, project_id) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id',
      [b.name, b.description, JSON.stringify(b.layout), req.user!.id, b.visibility, req.user!.projectId])).rows[0].id;
    return reply.code(201).send({ id });
  });

  app.put('/api/dashboards/:id', { preHandler: build }, async (req) => {
    const { id } = Id.parse(req.params);
    const d = await loadDashboard(id);
    if (!canSee(req.user!, d)) throw notFound('Dashboard');
    if (!canEdit(req.user!, d)) throw forbidden();
    const b = z.object({ name: z.string().trim().min(1).max(80).optional(), description: z.string().max(300).optional(), visibility: Visibility.optional(), layout: Layout.optional() }).parse(req.body);
    if (b.layout) await assertReportsExist(b.layout, req.user!.projectId);
    await pool.query('UPDATE dashboards SET name=COALESCE($2,name), description=COALESCE($3,description), visibility=COALESCE($4,visibility), layout=COALESCE($5,layout), updated_at=now() WHERE id=$1',
      [id, b.name ?? null, b.description ?? null, b.visibility ?? null, b.layout ? JSON.stringify(b.layout) : null]);
    return { ok: true };
  });

  app.post('/api/dashboards/:id/duplicate', { preHandler: build }, async (req, reply) => {
    const d = await loadDashboard(Id.parse(req.params).id);
    if (!canSee(req.user!, d)) throw notFound('Dashboard');
    // Fresh widget ids so the copy and the original never share identities.
    const layout = (d.layout as any[]).map((w) => ({ ...w, id: crypto.randomUUID() }));
    const id = (await pool.query('INSERT INTO dashboards (name, description, layout, owner_id, project_id) VALUES ($1,$2,$3,$4,$5) RETURNING id',
      [`Copy of ${d.name}`.slice(0, 80), d.description, JSON.stringify(layout), req.user!.id, req.user!.projectId])).rows[0].id;
    return reply.code(201).send({ id });
  });

  app.delete('/api/dashboards/:id', { preHandler: build }, async (req) => {
    const { id } = Id.parse(req.params);
    const d = await loadDashboard(id);
    if (!canSee(req.user!, d)) throw notFound('Dashboard');
    if (!canEdit(req.user!, d)) throw forbidden();
    await pool.query('DELETE FROM dashboards WHERE id=$1', [id]);
    return { ok: true };
  });
}

async function assertReportsExist(layout: z.infer<typeof Layout>, projectId: string | null) {
  const ids = [...new Set(layout.map((w) => w.reportId))];
  if (!ids.length) return;
  const n = (await pool.query('SELECT count(*)::int n FROM reports WHERE id = ANY($1::uuid[]) AND (project_id IS NULL OR project_id = $2)', [ids, projectId])).rows[0].n;
  if (n !== ids.length) throw new DocError('A widget points to a report that does not exist', 400);
}
