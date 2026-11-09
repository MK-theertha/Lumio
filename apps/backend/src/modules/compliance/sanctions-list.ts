import { parseCsv } from '@lumio/shared-utils';
import { XMLParser } from 'fast-xml-parser';
import { BusinessRuleError } from '../../shared/errors.js';

export interface ParsedEntry {
  externalId: string;
  name: string;
  aliases: string[];
  type: 'INDIVIDUAL' | 'ENTITY';
  dateOfBirth?: string;
  nationality?: string;
  program?: string;
}

export interface ParsedList {
  version: string;
  entries: ParsedEntry[];
}

type Node = Record<string, unknown>;

const text = (value: unknown): string =>
  typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
const nodes = (value: unknown): Node[] =>
  (Array.isArray(value) ? value : value ? [value] : []) as Node[];
const compact = (values: string[]) => [...new Set(values.filter(Boolean))];

function aliasesOf(entry: Node, tag: string): string[] {
  return compact([
    ...nodes(entry[tag]).map((alias) => text(alias.ALIAS_NAME)),
    text(entry.NAME_ORIGINAL_SCRIPT),
  ]);
}

function common(entry: Node) {
  const program = text(entry.UN_LIST_TYPE);
  return {
    externalId: text(entry.REFERENCE_NUMBER) || text(entry.DATAID),
    ...(program ? { program } : {}),
  };
}

/** The UN Security Council Consolidated List, as published at scsanctions.un.org. */
export function parseUnConsolidatedXml(xml: string): ParsedList {
  const parser = new XMLParser({
    ignoreAttributes: false,
    parseTagValue: false,
    parseAttributeValue: false,
    trimValues: true,
  });
  const root = (parser.parse(xml) as Node).CONSOLIDATED_LIST as Node | undefined;
  if (!root) throw new BusinessRuleError('This is not a UN consolidated list file.');

  const individuals = nodes((root.INDIVIDUALS as Node | undefined)?.INDIVIDUAL).map(
    (entry): ParsedEntry => {
      const birth = nodes(entry.INDIVIDUAL_DATE_OF_BIRTH)[0];
      const dateOfBirth = text(birth?.DATE) || text(birth?.YEAR);
      const nationality = compact(
        nodes(entry.NATIONALITY).flatMap((n) =>
          (Array.isArray(n.VALUE) ? n.VALUE : [n.VALUE]).map(text),
        ),
      ).join(', ');
      return {
        ...common(entry),
        name: compact(
          ['FIRST_NAME', 'SECOND_NAME', 'THIRD_NAME', 'FOURTH_NAME'].map((k) => text(entry[k])),
        ).join(' '),
        aliases: aliasesOf(entry, 'INDIVIDUAL_ALIAS'),
        type: 'INDIVIDUAL',
        ...(dateOfBirth ? { dateOfBirth } : {}),
        ...(nationality ? { nationality } : {}),
      };
    },
  );
  const entities = nodes((root.ENTITIES as Node | undefined)?.ENTITY).map((entry): ParsedEntry => ({
    ...common(entry),
    name: text(entry.FIRST_NAME),
    aliases: aliasesOf(entry, 'ENTITY_ALIAS'),
    type: 'ENTITY',
  }));
  return {
    version: text(root['@_dateGenerated']) || new Date().toISOString(),
    entries: [...individuals, ...entities].filter((e) => e.name && e.externalId),
  };
}

const CSV_COLUMNS = ['externalid', 'name', 'aliases', 'type'];

/** A plain format for lists with no machine-readable feed, such as a national terrorist list. */
export function parseSanctionsCsv(csv: string): ParsedList {
  const [header, ...rows] = parseCsv(csv);
  const columns = (header ?? []).map((name) => name.toLowerCase().replace(/[\s_]/g, ''));
  const missing = CSV_COLUMNS.filter((column) => !columns.includes(column));
  if (missing.length) {
    throw new BusinessRuleError(`The list file is missing the column(s): ${missing.join(', ')}.`);
  }
  const at = (row: string[], column: string) => row[columns.indexOf(column)] ?? '';
  const entries = rows.map((row, index): ParsedEntry => {
    const type = at(row, 'type').toUpperCase();
    if (type !== 'INDIVIDUAL' && type !== 'ENTITY') {
      throw new BusinessRuleError(`Row ${index + 2}: type must be INDIVIDUAL or ENTITY.`);
    }
    const [externalId, name] = [at(row, 'externalid'), at(row, 'name')];
    if (!externalId || !name) {
      throw new BusinessRuleError(`Row ${index + 2}: externalId and name are required.`);
    }
    const [dateOfBirth, nationality, program] = [
      at(row, 'dateofbirth'),
      at(row, 'nationality'),
      at(row, 'program'),
    ];
    return {
      externalId,
      name,
      aliases: compact(at(row, 'aliases').split(';').map(text)),
      type,
      ...(dateOfBirth ? { dateOfBirth } : {}),
      ...(nationality ? { nationality } : {}),
      ...(program ? { program } : {}),
    };
  });
  return { version: new Date().toISOString(), entries };
}
