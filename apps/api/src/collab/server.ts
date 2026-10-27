import type { Server as HttpServer, IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer } from 'ws';
import * as Y from 'yjs';
import { Hocuspocus } from '@hocuspocus/server';
import { runWithContext } from '../db.js';
import { verifyCollab, type CollabClaim } from './token.js';
import { loadDraft, pmToYdoc, storeDraft, replaceContent } from './draft.js';
import { emptyDoc, type PmNode } from '../docgen/pm.js';
import type { DocKind } from '../docs/kinds.js';

type Ctx = { claim?: CollabClaim };
export let hocuspocus: Hocuspocus<Ctx> | null = null;
let sockets: WebSocketServer | null = null;
/** Drops every live editing connection (used on shutdown; upgraded sockets would otherwise keep the server open). */
export function closeCollab() { sockets?.clients.forEach((c) => c.terminate()); hocuspocus?.flushPendingStores(); }

const parse = (name: string) => { const [pid, ticket, kind] = name.split(':'); return { pid, ticket, kind: kind as DocKind }; };

/**
 * Live co-editing endpoint at /collab. A connection is accepted only with a valid short-lived pass for exactly that
 * document; a pass without edit rights opens a read-only connection (it can watch live but never change the draft).
 */
export function attachCollab(http: HttpServer) {
  const hp = new Hocuspocus<Ctx>({
    quiet: true, debounce: 1500, maxDebounce: 8000,
    async onAuthenticate({ token, documentName, connectionConfig }) {
      const c = verifyCollab(token);
      const { pid, ticket, kind } = parse(documentName);
      if (!c || c.pid !== pid || c.ticket !== ticket || c.kind !== kind) throw new Error('Not allowed');
      if (!c.edit) connectionConfig.readOnly = true;
      return { claim: c };
    },
    async onLoadDocument({ documentName, document }) {
      const { pid, ticket, kind } = parse(documentName);
      const stored = (await loadDraft(pid, ticket, kind)) ?? pmToYdoc(emptyDoc());
      Y.applyUpdate(document, Y.encodeStateAsUpdate(stored));
    },
    async onStoreDocument({ documentName, document }) {
      const { pid, ticket, kind } = parse(documentName);
      await storeDraft(pid, ticket, kind, document);
    },
  });
  hocuspocus = hp;

  const wss = sockets = new WebSocketServer({ noServer: true, maxPayload: 4 * 1024 * 1024 });
  http.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    if (!req.url?.startsWith('/collab')) return;       // Socket.io handles its own path
    wss.handleUpgrade(req, socket, head, (ws) => {
      const headers = new Headers(); for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v);
      const conn = hp.handleConnection(ws as never, new Request(`http://localhost${req.url}`, { headers }));
      ws.on('message', (data: Buffer) => conn.handleMessage(new Uint8Array(data)));
      ws.on('close', (code: number, reason: Buffer) => conn.handleClose({ code, reason: reason.toString() } as never));
      ws.on('error', () => ws.close());
    });
  });
  return hp;
}

/** The current draft content, read from the live document when someone is editing, otherwise from storage. */
export async function readDraft(projectId: string, ticketId: string, kind: DocKind): Promise<PmNode | null> {
  const { ydocToPm } = await import('./draft.js');
  const name = `${projectId}:${ticketId}:${kind}`;
  if (hocuspocus) {
    const conn = await hocuspocus.openDirectConnection(name, {});
    try { return conn.document ? ydocToPm(conn.document) : null; } finally { await conn.disconnect(); }
  }
  const d = await loadDraft(projectId, ticketId, kind);
  return d && ydocToPm(d);
}

/** Replaces the shared draft (after a regenerate, an import, or a version saved through the API). Connected editors see it at once. */
export async function resetDraft(projectId: string, ticketId: string, kind: DocKind, pm: PmNode) {
  if (hocuspocus) {
    const conn = await hocuspocus.openDirectConnection(`${projectId}:${ticketId}:${kind}`, {});
    try { await conn.transact((doc) => replaceContent(doc, pm)); } finally { await conn.disconnect(); }
  } else await storeDraft(projectId, ticketId, kind, pmToYdoc(pm));
}
export { runWithContext };
