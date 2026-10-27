import type pg from 'pg';
import type { Extractor } from './types.js';
import { loadRecord } from './load.js';
import { storeEmbeddings, ticketEmbedItem, type Embedder, type EmbedItem } from './vectorize.js';

export interface MigrationResult { tickets: number; embedded: number; failed: { legacyId: string; error: string }[] }

export async function runMigration(db: pg.Pool, projectId: string, extractor: Extractor, embedder: Embedder): Promise<MigrationResult> {
  const res: MigrationResult = { tickets: 0, embedded: 0, failed: [] };
  const items: EmbedItem[] = [];
  for await (const r of extractor.extract()) {
    try {
      await loadRecord(db, projectId, r);
      res.tickets++;
      const item = ticketEmbedItem(r.legacyId, r);
      if (item) items.push({ ...item, projectId });
    } catch (e) {
      res.failed.push({ legacyId: r.legacyId, error: (e as Error).message });
    }
  }
  await storeEmbeddings(db, embedder, items);
  res.embedded = items.length;
  return res;
}
