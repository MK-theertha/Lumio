import { createRequire } from 'node:module';
import PDFDocument from 'pdfkit';
import { dec, money } from '../../shared/decimal.js';

export interface PdfCompany {
  legalName: string;
  taxRegistrationNumber?: string;
  address?: string;
}

interface PdfLine {
  lineId: string;
  sku: string;
  productName: string;
  tag?: string;
  purityLabel: string;
  grossWeight: string;
  netWeight: string;
  goldValue: string;
  wastageValue: string;
  makingCharge: string;
  discount: string;
  taxableValue: string;
  taxRatePercent: string;
  taxAmount: string;
  taxTreatment: string;
  lineTotal: string;
}

export interface PdfInvoice {
  number: string;
  docDate: string;
  dueDate?: string;
  currency: string;
  supplierInvoiceNo?: string;
  foreign?: { currency: string; exchangeRate: string; grandTotal: string };
  /** On a credit note, the invoice it corrects. */
  originalNumber?: string;
  notes?: string;
  partySnapshot: { name: string; taxRegistrationNumber?: string; billingAddress?: string };
  lines: PdfLine[];
  taxableTotal: string;
  taxTotal: string;
  discountTotal: string;
  grandTotal: string;
}

const require = createRequire(import.meta.url);
const ARABIC = 'Arabic';
const ARABIC_BOLD = 'Arabic-Bold';
const fontFile = (style: string) =>
  require.resolve(`@expo-google-fonts/noto-naskh-arabic/${style}/NotoNaskhArabic_${style}.ttf`);
const hasArabic = (text: string) => /[\u0600-\u06FF]/.test(text);
/** Kept as one run, because the line wrapper would otherwise lay out the words left to right. */
const shaped = (text: string) => (hasArabic(text) ? text.replace(/ /g, '\u00A0') : text);

const MARGIN = 36;
const FONT = 'Helvetica';
const BOLD = 'Helvetica-Bold';

const COLUMNS = [
  { title: 'Description', arabic: 'الوصف', width: 269, align: 'left' },
  { title: 'Gross (g)', arabic: 'الوزن القائم', width: 52, align: 'right' },
  { title: 'Net (g)', arabic: 'الوزن الصافي', width: 52, align: 'right' },
  { title: 'Gold value', arabic: 'قيمة الذهب', width: 66, align: 'right' },
  { title: 'Making', arabic: 'المصنعية', width: 58, align: 'right' },
  { title: 'Discount', arabic: 'الخصم', width: 52, align: 'right' },
  { title: 'Taxable', arabic: 'الخاضع للضريبة', width: 66, align: 'right' },
  { title: 'VAT %', arabic: 'النسبة', width: 36, align: 'right' },
  { title: 'VAT', arabic: 'الضريبة', width: 56, align: 'right' },
  { title: 'Total', arabic: 'الإجمالي', width: 64, align: 'right' },
] as const;

const TITLES = {
  SALE: { english: 'TAX INVOICE', arabic: 'فاتورة ضريبية' },
  PURCHASE: { english: 'PURCHASE INVOICE', arabic: 'فاتورة شراء' },
  CREDIT_NOTE: { english: 'TAX CREDIT NOTE', arabic: 'إشعار دائن ضريبي' },
} as const;

const day = (iso: string) => iso.slice(0, 10);

function lineCells(line: PdfLine): string[] {
  const reverseCharge = line.taxTreatment === 'REVERSE_CHARGE' ? ' (reverse charge)' : '';
  // Wastage is charged as gold value, and the invoice has no separate column for it.
  const gold = money(dec(line.goldValue).plus(dec(line.wastageValue)));
  return [
    `${line.sku} ${line.productName}${line.tag ? ` (${line.tag})` : ''}, ${line.purityLabel}${reverseCharge}`,
    line.grossWeight,
    line.netWeight,
    gold,
    money(line.makingCharge),
    money(line.discount),
    money(line.taxableValue),
    money(line.taxRatePercent),
    money(line.taxAmount),
    money(line.lineTotal),
  ];
}

