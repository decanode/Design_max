'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import * as Y from 'yjs';
import { HocuspocusProvider } from '@hocuspocus/provider';
import { EditorContent, useEditor, type Editor } from '@tiptap/react';
import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { ySyncPluginKey, absolutePositionToRelativePosition, relativePositionToAbsolutePosition } from 'y-prosemirror';
import Collaboration from '@tiptap/extension-collaboration';
import CollaborationCursor from '@tiptap/extension-collaboration-cursor';
import { docExtensions } from '@design-max/doc-schema';
import type { Kind } from '../lib/docKinds';

export interface Anchored { id: string; status: string; anchor: { from: unknown; to: unknown } | null }
export interface SelectionAnchor { anchor: { from: unknown; to: unknown }; quote: string }
export interface EditorApi { selection(): SelectionAnchor | null; scrollTo(id: string): void; whenSynced(): Promise<void> }
type Pass = { token: string; room: string; canEdit: boolean; lock: string | null };
type Peer = { name: string; color: string };
const COLORS = ['#c2410c', '#0f766e', '#7c3aed', '#be123c', '#1d4ed8', '#a16207'];
const colorFor = (s: string) => COLORS[[...s].reduce((a, c) => a + c.charCodeAt(0), 0) % COLORS.length];

/** The URL of the live editing endpoint: same origin as the page (the web server forwards it), unless overridden. */
const wsUrl = () => process.env.NEXT_PUBLIC_COLLAB_URL ?? `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/collab`;

function Toolbar({ editor }: { editor: Editor }) {
  const b = (label: string, on: () => void, active?: boolean, title = label) => (
    <button type="button" key={label} className="tb" aria-pressed={active} title={title} aria-label={title} onClick={on}>{label}</button>);
  const c = () => editor.chain().focus();
  return (
    <div className="toolbar" role="toolbar" aria-label="Formatting">
      {b('B', () => c().toggleBold().run(), editor.isActive('bold'), 'Bold')}
      {b('I', () => c().toggleItalic().run(), editor.isActive('italic'), 'Italic')}
      {b('U', () => c().toggleUnderline().run(), editor.isActive('underline'), 'Underline')}
      <span className="sep" />
      {([1, 2, 3] as const).map((l) => b(`H${l}`, () => c().toggleHeading({ level: l }).run(), editor.isActive('heading', { level: l }), `Heading ${l}`))}
      {b('¶', () => c().setParagraph().run(), editor.isActive('paragraph'), 'Paragraph')}
      <span className="sep" />
      {b('• List', () => c().toggleBulletList().run(), editor.isActive('bulletList'), 'Bulleted list')}
      {b('1. List', () => c().toggleOrderedList().run(), editor.isActive('orderedList'), 'Numbered list')}
      {b('☑ Tasks', () => c().toggleTaskList().run(), editor.isActive('taskList'), 'Checklist')}
      <span className="sep" />
      {b('Table', () => c().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run(), false, 'Insert table')}
      {editor.isActive('table') && <>
        {b('+ Row', () => c().addRowAfter().run(), false, 'Add row below')}
        {b('+ Col', () => c().addColumnAfter().run(), false, 'Add column right')}
        {b('− Row', () => c().deleteRow().run(), false, 'Delete row')}
        {b('− Col', () => c().deleteColumn().run(), false, 'Delete column')}
        {b('✕ Table', () => c().deleteTable().run(), false, 'Delete table')}
      </>}
      <span className="sep" />
      {b('Link', () => {
        const prev = editor.getAttributes('link').href as string | undefined;
        const href = window.prompt('Link address (https://…)', prev ?? 'https://');
        if (href === null) return;
        if (!href) return void c().unsetLink().run();
        if (/^(https?:|mailto:)/i.test(href)) c().extendMarkRange('link').setLink({ href }).run();
      }, editor.isActive('link'), 'Link')}
      {b('↶', () => c().undo().run(), false, 'Undo')}
      {b('↷', () => c().redo().run(), false, 'Redo')}
    </div>);
}

