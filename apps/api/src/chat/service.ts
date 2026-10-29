import { pool } from '../db.js';
import { assessFit, loadStackPolicy } from '../stacks.js';
import { similar, type Embedder } from '../etl/vectorize.js';
import { DocError } from '../errors.js';
import { loadWorkflow, typeFields, validateMetadata, type TypeField } from '../workflow/service.js';
import type { ChatAgent, ChatMessage, Turn } from './agent.js';
import { greeting, type Intent, type Persona, type PromptContext, type Stage, type TicketTypeBrief } from './prompts.js';

type Who = { id: string; perms: Set<string>; projectId: string | null };

/** A customer is anyone whose role cannot act as a consultant; everyone else (consultants, leads, project managers, admins) is the team. */
export const personaOf = (perms: Set<string>): Persona => (perms.has('chat.as_consultant') ? 'team' : 'customer');

/**
 * Opens a conversation: the assistant greets the person and asks what they want to do. `owner` is the person (with the persona
 * their role implies); a bare user id is accepted too and means a customer.
 */
export async function createConversation(projectId: string, title?: string, owner?: string | { id: string; persona: Persona; name: string } | null) {
  let o: { id: string; persona: Persona; name: string } | null = null;
  if (typeof owner === 'string') o = { id: owner, persona: 'customer', name: (await pool.query('SELECT display_name FROM users WHERE id=$1', [owner])).rows[0]?.display_name ?? '' };
  else if (owner) o = owner;
  const { rows } = await pool.query(
    `INSERT INTO conversations (project_id, title, customer_id, opened_by, persona, stage) VALUES ($1,$2,$3,$4,$5,'greeting') RETURNING *`,
    [projectId, title ?? null, o?.persona === 'customer' ? o.id : null, o?.id ?? null, o?.persona ?? 'customer']);
  const conv = rows[0];
  if (o) {
    const g = greeting(o.persona, o.name.split(' ')[0] ?? '');
    await addMessage(conv.id, 'assistant', 'Design Max', g.text);
    await pool.query('UPDATE conversations SET suggestions=$2 WHERE id=$1', [conv.id, JSON.stringify(g.quickReplies)]);
  }
  return (await getConversation(conv.id))!;
}

/** Chats opened before the assistant existed (or whose greeting failed) are empty: greet the person who opened them, once. */
export async function ensureGreeting(conversationId: string, userId: string, name: string) {
  const c = await getConversation(conversationId);
  if (!c || c.opened_by !== userId || c.stage === 'done') return;
  const has = (await pool.query('SELECT 1 FROM messages WHERE conversation_id=$1 LIMIT 1', [conversationId])).rowCount;
  if (has) return;
  const g = greeting(c.persona, name.split(' ')[0] ?? '');
  await addMessage(conversationId, 'assistant', 'Design Max', g.text);
  await pool.query(`UPDATE conversations SET suggestions=$2, stage='greeting' WHERE id=$1`, [conversationId, JSON.stringify(g.quickReplies)]);
}

export async function getConversation(id: string) {
  return (await pool.query('SELECT id, project_id, customer_id, opened_by, persona, intent, stage, outcome, suggestions, created_at FROM conversations WHERE id=$1', [id])).rows[0] ?? null;
}

/** A person may open a conversation they started, or any in the project if their role can see all of them. */
export async function canAccessConversation(u: Who, conversationId: string) {
  const c = (await pool.query('SELECT customer_id, opened_by, project_id FROM conversations WHERE id=$1', [conversationId])).rows[0];
  if (!c || c.project_id !== u.projectId) return false;                       // other projects' conversations do not exist for you
  return u.perms.has('chat.view_all') || c.customer_id === u.id || c.opened_by === u.id;
}

