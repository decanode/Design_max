import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { pool } from '../db.js';
import { need } from '../rbac/auth.js';
import { audit } from '../rbac/audit.js';
import { DocError } from '../errors.js';
import { signCollab } from '../collab/token.js';
import { PlanningAiError, type PlanningAi } from './ai.js';
import { CHARTER_ROOM, closeCharterRoom, flushCharter, resetCharterRoom } from './collab.js';
import {
  PLANNING_MODULE, addElement, approveCharter, convertToTickets, deleteElement, generateCharter, generateWbs, getCharter, listWbs, modulesOf, moveElement, reopenCharter,
  storeCharterContent, updateElement, type Actor,
} from './service.js';

/** Generation calls cost money and time: a person may start only so many in a window. */
const recent = new Map<string, number[]>();
export function allowGeneration(userId: string, max = 12, windowMs = 10 * 60_000, now = Date.now()) {
  const hits = (recent.get(userId) ?? []).filter((t) => now - t < windowMs);
  if (hits.length >= max) { recent.set(userId, hits); return false; }
  recent.set(userId, [...hits, now]);
  return true;
}

const Intake = z.object({
  problem: z.string().trim().min(10, 'Describe the business problem in a sentence or two').max(4000),
  sponsor: z.string().trim().min(2, 'Name the sponsor').max(300),
  goals: z.string().trim().min(10, 'Add at least one goal').max(4000),
  constraints: z.string().trim().max(3000).default(''),
  replace: z.boolean().optional(),
});

const Id = z.object({ id: z.string().uuid() });

