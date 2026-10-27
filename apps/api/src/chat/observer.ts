import { z } from 'zod';
import type { Fetcher } from '../etl/types.js';

export interface ChatMessage { role: 'customer' | 'consultant' | 'system'; name: string; body: string }

export const DraftSchema = z.object({
  title: z.string().min(1).max(120),
  summary: z.string().min(1),
  entities: z.object({
    businessObjects: z.array(z.string()).default([]),
    vendors: z.array(z.string()).default([]),
    materialTypes: z.array(z.string()).default([]),
  }).default({ businessObjects: [], vendors: [], materialTypes: [] }),
});
export type Draft = z.infer<typeof DraftSchema>;

/** The AI Observer: silently turns a conversation into a plain-English requirement draft. */
export interface Observer { draft(messages: ChatMessage[]): Promise<Draft | null> }

const OBJECTS = ['purchase order', 'sales order', 'invoice', 'material master', 'vendor master', 'delivery', 'goods receipt', 'report'];
const MATERIALS = ['raw material', 'finished good', 'semifinished', 'trading good', 'service'];

/** Deterministic offline observer for dev/tests. Not a language model. */
export class RuleBasedObserver implements Observer {
  async draft(messages: ChatMessage[]): Promise<Draft | null> {
    const cust = messages.filter((m) => m.role === 'customer');
    if (!cust.length) return null;
    const text = cust.map((m) => m.body).join(' ');
    const lower = text.toLowerCase();
    const vendors = [...text.matchAll(/\bvendor\s+([A-Z][\w&-]+)/g)].map((m) => m[1]);
    return {
      title: cust[0].body.split(/[.!?\n]/)[0].trim().slice(0, 120),
      summary: `The customer requests: ${cust.map((m) => m.body.trim()).join(' ')}`,
      entities: {
        businessObjects: OBJECTS.filter((o) => lower.includes(o)),
        vendors: [...new Set(vendors)],
        materialTypes: MATERIALS.filter((o) => lower.includes(o)),
      },
    };
  }
}

/** Claude-backed observer (Messages API). Not exercised against the live API yet. */
export class ClaudeObserver implements Observer {
  constructor(private apiKey: string, private model = 'claude-sonnet-5-5', private f: Fetcher = fetch) {}
  async draft(messages: ChatMessage[]): Promise<Draft | null> {
    if (!messages.some((m) => m.role === 'customer')) return null;
    const transcript = messages.map((m) => `${m.name} (${m.role}): ${m.body}`).join('\n');
    const res = await this.f('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': this.apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: this.model, max_tokens: 1024,
        system: 'You observe a customer/consultant chat and draft a plain-English requirement. Reply with ONLY JSON: {"title": string (<=120 chars), "summary": string, "entities": {"businessObjects": string[], "vendors": string[], "materialTypes": string[]}}. Do not invent facts absent from the chat.',
        messages: [{ role: 'user', content: transcript }],
      }),
    });
    if (!res.ok) throw new Error(`Anthropic ${res.status}`);
    const text: string = ((await res.json()) as any).content?.[0]?.text ?? '';
    const json = text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1);
    return DraftSchema.parse(JSON.parse(json));
  }
}

export const defaultObserver = (): Observer =>
  process.env.ANTHROPIC_API_KEY ? new ClaudeObserver(process.env.ANTHROPIC_API_KEY) : new RuleBasedObserver();
