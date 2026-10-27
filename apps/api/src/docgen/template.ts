import PizZip from 'pizzip';
import { XMLValidator } from 'fast-xml-parser';
import { docXml, esc, newContext, blockXml, type RenderContext } from './ooxml.js';
import type { PmNode } from './pm.js';

/**
 * Fills a Word (.docx) template. The template keeps its own design: cover page, headers, footers, styles, fixed text.
 * Placeholders are written in the template as {{NAME}}:
 *   {{BODY}}       a paragraph that is replaced by the document's content
 *   {{APPROVALS}}  … / {{REVISIONS}}   paragraphs replaced by a generated table (block placeholders)
 *   {{ANYTHING}}   replaced by plain text from `tokens`, anywhere (body, headers, footers, tables)
 */
export interface Typography {
  bodyFont?: string; headingFont?: string;
  bodySizePt?: number; headingSizesPt?: { h1?: number; h2?: number; h3?: number };
}
export interface FillInput {
  tokens: Record<string, string>;
  body: PmNode;
  blocks?: Record<string, PmNode>;           // e.g. { APPROVALS: table, REVISIONS: table }
  typography?: Typography;
  title?: string;                            // document property shown by Word and the file manager
}
export interface FillResult { buffer: Buffer; unknownTokens: string[] }

const PART = /^word\/(document|header\d*|footer\d*)\.xml$/;
const TOKEN = /\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g;

