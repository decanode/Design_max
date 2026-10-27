import type { Mark, PmNode } from './pm.js';

/** Escapes text for XML (element text and attribute values). Also strips characters Word rejects. */
export const esc = (s: string) => s
  .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** What the target template offers. Styles that do not exist fall back to direct formatting, so any template works. */
export interface RenderContext {
  styles: Set<string>;                         // style ids present in the template's styles.xml
  links: Map<string, string>;                  // href -> relationship id (filled while rendering, written into document.xml.rels)
  nextRelId: () => string;
}
export const newContext = (styles: Set<string>, firstRel = 9000): RenderContext => {
  let n = firstRel;
  return { styles, links: new Map(), nextRelId: () => `rId${n++}` };
};

const pStyle = (id: string) => `<w:pStyle w:val="${id}"/>`;

/** Extra direct formatting for a run (used when the template has no suitable style). */
interface RunExtra { bold?: boolean; italic?: boolean; sizeHalfPt?: number }

/** Run properties in the order the Word schema requires (rStyle, rFonts, b, i, strike, color, sz, u): Word can reject other orders. */
function runProps(marks: Mark[] | undefined, ctx: RenderContext, extra: RunExtra = {}): string {
  const m = new Set((marks ?? []).map((x) => x.type));
  const isLink = m.has('link');
  const linkStyled = isLink && ctx.styles.has('Hyperlink');
  const parts: string[] = [];
  if (linkStyled) parts.push('<w:rStyle w:val="Hyperlink"/>');
  if (m.has('code')) parts.push('<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:cs="Consolas"/>');
  if (m.has('bold') || extra.bold) parts.push('<w:b/>');
  if (m.has('italic') || extra.italic) parts.push('<w:i/>');
  if (m.has('strike')) parts.push('<w:strike/>');
  if (isLink && !linkStyled) parts.push('<w:color w:val="0563C1"/>');
  if (extra.sizeHalfPt) parts.push(`<w:sz w:val="${extra.sizeHalfPt}"/>`);
  if (m.has('underline') || (isLink && !linkStyled)) parts.push('<w:u w:val="single"/>');
  return parts.length ? `<w:rPr>${parts.join('')}</w:rPr>` : '';
}

function inlineXml(nodes: PmNode[] | undefined, ctx: RenderContext, extra: RunExtra = {}): string {
  return (nodes ?? []).map((n) => {
    if (n.type === 'hardBreak') return '<w:r><w:br/></w:r>';
    if (n.type !== 'text') return inlineXml(n.content, ctx, extra);
    const run = `<w:r>${runProps(n.marks, ctx, extra)}<w:t xml:space="preserve">${esc(n.text ?? '')}</w:t></w:r>`;
    const link = n.marks?.find((x) => x.type === 'link')?.attrs?.href;
    if (link && /^(https?:|mailto:)/i.test(link)) {                              // only safe schemes become clickable
      if (!ctx.links.has(link)) ctx.links.set(link, ctx.nextRelId());
      return `<w:hyperlink r:id="${ctx.links.get(link)}" w:history="1">${run}</w:hyperlink>`;
    }
    return run;
  }).join('');
}

const para = (inner: string, pPr = '') => `<w:p>${pPr ? `<w:pPr>${pPr}</w:pPr>` : ''}${inner}</w:p>`;

function listXml(list: PmNode, ctx: RenderContext, depth: number): string {
  const ordered = list.type === 'orderedList', task = list.type === 'taskList';
  const styleId = `${ordered ? 'ListNumber' : 'ListBullet'}${depth > 0 ? depth + 1 : ''}`;
  const hasStyle = !task && ctx.styles.has(styleId);
  return (list.content ?? []).map((item, i) => {
    const kids = item.content ?? [];
    const first = kids.find((k) => k.type === 'paragraph');
    const marker = task ? (item.attrs?.checked ? '☒ ' : '☐ ') : hasStyle ? '' : ordered ? `${i + 1}. ` : '• ';
    const indent = `<w:ind w:left="${360 + depth * 360}" w:hanging="360"/>`;
    const head = para(`${marker ? `<w:r><w:t xml:space="preserve">${marker}</w:t></w:r>` : ''}${inlineXml(first?.content, ctx)}`, hasStyle ? pStyle(styleId) : indent);
    const rest = kids.filter((k) => k !== first).map((k) => (k.type === 'bulletList' || k.type === 'orderedList' || k.type === 'taskList' ? listXml(k, ctx, depth + 1) : blockXml(k, ctx))).join('');
    return head + rest;
  }).join('');
}

