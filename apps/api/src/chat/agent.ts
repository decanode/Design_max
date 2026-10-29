import { z } from 'zod';
import { assessFit } from '../stacks.js';
import type { LlmClient } from './llm.js';
import { INTENTS, buildSystemPrompt, type Intent, type PromptContext, type Stage } from './prompts.js';

export interface ChatMessage { role: 'customer' | 'consultant' | 'assistant' | 'system'; name: string; body: string }

/** One reply from the assistant, plus how the conversation has moved. The application decides what to do with it; the assistant cannot create anything itself. */
export const TurnSchema = z.object({
  reply: z.string().trim().min(1).max(12000),
  intent: z.enum(INTENTS).catch('unknown'),
  stage: z.enum(['discovery', 'self_help', 'scoping', 'confirm', 'done']).catch('discovery'),
  deliverable: z.enum(['ticket', 'solution', 'undecided']).catch('undecided'),
  quickReplies: z.array(z.string().trim().min(1).max(60)).max(6).catch([]).transform((a) => a.slice(0, 4)),
  scope: z.object({ title: z.string().trim().min(1).max(160), markdown: z.string().trim().min(1).max(20000) }).nullable().catch(null),
  ticket: z.object({ typeKey: z.string().max(60), title: z.string().trim().min(1).max(160), fields: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).catch({}) }).nullable().catch(null),
  ready: z.boolean().catch(false),
  missing: z.array(z.string().max(80)).max(20).catch([]),
  outcome: z.enum(['self_resolved', 'solution_given']).nullable().catch(null),
  stackFit: z.enum(['in_scope', 'unclear', 'out_of_scope']).catch('in_scope'),
  stackNote: z.string().max(600).catch(''),
  entities: z.object({ businessObjects: z.array(z.string()).default([]), vendors: z.array(z.string()).default([]), materialTypes: z.array(z.string()).default([]) }).catch({ businessObjects: [], vendors: [], materialTypes: [] }),
});
export type Turn = z.infer<typeof TurnSchema>;

export interface ChatAgent { readonly name: string; turn(history: ChatMessage[], ctx: PromptContext): Promise<Turn> }

const label = (m: ChatMessage, ctx: PromptContext) => (m.role === 'assistant' ? 'Assistant' : m.role === 'system' ? 'Note' : m.role === 'customer' ? `${m.name} (customer)` : `${m.name} (team member)`) + (m.role === 'assistant' ? '' : '');
/** The conversation as text. The person's words sit inside a tag the system prompt calls data; a closing tag typed into them cannot end it early. */
export function transcript(history: ChatMessage[], ctx: PromptContext, max = 40): string {
  const lines = history.slice(-max).map((m) => `${label(m, ctx)}: ${m.body.replace(/<\/?conversation>/gi, '')}`);
  return `<conversation>\n${lines.join('\n\n')}\n</conversation>\n\nWrite the assistant's next reply to the last message, as the JSON object described.`;
}

/** Pulls the JSON object out of whatever the model returned, even if it wrapped it in a fence or a sentence. */
export function extractJson(text: string): unknown {
  const a = text.indexOf('{'), b = text.lastIndexOf('}');
  if (a < 0 || b <= a) throw new Error('no JSON object in the reply');
  return JSON.parse(text.slice(a, b + 1));
}

/** The language-model assistant: layered system prompts, JSON out, validated, one corrective retry. */
export class LlmChatAgent implements ChatAgent {
  readonly name = 'llm';
  constructor(private llm: LlmClient) {}
  async turn(history: ChatMessage[], ctx: PromptContext): Promise<Turn> {
    const system = buildSystemPrompt(ctx);
    let user = transcript(history, ctx), problem = '';
    for (let i = 0; i < 2; i++) {
      const raw = await this.llm.complete(system, user);
      try {
        const parsed = TurnSchema.safeParse(extractJson(raw));
        if (parsed.success) return parsed.data;
        problem = parsed.error.issues.slice(0, 4).map((x) => `${x.path.join('.') || 'reply'}: ${x.message}`).join('; ');
      } catch {
        // A model that answered in prose instead of JSON still said something useful: keep it rather than fail the person.
        const prose = raw.trim();
        if (i === 1 && prose && !prose.startsWith('{')) return TurnSchema.parse({ reply: prose.slice(0, 12000) });
        problem = 'the reply was not a JSON object';
      }
      user = `${transcript(history, ctx)}\n\nYour previous reply was rejected because ${problem}. Reply again with ONLY the JSON object.`;
    }
    throw new Error('The assistant returned an unusable reply');
  }
}

