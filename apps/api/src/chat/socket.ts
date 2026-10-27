import type { Server as HttpServer } from 'node:http';
import { Server } from 'socket.io';
import { z } from 'zod';
import type { Observer } from './observer.js';
import { addMessage, canAccessConversation, getConversationProject, getDraft, getMessages, refreshDraft, verifyDraft, VerifyError } from './service.js';
import { userFromCookie, type SessionUser } from '../rbac/auth.js';
import { runWithContext } from '../db.js';

const Join = z.object({ conversationId: z.string().uuid() });
const Msg = z.object({ conversationId: z.string().uuid(), role: z.enum(['customer', 'consultant']).optional(), body: z.string().min(1).max(4000) });
type Ack = ((r: unknown) => void) | undefined;

export function attachChat(http: HttpServer, observer: Observer) {
  const io = new Server(http, { cors: { origin: true, credentials: true } });
  // Serialize observer runs per conversation so drafts never race.
  const chains = new Map<string, Promise<unknown>>();

  // Only signed-in users may connect.
  io.use(async (socket, next) => {
    const u = await userFromCookie(socket.handshake.headers.cookie);
    return u ? next() : next(new Error('Sign in required'));
  });

  io.on('connection', (socket) => {
    /**
     * Permissions AND the current project are re-read on every event (so role changes and project switches apply at once),
     * and the event body runs inside that project's database context, exactly like an HTTP request.
     */
    const on = (event: string, handler: (u: SessionUser, raw: unknown, ack: Ack) => Promise<void>) =>
      socket.on(event, async (raw: unknown, ack: Ack) => {
        const u = await userFromCookie(socket.handshake.headers.cookie);
        if (!u) return ack?.({ error: 'Invalid request' });
        await runWithContext({ projectId: u.projectId }, () => handler(u, raw, ack));
      });

    on('join', async (u, raw, ack) => {
      const p = Join.safeParse(raw);
      if (!p.success) return ack?.({ error: 'Invalid request' });
      if (!(await canAccessConversation(u, p.data.conversationId))) return ack?.({ error: 'Conversation not found' });
      await socket.join(p.data.conversationId);
      ack?.({ messages: await getMessages(p.data.conversationId), draft: await getDraft(p.data.conversationId), project: await getConversationProject(p.data.conversationId) });
    });

    on('message', async (u, raw, ack) => {
      const p = Msg.safeParse(raw);
      if (!p.success) return ack?.({ error: 'Invalid message' });
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

    on('verify', async (u, raw, ack) => {
      const p = Join.safeParse(raw);
      if (!p.success) return ack?.({ error: 'Invalid request' });
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
