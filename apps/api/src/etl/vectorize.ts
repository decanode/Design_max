import type pg from 'pg';

export const EMBEDDING_DIM = 1536;
export interface Embedder { embed(texts: string[]): Promise<number[][]>; /** false for the offline stand-in: its similarity is meaningless */ readonly semantic?: boolean }

export class OpenAIEmbedder implements Embedder {
  constructor(private apiKey: string, private model = 'text-embedding-3-small', private f: typeof fetch = fetch) {}
  async embed(texts: string[]) {
    const res = await this.f('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: this.model, input: texts }),
    });
    if (!res.ok) throw new Error(`Embeddings ${res.status}`);
    return ((await res.json()) as any).data.map((d: any) => d.embedding);
  }
}

/** GitHub Models embeddings (OpenAI-compatible). Model must produce 1536 dims to match the schema. */
export class GitHubModelsEmbedder implements Embedder {
  constructor(private token: string, private model = 'openai/text-embedding-3-small', private org?: string, private f: typeof fetch = fetch) {}
  async embed(texts: string[]) {
    const res = await this.f(`https://models.github.ai${this.org ? `/orgs/${this.org}` : ''}/inference/embeddings`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.token}`, Accept: 'application/vnd.github+json', 'content-type': 'application/json' },
      body: JSON.stringify({ model: this.model, input: texts }),
    });
    if (!res.ok) throw new Error(`GitHub Models embeddings ${res.status}`);
    const vecs: number[][] = ((await res.json()) as any).data.map((d: any) => d.embedding);
    if (vecs.some((v) => v.length !== EMBEDDING_DIM)) throw new Error(`Embedding dimension != ${EMBEDDING_DIM}`);
    return vecs;
  }
}

/** Deterministic offline embedder (hashed bag-of-words) for tests and keyless dev. */
export class HashEmbedder implements Embedder {
  readonly semantic = false;
  async embed(texts: string[]) {
    return texts.map((t) => {
      const v = new Array(EMBEDDING_DIM).fill(0);
      for (const w of t.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
        let h = 2166136261;
        for (const ch of w) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
        v[Math.abs(h) % EMBEDDING_DIM] += 1;
      }
      const n = Math.hypot(...v) || 1;
      return v.map((x) => x / n);
    });
  }
}

export interface EmbedItem { sourceType: 'ticket' | 'sap_metadata' | 'git' | 'kb_doc'; sourceRef: string; content: string }

export async function storeEmbeddings(db: Pick<pg.Pool, 'query'>, embedder: Embedder, items: EmbedItem[], batch = 64) {
  for (let i = 0; i < items.length; i += batch) {
    const chunk = items.slice(i, i + batch);
    const vecs = await embedder.embed(chunk.map((c) => c.content));
    for (let j = 0; j < chunk.length; j++) {
      await db.query(
        `INSERT INTO embeddings (source_type, source_ref, content, embedding) VALUES ($1,$2,$3,$4::vector)
         ON CONFLICT (source_type, source_ref) DO UPDATE SET content=EXCLUDED.content, embedding=EXCLUDED.embedding`,
        [chunk[j].sourceType, chunk[j].sourceRef, chunk[j].content, `[${vecs[j].join(',')}]`]);
    }
  }
}

/** Resolution notes + acceptance criteria are what the AI recalls as historical fixes. */
export const ticketEmbedItem = (legacyId: string, r: { title: string; resolutionNotes?: string; acceptanceCriteria?: string }): EmbedItem | null => {
  const body = [r.resolutionNotes, r.acceptanceCriteria].filter(Boolean).join('\n');
  return body ? { sourceType: 'ticket', sourceRef: legacyId, content: `${r.title}\n${body}` } : null;
};

export async function similar(db: Pick<pg.Pool, 'query'>, embedder: Embedder, query: string, k = 5) {
  const [v] = await embedder.embed([query]);
  const { rows } = await db.query(
    `SELECT source_type, source_ref, content, embedding <=> $1::vector AS distance
     FROM embeddings ORDER BY distance LIMIT $2`, [`[${v.join(',')}]`, k]);
  return rows;
}

export function defaultEmbedder(): Embedder {
  const e = process.env;
  if (e.GITHUB_MODELS_TOKEN) return new GitHubModelsEmbedder(e.GITHUB_MODELS_TOKEN, e.GITHUB_MODELS_EMBED_MODEL, e.GITHUB_MODELS_ORG);
  if (e.OPENAI_API_KEY) return new OpenAIEmbedder(e.OPENAI_API_KEY);
  return new HashEmbedder();
}