export function registerPlanningRoutes(app: FastifyInstance, deps: { ai: PlanningAi }) {
  /** Planning is a per-project feature: the Project Admin must have switched it on. */
  const moduleOn = async (req: FastifyRequest, reply: FastifyReply) => {
    if (!(await modulesOf(req.user!.projectId!))[PLANNING_MODULE]) return reply.code(403).send({ error: 'The Planning module is not switched on for this project', code: 'MODULE_DISABLED' });
  };
  const gate = { preHandler: [need('planning.manage'), moduleOn] };
  const actor = (req: FastifyRequest): Actor => ({ id: req.user!.id, name: req.user!.name, projectId: req.user!.projectId!, projectName: req.user!.projectName ?? 'Project' });
  const generating = (req: FastifyRequest) => { if (!allowGeneration(req.user!.id)) throw new DocError('You have started a lot of AI drafts in a short time. Wait a few minutes and try again.', 429); };
  const ai = async <T>(fn: () => Promise<T>) => { try { return await fn(); } catch (e) { if (e instanceof PlanningAiError) throw new DocError(e.message, e.status); throw e; } };

  const charterView = (c: Awaited<ReturnType<typeof getCharter>>) => c && ({
    status: c.status as 'Draft' | 'Approved', generatedBy: c.generated_by as string | null, intake: c.intake, approvedAt: c.approved_at, approvedBy: c.approved_by_name, updatedAt: c.updated_at,
    hasContent: !!(c.content_json || c.executive_summary), sections: { executiveSummary: c.executive_summary, objectives: c.objectives, scope: c.scope, outOfScope: c.out_of_scope, stakeholders: c.stakeholders, milestones: c.milestones, risks: c.risks },
  });
  const state = async (req: FastifyRequest) => ({
    ai: { provider: deps.ai.provider, model: deps.ai.model },
    charter: charterView(await getCharter(req.user!.projectId!)),
    wbs: await listWbs(req.user!.projectId!),
  });

  app.get('/api/planning', gate, async (req) => state(req));

  // ------------------------------------------------------------ charter
  app.post('/api/planning/charter/generate', gate, async (req, reply) => {
    const b = Intake.parse(req.body);
    generating(req);
    const r = await ai(() => generateCharter(actor(req), b, deps.ai, { replace: b.replace }));
    await resetCharterRoom(req.user!.projectId!, r.doc);
    await audit(req, 'planning.charter.generate', { by: r.by });
    return reply.code(201).send(await state(req));
  });

  /** Plain save, for clients that are not in the live editor. The live editor saves itself on the collaboration server. */
  app.put('/api/planning/charter', gate, async (req) => {
    const b = z.object({ content: z.object({ type: z.literal('doc'), content: z.array(z.any()).max(5000).optional() }).passthrough() }).parse(req.body);
    if (JSON.stringify(b.content).length > 1_000_000) throw new DocError('The charter is too large', 413);
    const c = await getCharter(req.user!.projectId!);
    if (!c) throw new DocError('Generate or start a charter first', 404);
    if (c.status === 'Approved') throw new DocError('The charter is approved. Reopen it to edit.', 409);
    await storeCharterContent(req.user!.projectId!, b.content as never);
    await resetCharterRoom(req.user!.projectId!, b.content as never);
    return state(req);
  });

  app.post('/api/planning/charter/collab-token', gate, async (req) => {
    const c = await getCharter(req.user!.projectId!);
    if (!c) throw new DocError('There is no charter yet', 404);
    const u = req.user!, pid = u.projectId!;
    const edit = c.status === 'Draft';
    return { token: signCollab({ uid: u.id, name: u.name, pid, ticket: 'charter', kind: 'CHARTER', edit }), room: CHARTER_ROOM(pid), canEdit: edit, lock: edit ? null : 'The charter is approved. Reopen it to edit.' };
  });

  app.post('/api/planning/charter/approve', gate, async (req) => {
    await flushCharter(req.user!.projectId!);            // what people have just typed counts
    await approveCharter(actor(req));
    closeCharterRoom(req.user!.projectId!);
    await audit(req, 'planning.charter.approve', {});
    return state(req);
  });
  app.post('/api/planning/charter/reopen', gate, async (req) => {
    await reopenCharter(req.user!.projectId!);
    await audit(req, 'planning.charter.reopen', {});
    return state(req);
  });

  // ------------------------------------------------------------ WBS
  app.post('/api/planning/wbs/generate', gate, async (req, reply) => {
    const b = z.object({ replace: z.boolean().optional() }).parse(req.body ?? {});
    generating(req);
    await ai(() => generateWbs(actor(req), deps.ai, { replace: b.replace }));
    await audit(req, 'planning.wbs.generate', {});
    return reply.code(201).send(await state(req));
  });

  const Effort = z.number().min(0).max(100000).nullable();
  app.post('/api/planning/wbs', gate, async (req, reply) => {
    const b = z.object({ parentId: z.string().uuid().nullable(), title: z.string().trim().min(1).max(200), description: z.string().max(4000).optional(), effort: Effort.optional() }).parse(req.body);
    const id = await addElement(req.user!.projectId!, b);
    return reply.code(201).send({ id, wbs: await listWbs(req.user!.projectId!) });
  });
  app.patch('/api/planning/wbs/:id', gate, async (req) => {
    const { id } = Id.parse(req.params);
    const b = z.object({ title: z.string().trim().min(1).max(200).optional(), description: z.string().max(4000).optional(), effort: Effort.optional() }).strict().parse(req.body);
    await updateElement(req.user!.projectId!, id, b);
    return { wbs: await listWbs(req.user!.projectId!) };
  });
  app.post('/api/planning/wbs/:id/move', gate, async (req) => {
    const { id } = Id.parse(req.params);
    const b = z.object({ parentId: z.string().uuid().nullable(), index: z.number().int().min(0).max(10000) }).parse(req.body);
    await moveElement(req.user!.projectId!, id, b.parentId, b.index);
    return { wbs: await listWbs(req.user!.projectId!) };
  });
  app.delete('/api/planning/wbs/:id', gate, async (req) => {
    const { id } = Id.parse(req.params);
    await deleteElement(req.user!.projectId!, id);
    return { wbs: await listWbs(req.user!.projectId!) };
  });

  // ------------------------------------------------------------ conversion
  app.post('/api/planning/convert', gate, async (req, reply) => {
    if (!req.user!.perms.has('ticket.create')) return reply.code(403).send({ error: 'Your role cannot create tickets' });
    const b = z.object({ elementIds: z.array(z.string().uuid()).max(500).optional(), ticketTypeId: z.number().int().positive().optional(), fields: z.record(z.string(), z.unknown()).optional() }).parse(req.body ?? {});
    const r = await convertToTickets(actor(req), b);
    await audit(req, 'planning.convert', { count: r.created.length, type: r.type.name });
    return reply.code(201).send({ ...r, wbs: await listWbs(req.user!.projectId!) });
  });
}
