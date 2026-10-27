import Fastify from 'fastify';
import cors from '@fastify/cors';
import { z } from 'zod';
import { pool } from './db.js';
import { STATES } from './stateMachine.js';
import { createConversation, getDraft, getMessages } from './chat/service.js';
import { createTicket, transitionTicket, TransitionError } from './tickets.js';

export function buildApp() {
  const app = Fastify();
  app.register(cors, { origin: true });

  app.get('/health', async () => ({ ok: true }));
  app.get('/api/states', async () => STATES);

  app.get('/api/projects', async () => (await pool.query('SELECT * FROM projects ORDER BY created_at')).rows);
  app.post('/api/projects', async (req, reply) => {
    const b = z.object({ name: z.string().min(1) }).parse(req.body);
    const { rows } = await pool.query('INSERT INTO projects (name) VALUES ($1) RETURNING *', [b.name]);
    return reply.code(201).send(rows[0]);
  });

  app.get('/api/tickets', async () => (await pool.query('SELECT * FROM tickets ORDER BY created_at DESC')).rows);
  app.post('/api/tickets', async (req, reply) => {
    const b = z.object({ projectId: z.string().uuid(), title: z.string().min(1), aiSummary: z.string().optional() }).parse(req.body);
    return reply.code(201).send(await createTicket(b.projectId, b.title, b.aiSummary));
  });
  app.post('/api/tickets/:id/transition', async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const b = z.object({ to: z.enum(STATES) }).parse(req.body);
    try { return await transitionTicket(id, b.to); }
    catch (e) {
      if (e instanceof TransitionError) return reply.code(409).send({ error: e.message });
      throw e;
    }
  });

  app.post('/api/conversations', async (req, reply) => {
    const b = z.object({ projectId: z.string().uuid().optional(), title: z.string().optional() }).parse(req.body ?? {});
    let pid = b.projectId ?? (await pool.query('SELECT id FROM projects ORDER BY created_at LIMIT 1')).rows[0]?.id;
    pid ??= (await pool.query("INSERT INTO projects (name) VALUES ('Default') RETURNING id")).rows[0].id;
    return reply.code(201).send(await createConversation(pid, b.title));
  });
  app.get('/api/conversations/:id', async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    return { messages: await getMessages(id), draft: await getDraft(id) };
  });
  return app;
}