/* ====================================================================================================== scripted stand-in */
const text = (history: ChatMessage[]) => history.filter((m) => m.role === 'customer' || m.role === 'consultant');
const CHIP_INTENT: Record<string, Intent> = {
  'report a problem': 'incident', 'ask how something works': 'how_to', 'request a change or new feature': 'request', 'check on an earlier request': 'status',
  'scope a new requirement': 'requirement', 'design a solution or logic': 'implementation', 'troubleshoot an issue': 'analysis', 'prepare a ticket': 'requirement',
};
const YES = /^(yes|yep|yeah|y|sure|ok|okay|please|go ahead|do it|create( it| the ticket)?|confirm(ed)?)\b/i;

export function detectIntent(msg: string, persona: 'customer' | 'team'): Intent {
  const m = msg.toLowerCase().trim();
  if (CHIP_INTENT[m]) return CHIP_INTENT[m];
  if (/(status|any update|earlier request|already raised|my ticket|what happened to)/.test(m)) return 'status';
  if (/(error|not working|doesn'?t work|isn'?t working|broken|fail|crash|stuck|can'?t|cannot|unable|wrong|missing|incident)/.test(m)) return persona === 'customer' ? 'incident' : 'analysis';
  if (persona === 'team' && /(design|logic|implement|approach|solution|how (do|should|would) (i|we))/.test(m)) return 'implementation';
  if (/^(how|where|what|why|can i|is there|which)\b/.test(m)) return 'how_to';
  if (/(need|want|require|add|create|build|enhance|change|block|new |automate)/.test(m)) return persona === 'team' ? 'requirement' : 'request';
  return 'unknown';
}

const OBJECTS = ['purchase order', 'sales order', 'invoice', 'material master', 'vendor master', 'delivery', 'goods receipt', 'report'];
const MATERIALS = ['raw material', 'finished good', 'semifinished', 'trading good', 'service'];
const entitiesOf = (t: string) => ({ businessObjects: OBJECTS.filter((o) => t.toLowerCase().includes(o)), vendors: [...new Set([...t.matchAll(/\bvendor\s+([A-Z][\w&-]+)/g)].map((m) => m[1]))], materialTypes: MATERIALS.filter((o) => t.toLowerCase().includes(o)) });
const firstLine = (t: string, n = 100) => t.split(/[.!?\n]/)[0].trim().slice(0, n) || t.slice(0, n);

/**
 * A deterministic stand-in for when no language model is configured. It follows the same conversation shape (greet, find out,
 * offer self-help for simple incidents, probe, show the full scope, ask to confirm) with fixed questions. It organises what the
 * person said and invents nothing; it is far less capable than the real assistant, and says so when asked something it cannot answer.
 */
export class ScriptedChatAgent implements ChatAgent {
  readonly name = 'scripted';
  async turn(history: ChatMessage[], ctx: PromptContext): Promise<Turn> {
    const users = text(history);
    const last = users[users.length - 1]?.body.trim() ?? '';
    const lower = last.toLowerCase();
    const prevState = ctx.state;
    const all = users.map((m) => m.body).join(' ');
    const fit = assessFit(all, ctx.policy);
    const base = { stackFit: fit.fit, stackNote: fit.note, entities: entitiesOf(all) };
    const out = (o: Partial<Turn> & { reply: string }): Turn => TurnSchema.parse({ intent: prevState.intent ?? 'unknown', stage: 'discovery', deliverable: prevState.deliverable ?? 'undecided', quickReplies: [], scope: prevState.scopeMarkdown ? { title: prevState.ticket?.title ?? 'Scope', markdown: prevState.scopeMarkdown } : null, ticket: prevState.ticket ?? null, ready: false, missing: [], outcome: null, ...base, ...o });

    // The first thing a person says: a quick reply (which names the goal) or free text.
    let intent: Intent = prevState.intent && prevState.intent !== 'unknown' ? prevState.intent : detectIntent(last, ctx.persona);
    const chip = CHIP_INTENT[lower];
    const detailMessages = users.filter((m) => !CHIP_INTENT[m.body.trim().toLowerCase()] && !/^(let me try that first|raise the incident now|it worked, thanks|still not working|create a ticket|the outline is enough|yes, raise a request|no thanks)$/i.test(m.body.trim()));

    if (prevState.stage === 'done') return out({ reply: 'We are all done here. Start a new conversation whenever you need something else.', stage: 'done' });

    // ---- answers to the choices we offered
    if (prevState.stage === 'self_help') {
      if (/(it worked|worked|fixed|resolved|sorted|all good|that did it)/i.test(last) && !/not|didn'?t|still/i.test(last))
        return out({ reply: 'Wonderful, glad that sorted it. I have not raised anything, so there is nothing more to do. Come back any time.', stage: 'done', outcome: 'self_resolved', intent: 'incident' });
      if (/(try (that )?first|let me try|i'?ll try)/i.test(last)) return out({ reply: 'Great, give those steps a go and tell me how it went. I will be here.', stage: 'self_help', quickReplies: ['It worked, thanks', 'Still not working', 'Raise the incident now'], intent: 'incident' });
      // still broken, or they want to raise it: capture the incident
      return out({ reply: 'No problem, let us raise it properly. Two quick things so the right people can act on it:\n\n1. **How urgent is it for you?** (critical, high, medium or low)\n2. **How many people are affected?** (just you, your team, everyone)', stage: 'scoping', intent: 'incident', deliverable: 'ticket', quickReplies: ['High, my whole team', 'Medium, just me', 'Critical, everyone'] });
    }
    if (prevState.stage === 'scoping' && intent === 'how_to' && /^(yes, raise a request)$/i.test(last)) intent = 'request';
    if (intent === 'how_to' && /^no thanks$/i.test(last)) return out({ reply: 'Understood. Ask me anything else whenever you like.', stage: 'done', outcome: 'solution_given' });
    if (ctx.persona === 'team' && /^the outline is enough$/i.test(last)) return out({ reply: 'Good. Nothing has been raised. If you want this as a ticket later, just say so.', stage: 'done', outcome: 'solution_given', deliverable: 'solution' });
    if (ctx.persona === 'team' && /^create a ticket$/i.test(last)) return this.present(ctx, detailMessages, intent, out, base);

    // ---- opening up: the goal is not clear yet
    if (!detailMessages.length || (chip && detailMessages.length === 0)) {
      const asks: Record<string, string> = {
        incident: 'I am sorry you are stuck. Tell me what happened: **what were you trying to do, and what did you see instead?** If there was a message, please copy it exactly.',
        how_to: 'Happy to help. **What would you like to know how to do?**',
        request: 'Tell me what you need. **What are you trying to achieve, and why does it matter?**',
        change: 'Tell me what you need. **What are you trying to achieve, and why does it matter?**',
        status: 'Which request do you mean? Give me its title or a few words about it, and I will point you to it.',
        requirement: 'Let us scope it. **What is the business need behind this, and how will you know it worked?**',
        implementation: 'Let us design it. **What exactly needs to happen, and in which objects or programs?**',
        analysis: 'Let us dig in. **What is happening, where, and since when?** Anything you have tried already?',
      };
      return out({ reply: asks[intent] ?? 'Tell me a little more about what you would like to do.', intent, stage: 'discovery', quickReplies: [] });
    }

    // ---- customer, incident
    if (ctx.persona === 'customer' && intent === 'incident') {
      if (detailMessages.length === 1) {
        const steps = '1. **Check your selections.** Make sure the filters, dates and variant you used are the ones you meant, and try again with a wider selection.\n2. **Refresh.** Close the screen, sign out and back in, and repeat the steps.\n3. **Look for an authorisation message.** If you saw one, tell me exactly what it says.';
        return out({ reply: `Thanks, that helps. Some problems like this clear up with a few simple checks, which could save you the wait:\n\n${steps}\n\n**Would you like to try these first, or shall I raise an incident right away?**`, intent: 'incident', stage: 'self_help', deliverable: 'ticket', quickReplies: ['Let me try that first', 'Raise the incident now'] });
      }
      return this.present(ctx, detailMessages, intent, out, base);
    }

    // ---- how to (the stand-in cannot answer real questions)
    if (intent === 'how_to') return out({ reply: 'I cannot answer that reliably without the AI service, and I would rather not guess. **Would you like me to raise it as a request so a consultant can answer it?**', intent, stage: 'scoping', quickReplies: ['Yes, raise a request', 'No thanks'] });
    if (intent === 'status') return out({ reply: 'You can follow everything you have raised on the **Board**: open the request and you will see where it is and who is working on it.', intent, stage: 'done', outcome: 'solution_given' });

    // ---- requests and requirements
    if (detailMessages.length === 1) {
      const qs = ctx.persona === 'team'
        ? '1. **What does success look like**, and who signs it off?\n2. **Which objects, programs or interfaces** are involved, and what data volumes?\n3. **Edge cases and constraints:** authorisations, timing, error handling, anything that must not break?'
        : '1. **Who is affected**, and how do they do this today?\n2. **What would a good result look like** for you?\n3. **Is there a deadline** or a moment it must be ready by?';
      return out({ reply: `Thanks, I have the idea. To build the full picture I need a little more:\n\n${qs}`, intent, stage: 'scoping', deliverable: ctx.persona === 'team' ? 'undecided' : 'ticket' });
    }
    if (ctx.persona === 'team' && detailMessages.length === 2 && prevState.deliverable !== 'ticket')
      return out({ reply: `Here is how I would approach it, based on what you told me:\n\n1. Confirm the objective and acceptance criteria with the owner.\n2. Identify and reuse existing objects before building anything new.\n3. Build the smallest change that meets the criteria, with error handling and authorisation checks.\n4. Test the main flow and the edge cases you listed, then regress the neighbouring areas.\n\n**Do you want me to turn this into a ticket, or is the outline enough?**`, intent, stage: 'scoping', deliverable: 'undecided', quickReplies: ['Create a ticket', 'The outline is enough'] });
    return this.present(ctx, detailMessages, intent, out, base);
  }

  /** Writes the full scope from the person's own words and asks for confirmation. */
  private present(ctx: PromptContext, details: ChatMessage[], intent: Intent, out: (o: Partial<Turn> & { reply: string }) => Turn, base: { stackFit: Turn['stackFit'] }): Turn {
    const words = details.map((m) => m.body.trim());
    const first = words[0] ?? '';
    const incident = intent === 'incident' || intent === 'analysis';
    const types = ctx.ticketTypes;
    const type = (incident && types.find((t) => t.key === 'incident')) || (!incident && types.find((t) => ['requirement', 'wricef', 'ritm', 'feature'].includes(t.key))) || types[0];
    const urgency = /critical|everyone|p1|down/i.test(words.join(' ')) ? 'P1 - Critical' : /high|team|p2/i.test(words.join(' ')) ? 'P2 - High' : /low|p4/i.test(words.join(' ')) ? 'P4 - Low' : 'P3 - Medium';
    const impact = /everyone|enterprise/i.test(words.join(' ')) ? 'Enterprise-wide' : /team|department/i.test(words.join(' ')) ? 'Department' : 'Single user';
    const title = firstLine(first);
    const sections = incident
      ? [`## Summary\n${first}`, `## What happened\n${words.slice(0, 2).map((w) => `- ${w}`).join('\n')}`, `## Impact and urgency\n- Urgency: ${urgency}\n- Affected: ${impact}`, '## What was already tried\n- Basic checks suggested by the assistant (selections, refresh, authorisation message)']
      : [`## Background\n${first}`, `## Objective\n${words[1] ?? first}`, `## Details provided\n${words.slice(1).map((w) => `- ${w}`).join('\n') || '- None beyond the above'}`, '## Open questions\n- To be refined with the consultant during specification'];
    const markdown = sections.join('\n\n');
    const fields: Record<string, string> = {};
    for (const f of type?.fields ?? []) {
      if (f.key === 'priority') fields.priority = urgency; else if (f.key === 'impact') fields.impact = impact; else if (f.key === 'steps_to_reproduce') fields.steps_to_reproduce = first;
      else if (f.key === 'requested_for') fields.requested_for = ctx.userName; else if (f.key === 'catalog_item') fields.catalog_item = title;
    }
    if (ctx.noTickets) return out({ reply: `Here is the full scope as I understand it:\n\n${markdown}\n\nThis project's tickets live in your own tracking tool, so I have not created anything. You can copy this scope into a ticket there.`, intent, stage: 'done', outcome: 'solution_given', deliverable: 'solution', scope: { title, markdown }, ticket: null, ready: false });
    const reply = `Here is the full scope as I understand it:\n\n${markdown}\n\n**Proposed ticket:** ${type ? type.name : 'Ticket'}: *${title}*\n\n**Shall I create this ticket?** Reply **yes** to confirm, or tell me what to change.`;
    return out({ reply, intent, stage: 'confirm', deliverable: 'ticket', scope: { title, markdown }, ticket: type ? { typeKey: type.key, title, fields } : null, ready: base.stackFit !== 'out_of_scope', quickReplies: ['Yes, create the ticket', 'I want to change something'] });
  }
}

export { YES };
