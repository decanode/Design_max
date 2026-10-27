import { marked, type Token, type Tokens } from 'marked';

/**
 * Canonical document content: ProseMirror JSON (the format the online editor uses), a small subset:
 * doc, paragraph, heading, bulletList, orderedList, taskList, listItem, taskItem, blockquote, codeBlock,
 * horizontalRule, hardBreak, table/tableRow/tableHeader/tableCell, text (+ bold, italic, strike, code, underline, link marks).
 * Markdown (what FS/TS were stored as until now) converts into it on demand.
 */
export interface Mark { type: 'bold' | 'italic' | 'strike' | 'code' | 'underline' | 'link'; attrs?: { href?: string } }
export interface PmNode { type: string; attrs?: Record<string, unknown>; content?: PmNode[]; text?: string; marks?: Mark[] }
export const emptyDoc = (): PmNode => ({ type: 'doc', content: [{ type: 'paragraph' }] });

type Inline = Token & { tokens?: Token[]; text?: string; href?: string };

function inline(tokens: Token[] | undefined, marks: Mark[] = []): PmNode[] {
  const out: PmNode[] = [];
  const text = (t: string, m: Mark[]) => { if (t) out.push({ type: 'text', text: t, ...(m.length ? { marks: m } : {}) }); };
  for (const raw of tokens ?? []) {
    const t = raw as Inline;
    switch (t.type) {
      case 'strong': out.push(...inline(t.tokens, [...marks, { type: 'bold' }])); break;
      case 'em': out.push(...inline(t.tokens, [...marks, { type: 'italic' }])); break;
      case 'del': out.push(...inline(t.tokens, [...marks, { type: 'strike' }])); break;
      case 'codespan': text(t.text ?? '', [...marks, { type: 'code' }]); break;
      case 'link': out.push(...inline(t.tokens, [...marks, { type: 'link', attrs: { href: t.href } }])); break;
      case 'br': out.push({ type: 'hardBreak' }); break;
      case 'image': text(((t as unknown as Tokens.Image).text || (t as unknown as Tokens.Image).href) ?? '', marks); break;   // images arrive with the editor phase
      case 'escape': case 'text': case 'html': default:
        if (t.tokens?.length) out.push(...inline(t.tokens, marks)); else text(decode(t.text ?? (t as { raw?: string }).raw ?? ''), marks);
    }
  }
  return out;
}
const decode = (s: string) => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");

function listItem(item: Tokens.ListItem, task: boolean): PmNode {
  const content: PmNode[] = [];
  for (const t of item.tokens) {
    if (t.type === 'text') content.push({ type: 'paragraph', content: inline((t as Tokens.Text).tokens ?? [t]) });
    else content.push(...blocks([t]));
  }
  if (!content.length) content.push({ type: 'paragraph' });
  return task ? { type: 'taskItem', attrs: { checked: !!item.checked }, content } : { type: 'listItem', content };
}

function blocks(tokens: Token[]): PmNode[] {
  const out: PmNode[] = [];
  for (const t of tokens) {
    switch (t.type) {
      case 'heading': out.push({ type: 'heading', attrs: { level: Math.min(6, (t as Tokens.Heading).depth) }, content: inline((t as Tokens.Heading).tokens) }); break;
      case 'paragraph': { const c = inline((t as Tokens.Paragraph).tokens); out.push({ type: 'paragraph', ...(c.length ? { content: c } : {}) }); break; }
      case 'list': {
        const l = t as Tokens.List;
        const task = l.items.length > 0 && l.items.every((i) => i.task);
        out.push({ type: task ? 'taskList' : l.ordered ? 'orderedList' : 'bulletList', content: l.items.map((i) => listItem(i, task)) });
        break;
      }
      case 'blockquote': out.push({ type: 'blockquote', content: blocks((t as Tokens.Blockquote).tokens) }); break;
      case 'code': out.push({ type: 'codeBlock', content: [{ type: 'text', text: (t as Tokens.Code).text }] }); break;
      case 'hr': out.push({ type: 'horizontalRule' }); break;
      case 'table': {
        const tb = t as Tokens.Table;
        const cell = (c: Tokens.TableCell, type: string): PmNode => ({ type, content: [{ type: 'paragraph', content: inline(c.tokens) }] });
        out.push({ type: 'table', content: [
          { type: 'tableRow', content: tb.header.map((c) => cell(c, 'tableHeader')) },
          ...tb.rows.map((r) => ({ type: 'tableRow', content: r.map((c) => cell(c, 'tableCell')) })),
        ] });
        break;
      }
      case 'html': { const txt = decode((t as Tokens.HTML).text.replace(/<[^>]+>/g, '')).trim(); if (txt) out.push({ type: 'paragraph', content: [{ type: 'text', text: txt }] }); break; }
      case 'space': default: break;
    }
  }
  return out;
}

/** Markdown (the current FS/TS storage format) → structured content. Never throws on odd input. */
export function markdownToPm(md: string): PmNode {
  const content = blocks(marked.lexer(md ?? '', { gfm: true }));
  return { type: 'doc', content: content.length ? content : [{ type: 'paragraph' }] };
}

/** Plain text of a node (used for tests and for search/diff later). */
export function pmText(n: PmNode): string {
  if (n.text) return n.text;
  return (n.content ?? []).map(pmText).join(n.type === 'doc' || n.type === 'tableRow' ? '\n' : ' ').trim();
}
