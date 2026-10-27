import PizZip from 'pizzip';
import mammoth from 'mammoth';
import { parseDocument } from 'htmlparser2';
import type { ChildNode, Element } from 'domhandler';
import { DocError } from '../errors.js';
import type { Mark, PmNode } from './pm.js';

export const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;
const MAX_UNZIPPED = 60 * 1024 * 1024, MAX_ENTRIES = 600, MAX_NODES = 60_000;

/** Rejects anything that is not a plain Word document. The file is only ever read as data; nothing in it is executed or fetched. */
export function checkDocx(buf: Buffer) {
  if (buf.length > MAX_UPLOAD_BYTES) throw new DocError('The file is larger than 8 MB', 413);
  if (buf.subarray(0, 2).toString() !== 'PK') throw new DocError('This is not a Word (.docx) file. Older .doc files must be saved as .docx first.', 400);
  let zip: PizZip;
  try { zip = new PizZip(buf); } catch { throw new DocError('This is not a valid Word (.docx) file', 400); }
  const names = Object.keys(zip.files);
  if (names.length > MAX_ENTRIES) throw new DocError('The file has too many parts', 400);
  if (!zip.file('word/document.xml')) throw new DocError('This is not a Word (.docx) file', 400);
  if (names.some((n) => /vbaProject/i.test(n))) throw new DocError('Macro-enabled documents are not accepted. Save the file as a plain .docx.', 400);
  if (names.includes('EncryptedPackage') || names.includes('EncryptionInfo')) throw new DocError('Password-protected documents cannot be read', 400);
  let total = 0;
  for (const n of names) { total += (zip.files[n] as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize ?? 0; if (total > MAX_UNZIPPED) throw new DocError('The file expands to an unreasonable size', 400); }
  const doc = zip.file('word/document.xml')!.asText();
  if (/<!DOCTYPE|<!ENTITY/i.test(doc)) throw new DocError('The file contains unsupported XML declarations', 400);
}

const safeHref = (h?: string) => (h && /^(https?:|mailto:)/i.test(h.trim()) ? h.trim() : null);
const text = (n: ChildNode): string => (n.type === 'text' ? (n as unknown as { data: string }).data : 'children' in n ? (n.children as ChildNode[]).map(text).join('') : '');

function inline(nodes: ChildNode[], marks: Mark[] = []): PmNode[] {
  const out: PmNode[] = [];
  for (const n of nodes) {
    if (n.type === 'text') { const t = (n as unknown as { data: string }).data.replace(/\s+/g, ' '); if (t) out.push({ type: 'text', text: t, ...(marks.length ? { marks } : {}) }); continue; }
    if (n.type !== 'tag') continue;
    const e = n as Element;
    const add = (m: Mark) => inline(e.children, [...marks, m]);
    switch (e.name) {
      case 'strong': case 'b': out.push(...add({ type: 'bold' })); break;
      case 'em': case 'i': out.push(...add({ type: 'italic' })); break;
      case 'u': out.push(...add({ type: 'underline' })); break;
      case 's': case 'strike': case 'del': out.push(...add({ type: 'strike' })); break;
      case 'code': out.push(...add({ type: 'code' })); break;
      case 'a': { const h = safeHref(e.attribs.href); out.push(...(h ? add({ type: 'link', attrs: { href: h } }) : inline(e.children, marks))); break; }
      case 'br': out.push({ type: 'hardBreak' }); break;
      case 'img': break;                                  // images are not imported (counted by the caller)
      default: out.push(...inline(e.children, marks));
    }
  }
  // merge neighbouring text with identical marks
  return out.reduce<PmNode[]>((a, n) => { const p = a[a.length - 1]; if (p && p.type === 'text' && n.type === 'text' && JSON.stringify(p.marks) === JSON.stringify(n.marks)) p.text = (p.text ?? '') + (n.text ?? ''); else a.push(n); return a; }, []);
}

function block(nodes: ChildNode[], depth = 0): PmNode[] {
  const out: PmNode[] = [];
  const loose: ChildNode[] = [];
  const flush = () => { const c = inline(loose.splice(0)); if (c.some((x) => x.type !== 'text' || x.text!.trim())) out.push({ type: 'paragraph', content: c }); };
  for (const n of nodes) {
    if (n.type !== 'tag') { loose.push(n); continue; }
    const e = n as Element;
    if (depth > 12) { loose.push(n); continue; }
    const h = /^h([1-6])$/.exec(e.name);
    if (h) { flush(); const c = inline(e.children); if (text(e).trim()) out.push({ type: 'heading', attrs: { level: Math.min(4, Number(h[1])) }, content: c }); continue; }
    switch (e.name) {
      case 'p': flush(); { const c = inline(e.children); out.push({ type: 'paragraph', ...(c.length ? { content: c } : {}) }); } break;
      case 'ul': case 'ol': flush(); out.push({ type: e.name === 'ul' ? 'bulletList' : 'orderedList', content: e.children.filter((c): c is Element => c.type === 'tag' && (c as Element).name === 'li').map((li) => ({ type: 'listItem', content: block(li.children, depth + 1).length ? block(li.children, depth + 1) : [{ type: 'paragraph' }] })) }); break;
      case 'blockquote': flush(); out.push({ type: 'blockquote', content: block(e.children, depth + 1) }); break;
      case 'pre': flush(); out.push({ type: 'codeBlock', content: [{ type: 'text', text: text(e) }] }); break;
      case 'hr': flush(); out.push({ type: 'horizontalRule' }); break;
      case 'table': flush(); out.push(...table(e)); break;
      case 'img': break;
      case 'div': case 'section': case 'article': case 'body': flush(); out.push(...block(e.children, depth + 1)); break;
      default: loose.push(n);
    }
  }
  flush();
  return out;
}

function table(t: Element): PmNode[] {
  const rows: Element[] = [];
  const walk = (cs: ChildNode[]) => cs.forEach((c) => { if (c.type === 'tag') { const e = c as Element; if (e.name === 'tr') rows.push(e); else walk(e.children); } });
  walk(t.children);
  const out = rows.map((r, i) => ({
    type: 'tableRow', content: r.children.filter((c): c is Element => c.type === 'tag' && ['td', 'th'].includes((c as Element).name)).map((c) => {
      const inner = block(c.children); return { type: i === 0 && c.name === 'th' ? 'tableHeader' : 'tableCell', content: inner.length ? inner : [{ type: 'paragraph' }] };
    }),
  })).filter((r) => r.content.length);
  if (!out.length) return [];
  // every row needs the same number of cells
  const width = Math.max(...out.map((r) => r.content.length));
  for (const r of out) while (r.content.length < width) r.content.push({ type: 'tableCell', content: [{ type: 'paragraph' }] });
  return [{ type: 'table', content: out }];
}

const count = (n: PmNode): number => 1 + (n.content ?? []).reduce((a, c) => a + count(c), 0);

/** Reads an uploaded Word file into editor content. Returns what could not be carried over so the person is told. */
export async function importDocx(buf: Buffer): Promise<{ doc: PmNode; images: number; notes: string[] }> {
  checkDocx(buf);
  let html: string; let images = 0;
  try {
    const r = await mammoth.convertToHtml({ buffer: buf }, { styleMap: ["p[style-name='List Bullet'] => ul > li:fresh", "p[style-name='List Bullet 2'] => ul|ul > li:fresh", "p[style-name='List Number'] => ol > li:fresh", "p[style-name='List Number 2'] => ol|ol > li:fresh", "p[style-name='Title'] => h1:fresh"], convertImage: mammoth.images.imgElement(async () => { images++; return { src: '' }; }) });
    html = r.value;
  } catch { throw new DocError('This Word file could not be read. Open it in Word and save it again as .docx.', 400); }
  const root = parseDocument(html);
  const content = block(root.children as ChildNode[]);
  const doc: PmNode = { type: 'doc', content: content.length ? content : [{ type: 'paragraph' }] };
  if (count(doc) > MAX_NODES) throw new DocError('The document is too large to import', 413);
  const notes: string[] = [];
  if (images) notes.push(`${images} image${images > 1 ? 's were' : ' was'} not imported`);
  return { doc, images, notes };
}