function tableXml(t: PmNode, ctx: RenderContext): string {
  const rows = t.content ?? [];
  const cols = Math.max(1, ...rows.map((r) => (r.content ?? []).reduce((n, c) => n + Number(c.attrs?.colspan ?? 1), 0)));
  const colW = Math.floor(9000 / cols);
  const borders = ctx.styles.has('TableGrid') ? '' : '<w:tblBorders>' + ['top', 'left', 'bottom', 'right', 'insideH', 'insideV'].map((b) => `<w:${b} w:val="single" w:sz="4" w:space="0" w:color="999999"/>`).join('') + '</w:tblBorders>';
  const head = `<w:tbl><w:tblPr>${ctx.styles.has('TableGrid') ? '<w:tblStyle w:val="TableGrid"/>' : ''}<w:tblW w:w="5000" w:type="pct"/>${borders}<w:tblLayout w:type="autofit"/></w:tblPr><w:tblGrid>${Array.from({ length: cols }, () => `<w:gridCol w:w="${colW}"/>`).join('')}</w:tblGrid>`;
  const body = rows.map((r) => {
    const isHeader = (r.content ?? []).length > 0 && (r.content ?? []).every((c) => c.type === 'tableHeader');
    const cells = (r.content ?? []).map((c) => {
      const span = Number(c.attrs?.colspan ?? 1);
      const shade = c.type === 'tableHeader' ? '<w:shd w:val="clear" w:color="auto" w:fill="D9E2F3"/>' : '';
      const inner = (c.content?.length ? c.content : [{ type: 'paragraph' }]).map((b) => blockXml(b, ctx, c.type === 'tableHeader' ? { bold: true } : {})).join('');
      return `<w:tc><w:tcPr><w:tcW w:w="${colW * span}" w:type="dxa"/>${span > 1 ? `<w:gridSpan w:val="${span}"/>` : ''}${shade}</w:tcPr>${inner}</w:tc>`;
    }).join('');
    return `<w:tr>${isHeader ? '<w:trPr><w:cantSplit/><w:tblHeader/></w:trPr>' : '<w:trPr><w:cantSplit/></w:trPr>'}${cells}</w:tr>`;
  }).join('');
  return `${head}${body}</w:tbl>${para('')}`;                                    // Word requires a paragraph after a table
}

export function blockXml(n: PmNode, ctx: RenderContext, extra: RunExtra = {}): string {
  switch (n.type) {
    case 'paragraph': return para(inlineXml(n.content, ctx, extra));
    case 'heading': {
      const level = Math.min(6, Math.max(1, Number(n.attrs?.level ?? 1)));
      const id = `Heading${level}`;
      if (ctx.styles.has(id)) return para(inlineXml(n.content, ctx), pStyle(id));
      const size = [32, 28, 26, 24, 22, 22][level - 1];
      return para(inlineXml(n.content, ctx, { bold: true, sizeHalfPt: size }), '<w:keepNext/>');
    }
    case 'bulletList': case 'orderedList': case 'taskList': return listXml(n, ctx, 0);
    case 'blockquote': {
      const q = ctx.styles.has('Quote') ? pStyle('Quote') : '<w:ind w:left="720"/>';
      return (n.content ?? []).map((b) => (b.type === 'paragraph' ? para(inlineXml(b.content, ctx, ctx.styles.has('Quote') ? {} : { italic: true }), q) : blockXml(b, ctx))).join('');
    }
    case 'codeBlock': {
      const text = (n.content ?? []).map((c) => c.text ?? '').join('');
      const style = ctx.styles.has('Code') ? pStyle('Code') : '<w:shd w:val="clear" w:color="auto" w:fill="F2F2F2"/><w:spacing w:after="0"/>';
      return text.split('\n').map((line) => para(`<w:r><w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:cs="Consolas"/><w:sz w:val="18"/></w:rPr><w:t xml:space="preserve">${esc(line)}</w:t></w:r>`, style)).join('');
    }
    case 'horizontalRule': return para('', '<w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="999999"/></w:pBdr>');
    case 'table': return tableXml(n, ctx);
    default: return n.content ? n.content.map((c) => blockXml(c, ctx)).join('') : '';
  }
}

/** Body XML for a whole document (a `doc` node or any list of blocks). */
export const docXml = (doc: PmNode, ctx: RenderContext) => (doc.content ?? []).map((b) => blockXml(b, ctx)).join('');

/** A simple grid for front matter (approval and revision tables). Header row first. */
export function simpleTable(header: string[], rows: string[][]): PmNode {
  const cell = (type: string, t: string): PmNode => ({ type, content: [{ type: 'paragraph', content: t ? [{ type: 'text', text: t }] : [] }] });
  return { type: 'table', content: [
    { type: 'tableRow', content: header.map((h) => cell('tableHeader', h)) },
    ...rows.map((r) => ({ type: 'tableRow', content: r.map((c) => cell('tableCell', c)) })),
  ] };
}
