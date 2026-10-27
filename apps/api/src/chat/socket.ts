import type { Server as HttpServer } from 'node:http';
import { Server } from 'socket.io';
import { z } from 'zod';
import type { Observer } from './observer.js';
import { addMessage, canAccessConversation, getDraft, getMessages, refreshDraft, verifyDraft, VerifyError } from './service.js';
import { loadUser, userFromCookie, verifySession, readCookie } from '../rbac/auth.js';

const Join = z.object({ conversationId: z.string().uuid() });
const Msg = z.object({ conversationId: z.string().uuid(), role: z.enum(['customer', 'consultant']).optional(), body: z.string().min(1).max(4000) });

export function attachChat(http: HttpServer, observer: Observer) {
  const io = new Server(http, { cors: { origin: true, credentials: true } });
  // Serialize observer runs per conversation so drafts never race.
  const chains = new Map<string, Promise<unknown>>();

  // Only signed-in users may connect.
  io.use(async (socket, next) => {
    const u = await userFromCookie(socket.handshake.headers.cookie);
    return u ? next() : next(new Error('Sign in required'));
  });

  /** Permissions are re-read on every event so a role change takes effect immediately. */
  const current = async (socket: { handshake: { headers: { cookie?: string } } }) => {
    const id = verifySession(readCookie(socket.handshake.headers.cookie));
    return id ? loadUser(id) : null;
  };

  io.on('connection', (socket) => {
    socket.on('join', async (raw, ack) => {
      const p = Join.safeParse(raw);
      const u = await current(socket);
      if (!p.success || !u) return ack?.({ error: 'Invalid request' });
      if (!(await canAccessConversation(u, p.data.conversationId))) return ack?.({ error: 'Conversation not found' });
      await socket.join(p.data.conversationId);
      ack?.({ messages: await getMessages(p.data.conversationId), draft: await getDraft(p.data.conversationId) });
    });

    socket.on('message', async (raw, ack) => {
      const p = Msg.safeParse(raw);
      const u = await current(socket);
      if (!p.success || !u) return ack?.({ error: 'Invalid message' });
      const { conversationId: cid, body } = p.data;
      if (!(await canAccessConversation(u, cid))) return ack?.({ error: 'Conversation not found' });
      const can = { customer: u.perms.has('chat.as_customer'), consultant: u.perms.has('chat.as_consultant') };
      const role = p.data.role ?? (can.customer ? 'customer' : 'consultant');
      if (!can[role]) return ack?.({ error: `Your role cannot send messages as ${role}` });
      io.to(cid).emit('message', await addMessage(cid, role, u.name, body));
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
      const u = await current(socket);
      if (!p.success || !u) return ack?.({ error: 'Invalid request' });
      if (!u.perms.has('chat.verify')) return ack?.({ error: 'Your role cannot verify requirements' });
      if (!(await canAccessConversation(u, p.data.conversationId))) return ack?.({ error: 'Conversation not found' });
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
