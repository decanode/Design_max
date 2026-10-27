import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { pool } from '../db.js';
import { need, ticketVisible } from '../rbac/auth.js';
import { DocError } from '../errors.js';
import { KINDS } from './kinds.js';
import { importDocx, MAX_UPLOAD_BYTES } from '../docgen/importDocx.js';
import { mergePairs, pairSections, splitSections, textOf, type Choice, type Pair } from '../docgen/sections.js';
import { draftLock, saveVersion, snapshotDraft, syncDraft } from './service.js';
import { readDraft } from '../collab/server.js';
import { normalise } from '../collab/draft.js';
import type { PmNode } from '../docgen/pm.js';

const Kind = z.enum(KINDS);
const preview = (nodes: PmNode[] | undefined) => (nodes ?? []).map(textOf).join('\n').trim().slice(0, 600);
const summary = (p: Pair) => ({
  id: p.id, title: p.title, match: p.match,
  draft: p.draft ? { preview: preview(p.draft.nodes), blocks: p.draft.nodes.length } : null,
  upload: p.upload ? { preview: preview(p.upload.nodes), blocks: p.upload.nodes.length } : null,
});

/** Upload your own Word file and merge it with the draft, section by section. Nothing changes until the merge is confirmed. */
export function registerUploadRoutes(app: FastifyInstance) {
  const visible = async (req: import('fastify').FastifyRequest, id: string) => { if (!(await ticketVisible(req.user!, id))) throw new DocError('Ticket not found', 404); };
  const T = z.object({ id: z.string().uuid(), kind: Kind });

  app.post('/api/tickets/:id/documents/:kind/upload', { preHandler: need('spec.edit'), bodyLimit: Math.ceil(MAX_UPLOAD_BYTES * 1.4) + 4096 }, async (req, reply) => {
    const p = T.parse(req.params); await visible(req, p.id);
    const b = z.object({ filename: z.string().trim().min(1).max(200), docxBase64: z.string().min(100) }).parse(req.body);
    const lock = await draftLock(p.id, p.kind); if (lock) throw new DocError(lock, 409);
    const u = req.user!;
    const draft = await readDraft(u.projectId!, p.id, p.kind);
    if (!draft) throw new DocError('Generate the draft first, then merge your file into it', 409);
    const buf = Buffer.from(b.docxBase64, 'base64');
    const { doc, notes } = await importDocx(buf);
    const id = (await pool.query('INSERT INTO doc_uploads (project_id, ticket_id, kind, filename, original, content_json, uploaded_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id',
      [u.projectId, p.id, p.kind, b.filename.replace(/[\r\n"]/g, ''), buf, JSON.stringify(doc), u.id])).rows[0].id as string;
    const pairs = pairSections(splitSections(normalise(draft)), splitSections(doc));
    return reply.code(201).send({ uploadId: id, filename: b.filename, notes, sections: pairs.map(summary) });
  });

  app.post('/api/tickets/:id/documents/:kind/upload/:uploadId/merge', { preHandler: need('spec.edit') }, async (req, reply) => {
    const p = z.object({ id: z.string().uuid(), kind: Kind, uploadId: z.string().uuid() }).parse(req.params); await visible(req, p.id);
    const b = z.object({ choices: z.record(z.string(), z.enum(['keep', 'upload', 'append', 'skip'])) }).parse(req.body);
    const u = req.user!;
    const lock = await draftLock(p.id, p.kind); if (lock) throw new DocError(lock, 409);
    const up = (await pool.query('SELECT * FROM doc_uploads WHERE id=$1 AND ticket_id=$2 AND kind=$3', [p.uploadId, p.id, p.kind])).rows[0];
    if (!up) throw new DocError('Upload not found', 404);
    if (up.merged_as) throw new DocError('This upload was already merged', 409);

    // 1. keep whatever the team had in the shared draft as its own version, so the merge can always be undone
    await snapshotDraft(u.projectId!, p.id, p.kind, u.name, 'Before merging an uploaded file');
    const draft = normalise((await readDraft(u.projectId!, p.id, p.kind))!);
    const pairs = pairSections(splitSections(draft), splitSections(up.content_json));
    const merged = mergePairs(pairs, (pr): Choice => b.choices[String(pr.id)] ?? (pr.match === 'missing' ? 'keep' : pr.match === 'new' ? 'skip' : 'keep'));

    // 2. the merged text becomes the next version, and the shared draft follows it
    const latest = (await pool.query('SELECT max(version_number) v FROM documents WHERE ticket_id=$1 AND kind=$2', [p.id, p.kind])).rows[0].v as number;
    const row = await saveVersion(p.id, p.kind, normalise(merged), latest, u.name, `Merged from ${up.filename}`);
    await syncDraft(u.projectId!, p.id, p.kind, row);
    await pool.query('UPDATE doc_uploads SET merged_as=$2 WHERE id=$1', [p.uploadId, row.version_number]);
    return reply.code(201).send({ version: row.version_number });
  });
}
