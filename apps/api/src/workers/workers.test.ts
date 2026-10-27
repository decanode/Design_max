import { describe, it, expect, afterAll } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pool } from '../db.js';
import { extractGitRepo } from './git.js';
import { extractSapMetadata, type RfcClient } from './sap.js';
import { extractSharePoint } from './sharepoint.js';
import { migrateAttachments, LocalBlobStore } from '../etl/attachments.js';
import { HashEmbedder, storeEmbeddings, similar } from '../etl/vectorize.js';

afterAll(() => pool.end());

describe('workers', () => {
  it('Git worker extracts README, OpenAPI and function headers', async () => {
    const d = await mkdtemp(join(tmpdir(), 'repo-'));
    await mkdir(join(d, 'node_modules'));
    await writeFile(join(d, 'node_modules/skip.js'), 'function nope() {}');
    await writeFile(join(d, 'README.md'), '# Vendor service');
    await writeFile(join(d, 'openapi.json'), JSON.stringify({ info: { title: 'Vendors' }, paths: { '/vendors': { get: { summary: 'List vendors' } } } }));
    await writeFile(join(d, 'a.ts'), 'export async function createVendor(name: string) {\n}\n');
    const items = await extractGitRepo(d, 'vend');
    expect(items.map((i) => i.sourceRef).sort()).toEqual(['vend:README.md', 'vend:a.ts', 'vend:openapi.json']);
    expect(items.find((i) => i.sourceRef.endsWith('openapi.json'))!.content).toContain('GET /vendors - List vendors');
    expect(items.find((i) => i.sourceRef.endsWith('a.ts'))!.content).toContain('createVendor');
  });

  it('SAP worker joins programs, tcodes and usage', async () => {
    const rfc: RfcClient = { call: async (_fm, p: any) => ({
      DATA: p.QUERY_TABLE === 'TRDIR' ? [{ WA: 'ZMM_VENDOR_UPLOAD|1|JDOE' }] : [{ WA: 'ZVU1|ZMM_VENDOR_UPLOAD' }] }) };
    const [it] = await extractSapMetadata(rfc, async () => ({ ZMM_VENDOR_UPLOAD: 420 }));
    expect(it.sourceRef).toBe('program:ZMM_VENDOR_UPLOAD');
    expect(it.content).toContain('Transactions: ZVU1');
    expect(it.content).toContain('Usage count: 420');
    await storeEmbeddings(pool, new HashEmbedder(), [it]);
    expect((await similar(pool, new HashEmbedder(), 'vendor upload program', 1))[0].source_ref).toBe('program:ZMM_VENDOR_UPLOAD');
  });

  it('SharePoint connector pages and skips binaries', async () => {
    const f: typeof fetch = async (u) => {
      const url = String(u);
      if (url.endsWith('/children')) return Response.json({ value: [{ id: '1', name: 'sop.md', file: {} }, { id: '2', name: 'x.pdf', file: {} }, { id: '3', name: 'dir' }], '@odata.nextLink': 'https://graph.microsoft.com/next' });
      if (url.endsWith('/next')) return Response.json({ value: [{ id: '4', name: 'b.txt', file: {} }] });
      return new Response('SOP body');
    };
    const r = await extractSharePoint({ accessToken: 't', driveId: 'd', fetch: f });
    expect(r.items.map((i) => i.sourceRef)).toEqual(['sharepoint:1', 'sharepoint:4']);
    expect(r.skipped).toEqual(['x.pdf']);
  });

  it('migrates attachment binaries to the blob store', async () => {
    const p = (await pool.query("INSERT INTO projects(name) VALUES('att') RETURNING id")).rows[0].id;
    const t = (await pool.query("INSERT INTO tickets(project_id,title) VALUES($1,'a') RETURNING id", [p])).rows[0].id;
    const a = (await pool.query("INSERT INTO attachments(ticket_id,filename,legacy_url) VALUES($1,'my file.txt','https://x/f') RETURNING id", [t])).rows[0].id;
    const root = await mkdtemp(join(tmpdir(), 'blob-'));
    const r = await migrateAttachments(pool, new LocalBlobStore(root), {}, async () => new Response('hello'));
    expect(r.migrated).toBeGreaterThanOrEqual(1);
    const key = (await pool.query('SELECT storage_key FROM attachments WHERE id=$1', [a])).rows[0].storage_key;
    expect(await readFile(join(root, key), 'utf8')).toBe('hello');
  });
});
