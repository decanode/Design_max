import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import type { Embedder } from './vectorize.js';

/** Replays real embeddings recorded earlier, so tests are offline AND semantically meaningful. */
export class RecordedEmbedder implements Embedder {
  private map: Record<string, number[]>;
  constructor(private file: string) { this.map = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {}; }
  async embed(texts: string[]) {
    return texts.map((t) => {
      const v = this.map[t];
      if (!v) throw new Error(`No recorded embedding for "${t.slice(0, 60)}". Run: npm run embeddings:record -w apps/api`);
      return v;
    });
  }
  /** Fetches any missing texts from a live embedder and persists them. */
  static async record(file: string, live: Embedder, texts: string[]) {
    const map: Record<string, number[]> = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
    const missing = [...new Set(texts)].filter((t) => !map[t]);
    if (missing.length) (await live.embed(missing)).forEach((v, i) => (map[missing[i]] = v));
    writeFileSync(file, JSON.stringify(map));
    return missing.length;
  }
}
