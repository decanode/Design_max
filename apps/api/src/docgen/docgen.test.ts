import { describe, it, expect } from 'vitest';
import PizZip from 'pizzip';
import { XMLValidator } from 'fast-xml-parser';
import { markdownToPm, pmText, type PmNode } from './pm.js';
import { fillTemplate, applyTypography, styleIds } from './template.js';
import { baseTemplate } from './baseTemplate.js';
import { simpleTable, esc } from './ooxml.js';

const parts = (buf: Buffer) => { const z = new PizZip(buf); return (n: string) => z.file(n)!.asText(); };
const fill = (md: string, tokens: Record<string, string> = {}, extra: Partial<Parameters<typeof fillTemplate>[1]> = {}) =>
  fillTemplate(baseTemplate(), { tokens: { PROJECT_NAME: 'Acme Rollout', DOCUMENT_TYPE: 'Technical Specification', TICKET_TITLE: 'T', ...tokens }, body: markdownToPm(md), ...extra });

describe('markdown → structured content', () => {
  const find = (n: PmNode, type: string): PmNode[] => [n, ...(n.content ?? []).flatMap((c) => find(c, type))].filter((x) => x.type === type);
  it('maps headings, emphasis, links, lists, tasks, tables, quotes and code', () => {
    const doc = markdownToPm('# Title\n\nSome **bold**, *italic*, `code` and [a link](https://x.test).\n\n- one\n- two\n  - nested\n\n1. first\n2. second\n\n- [x] done\n- [ ] todo\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\n> quoted\n\n```\nlet x = 1;\n```');
    expect(find(doc, 'heading')[0].attrs?.level).toBe(1);
    const marks = find(doc, 'text').flatMap((t) => (t.marks ?? []).map((m) => m.type));
    expect(marks).toEqual(expect.arrayContaining(['bold', 'italic', 'code', 'link']));
    expect(find(doc, 'bulletList').length).toBeGreaterThanOrEqual(2);       // top level + nested
    expect(find(doc, 'orderedList')).toHaveLength(1);
    expect(find(doc, 'taskItem').map((t) => t.attrs?.checked)).toEqual([true, false]);
    expect(find(doc, 'tableHeader')).toHaveLength(2); expect(find(doc, 'tableCell')).toHaveLength(2);
    expect(find(doc, 'blockquote')).toHaveLength(1); expect(find(doc, 'codeBlock')).toHaveLength(1);
  });
  it('never throws: empty, hostile and odd input still give a valid document', () => {
    for (const md of ['', '   ', '<script>alert(1)</script>', '| broken | table\n|--', '\u0000\u0001 weird', '#'.repeat(50)]) {
      const d = markdownToPm(md); expect(d.type).toBe('doc'); expect(d.content!.length).toBeGreaterThan(0);
    }
    expect(pmText(markdownToPm('<script>alert(1)</script>'))).not.toContain('<script>');
  });
});

