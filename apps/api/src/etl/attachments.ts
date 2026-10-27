import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type pg from 'pg';
import type { Fetcher } from './types.js';

export interface BlobStore { put(key: string, data: Buffer, contentType?: string): Promise<void> }

/** Dev/test store. Production swaps in an S3/Azure Blob implementation of BlobStore. */
export class LocalBlobStore implements BlobStore {
  constructor(private root: string) {}
  async put(key: string, data: Buffer) {
    const p = join(this.root, key);
    await mkdir(join(p, '..'), { recursive: true });
    await writeFile(p, data);
  }
}

/** Downloads pending legacy binaries into the blob store and links them via storage_key. */
export async function migrateAttachments(db: pg.Pool, store: BlobStore, headers: Record<string, string> = {}, f: Fetcher = fetch) {
  const { rows } = await db.query('SELECT id, ticket_id, filename, mime_type, legacy_url FROM attachments WHERE storage_key IS NULL AND legacy_url IS NOT NULL');
  let ok = 0; const failed: number[] = [];
  for (const a of rows) {
    try {
      const res = await f(a.legacy_url, { headers });
      if (!res.ok) throw new Error(String(res.status));
      const key = `tickets/${a.ticket_id}/${a.id}-${a.filename.replace(/[^\w.-]/g, '_')}`;
      await store.put(key, Buffer.from(await res.arrayBuffer()), a.mime_type ?? undefined);
      await db.query('UPDATE attachments SET storage_key=$2, migrated_at=now() WHERE id=$1', [a.id, key]);
      ok++;
    } catch { failed.push(a.id); }
  }
  return { migrated: ok, failed };
}