export async function listConversations(u: Who) {
  const all = u.perms.has('chat.view_all');
  return (await pool.query(
    `SELECT c.id, c.created_at, c.customer_id, c.opened_by, c.persona, c.stage, c.outcome, COALESCE(op.display_name, cu.display_name) AS customer, pr.name AS project, d.title AS draft_title, d.status AS draft_status,
            (SELECT body FROM messages m WHERE m.conversation_id = c.id AND m.sender_role <> 'assistant' ORDER BY m.id DESC LIMIT 1) AS last_message,
            COALESCE((SELECT max(created_at) FROM messages m WHERE m.conversation_id = c.id), c.created_at) AS last_at
     FROM conversations c LEFT JOIN users cu ON cu.id = c.customer_id LEFT JOIN users op ON op.id = c.opened_by LEFT JOIN requirement_drafts d ON d.conversation_id = c.id JOIN projects pr ON pr.id = c.project_id
     WHERE c.project_id = $3 AND ($1 OR c.customer_id = $2 OR c.opened_by = $2) ORDER BY last_at DESC LIMIT 100`, [all, u.id, u.projectId])).rows;
}

export async function getMessages(conversationId: string) {
  return (await pool.query('SELECT id, sender_role, sender_name, body, created_at FROM messages WHERE conversation_id=$1 ORDER BY id', [conversationId])).rows;
}
export async function getConversationProject(conversationId: string) {
  return (await pool.query(
    `SELECT p.id, p.name, COALESCE((SELECT array_agg(s.name ORDER BY s.name) FROM project_stacks ps JOIN tech_stacks s ON s.id=ps.stack_id WHERE ps.project_id=p.id), '{}') AS stacks
     FROM conversations c JOIN projects p ON p.id=c.project_id WHERE c.id=$1`, [conversationId])).rows[0] ?? null;
}
export async function getDraft(conversationId: string) {
  return (await pool.query('SELECT * FROM requirement_drafts WHERE conversation_id=$1', [conversationId])).rows[0] ?? null;
}
export async function conversationOwner(conversationId: string) {
  return (await pool.query('SELECT opened_by, customer_id FROM conversations WHERE id=$1', [conversationId])).rows[0] as { opened_by: string | null; customer_id: string | null } | undefined;
}
export async function addMessage(conversationId: string, role: ChatMessage['role'], name: string, body: string) {
  return (await pool.query('INSERT INTO messages (conversation_id, sender_role, sender_name, body) VALUES ($1,$2,$3,$4) RETURNING id, sender_role, sender_name, body, created_at', [conversationId, role, name, body])).rows[0];
}

/* ------------------------------------------------------------------ one turn of the assistant */
const brief = (t: { key: string; name: string; description: string; fields: TypeField[] }): TicketTypeBrief => ({ key: t.key, name: t.name, description: t.description, fields: t.fields.map((f) => ({ key: f.key, label: f.label, kind: f.kind, options: f.options, required: f.required })) });

/** Required fields of the chosen ticket type that the conversation has not yet supplied with a usable value. */
export function missingFields(defs: TypeField[], values: Record<string, unknown>): string[] {
  const ok = (f: TypeField) => { const v = values[f.key]; if (v === undefined || v === null || String(v).trim() === '') return false; return f.kind === 'select' ? f.options.includes(String(v)) : true; };
  return defs.filter((f) => f.required && f.kind !== 'checkbox' && !ok(f)).map((f) => f.label);
}

export interface TurnResult { message: Awaited<ReturnType<typeof addMessage>>; draft: any; conversation: NonNullable<Awaited<ReturnType<typeof getConversation>>> }

/**
 * Lets the assistant answer the person's latest message. What it says is checked before it is kept: the ticket type must be one the project
 * accepts, the fields are cleaned against that type, "ready" is only true when the scope has been shown and nothing required is missing,
 * and a request outside the project's technology can never become ready.
 */
