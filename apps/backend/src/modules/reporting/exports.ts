import { strToU8, zipSync } from 'fflate';
import PDFDocument from 'pdfkit';

type Row = Record<string, unknown>;

const esc = (value: string) =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    // Characters XML 1.0 cannot carry at all.
    // eslint-disable-next-line no-control-regex -- removing control characters is the purpose
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');

const cellText = (value: unknown): string => {
  if (value === null || value === undefined) return '';
  return typeof value === 'object' ? JSON.stringify(value) : String(value);
};

function column(index: number): string {
  let name = '';
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) {
    name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
  }
  return name;
}

const headersOf = (rows: Row[]) => [...new Set(rows.flatMap((row) => Object.keys(row)))];

/** A minimal workbook. Text is written as text, so a value can never run as a formula. */
export function toXlsx(sheetName: string, rows: Row[]): Buffer {
  const headers = headersOf(rows);
  const cell = (value: string, rowIndex: number, columnIndex: number) => {
    const ref = `${column(columnIndex)}${rowIndex}`;
    return /^-?\d+(\.\d+)?$/.test(value)
      ? `<c r="${ref}"><v>${value}</v></c>`
      : `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${esc(value)}</t></is></c>`;
  };
  const sheetRows = [headers, ...rows.map((row) => headers.map((h) => cellText(row[h])))]
    .map(
      (values, index) =>
        `<row r="${index + 1}">${values.map((v, at) => cell(v, index + 1, at)).join('')}</row>`,
    )
    .join('');
  const NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
  const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
  const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
  return Buffer.from(
    zipSync({
      '[Content_Types].xml': strToU8(
        `${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`,
      ),
      '_rels/.rels': strToU8(
        `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
      ),
      'xl/workbook.xml': strToU8(
        `${XML}<workbook xmlns="${NS}" xmlns:r="${REL}"><sheets><sheet name="${esc(sheetName.slice(0, 31).replace(/[\\/?*[\]:]/g, ' '))}" sheetId="1" r:id="rId1"/></sheets></workbook>`,
      ),
      'xl/_rels/workbook.xml.rels': strToU8(
        `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`,
      ),
      'xl/worksheets/sheet1.xml': strToU8(
        `${XML}<worksheet xmlns="${NS}"><sheetData>${sheetRows}</sheetData></worksheet>`,
      ),
    }),
  );
}

const MARGIN = 36;

/** A simple paginated table, for reports and statements. */
export function toPdf(title: string, rows: Row[], subtitle?: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const pdf = new PDFDocument({ size: 'A4', layout: 'landscape', margin: MARGIN });
    const chunks: Buffer[] = [];
    pdf.on('data', (chunk: Buffer) => chunks.push(chunk));
    pdf.on('end', () => resolve(Buffer.concat(chunks)));
    pdf.on('error', reject);
    const headers = headersOf(rows);
    const width = (pdf.page.width - MARGIN * 2) / Math.max(headers.length, 1);
    const bottom = pdf.page.height - MARGIN - 14;

    const header = (top: number) => {
      pdf.font('Helvetica-Bold').fontSize(8);
      headers.forEach((h, i) => {
        pdf.text(h, MARGIN + i * width, top, {
          width: width - 4,
          lineBreak: false,
          ellipsis: true,
        });
      });
      pdf.font('Helvetica');
      return top + 14;
    };

    pdf.font('Helvetica-Bold').fontSize(14).text(title, MARGIN);
    if (subtitle) pdf.font('Helvetica').fontSize(9).text(subtitle);
    let y = header(pdf.y + 10);
    for (const row of rows) {
      if (y > bottom) {
        pdf.addPage();
        y = header(MARGIN);
      }
      pdf.fontSize(8);
      headers.forEach((h, i) => {
        pdf.text(cellText(row[h]), MARGIN + i * width, y, {
          width: width - 4,
          lineBreak: false,
          ellipsis: true,
        });
      });
      y += 12;
    }
    pdf.end();
  });
}
