export const escapeXml = (value: string): string =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');

/** Renders an element, omitting it when there is no value, as goAML optional fields expect. */
const el = (name: string, value: string | undefined): string =>
  value ? `<${name}>${escapeXml(value)}</${name}>` : '';

export interface GoamlParty {
  name: string;
  type: 'INDIVIDUAL' | 'BUSINESS';
  taxRegistrationNumber?: string;
  dateOfBirth?: string;
  nationality?: string;
  address?: string;
  phone?: string;
  identification?: { type: string; number: string; expiresAt?: string };
}

export interface GoamlTransaction {
  number: string;
  date: string;
  amount: string;
  description: string;
  /** Who funds moved from, from the reporting entity's point of view. */
  direction: 'FROM_PARTY' | 'TO_PARTY';
  mode: string;
  party: GoamlParty;
}

export interface GoamlReportData {
  reportType: 'DPMSR' | 'STR';
  reference: string;
  entityId: string;
  submissionDate: string;
  currency: string;
  reporter: { firstName: string; lastName: string; email: string };
  reason: string;
  action?: string;
  indicators: string[];
  transactions: GoamlTransaction[];
}

export function splitName(name: string): { firstName: string; lastName: string } {
  const parts = name.trim().split(/\s+/);
  const lastName = parts.length > 1 ? (parts.pop() as string) : (parts[0] as string);
  return { firstName: parts.join(' '), lastName };
}

function renderParty(party: GoamlParty): string {
  if (party.type === 'BUSINESS') {
    return `<entity>${el('name', party.name)}${el('tax_number', party.taxRegistrationNumber)}${el('incorporation_address', party.address)}</entity>`;
  }
  const { firstName, lastName } = splitName(party.name);
  const id = party.identification;
  return [
    '<person>',
    el('first_name', firstName),
    el('last_name', lastName),
    el('birthdate', party.dateOfBirth),
    el('nationality1', party.nationality),
    el('phone', party.phone),
    el('address', party.address),
    id
      ? `<identification>${el('type', id.type)}${el('number', id.number)}${el('expiry_date', id.expiresAt)}</identification>`
      : '',
    '</person>',
  ].join('');
}

function renderTransaction(t: GoamlTransaction, entityId: string): string {
  const party = renderParty(t.party);
  const reportingEntity = el('rentity_id', entityId);
  const [from, to] =
    t.direction === 'FROM_PARTY'
      ? [`<t_from>${party}</t_from>`, `<t_to_my_client>${reportingEntity}</t_to_my_client>`]
      : [`<t_from_my_client>${reportingEntity}</t_from_my_client>`, `<t_to>${party}</t_to>`];
  return [
    '<transaction>',
    el('transactionnumber', t.number),
    el('transaction_description', t.description),
    el('date_transaction', t.date),
    el('transmode_code', t.mode),
    el('amount_local', t.amount),
    from,
    to,
    '</transaction>',
  ].join('');
}

/**
 * Follows the element naming of the UNODC goAML report schema. It has not been validated against
 * the XSD issued by the UAE FIU, which is available only to registered reporting entities.
 */
export function renderGoamlXml(report: GoamlReportData): string {
  const indicators = report.indicators.length
    ? `<report_indicators>${report.indicators.map((i) => el('indicator', i)).join('')}</report_indicators>`
    : '';
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<report>',
    el('rentity_id', report.entityId),
    el('submission_code', 'E'),
    el('report_code', report.reportType),
    el('entity_reference', report.reference),
    el('submission_date', report.submissionDate),
    el('currency_code_local', report.currency),
    '<reporting_person>',
    el('first_name', report.reporter.firstName),
    el('last_name', report.reporter.lastName),
    el('email', report.reporter.email),
    '</reporting_person>',
    el('reason', report.reason),
    el('action', report.action),
    ...report.transactions.map((t) => renderTransaction(t, report.entityId)),
    indicators,
    '</report>',
  ].join('');
}

/** Facts the schema expects that this record does not hold, shown to the preparer before approval. */
export function reportWarnings(report: GoamlReportData): string[] {
  const warnings: string[] = [];
  if (!report.entityId) warnings.push('The company has no goAML reporting entity ID.');
  const parties = new Map(report.transactions.map((t) => [t.party.name, t.party]));
  for (const party of parties.values()) {
    if (party.type === 'BUSINESS') {
      if (!party.taxRegistrationNumber) warnings.push(`${party.name}: no tax registration number.`);
      continue;
    }
    if (!party.dateOfBirth) warnings.push(`${party.name}: no date of birth.`);
    if (!party.nationality) warnings.push(`${party.name}: no nationality.`);
    if (!party.identification) warnings.push(`${party.name}: no KYC identity document.`);
  }
  return warnings;
}