export async function runTurn(conversationId: string, agent: ChatAgent, embedder?: Embedder): Promise<TurnResult | null> {
  const conv = await getConversation(conversationId);
  if (!conv) return null;
  const draft = await getDraft(conversationId);
  if (draft?.status === 'verified') return null;
  const history = (await getMessages(conversationId)).map((m): ChatMessage => ({ role: m.sender_role, name: m.sender_name, body: m.body }));
  const opener = conv.opened_by ? (await pool.query('SELECT display_name FROM users WHERE id=$1', [conv.opened_by])).rows[0]?.display_name as string : 'there';
  const project = (await getConversationProject(conversationId))!;
  const policy = await loadStackPolicy(project.id);
  const wf = await loadWorkflow(project.id);
  const types = wf.ticketTypes.filter((t) => t.enabled);
  const defaultType = types.find((t) => t.isDefault) ?? types[0];

  let knowledge: string[] | undefined;
  const userText = history.filter((m) => m.role === 'customer' || m.role === 'consultant').map((m) => m.body).join('\n');
  if (embedder?.semantic && userText.trim()) {      // similar past tickets, only meaningful with a real embedding model
    try { knowledge = (await similar(pool, embedder, userText.slice(-1500), 4, policy?.allowed.map((a) => a.name), project.id)).map((h) => `[${h.source_type}] ${h.source_ref}: ${String(h.content).slice(0, 500)}`); } catch { /* the assistant works without it */ }
  }
  const ctx: PromptContext = {
    persona: conv.persona, userName: opener, projectName: project.name, policy, ticketTypes: types.map(brief), knowledge,
    state: { stage: conv.stage as Stage, intent: (conv.intent as Intent | null), deliverable: draft?.deliverable, scopeMarkdown: draft?.scope_md ?? null, ticket: draft?.ticket_type_key ? { typeKey: draft.ticket_type_key, title: draft.title, fields: draft.ticket_fields ?? {} } : null },
  };
  const turn: Turn = await agent.turn(history, ctx);

  // ---- checks on what the assistant proposed
  const type = types.find((t) => t.key === turn.ticket?.typeKey) ?? (turn.ticket ? defaultType : undefined);
  const defs = type?.fields ?? [];
  const known = new Set(defs.map((f) => f.key));
  const fields = Object.fromEntries(Object.entries(turn.ticket?.fields ?? {}).filter(([k, v]) => known.has(k) && String(v).trim() !== ''));
  const missing = type && turn.deliverable !== 'solution' ? missingFields(defs, fields) : [];
  const check = assessFit(userText, policy);
  const stackFit = turn.stackFit === 'in_scope' && check.fit !== 'in_scope' ? (check.fit === 'out_of_scope' ? 'unclear' : check.fit) : turn.stackFit;
  const stackNote = turn.stackNote || (stackFit !== 'in_scope' ? check.note : '');
  const ready = turn.ready && turn.stage === 'confirm' && !!turn.scope && !!type && turn.deliverable !== 'solution' && missing.length === 0 && stackFit !== 'out_of_scope';

  const message = await addMessage(conversationId, 'assistant', 'Design Max', turn.reply);
  const outcome = turn.outcome ?? conv.outcome ?? null;
  await pool.query('UPDATE conversations SET intent=$2, stage=$3, outcome=$4, suggestions=$5 WHERE id=$1', [conversationId, turn.intent, turn.stage, outcome, JSON.stringify(turn.quickReplies)]);

  let saved = draft;
  if (turn.scope || turn.ticket) {
    const scope = turn.scope?.markdown ?? draft?.scope_md ?? turn.reply;
    const title = (type && turn.ticket?.title) || turn.scope?.title || draft?.title || 'New request';
    saved = (await pool.query(
      `INSERT INTO requirement_drafts (conversation_id, title, summary, scope_md, entities, stack_fit, stack_note, ticket_type_key, ticket_fields, ready, missing, deliverable)
       VALUES ($1,$2,$3,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (conversation_id) DO UPDATE SET title=$2, summary=$3, scope_md=$3, entities=$4, stack_fit=$5, stack_note=$6, ticket_type_key=$7, ticket_fields=$8, ready=$9, missing=$10, deliverable=$11, updated_at=now()
       WHERE requirement_drafts.status='draft' RETURNING *`,
      [conversationId, title.slice(0, 160), scope, JSON.stringify(turn.entities), stackFit, stackNote, type?.key ?? null, JSON.stringify(fields), ready, JSON.stringify(missing), turn.deliverable])).rows[0] ?? draft;
  }
  return { message, draft: saved, conversation: (await getConversation(conversationId))! };
}