/** Renders a posted invoice. Costs and margins are not part of the input, so they cannot leak. */
export function renderInvoicePdf(
  invoice: PdfInvoice,
  company: PdfCompany,
  kind: 'SALE' | 'PURCHASE' | 'CREDIT_NOTE',
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const pdf = new PDFDocument({
      size: 'A4',
      layout: 'landscape',
      margin: MARGIN,
      bufferPages: true,
      info: { Title: invoice.number, Author: company.legalName },
    });
    const chunks: Buffer[] = [];
    pdf.on('data', (chunk: Buffer) => chunks.push(chunk));
    pdf.on('end', () => resolve(Buffer.concat(chunks)));
    pdf.on('error', reject);
    pdf.registerFont(ARABIC, fontFile('400Regular'));
    pdf.registerFont(ARABIC_BOLD, fontFile('700Bold'));

    /** Names can be entered in Arabic, which the built-in Latin fonts cannot draw. */
    const fontFor = (text: string, latin: string) =>
      hasArabic(text) ? (latin === BOLD ? ARABIC_BOLD : ARABIC) : latin;

    const right = pdf.page.width - MARGIN;
    const bottom = pdf.page.height - MARGIN - 18;

    const tableHeader = (y: number): number => {
      pdf.rect(MARGIN, y, right - MARGIN, 28).fill('#eeeeee');
      pdf.fillColor('#000000');
      let x = MARGIN;
      for (const column of COLUMNS) {
        const options = { width: column.width - 6, align: column.align };
        pdf
          .font(BOLD)
          .fontSize(8)
          .text(column.title, x + 3, y + 3, options);
        pdf
          .font(ARABIC)
          .fontSize(7)
          .text(shaped(column.arabic), x + 3, y + 12, options);
        x += column.width;
      }
      return y + 32;
    };

    const title = TITLES[kind];
    pdf.font(BOLD).fontSize(18).text(title.english, MARGIN);
    pdf.font(ARABIC_BOLD).fontSize(13).text(shaped(title.arabic), MARGIN);
    pdf
      .moveDown(0.2)
      .font(fontFor(company.legalName, BOLD))
      .fontSize(11)
      .text(shaped(company.legalName));
    pdf.font(FONT).fontSize(9);
    if (company.address) pdf.text(company.address);
    if (company.taxRegistrationNumber) pdf.text(`TRN: ${company.taxRegistrationNumber}`);

    const companyBottom = pdf.y;
    const facts: [string, string | undefined][] = [
      ['Invoice no.', invoice.number],
      ['Date', day(invoice.docDate)],
      ['Due date', invoice.dueDate ? day(invoice.dueDate) : undefined],
      ['Currency', invoice.currency],
      ['Supplier invoice', invoice.supplierInvoiceNo],
      ['Credits invoice', invoice.originalNumber],
      [
        'Foreign total',
        invoice.foreign
          ? `${invoice.foreign.currency} ${invoice.foreign.grandTotal} at ${invoice.foreign.exchangeRate}`
          : undefined,
      ],
    ];
    let factY = MARGIN;
    for (const [label, value] of facts) {
      if (!value) continue;
      pdf.font(BOLD).text(label, right - 220, factY, { width: 90 });
      pdf.font(FONT).text(value, right - 130, factY, { width: 130, align: 'right' });
      factY += 13;
    }

    let y = Math.max(companyBottom, factY) + 14;
    const party = invoice.partySnapshot;
    pdf
      .font(BOLD)
      .fontSize(9)
      .text(kind === 'PURCHASE' ? 'Supplier' : 'Bill to', MARGIN, y);
    pdf.font(fontFor(party.name, FONT)).text(shaped(party.name));
    if (party.billingAddress) {
      pdf.font(fontFor(party.billingAddress, FONT)).text(shaped(party.billingAddress));
    }
    pdf.font(FONT);
    if (party.taxRegistrationNumber) pdf.text(`TRN: ${party.taxRegistrationNumber}`);

    y = tableHeader(pdf.y + 12);
    for (const line of invoice.lines) {
      const cells = lineCells(line);
      pdf.font(FONT).fontSize(8);
      const height = Math.max(
        pdf.heightOfString(cells[0] as string, { width: (COLUMNS[0].width as number) - 6 }),
        10,
      );
      if (y + height > bottom) {
        pdf.addPage();
        y = tableHeader(MARGIN);
        pdf.font(FONT).fontSize(8);
      }
      let x = MARGIN;
      cells.forEach((cell, index) => {
        const column = COLUMNS[index] as (typeof COLUMNS)[number];
        pdf
          .font(fontFor(cell, FONT))
          .text(shaped(cell), x + 3, y, { width: column.width - 6, align: column.align });
        x += column.width;
      });
      y += height + 6;
    }

    const totals: [string, string, boolean][] = [
      ['Total discount', money(invoice.discountTotal), false],
      ['Taxable amount', money(invoice.taxableTotal), false],
      ['VAT', money(invoice.taxTotal), false],
      [`Total (${invoice.currency})`, money(invoice.grandTotal), true],
    ];
    if (y + totals.length * 15 + 20 > bottom) {
      pdf.addPage();
      y = MARGIN;
    }
    y += 8;
    pdf
      .moveTo(right - 220, y)
      .lineTo(right, y)
      .stroke();
    y += 6;
    for (const [label, value, strong] of totals) {
      pdf.font(strong ? BOLD : FONT).fontSize(strong ? 11 : 9);
      pdf.text(label, right - 220, y, { width: 120 });
      pdf.text(value, right - 100, y, { width: 100, align: 'right' });
      y += 15;
    }
    if (invoice.notes) {
      pdf
        .font(FONT)
        .fontSize(8)
        .text(invoice.notes, MARGIN, y + 8, { width: right - MARGIN });
    }

    const range = pdf.bufferedPageRange();
    for (let page = 0; page < range.count; page += 1) {
      pdf.switchToPage(page);
      // The footer sits in the bottom margin, where pdfkit would otherwise start a new page.
      pdf.page.margins.bottom = 0;
      pdf
        .font(FONT)
        .fontSize(7)
        .fillColor('#666666')
        .text(
          `${invoice.number}  |  Page ${page + 1} of ${range.count}`,
          MARGIN,
          pdf.page.height - MARGIN - 8,
          { width: right - MARGIN, align: 'right', lineBreak: false },
        );
    }
    pdf.end();
  });
}
