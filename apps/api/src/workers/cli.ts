import 'dotenv/config';
import { pool } from '../db.js';
import { defaultEmbedder, storeEmbeddings, type EmbedItem } from '../etl/vectorize.js';
import { extractGitUrl } from './git.js';
import { extractSharePoint } from './sharepoint.js';

// Usage: npm run ingest -w apps/api -- git <url> <name> | sharepoint <driveId> [folder]
// (SAP is run programmatically once an RfcClient is configured; see workers/sap.ts.)
const [kind, a, b] = process.argv.slice(2);
const embedder = defaultEmbedder();

let items: EmbedItem[] = [];
if (kind === 'git' && a && b) items = await extractGitUrl(a, b);
else if (kind === 'sharepoint' && a) {
  const token = process.env.GRAPH_ACCESS_TOKEN;
  if (!token) throw new Error('GRAPH_ACCESS_TOKEN required');
  const r = await extractSharePoint({ accessToken: token, driveId: a, folderPath: b });
  items = r.items;
  if (r.skipped.length) console.warn('skipped (unsupported format):', r.skipped);
} else throw new Error('Usage: ingest git <url> <name> | ingest sharepoint <driveId> [folder]');

await storeEmbeddings(pool, embedder, items);
console.log(`embedded ${items.length} items`);
await pool.end();
