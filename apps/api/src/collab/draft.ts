import * as Y from 'yjs';
import { prosemirrorJSONToYXmlFragment } from 'y-prosemirror';
import { TiptapTransformer } from '@hocuspocus/transformer';
import { docExtensions, docSchema } from '@design-max/doc-schema';
import { pool, runWithContext } from '../db.js';
import { emptyDoc, pmText, type PmNode } from '../docgen/pm.js';
import { versionPm } from '../docs/content.js';
import type { DocKind } from '../docs/kinds.js';

const extensions = docExtensions() as never;     // the transformer may bundle its own copy of the editor core; the schema is the same
const schema = docSchema();
export const FIELD = 'default';

/** Normalises content through the editor's own schema so what is stored always opens in the editor. */
export function normalise(pm: PmNode): PmNode {
  try { return schema.nodeFromJSON(pm).toJSON(); } catch { return pm; }
}

export const pmToYdoc = (pm: PmNode): Y.Doc => TiptapTransformer.toYdoc(normalise(pm), FIELD, extensions);
export const ydocToPm = (doc: Y.Doc): PmNode => (TiptapTransformer.fromYdoc(doc, FIELD) as unknown as PmNode | undefined) ?? emptyDoc();

/** Replaces the whole content of a live (or loaded) Y.Doc, keeping the same document identity so connected editors follow. */
export function replaceContent(doc: Y.Doc, pm: PmNode) {
  doc.transact(() => {
    const frag = doc.getXmlFragment(FIELD);
    frag.delete(0, frag.length);
    prosemirrorJSONToYXmlFragment(schema, normalise(pm), frag);
  });
}

export async function loadDraft(projectId: string, ticketId: string, kind: DocKind): Promise<Y.Doc | null> {
  return runWithContext({ projectId }, async () => {
    const row = (await pool.query('SELECT ydoc FROM document_drafts WHERE ticket_id=$1 AND kind=$2', [ticketId, kind])).rows[0];
    if (row) { const d = new Y.Doc(); Y.applyUpdate(d, row.ydoc); return d; }
    const v = (await pool.query('SELECT content_json, content_md, content_text, version_number FROM documents WHERE ticket_id=$1 AND kind=$2 ORDER BY version_number DESC LIMIT 1', [ticketId, kind])).rows[0];
    return v ? pmToYdoc(versionPm(v)) : null;
  });
}

export async function storeDraft(projectId: string, ticketId: string, kind: DocKind, doc: Y.Doc) {
  await runWithContext({ projectId }, async () => {
    const based = (await pool.query('SELECT coalesce(max(version_number),0) v FROM documents WHERE ticket_id=$1 AND kind=$2', [ticketId, kind])).rows[0].v as number;
    await pool.query(
      `INSERT INTO document_drafts (ticket_id, kind, project_id, ydoc, based_on) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (ticket_id, kind) DO UPDATE SET ydoc=$4, updated_at=now()`, [ticketId, kind, projectId, Buffer.from(Y.encodeStateAsUpdate(doc)), based]);
  });
}

export const draftText = (pm: PmNode) => pmText(pm);
