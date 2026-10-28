import * as Y from 'yjs';
import { pool, runWithContext } from '../db.js';
import { emptyDoc, type PmNode } from '../docgen/pm.js';
import { pmToYdoc, replaceContent, ydocToPm } from '../collab/draft.js';
import { hocuspocus } from '../collab/server.js';
import { storeCharterContent } from './service.js';

/** Live co-editing of the charter uses the same collaboration server as the ticket documents; its room is `projectId:charter:CHARTER`. */
export const CHARTER_ROOM = (projectId: string) => `${projectId}:charter:CHARTER`;

export async function loadCharterDoc(projectId: string): Promise<Y.Doc | null> {
  return runWithContext({ projectId }, async () => {
    const r = (await pool.query('SELECT ydoc, content_json FROM project_charters WHERE project_id=$1', [projectId])).rows[0];
    if (!r) return null;
    if (r.ydoc) { const d = new Y.Doc(); Y.applyUpdate(d, r.ydoc); return d; }
    return r.content_json ? pmToYdoc(r.content_json as PmNode) : pmToYdoc(emptyDoc());
  });
}

export async function storeCharterDoc(projectId: string, doc: Y.Doc) {
  await runWithContext({ projectId }, () => storeCharterContent(projectId, ydocToPm(doc), Buffer.from(Y.encodeStateAsUpdate(doc))));
}

/** Makes the live document (if anyone has it open) follow a regenerated charter. */
export async function resetCharterRoom(projectId: string, pm: PmNode) {
  if (!hocuspocus) return;
  const conn = await hocuspocus.openDirectConnection(CHARTER_ROOM(projectId), {});
  try { await conn.transact((doc) => replaceContent(doc, pm)); } finally { await conn.disconnect(); }
}

/** Saves whatever people have typed (still in memory on the collaboration server) so the stored charter is current. */
export async function flushCharter(projectId: string) {
  if (!hocuspocus) return;
  const conn = await hocuspocus.openDirectConnection(CHARTER_ROOM(projectId), {});
  try { if (conn.document) await storeCharterDoc(projectId, conn.document); } finally { await conn.disconnect(); }
}

/** Disconnects editors (after approval) so they reconnect read-only. */
export function closeCharterRoom(projectId: string) { hocuspocus?.closeConnections(CHARTER_ROOM(projectId)); }
