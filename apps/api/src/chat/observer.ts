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

/** Minimal text-in/text-out LLM seam; providers implement this and nothing else leaks into the observer. */
export interface LlmClient { complete(system: string, user: string): Promise<string> }

export class AnthropicClient implements LlmClient {
  constructor(private apiKey: string, private model = 'claude-sonnet-5-5', private f: Fetcher = fetch) {}
  async complete(system: string, user: string) {
    const res = await this.f('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': this.apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: this.model, max_tokens: 1024, system, messages: [{ role: 'user', content: user }] }),
    });
    if (!res.ok) throw new Error(`Anthropic ${res.status}`);
    return ((await res.json()) as any).content?.[0]?.text ?? '';
  }
}

/** GitHub Models (OpenAI-compatible). With `org`, usage is billed/attributed to that GitHub organization. */
export class GitHubModelsClient implements LlmClient {
  constructor(private token: string, private model = 'openai/gpt-4.1', private org?: string, private f: Fetcher = fetch) {}
  async complete(system: string, user: string) {
    const base = 'https://models.github.ai';
    const res = await this.f(`${base}${this.org ? `/orgs/${this.org}` : ''}/inference/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'content-type': 'application/json' },
      body: JSON.stringify({ model: this.model, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] }),
    });
    if (!res.ok) throw new Error(`GitHub Models ${res.status}`);
    return ((await res.json()) as any).choices?.[0]?.message?.content ?? '';
  }
}

const SYSTEM = 'You observe a customer/consultant chat and draft a plain-English requirement. Reply with ONLY JSON: {"title": string (<=120 chars), "summary": string, "entities": {"businessObjects": string[], "vendors": string[], "materialTypes": string[]}}. Do not invent facts absent from the chat.';

/** Provider-agnostic LLM observer. Output is validated, so a bad model reply never corrupts a draft. */
export class LlmObserver implements Observer {
  constructor(private llm: LlmClient) {}
  async draft(messages: ChatMessage[]): Promise<Draft | null> {
    if (!messages.some((m) => m.role === 'customer')) return null;
    const text = await this.llm.complete(SYSTEM, messages.map((m) => `${m.name} (${m.role}): ${m.body}`).join('\n'));
    return DraftSchema.parse(JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)));
  }
}

/** Provider choice: GitHub Models (firm license) > Anthropic > offline rule-based. */
export function defaultObserver(): Observer {
  const e = process.env;
  if (e.GITHUB_MODELS_TOKEN) return new LlmObserver(new GitHubModelsClient(e.GITHUB_MODELS_TOKEN, e.GITHUB_MODELS_MODEL, e.GITHUB_MODELS_ORG));
  if (e.ANTHROPIC_API_KEY) return new LlmObserver(new AnthropicClient(e.ANTHROPIC_API_KEY));
  return new RuleBasedObserver();
}
