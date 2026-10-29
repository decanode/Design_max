import type { Server as HttpServer } from 'node:http';
import { Server } from 'socket.io';
import { z } from 'zod';
import type { ChatAgent } from './agent.js';
import { addMessage, canAccessConversation, ensureGreeting, getConversation, getConversationProject, getDraft, getMessages, isConfirmation, runTurn, verifyDraft, VerifyError } from './service.js';
import { userFromCookie, type SessionUser } from '../rbac/auth.js';
import { runWithContext } from '../db.js';
import type { Embedder } from '../etl/vectorize.js';

const Join = z.object({ conversationId: z.string().uuid() });
const Msg = z.object({ conversationId: z.string().uuid(), role: z.enum(['customer', 'consultant']).optional(), body: z.string().min(1).max(4000) });
type Ack = ((r: unknown) => void) | undefined;

/**
 * Who a message is "from": the person who opened the conversation speaks as their own kind (a customer as a customer, everyone
 * else as a consultant); anyone else reading it speaks as a consultant (they are commenting, not asking the assistant).
 */
async function sendAs(u: SessionUser, cid: string): Promise<'customer' | 'consultant' | null> {
  const c = await getConversation(cid);
  const can = { customer: u.perms.has('chat.as_customer'), consultant: u.perms.has('chat.as_consultant') };
  if (c?.opened_by === u.id) return c.persona === 'customer' ? (can.customer ? 'customer' : null) : (can.consultant ? 'consultant' : can.customer ? 'customer' : null);
  return can.consultant ? 'consultant' : can.customer ? 'customer' : null;
}

export function attachChat(http: HttpServer, agent: ChatAgent, embedder?: Embedder) {
  const io = new Server(http, { cors: { origin: true, credentials: true } });
  // Serialize the assistant's turns per conversation so each reply sees the whole conversation so far.
  const chains = new Map<string, Promise<unknown>>();

  io.use(async (socket, next) => {
    const u = await userFromCookie(socket.handshake.headers.cookie);
    return u ? next() : next(new Error('Sign in required'));
  });

  io.on('connection', (socket) => {
    /** Permissions AND the current project are re-read on every event, and the body runs in that project's database context. */
    const on = (event: string, handler: (u: SessionUser, raw: unknown, ack: Ack) => Promise<void>) =>
      socket.on(event, async (raw: unknown, ack: Ack) => {
        const u = await userFromCookie(socket.handshake.headers.cookie);
        if (!u) return ack?.({ error: 'Invalid request' });
        await runWithContext({ projectId: u.projectId }, () => handler(u, raw, ack));
      });

    /** Creates the ticket the person confirmed and tells the room. Shared by the button and by a typed "yes". */
    async function confirmTicket(u: SessionUser, cid: string) {
      const r = await verifyDraft(cid);
      if (r.created) {
        const msg = await addMessage(cid, 'assistant', 'Design Max', `Done. I created the ${'typeName' in r ? r.typeName : 'ticket'} **${r.draft.title}**. ${'approval' in r && r.approval ? `It needs approval first (workflow “${r.approval.workflow}”): the approvers have been notified, and work starts once they sign off. You can follow it on the board.` : 'You can follow it on the board; the team will pick it up from there.'} Is there anything else I can help with?`);
        io.to(cid).emit('message', msg);
        io.to(cid).emit('verified', { draft: r.draft, ticketId: r.ticketId });
        io.to(cid).emit('conversation', await getConversation(cid));
      }
      return r;
    }

    on('join', async (u, raw, ack) => {
      const p = Join.safeParse(raw);
      if (!p.success) return ack?.({ error: 'Invalid request' });
      if (!(await canAccessConversation(u, p.data.conversationId))) return ack?.({ error: 'Conversation not found' });
      await ensureGreeting(p.data.conversationId, u.id, u.name);
      await socket.join(p.data.conversationId);
      ack?.({ messages: await getMessages(p.data.conversationId), draft: await getDraft(p.data.conversationId), project: await getConversationProject(p.data.conversationId), sendAs: await sendAs(u, p.data.conversationId), conversation: await getConversation(p.data.conversationId) });
    });

    on('message', async (u, raw, ack) => {
      const p = Msg.safeParse(raw);
      if (!p.success) return ack?.({ error: 'Invalid message' });
      const { conversationId: cid, body } = p.data;
      if (!(await canAccessConversation(u, cid))) return ack?.({ error: 'Conversation not found' });
      const can = { customer: u.perms.has('chat.as_customer'), consultant: u.perms.has('chat.as_consultant') };
      const role = p.data.role ?? (await sendAs(u, cid));      // detected from the person and the conversation; an explicit role is only honoured if allowed
      if (!role || !can[role]) return ack?.({ error: 'Your role cannot send messages in this conversation' });
      io.to(cid).emit('message', await addMessage(cid, role, u.name, body));
      ack?.({ ok: true });

      const conv = await getConversation(cid);
      if (!conv || conv.opened_by !== u.id) return;         // others reading along are commenting; the assistant answers the person who asked
      const draft = await getDraft(cid);
      const run = (chains.get(cid) ?? Promise.resolve()).then(() => runWithContext({ projectId: u.projectId }, async () => {
        try {
          if (draft?.status === 'verified') {
            io.to(cid).emit('message', await addMessage(cid, 'assistant', 'Design Max', 'This conversation already produced a ticket. Please start a new conversation for something else, so each request stays on its own.'));
            return;
          }
          // The full scope is on the table and the person just said yes: that is the confirmation.
          if (draft?.ready && isConfirmation(body) && u.perms.has('chat.verify')) { await confirmTicket(u, cid); return; }
          io.to(cid).emit('assistant:working');
          const r = await runTurn(cid, agent, embedder);
          if (!r) return;
          io.to(cid).emit('message', r.message);
          if (r.draft) io.to(cid).emit('draft', r.draft);
          io.to(cid).emit('conversation', r.conversation);
        } catch (e) {
          console.error(e);
          io.to(cid).emit('assistant:error', { error: 'The assistant could not answer' });
          io.to(cid).emit('message', await addMessage(cid, 'assistant', 'Design Max', 'I could not answer that just now, and I am sorry. Your message is saved. Please send it again in a moment.'));
        }
      }));
      chains.set(cid, run);
    });

    on('verify', async (u, raw, ack) => {
      const p = Join.safeParse(raw);
      if (!p.success) return ack?.({ error: 'Invalid request' });
      if (!u.perms.has('chat.verify')) return ack?.({ error: 'Your role cannot confirm tickets' });
      if (!(await canAccessConversation(u, p.data.conversationId))) return ack?.({ error: 'Conversation not found' });
      try {
        await chains.get(p.data.conversationId);               // let the latest answer land first
        const r = await confirmTicket(u, p.data.conversationId);
        ack?.({ ok: true, ticketId: r.ticketId });
      } catch (e) {
        ack?.({ error: e instanceof VerifyError ? e.message : 'Could not create the ticket' });
      }
    });
  });
  return io;
}
