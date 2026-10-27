import { readdir, readFile } from 'node:fs/promises';
import { join, relative, basename } from 'node:path';
import type { EmbedItem } from '../etl/vectorize.js';

const SKIP = new Set(['node_modules', '.git', 'dist', 'bin', 'obj', 'target']);
const FUNC_RE = /^[ \t]*(?:export\s+)?(?:public\s+|private\s+|protected\s+|static\s+|async\s+)*(?:function\s+\w+\s*\([^)]*\)|(?:[\w<>\[\]]+\s+)\w+\s*\([^)]*\)\s*(?:\{|throws|$)|def\s+\w+\s*\([^)]*\))/gm;

async function* walk(dir: string): AsyncGenerator<string> {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walk(p); else yield p;
  }
}

/** Summarize an OpenAPI/Swagger JSON spec as "METHOD /path - summary" lines. */
export function summarizeOpenApi(spec: any): string {
  const out: string[] = [spec.info?.title ?? ''];
  for (const [path, ops] of Object.entries<any>(spec.paths ?? {}))
    for (const [m, op] of Object.entries<any>(ops)) out.push(`${m.toUpperCase()} ${path} - ${op?.summary ?? ''}`);
  return out.join('\n');
}

/** Extracts README, OpenAPI specs and function headers from a checked-out repository. */
export async function extractGitRepo(repoDir: string, repoName: string): Promise<EmbedItem[]> {
  const items: EmbedItem[] = [];
  for await (const file of walk(repoDir)) {
    const rel = relative(repoDir, file), name = basename(file).toLowerCase();
    const ref = `${repoName}:${rel}`;
    if (name === 'readme.md') items.push({ sourceType: 'git', sourceRef: ref, content: (await readFile(file, 'utf8')).slice(0, 8000) });
    else if (/^(swagger|openapi)\.json$/.test(name)) {
      try { items.push({ sourceType: 'git', sourceRef: ref, content: summarizeOpenApi(JSON.parse(await readFile(file, 'utf8'))) }); } catch { /* malformed spec */ }
    } else if (/\.(ts|js|java|cs|py)$/.test(name)) {
      const heads = [...(await readFile(file, 'utf8')).matchAll(FUNC_RE)].map((m) => m[0].trim());
      if (heads.length) items.push({ sourceType: 'git', sourceRef: ref, content: `${rel}\n${heads.join('\n')}` });
    }
  }
  return items;
}

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';

/** Shallow-clones a repo, extracts it, and cleans up. `url` may embed a token for private repos. */
export async function extractGitUrl(url: string, repoName: string): Promise<EmbedItem[]> {
  const dir = await mkdtemp(join(tmpdir(), 'git-ingest-'));
  try {
    await promisify(execFile)('git', ['clone', '--depth', '1', '--quiet', url, dir]);
    return await extractGitRepo(dir, repoName);
  } finally { await rm(dir, { recursive: true, force: true }); }
}