describe('filling the Word template', () => {
  it('produces a well-formed Word package that keeps the template\'s structure', () => {
    const out = fill('# Heading\n\nBody text.\n\n- a\n- b');
    const z = new PizZip(out.buffer);
    for (const n of ['[Content_Types].xml', '_rels/.rels', 'word/document.xml', 'word/styles.xml', 'word/numbering.xml', 'word/header1.xml', 'word/footer1.xml']) expect(z.file(n), n).toBeTruthy();
    for (const n of Object.keys(z.files).filter((f) => /\.(xml|rels)$/.test(f))) expect(XMLValidator.validate(z.file(n)!.asText()), n).toBe(true);
    const doc = parts(out.buffer)('word/document.xml');
    expect(doc).toContain('w:pStyle w:val="Heading1"'); expect(doc).toContain('w:pStyle w:val="ListBullet"');
    expect(doc).not.toContain('{{');                                    // no placeholder is left behind
    expect(parts(out.buffer)('word/header1.xml')).toContain('Acme Rollout');
  });

  it('fills a placeholder that Word has split across several text runs', () => {
    const z = new PizZip(baseTemplate());
    z.file('word/header1.xml', z.file('word/header1.xml')!.asText().replace(/<w:r><w:t xml:space="preserve">\{\{PROJECT_NAME\}\}/, '<w:r><w:t>{{PRO</w:t></w:r><w:r><w:rPr><w:b/></w:rPr><w:t>JECT_</w:t></w:r><w:r><w:t>NAME}}'));
    expect(z.file('word/header1.xml')!.asText()).not.toContain('{{PROJECT_NAME}}');
    const out = fillTemplate(z.generate({ type: 'nodebuffer' }) as Buffer, { tokens: { PROJECT_NAME: 'Split Co', DOCUMENT_TYPE: 'TS', TICKET_ID: 'X' }, body: markdownToPm('x') });
    expect(parts(out.buffer)('word/header1.xml')).toContain('Split Co');
    expect(parts(out.buffer)('word/header1.xml')).not.toContain('{{');
  });

  it('escapes everything it is given, so titles and content cannot break or inject into the file', () => {
    const nasty = `A & B <w:p>"quote"</w:p> ]]> \u0000`;
    const out = fill(`para with ${nasty.replace(/\|/g, '')}\n\n| h |\n|---|\n| ${'<b>x</b> & y'} |`, { TICKET_TITLE: nasty, PROJECT_NAME: nasty });
    const doc = parts(out.buffer)('word/document.xml');
    expect(doc).not.toMatch(/<w:p>"quote"/);                             // the text stayed text
    expect(doc).toContain('A &amp; B &lt;w:p&gt;');
    expect(doc).not.toContain('\u0000');
    expect(XMLValidator.validate(doc)).toBe(true);
    expect(esc('<&>"')).toBe('&lt;&amp;&gt;&quot;');
  });

  it('reports placeholders the template has but nobody supplied, and leaves no braces', () => {
    const z = new PizZip(baseTemplate());
    z.file('word/document.xml', z.file('word/document.xml')!.asText().replace('{{AUTHOR}}', '{{AUTHOR}} {{NOT_A_FIELD}}'));
    const out = fillTemplate(z.generate({ type: 'nodebuffer' }) as Buffer, { tokens: { PROJECT_NAME: 'x', DOCUMENT_TYPE: 'x', AUTHOR: 'Sam' }, body: markdownToPm('x') });
    expect(out.unknownTokens).toContain('NOT_A_FIELD');
    expect(parts(out.buffer)('word/document.xml')).not.toContain('{{');
  });

  it('renders tables and the generated front-matter blocks', () => {
    const out = fill('| Col A | Col B |\n|---|---|\n| 1 | 2 |', {}, { blocks: { APPROVALS: simpleTable(['Level', 'Approver'], [['L1', 'Mia']]), REVISIONS: simpleTable(['Version'], [['v1'], ['v2']]) } });
    const doc = parts(out.buffer)('word/document.xml');
    expect((doc.match(/<w:tbl>/g) ?? []).length).toBe(4);                // cover table + approvals + revisions + the body table
    expect(doc).toContain('<w:tblHeader/>'); expect(doc).toContain('Mia'); expect(doc).toContain('v2');
    expect(doc).toContain('w:fill="D9E2F3"');                            // header shading
  });

  it('turns safe links into real hyperlinks and ignores dangerous schemes', () => {
    const out = fill('[ok](https://example.com/x?a=1&b=2) and [bad](javascript:alert(1)) and [mail](mailto:a@b.co)');
    const rels = parts(out.buffer)('word/_rels/document.xml.rels'), doc = parts(out.buffer)('word/document.xml');
    expect(rels).toContain('Target="https://example.com/x?a=1&amp;b=2"'); expect(rels).toContain('mailto:a@b.co'); expect(rels).not.toContain('javascript');
    expect((doc.match(/<w:hyperlink /g) ?? []).length).toBe(2);
    expect(doc).toContain('bad');                                         // the text survives, just not clickable
  });

  it('falls back to direct formatting when a template lacks a style (company templates differ)', () => {
    const z = new PizZip(baseTemplate());
    z.file('word/styles.xml', z.file('word/styles.xml')!.asText().replace(/<w:style[^>]*w:styleId="(Heading1|ListBullet|ListNumber|TableGrid|Quote)"[\s\S]*?<\/w:style>/g, ''));
    const out = fillTemplate(z.generate({ type: 'nodebuffer' }) as Buffer, { tokens: { PROJECT_NAME: 'x', DOCUMENT_TYPE: 'x' }, body: markdownToPm('# H\n\n- a\n\n1. b\n\n> q\n\n| a |\n|---|\n| b |') });
    const doc = parts(out.buffer)('word/document.xml');
    expect(doc).not.toContain('w:val="Heading1"'); expect(doc).toContain('>• <'); expect(doc).toContain('>1. <');   // manual markers when the template has no list styles
    expect(doc).toContain('<w:tblBorders>');                              // explicit borders because TableGrid is missing
    expect(XMLValidator.validate(doc)).toBe(true);
  });
});

