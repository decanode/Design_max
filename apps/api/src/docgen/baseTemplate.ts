import PizZip from 'pizzip';

/**
 * A stand-in Word template (cover page, header/footer, standard styles) used until a project's own company template is
 * uploaded. It is a normal .docx written to the same rules as a real template: everything is filled through {{PLACEHOLDERS}},
 * so a company file with the same placeholders drops in without any code change.
 */
const NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const t = (s: string) => `<w:r><w:t xml:space="preserve">${s}</w:t></w:r>`;
const p = (inner: string, pPr = '') => `<w:p>${pPr ? `<w:pPr>${pPr}</w:pPr>` : ''}${inner}</w:p>`;
const style = (id: string, name: string, body: string, type = 'paragraph', extra = '') => `<w:style w:type="${type}" ${extra} w:styleId="${id}"><w:name w:val="${name}"/>${body}</w:style>`;
const cell = (txt: string, w: number, bold = false) => `<w:tc><w:tcPr><w:tcW w:w="${w}" w:type="dxa"/>${bold ? '<w:shd w:val="clear" w:color="auto" w:fill="D9E2F3"/>' : ''}</w:tcPr>${p(`<w:r>${bold ? '<w:rPr><w:b/></w:rPr>' : ''}<w:t xml:space="preserve">${txt}</w:t></w:r>`)}</w:tc>`;
const infoRow = (k: string, v: string) => `<w:tr>${cell(k, 2400, true)}${cell(v, 6600)}</w:tr>`;

function documentXml() {
  const info = ['Project|{{PROJECT_NAME}}', 'Ticket|{{TICKET_ID}} · {{TICKET_TITLE}}', 'Document|{{DOCUMENT_TYPE}}', 'Version|{{VERSION}}', 'Status|{{STATUS}}', 'Date|{{DATE}}', 'Prepared by|{{AUTHOR}}', 'Customer|{{CUSTOMER}}', 'Technology|{{TECHNOLOGY}}'].map((r) => infoRow(...(r.split('|') as [string, string]))).join('');
  return `${XML}<w:document ${NS}><w:body>
${p(t('{{DOCUMENT_TYPE}}'), '<w:pStyle w:val="Title"/>')}
${p(t('{{TICKET_TITLE}}'), '<w:pStyle w:val="Subtitle"/>')}
<w:tbl><w:tblPr><w:tblStyle w:val="TableGrid"/><w:tblW w:w="5000" w:type="pct"/></w:tblPr><w:tblGrid><w:gridCol w:w="2400"/><w:gridCol w:w="6600"/></w:tblGrid>${info}</w:tbl>
${p('')}
${p(t('Approvals'), '<w:pStyle w:val="Heading2"/>')}
${p(t('{{APPROVALS}}'))}
${p(t('Revision history'), '<w:pStyle w:val="Heading2"/>')}
${p(t('{{REVISIONS}}'))}
${p('<w:r><w:br w:type="page"/></w:r>')}
${p(t('{{BODY}}'))}
<w:sectPr><w:headerReference w:type="default" r:id="rId5"/><w:footerReference w:type="default" r:id="rId6"/><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1260" w:bottom="1300" w:left="1260" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr>
</w:body></w:document>`;
}

const stylesXml = () => `${XML}<w:styles xmlns:w="${W}">
<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Calibri" w:eastAsia="Calibri"/><w:sz w:val="22"/><w:szCs w:val="22"/><w:lang w:val="en-GB"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="264" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>
${style('Normal', 'Normal', '<w:qFormat/>', 'paragraph', 'w:default="1"')}
${style('Title', 'Title', '<w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:spacing w:before="1800" w:after="120"/></w:pPr><w:rPr><w:rFonts w:ascii="Calibri Light" w:hAnsi="Calibri Light"/><w:color w:val="1F3864"/><w:sz w:val="56"/><w:szCs w:val="56"/></w:rPr>')}
${style('Subtitle', 'Subtitle', '<w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:spacing w:after="360"/></w:pPr><w:rPr><w:color w:val="595959"/><w:sz w:val="30"/><w:szCs w:val="30"/></w:rPr>')}
${[1, 2, 3, 4, 5, 6].map((n) => style(`Heading${n}`, `heading ${n}`, `<w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="${n === 1 ? 360 : 240}" w:after="80"/><w:outlineLvl w:val="${n - 1}"/></w:pPr><w:rPr><w:b/><w:color w:val="1F3864"/><w:sz w:val="${[32, 28, 26, 24, 22, 22][n - 1]}"/><w:szCs w:val="${[32, 28, 26, 24, 22, 22][n - 1]}"/></w:rPr>`)).join('\n')}
${style('ListBullet', 'List Bullet', '<w:basedOn w:val="Normal"/><w:pPr><w:numPr><w:numId w:val="1"/></w:numPr><w:spacing w:after="40"/></w:pPr>')}
${style('ListNumber', 'List Number', '<w:basedOn w:val="Normal"/><w:pPr><w:numPr><w:numId w:val="2"/></w:numPr><w:spacing w:after="40"/></w:pPr>')}
${[2, 3].map((n) => style(`ListBullet${n}`, `List Bullet ${n}`, `<w:basedOn w:val="Normal"/><w:pPr><w:numPr><w:ilvl w:val="${n - 1}"/><w:numId w:val="1"/></w:numPr><w:spacing w:after="40"/></w:pPr>`)).join('\n')}
${[2, 3].map((n) => style(`ListNumber${n}`, `List Number ${n}`, `<w:basedOn w:val="Normal"/><w:pPr><w:numPr><w:ilvl w:val="${n - 1}"/><w:numId w:val="2"/></w:numPr><w:spacing w:after="40"/></w:pPr>`)).join('\n')}
${style('Quote', 'Quote', '<w:basedOn w:val="Normal"/><w:pPr><w:pBdr><w:left w:val="single" w:sz="18" w:space="8" w:color="BFBFBF"/></w:pBdr><w:ind w:left="720"/></w:pPr><w:rPr><w:i/><w:color w:val="595959"/></w:rPr>')}
${style('Hyperlink', 'Hyperlink', '<w:rPr><w:color w:val="0563C1"/><w:u w:val="single"/></w:rPr>', 'character')}
${style('TableGrid', 'Table Grid', '<w:tblPr><w:tblBorders>' + ['top', 'left', 'bottom', 'right', 'insideH', 'insideV'].map((b) => `<w:${b} w:val="single" w:sz="4" w:space="0" w:color="999999"/>`).join('') + '</w:tblBorders><w:tblCellMar><w:left w:w="100" w:type="dxa"/><w:right w:w="100" w:type="dxa"/></w:tblCellMar></w:tblPr>', 'table')}
</w:styles>`;

