import type { Server as HttpServer } from 'node:http';
import { Server } from 'socket.io';
import { z } from 'zod';
import type { Observer } from './observer.js';
import { addMessage, getDraft, getMessages, refreshDraft, verifyDraft, VerifyError } from './service.js';

const Join = z.object({ conversationId: z.string().uuid() });
const Msg = z.object({ conversationId: z.string().uuid(), role: z.enum(['customer', 'consultant']), name: z.string().min(1).max(80), body: z.string().min(1).max(4000) });

export function attachChat(http: HttpServer, observer: Observer) {
  const io = new Server(http, { cors: { origin: true } });
  // Serialize observer runs per conversation so drafts never race.
  const chains = new Map<string, Promise<unknown>>();

  io.on('connection', (socket) => {
    socket.on('join', async (raw, ack) => {
      const p = Join.safeParse(raw);
      if (!p.success) return ack?.({ error: 'Invalid conversation id' });
      await socket.join(p.data.conversationId);
      ack?.({ messages: await getMessages(p.data.conversationId), draft: await getDraft(p.data.conversationId) });
    });

    socket.on('message', async (raw, ack) => {
      const p = Msg.safeParse(raw);
      if (!p.success) return ack?.({ error: 'Invalid message' });
      const { conversationId: cid, role, name, body } = p.data;
      io.to(cid).emit('message', await addMessage(cid, role, name, body));
      ack?.({ ok: true });
      if (role !== 'customer') return;
      const run = (chains.get(cid) ?? Promise.resolve()).then(async () => {
        try { const d = await refreshDraft(cid, observer); if (d) io.to(cid).emit('draft', d); }
        catch (e) { io.to(cid).emit('observer:error', { error: 'Draft update failed' }); console.error(e); }
      });
      chains.set(cid, run);
    });

    socket.on('verify', async (raw, ack) => {
      const p = Join.safeParse(raw);
      if (!p.success) return ack?.({ error: 'Invalid conversation id' });
      try {
        await chains.get(p.data.conversationId); // let the latest draft land first
        const r = await verifyDraft(p.data.conversationId);
        if (r.created) io.to(p.data.conversationId).emit('verified', { draft: r.draft, ticketId: r.ticketId });
        ack?.({ ok: true, ticketId: r.ticketId });
      } catch (e) {
        ack?.({ error: e instanceof VerifyError ? e.message : 'Verification failed' });
      }
    });
  });
  return io;
}