describe('fields and nested lists', () => {
  it('only edits the placeholder: page-number fields and their cached results are left alone', () => {
    const out = fill('x', { CONFIDENTIALITY: 'Confidential', VERSION: 'v1' });
    const footer = parts(out.buffer)('word/footer1.xml');
    expect(footer).toContain('PAGE'); expect(footer).toContain('NUMPAGES');
    expect((footer.match(/fldCharType="begin"/g) ?? []).length).toBe(2);
    expect((footer.match(/<w:t[^>]*>1<\/w:t>/g) ?? []).length).toBe(2);            // both field results untouched (the old code merged them into the text)
    expect(footer).toContain('Confidential');
  });
  it('indents nested lists with the template\'s level styles', () => {
    const doc = parts(fill('- a\n  - b\n    - c\n\n1. x\n   1. y').buffer)('word/document.xml');
    for (const id of ['ListBullet', 'ListBullet2', 'ListBullet3', 'ListNumber', 'ListNumber2']) expect(doc, id).toContain(`w:val="${id}"`);
  });
});

describe('fonts and sizes (document settings)', () => {
  it('applies body and heading fonts and sizes to the template\'s styles, in schema order', () => {
    const out = fill('# H\n\ntext', {}, { typography: { bodyFont: 'Arial', headingFont: 'Verdana', bodySizePt: 10, headingSizesPt: { h1: 20, h2: 16 } } });
    const styles = parts(out.buffer)('word/styles.xml');
    expect(XMLValidator.validate(styles)).toBe(true);
    const h1 = styles.match(/<w:style[^>]*w:styleId="Heading1"[\s\S]*?<\/w:style>/)![0];
    expect(h1).toContain('w:ascii="Verdana"'); expect(h1).toContain('<w:sz w:val="40"/>');
    expect(h1.indexOf('<w:color')).toBeLessThan(h1.indexOf('<w:sz '));   // sz comes after color, as Word requires
    const dflt = styles.match(/<w:rPrDefault>[\s\S]*?<\/w:rPrDefault>/)![0];
    expect(dflt).toContain('w:ascii="Arial"'); expect(dflt).toContain('<w:sz w:val="20"/>');
    expect(dflt.indexOf('<w:sz ')).toBeLessThan(dflt.indexOf('<w:lang'));  // and before lang
    expect(styles.match(/<w:sz w:val="[^"]*"\/>/g)!.filter((x) => x === '<w:sz w:val="40"/>')).toHaveLength(1);   // replaced, not duplicated
  });
  it('leaves a template untouched when no settings are given, and tolerates fonts with odd characters', () => {
    const base = parts(baseTemplate())('word/styles.xml');
    expect(applyTypography(base, undefined)).toBe(base);
    const out = applyTypography(base, { bodyFont: 'Evil"Font<>' });
    expect(XMLValidator.validate(out)).toBe(true); expect(out).not.toContain('Evil"Font<>');
    expect([...styleIds(base)]).toEqual(expect.arrayContaining(['Normal', 'Heading1', 'ListBullet', 'TableGrid']));
  });
});


// Real rendering: only runs where LibreOffice is installed (CI installs it; locally it is optional).
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const hasOffice = spawnSync('soffice', ['--version']).status === 0;
describe.skipIf(!hasOffice)('rendered by a real office suite', () => {
  it('opens without repair, paginates, and shows the project name, front matter, and correct page numbers', () => {
    const dir = mkdtempSync(join(tmpdir(), 'docx-'));
    const out = fill('# H\n\n' + 'Paragraph text. '.repeat(40) + '\n\n- a\n  - b', { PROJECT_NAME: 'Render Co', VERSION: 'v7' }, { blocks: { APPROVALS: simpleTable(['Level'], [['L1']]) } });
    writeFileSync(join(dir, 'x.docx'), out.buffer);
    execFileSync('soffice', ['--headless', '--convert-to', 'pdf', '--outdir', dir, join(dir, 'x.docx')], { timeout: 90_000 });
    const pdf = readFileSync(join(dir, 'x.pdf'));
    expect(pdf.subarray(0, 4).toString()).toBe('%PDF');
    const txt = spawnSync('pdftotext', [join(dir, 'x.pdf'), '-'], { encoding: 'utf8' });
    if (txt.status === 0) {
      expect(txt.stdout).toContain('Render Co'); expect(txt.stdout).toContain('Approvals'); expect(txt.stdout).toContain('Version v7');
      expect(txt.stdout).toMatch(/Page 1 of 2/); expect(txt.stdout).toMatch(/Page 2 of 2/);
    }
  }, 120_000);
});
