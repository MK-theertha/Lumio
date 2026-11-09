import { dec, Decimal, money } from '../../shared/decimal.js';

export interface UblParty {
  name: string;
  taxRegistrationNumber?: string;
  address?: string;
}

export interface UblLine {
  lineId: string;
  productName: string;
  netWeight: string;
  taxableValue: string;
  taxAmount: string;
  taxRatePercent: string;
  taxTreatment: string;
}

export interface UblInvoice {
  number: string;
  docDate: string;
  dueDate?: string;
  currency: string;
  seller: UblParty;
  buyer: UblParty;
  lines: UblLine[];
  taxableTotal: string;
  taxTotal: string;
  grandTotal: string;
}

const CATEGORY: Record<string, string> = {
  STANDARD: 'S',
  ZERO: 'Z',
  EXEMPT: 'E',
  REVERSE_CHARGE: 'AE',
  OUT_OF_SCOPE: 'O',
};

const esc = (value: string) =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const amount = (name: string, value: string, currency: string) =>
  `<cbc:${name} currencyID="${esc(currency)}">${money(value)}</cbc:${name}>`;

function taxCategory(tag: string, treatment: string, rate: string): string {
  return (
    `<cac:${tag}><cbc:ID>${CATEGORY[treatment] ?? 'O'}</cbc:ID>` +
    `<cbc:Percent>${money(rate)}</cbc:Percent>` +
    `<cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme></cac:${tag}>`
  );
}

function party(tag: string, p: UblParty): string {
  const trn = p.taxRegistrationNumber ? esc(p.taxRegistrationNumber) : '';
  return (
    `<cac:${tag}><cac:Party>` +
    (trn ? `<cbc:EndpointID schemeID="0235">${trn}</cbc:EndpointID>` : '') +
    `<cac:PartyName><cbc:Name>${esc(p.name)}</cbc:Name></cac:PartyName>` +
    (p.address
      ? `<cac:PostalAddress><cbc:StreetName>${esc(p.address)}</cbc:StreetName><cac:Country><cbc:IdentificationCode>AE</cbc:IdentificationCode></cac:Country></cac:PostalAddress>`
      : '') +
    (trn
      ? `<cac:PartyTaxScheme><cbc:CompanyID>${trn}</cbc:CompanyID><cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme></cac:PartyTaxScheme>`
      : '') +
    `<cac:PartyLegalEntity><cbc:RegistrationName>${esc(p.name)}</cbc:RegistrationName></cac:PartyLegalEntity>` +
    `</cac:Party></cac:${tag}>`
  );
}

function taxSubtotals(invoice: UblInvoice): string {
  const groups = new Map<
    string,
    { treatment: string; rate: string; base: Decimal; tax: Decimal }
  >();
  for (const line of invoice.lines) {
    const key = `${line.taxTreatment}|${money(line.taxRatePercent)}`;
    const group = groups.get(key) ?? {
      treatment: line.taxTreatment,
      rate: line.taxRatePercent,
      base: new Decimal(0),
      tax: new Decimal(0),
    };
    group.base = group.base.plus(dec(line.taxableValue));
    group.tax = group.tax.plus(dec(line.taxAmount));
    groups.set(key, group);
  }
  return [...groups.values()]
    .map(
      (g) =>
        `<cac:TaxSubtotal>${amount('TaxableAmount', g.base.toFixed(), invoice.currency)}` +
        `${amount('TaxAmount', g.tax.toFixed(), invoice.currency)}` +
        `${taxCategory('TaxCategory', g.treatment, g.rate)}</cac:TaxSubtotal>`,
    )
    .join('');
}

function invoiceLine(line: UblLine, index: number, currency: string): string {
  const net = dec(line.netWeight);
  const unitPrice = net.isZero() ? dec(line.taxableValue) : dec(line.taxableValue).dividedBy(net);
  return (
    `<cac:InvoiceLine><cbc:ID>${index + 1}</cbc:ID>` +
    `<cbc:InvoicedQuantity unitCode="GRM">${net.toFixed(3)}</cbc:InvoicedQuantity>` +
    amount('LineExtensionAmount', line.taxableValue, currency) +
    `<cac:Item><cbc:Name>${esc(line.productName)}</cbc:Name>` +
    `${taxCategory('ClassifiedTaxCategory', line.taxTreatment, line.taxRatePercent)}</cac:Item>` +
    `<cac:Price><cbc:PriceAmount currencyID="${esc(currency)}">${unitPrice.toFixed(4)}</cbc:PriceAmount></cac:Price>` +
    `</cac:InvoiceLine>`
  );
}

/**
 * UBL 2.1 invoice in the shape of Peppol PINT. The PINT AE identifiers below are the best available
 * reading of the specification and must be confirmed with the accredited service provider.
 */
export function renderUblInvoice(invoice: UblInvoice): string {
  const { currency } = invoice;
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2"',
    ' xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2"',
    ' xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2">',
    '<cbc:CustomizationID>urn:peppol:pint:billing-1@ae-1</cbc:CustomizationID>',
    '<cbc:ProfileID>urn:peppol:bis:billing</cbc:ProfileID>',
    `<cbc:ID>${esc(invoice.number)}</cbc:ID>`,
    `<cbc:IssueDate>${invoice.docDate.slice(0, 10)}</cbc:IssueDate>`,
    invoice.dueDate ? `<cbc:DueDate>${invoice.dueDate.slice(0, 10)}</cbc:DueDate>` : '',
    '<cbc:InvoiceTypeCode>380</cbc:InvoiceTypeCode>',
    `<cbc:DocumentCurrencyCode>${esc(currency)}</cbc:DocumentCurrencyCode>`,
    party('AccountingSupplierParty', invoice.seller),
    party('AccountingCustomerParty', invoice.buyer),
    `<cac:TaxTotal>${amount('TaxAmount', invoice.taxTotal, currency)}${taxSubtotals(invoice)}</cac:TaxTotal>`,
    '<cac:LegalMonetaryTotal>',
    amount('LineExtensionAmount', invoice.taxableTotal, currency),
    amount('TaxExclusiveAmount', invoice.taxableTotal, currency),
    amount('TaxInclusiveAmount', invoice.grandTotal, currency),
    amount('PayableAmount', invoice.grandTotal, currency),
    '</cac:LegalMonetaryTotal>',
    ...invoice.lines.map((line, index) => invoiceLine(line, index, currency)),
    '</Invoice>',
  ].join('');
}