/** Style ids in styles.xml, so rendering can use the template's own styles when they exist. */
export function styleIds(stylesXml: string): Set<string> {
  return new Set([...stylesXml.matchAll(/<w:style\b[^>]*\bw:styleId="([^"]+)"/g)].map((m) => m[1]));
}

/**
 * Word often splits one visible placeholder across several text runs ("{{PRO", "JECT_", "NAME}}"). To find it we look at the
 * paragraph's text as a whole, but we only EDIT the characters of the placeholder itself, in place. Everything else in the
 * paragraph (other runs, their formatting, and field results such as page numbers) is left exactly as it was.
 */
const unesc = (s: string) => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'");
interface Mapper { block: (name: string) => string | null; token: (name: string) => string }

function mapParagraphs(xml: string, m: Mapper): string {
  return xml.replace(/<w:p\b[^>]*>[\s\S]*?<\/w:p>/g, (p) => {
    const segs = [...p.matchAll(/<w:t\b[^>]*>([\s\S]*?)<\/w:t>/g)];
    if (!segs.length) return p;
    const plains = segs.map((x) => unesc(x[1]));
    const joined = plains.join('');
    if (!joined.includes('{{')) return p;
    const only = joined.trim().match(/^\{\{\s*([A-Za-z0-9_]+)\s*\}\}$/);
    if (only) { const b = m.block(only[1]); if (b !== null) return b; }
    const hits = [...joined.matchAll(TOKEN)].map((x) => ({ s: x.index!, e: x.index! + x[0].length, rep: m.token(x[1]) }));
    if (!hits.length) return p;
    let a = 0, i = 0;
    const rewritten = plains.map((plain) => {
      const from = a, to = a + plain.length; a = to;
      let cur = from, text = '';
      for (const h of hits) {
        if (h.e <= from || h.s >= to) continue;
        const lo = Math.max(h.s, from), hi = Math.min(h.e, to);
        if (lo > cur) text += plain.slice(cur - from, lo - from);
        if (h.s >= from) text += h.rep;              // the run where the placeholder starts carries its replacement
        cur = hi;
      }
      return text + (cur < to ? plain.slice(cur - from) : '');
    });
    return p.replace(/<w:t\b[^>]*>[\s\S]*?<\/w:t>/g, () => `<w:t xml:space="preserve">${esc(rewritten[i++])}</w:t>`);
  });
}

/** Sets font and size on one style (or the document defaults), inserting what is missing and dropping theme fonts that would override. */
function setStyleRun(xml: string, styleId: string | null, o: { font?: string; sizePt?: number }): string {
  if (!o.font && !o.sizePt) return xml;
  // Insert in schema order: rFonts right after rStyle; sz/szCs before the properties that must follow them.
  const AFTER_SZ = ['w:highlight', 'w:u', 'w:effect', 'w:bdr', 'w:shd', 'w:fitText', 'w:vertAlign', 'w:rtl', 'w:cs', 'w:em', 'w:lang', 'w:eastAsianLayout', 'w:specVanish', 'w:oMath'];
  const fix = (rPr: string) => {
    let r = rPr;
    if (o.font) {
      const f = `<w:rFonts w:ascii="${esc(o.font)}" w:hAnsi="${esc(o.font)}" w:cs="${esc(o.font)}" w:eastAsia="${esc(o.font)}"/>`;
      if (/<w:rFonts\b[^>]*\/>/.test(r)) r = r.replace(/<w:rFonts\b[^>]*\/>/, f);
      else { const m = r.match(/^<w:rStyle\b[^>]*\/>/); r = m ? m[0] + f + r.slice(m[0].length) : f + r; }
    }
    if (o.sizePt) {
      const half = Math.round(o.sizePt * 2);
      r = r.replace(/<w:szCs\b[^>]*\/>/g, '').replace(/<w:sz\b[^>]*\/>/g, '');
      const at = AFTER_SZ.map((tag) => r.search(new RegExp(`<${tag}[\\s/>]`))).filter((i) => i >= 0).sort((x, y) => x - y)[0];
      const sz = `<w:sz w:val="${half}"/><w:szCs w:val="${half}"/>`;
      r = at === undefined ? r + sz : r.slice(0, at) + sz + r.slice(at);
    }
    return r;
  };
  if (styleId === null) {                                                        // document defaults
    return xml.replace(/<w:rPrDefault>\s*<w:rPr>([\s\S]*?)<\/w:rPr>\s*<\/w:rPrDefault>/, (_m, r) => `<w:rPrDefault><w:rPr>${fix(r)}</w:rPr></w:rPrDefault>`);
  }
  return xml.replace(new RegExp(`(<w:style\\b[^>]*w:styleId="${styleId}"[^>]*>)([\\s\\S]*?)(</w:style>)`), (_m, open, inner, close) => {
    if (/<w:rPr>/.test(inner)) return `${open}${inner.replace(/<w:rPr>([\s\S]*?)<\/w:rPr>/, (_x: string, r: string) => `<w:rPr>${fix(r)}</w:rPr>`)}${close}`;
    return `${open}${inner}<w:rPr>${fix('')}</w:rPr>${close}`;
  });
}

export function applyTypography(stylesXml: string, t: Typography | undefined): string {
  if (!t) return stylesXml;
  let x = stylesXml;
  x = setStyleRun(x, null, { font: t.bodyFont, sizePt: t.bodySizePt });
  x = setStyleRun(x, 'Normal', { font: t.bodyFont, sizePt: t.bodySizePt });
  for (const [id, size] of [['Heading1', t.headingSizesPt?.h1], ['Heading2', t.headingSizesPt?.h2], ['Heading3', t.headingSizesPt?.h3]] as const)
    x = setStyleRun(x, id, { font: t.headingFont, sizePt: size });
  if (t.headingFont) for (const id of ['Title', 'Heading4', 'Heading5', 'Heading6']) x = setStyleRun(x, id, { font: t.headingFont });
  return x;
}

export function fillTemplate(template: Buffer, input: FillInput): FillResult {
  const zip = new PizZip(template);
  const stylesFile = zip.file('word/styles.xml');
  const ctx: RenderContext = newContext(stylesFile ? styleIds(stylesFile.asText()) : new Set());
  const unknown = new Set<string>();

  for (const name of Object.keys(zip.files).filter((n) => PART.test(n))) {
    const isDoc = name === 'word/document.xml';
    zip.file(name, mapParagraphs(zip.file(name)!.asText(), {
      block: (k) => (isDoc && k === 'BODY' ? docXml(input.body, ctx) : isDoc && input.blocks?.[k] ? blockXml(input.blocks[k], ctx) : null),
      token: (k) => { if (k in input.tokens) return input.tokens[k]; unknown.add(k); return ''; },
    }));
  }

  if (stylesFile) zip.file('word/styles.xml', applyTypography(stylesFile.asText(), input.typography));

  // Hyperlinks need relationships in document.xml.rels
  if (ctx.links.size) {
    const relsName = 'word/_rels/document.xml.rels';
    const rels = zip.file(relsName)?.asText() ?? '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>';
    const add = [...ctx.links].map(([href, id]) => `<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="${esc(href)}" TargetMode="External"/>`).join('');
    zip.file(relsName, rels.replace('</Relationships>', `${add}</Relationships>`));
  }

  // Document title property
  if (input.title && zip.file('docProps/core.xml')) {
    const core = zip.file('docProps/core.xml')!.asText();
    zip.file('docProps/core.xml', /<dc:title>[\s\S]*?<\/dc:title>|<dc:title\s*\/>/.test(core) ? core.replace(/<dc:title>[\s\S]*?<\/dc:title>|<dc:title\s*\/>/, `<dc:title>${esc(input.title)}</dc:title>`) : core.replace('</cp:coreProperties>', `<dc:title>${esc(input.title)}</dc:title></cp:coreProperties>`));
  }

  // Never hand back a file Word would refuse: every XML part must be well-formed.
  for (const name of Object.keys(zip.files).filter((n) => /\.(xml|rels)$/.test(n))) {
    const ok = XMLValidator.validate(zip.file(name)!.asText());
    if (ok !== true) throw new Error(`Generated ${name} is not well-formed XML: ${ok.err.msg}`);
  }
  return { buffer: zip.generate({ type: 'nodebuffer', compression: 'DEFLATE' }) as Buffer, unknownTokens: [...unknown] };
}