const numberingXml = () => `${XML}<w:numbering xmlns:w="${W}">
<w:abstractNum w:abstractNumId="0"><w:multiLevelType w:val="hybridMultilevel"/>${[0, 1, 2].map((l) => `<w:lvl w:ilvl="${l}"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="${['•', '–', '◦'][l]}"/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="${720 + l * 360}" w:hanging="360"/></w:pPr></w:lvl>`).join('')}</w:abstractNum>
<w:abstractNum w:abstractNumId="1"><w:multiLevelType w:val="hybridMultilevel"/>${[0, 1, 2].map((l) => `<w:lvl w:ilvl="${l}"><w:start w:val="1"/><w:numFmt w:val="${['decimal', 'lowerLetter', 'lowerRoman'][l]}"/><w:lvlText w:val="%${l + 1}."/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="${720 + l * 360}" w:hanging="360"/></w:pPr></w:lvl>`).join('')}</w:abstractNum>
<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num><w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num></w:numbering>`;

const header = () => `${XML}<w:hdr ${NS}>${p(t('{{PROJECT_NAME}}  ·  {{DOCUMENT_TYPE}}  ·  {{TICKET_ID}}'), '<w:pBdr><w:bottom w:val="single" w:sz="4" w:space="4" w:color="BFBFBF"/></w:pBdr>')}</w:hdr>`;
const field = (instr: string) => `<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> ${instr} </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>1</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r>`;
const footer = () => `${XML}<w:ftr ${NS}>${p(`${t('{{CONFIDENTIALITY}}   ·   Version {{VERSION}}   ·   Page ')}${field('PAGE')}${t(' of ')}${field('NUMPAGES')}`, '<w:jc w:val="center"/>')}</w:ftr>`;

const CT = (kind: string) => `application/vnd.openxmlformats-officedocument.wordprocessingml.${kind}+xml`;
let cached: Buffer | undefined;

/** The stand-in template as a .docx file. */
export function baseTemplate(): Buffer {
  if (cached) return cached;
  const z = new PizZip();
  z.file('[Content_Types].xml', `${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="${CT('document.main')}"/><Override PartName="/word/styles.xml" ContentType="${CT('styles')}"/><Override PartName="/word/numbering.xml" ContentType="${CT('numbering')}"/><Override PartName="/word/settings.xml" ContentType="${CT('settings')}"/><Override PartName="/word/header1.xml" ContentType="${CT('header')}"/><Override PartName="/word/footer1.xml" ContentType="${CT('footer')}"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>`);
  z.file('_rels/.rels', `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/></Relationships>`);
  const rel = (id: number, type: string, target: string) => `<Relationship Id="rId${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${type}" Target="${target}"/>`;
  z.file('word/_rels/document.xml.rels', `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rel(1, 'styles', 'styles.xml')}${rel(2, 'numbering', 'numbering.xml')}${rel(3, 'settings', 'settings.xml')}${rel(5, 'header', 'header1.xml')}${rel(6, 'footer', 'footer1.xml')}</Relationships>`);
  z.file('word/document.xml', documentXml());
  z.file('word/styles.xml', stylesXml());
  z.file('word/numbering.xml', numberingXml());
  z.file('word/settings.xml', `${XML}<w:settings xmlns:w="${W}"><w:updateFields w:val="true"/></w:settings>`);
  z.file('word/header1.xml', header());
  z.file('word/footer1.xml', footer());
  z.file('docProps/core.xml', `${XML}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title></dc:title><dc:creator>Design Max</dc:creator></cp:coreProperties>`);
  z.file('docProps/app.xml', `${XML}<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>Design Max</Application></Properties>`);
  cached = z.generate({ type: 'nodebuffer', compression: 'DEFLATE' }) as Buffer;
  return cached;
}