/**
 * The shared, live editor. Everyone with the document open edits the same draft and sees each other's cursors; the server
 * keeps the draft, so closing the tab loses nothing. "Save version" (outside this component) turns the draft into a version.
 */
const NO_THREADS: Anchored[] = [];     // a stable default: a fresh [] on every render would re-run the highlight repaint forever

export function DocEditor({ ticketId, kind, userName, tokenUrl, label, onPass, onChange, threads = NO_THREADS, activeId = null, onActivate, onOrphans, onReady, onSelection }: {
  ticketId: string; kind: Kind | 'CHARTER'; userName: string; tokenUrl?: string; label?: string; onPass?: (p: Pass) => void; onChange?: () => void;
  threads?: Anchored[]; activeId?: string | null; onActivate?: (id: string) => void; onOrphans?: (ids: string[]) => void; onReady?: (api: EditorApi) => void; onSelection?: (has: boolean) => void;
}) {
  const live = useRef({ threads, activeId, onActivate });
  live.current = { threads, activeId, onActivate };
  const [pass, setPass] = useState<Pass | null>(null);
  const [error, setError] = useState('');
  const ydoc = useMemo(() => new Y.Doc(), []);
  const [provider, setProvider] = useState<HocuspocusProvider | null>(null);
  const [status, setStatus] = useState<'connecting' | 'connected' | 'offline'>('connecting');
  const [peers, setPeers] = useState<Peer[]>([]);

  useEffect(() => {
    let dead = false; let p: HocuspocusProvider | null = null;
    (async () => {
      const r = await fetch((tokenUrl ?? `/api/tickets/${ticketId}/documents/${kind}/collab-token`), { method: 'POST' });
      if (!r.ok) return setError('Could not open the shared draft.');
      const pa: Pass = await r.json();
      if (dead) return;
      setPass(pa); onPass?.(pa);
      p = new HocuspocusProvider({
        url: wsUrl(), name: pa.room, document: ydoc,
        // A fresh pass on every (re)connect: the pass is short-lived, the session is not.
        token: async () => (await (await fetch((tokenUrl ?? `/api/tickets/${ticketId}/documents/${kind}/collab-token`), { method: 'POST' })).json()).token,
        onStatus: ({ status: s }: { status: string }) => setStatus(s === 'connected' ? 'connected' : s === 'connecting' ? 'connecting' : 'offline'),
        onAwarenessChange: ({ states }: { states: { user?: Peer }[] }) => setPeers(states.map((s) => s.user).filter((u): u is Peer => !!u)),
        onAuthenticationFailed: () => setError('You are not allowed to open this draft.'),
      } as never);
      setProvider(p);
    })();
    return () => { dead = true; p?.destroy(); setProvider(null); };
  }, [ticketId, kind, ydoc, onPass, tokenUrl]);

  const highlights = useMemo(() => Extension.create({
    name: 'commentHighlights',
    addProseMirrorPlugins() {
      const key = new PluginKey('commentHighlights');
      const resolve = (state: never, json: unknown) => {
        const ys = ySyncPluginKey.getState(state) as { type: Y.XmlFragment; binding?: { mapping: Map<never, never> } } | undefined;
        if (!ys?.binding || !json) return null;
        try { return relativePositionToAbsolutePosition(ydoc, ys.type, Y.createRelativePositionFromJSON(json), ys.binding.mapping as never); } catch { return null; }
      };
      return [new Plugin({
        key,
        props: {
          decorations(state) {
            const out: Decoration[] = []; const lost: string[] = [];
            for (const t of live.current.threads) {
              if (!t.anchor) continue;
              const a = resolve(state as never, t.anchor.from), b = resolve(state as never, t.anchor.to);
              if (a == null || b == null || b <= a || b > state.doc.content.size) { lost.push(t.id); continue; }
              out.push(Decoration.inline(a, b, { class: `cmt ${t.status} ${t.id === live.current.activeId ? 'active' : ''}`, 'data-cid': t.id }));
            }
            queueMicrotask(() => onOrphans?.(lost));
            return DecorationSet.create(state.doc, out);
          },
          handleClick(_v, _pos, ev) { const id = (ev.target as HTMLElement).closest?.('[data-cid]')?.getAttribute('data-cid'); if (id) live.current.onActivate?.(id); return false; },
        },
      })];
    },
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [ydoc]);

  const editor = useEditor({
    immediatelyRender: false,
    editable: !!pass?.canEdit,
    extensions: provider ? [
      ...docExtensions(), highlights,
      Collaboration.configure({ document: ydoc, field: 'default' }),
      CollaborationCursor.configure({ provider, user: { name: userName, color: colorFor(userName) } }),
    ] : docExtensions(),
    editorProps: { attributes: { class: 'rte-body', 'aria-label': label ?? `${kind} document`, role: 'textbox', 'aria-multiline': 'true' } },
    onUpdate: () => onChange?.(),
    onSelectionUpdate: ({ editor: e }) => onSelection?.(!e.state.selection.empty),
  }, [provider, pass?.canEdit]);

  // Repaint highlights when the thread list or the active thread changes.
  useEffect(() => { if (editor && !editor.isDestroyed) editor.view.dispatch(editor.state.tr.setMeta('commentHighlights', Date.now())); }, [editor, threads, activeId]);

  useEffect(() => {
    if (!editor) return;
    onReady?.({
      selection() {
        const { from, to, empty } = editor.state.selection;
        const ys = ySyncPluginKey.getState(editor.state) as { type: Y.XmlFragment; binding?: { mapping: unknown } } | undefined;
        if (empty || !ys?.binding) return null;
        const rel = (pos: number) => Y.relativePositionToJSON(absolutePositionToRelativePosition(pos, ys.type, ys.binding!.mapping as never));
        return { anchor: { from: rel(from), to: rel(to) }, quote: editor.state.doc.textBetween(from, to, ' ').slice(0, 500) };
      },
      scrollTo(id) { editor.view.dom.querySelector(`[data-cid="${id}"]`)?.scrollIntoView({ block: 'center', behavior: 'smooth' }); },
      /** Resolves once everything typed so far has reached the server (so an action that reads the saved text sees it). */
      async whenSynced() { const end = Date.now() + 5000; while (provider?.hasUnsyncedChanges && Date.now() < end) await new Promise((r) => setTimeout(r, 50)); },
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor, provider]);

  if (error) return <p role="alert" className="err">{error}</p>;
  if (!pass || !provider || !editor) return <p className="note">Opening the shared draft…</p>;
  return (
    <div className="rte">
      <div className="rte-status" aria-live="polite">
        <span className={`dot ${status}`} aria-hidden /> {status === 'connected' ? 'Live' : status === 'connecting' ? 'Connecting…' : 'Offline — changes are kept and will sync when you reconnect'}
        {peers.length > 1 && <span className="peers">{peers.map((p, i) => <span key={i} className="peer" style={{ background: p.color }}>{p.name}</span>)}</span>}
        {!pass.canEdit && <span className="note"> · {pass.lock ?? 'You have view-only access.'}</span>}
      </div>
      {pass.canEdit && <Toolbar editor={editor} />}
      <EditorContent editor={editor} />
    </div>);
}

/** A saved version, read-only, rendered with the same schema as the editor. */
export function DocView({ json }: { json: unknown }) {
  const editor = useEditor({ immediatelyRender: false, editable: false, extensions: docExtensions(), content: json as never, editorProps: { attributes: { class: 'rte-body' } } }, [json]);
  return editor ? <div className="rte"><EditorContent editor={editor} /></div> : null;
}