/* ------------------------------------------------------------------ confirming: the only way a ticket is created */
export class VerifyError extends Error {}

/** Creates the ticket the person confirmed, exactly once (the row lock makes double clicks safe). */
export async function verifyDraft(conversationId: string) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const d = (await client.query('SELECT * FROM requirement_drafts WHERE conversation_id=$1 FOR UPDATE', [conversationId])).rows[0];
    if (!d) throw new VerifyError('Nothing to verify yet');
    if (d.status === 'verified') { await client.query('COMMIT'); return { draft: d, ticketId: d.ticket_id as string, created: false }; }
    if (d.stack_fit === 'out_of_scope') throw new VerifyError(d.stack_note || 'This request is outside the project\'s allowed technology. Rephrase it, or raise it in the right project.');
    if (!d.ready) throw new VerifyError(d.missing?.length ? `The ticket still needs: ${(d.missing as string[]).join(', ')}. Keep chatting and I will ask for it.` : 'The scope is not final yet. Keep chatting until I have shown you the full scope and asked you to confirm it.');
    const conv = (await client.query('SELECT project_id, customer_id, opened_by, persona FROM conversations WHERE id=$1', [conversationId])).rows[0];
    const wf = await loadWorkflow(conv.project_id, client);
    const types = wf.ticketTypes.filter((t) => t.enabled);
    const type = types.find((t) => t.key === d.ticket_type_key) ?? types.find((t) => t.isDefault) ?? types[0];
    if (!type) throw new VerifyError('This project has no ticket types switched on. Ask a Project Admin to set up the template.');
    let meta: Record<string, unknown>;
    try { meta = validateMetadata((await typeFields(client)).get(type.id) ?? [], d.ticket_fields ?? {}); }
    catch (e) { throw new VerifyError(e instanceof DocError ? `The ticket still needs details: ${Object.values((e.extra as { fieldErrors?: Record<string, string> })?.fieldErrors ?? {}).join('; ') || e.message}` : 'The ticket details are incomplete'); }
    // A customer's request belongs to the customer; a team member's ticket starts with that team member.
    const t = await client.query(
      'INSERT INTO tickets (project_id, title, ai_summary, customer_id, consultant_id, ticket_type_id, dynamic_metadata) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id',
      [conv.project_id, d.title, d.scope_md ?? d.summary, conv.persona === 'customer' ? conv.customer_id : null, conv.persona === 'team' ? conv.opened_by : null, type.id, JSON.stringify(meta)]);
    const upd = await client.query(`UPDATE requirement_drafts SET status='verified', ticket_id=$2, updated_at=now() WHERE conversation_id=$1 RETURNING *`, [conversationId, t.rows[0].id]);
    await client.query(`UPDATE conversations SET stage='done', outcome='ticket_created', suggestions='[]' WHERE id=$1`, [conversationId]);
    await client.query('COMMIT');
    return { draft: upd.rows[0], ticketId: t.rows[0].id as string, created: true, typeName: type.name as string };
  } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
}

/** A short, unambiguous "yes" typed while the full scope is on the table counts as the confirmation. */
export const isConfirmation = (body: string) => body.trim().length <= 40 && /^(yes|yep|yeah|y|yes please|sure|ok|okay|go ahead|do it|please do|create( it| the ticket)?|confirm(ed)?|yes,? (create|go ahead|confirm)\b.*)[.!\s]*$/i.test(body.trim());
