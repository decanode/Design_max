import type { Fetcher } from '../etl/types.js';

// The language-model providers behind every AI feature (chat assistant, specifications). Each implements one small seam: text in, text out.
/** Minimal text-in/text-out LLM seam; providers implement this and nothing else leaks past it. */
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

/** Google Gemini via the Generative Language API (API key from Google AI Studio). */
export class GeminiClient implements LlmClient {
  constructor(private apiKey: string, private model = 'gemini-3.5-flash', private f: Fetcher = fetch, private retryDelayMs = 1000) {}
  async complete(system: string, user: string) {
    let res!: Response;
    // 429/503 are momentary (rate limit, overloaded model): retry a couple of times before giving up.
    for (let attempt = 0; attempt < 3; attempt++) {
      res = await this.f(`https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent`, {
        method: 'POST',
        headers: { 'x-goog-api-key': this.apiKey, 'content-type': 'application/json' },
        body: JSON.stringify({ systemInstruction: { parts: [{ text: system }] }, contents: [{ role: 'user', parts: [{ text: user }] }] }),
      });
      if (res.status !== 429 && res.status !== 503) break;
      await new Promise((r) => setTimeout(r, this.retryDelayMs * (attempt + 1)));
    }
    if (!res.ok) throw new Error(`Gemini ${res.status}`);
    const parts: { text?: string }[] = ((await res.json()) as any).candidates?.[0]?.content?.parts ?? [];
    return parts.map((p) => p.text ?? '').join('');
  }
}

/**
 * Provider choice. `AI_PROVIDER` (github | gemini | anthropic | offline) forces one;
 * otherwise the first configured wins: GitHub Models (firm license) > Gemini > Anthropic > offline.
 */
export function defaultLlm(): LlmClient | null {
  const e = process.env;
  const want = e.AI_PROVIDER?.toLowerCase();
  const ok = (name: string, key?: string) => (want ? want === name : !!key) && !!key;
  if (ok('github', e.GITHUB_MODELS_TOKEN)) return new GitHubModelsClient(e.GITHUB_MODELS_TOKEN!, e.GITHUB_MODELS_MODEL, e.GITHUB_MODELS_ORG);
  if (ok('gemini', e.GEMINI_API_KEY)) return new GeminiClient(e.GEMINI_API_KEY!, e.GEMINI_MODEL);
  if (ok('anthropic', e.ANTHROPIC_API_KEY)) return new AnthropicClient(e.ANTHROPIC_API_KEY!);
  return null;
}
