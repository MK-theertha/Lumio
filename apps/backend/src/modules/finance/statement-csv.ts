import { parseCsv } from '@lumio/shared-utils';
import { dec, Decimal } from '../../shared/decimal.js';
import { BusinessRuleError } from '../../shared/errors.js';

export type DateOrder = 'DMY' | 'MDY' | 'YMD';

export interface StatementRow {
  date: Date;
  description: string;
  reference: string;
  /** Positive for money received into the account, negative for money leaving it. */
  amount: Decimal;
  balance?: Decimal;
}

const COLUMN_NAMES = {
  date: ['date', 'transaction date', 'txn date', 'value date', 'posting date', 'book date'],
  description: [
    'description',
    'narration',
    'details',
    'particulars',
    'memo',
    'transaction details',
  ],
  reference: ['reference', 'ref', 'ref no', 'reference number', 'cheque no', 'cheque number'],
  amount: ['amount', 'transaction amount'],
  debit: ['debit', 'withdrawal', 'withdrawals', 'money out', 'dr', 'debit amount'],
  credit: ['credit', 'deposit', 'deposits', 'money in', 'cr', 'credit amount'],
  balance: ['balance', 'running balance', 'closing balance'],
};

const MONTHS = 'JAN FEB MAR APR MAY JUN JUL AUG SEP OCT NOV DEC'.split(' ');

function parseDate(raw: string, order: DateOrder, row: number): Date {
  const fail = () => new BusinessRuleError(`Row ${row}: "${raw}" is not a recognised date.`);
  const parts = raw.trim().split(/[-/.\s]+/);
  if (parts.length !== 3) throw fail();
  // A leading four-digit year is unambiguous whatever order was chosen.
  const effective = (parts[0] as string).length === 4 ? 'YMD' : order;
  const [first, second, third] = parts as [string, string, string];
  const [y, m, d] =
    effective === 'YMD'
      ? [first, second, third]
      : effective === 'MDY'
        ? [third, first, second]
        : [third, second, first];
  const namedMonth = MONTHS.indexOf(m.slice(0, 3).toUpperCase());
  const month = namedMonth >= 0 ? namedMonth + 1 : Number(m);
  const year = y.length === 2 ? 2000 + Number(y) : Number(y);
  const date = new Date(Date.UTC(year, month - 1, Number(d)));
  if (
    Number.isNaN(date.getTime()) ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== Number(d)
  ) {
    throw fail();
  }
  return date;
}

function parseAmount(raw: string, row: number): Decimal {
  const trimmed = raw.trim();
  const negative = /^\(.*\)$/.test(trimmed) || trimmed.endsWith('-');
  const digits = trimmed.replace(/[(),\s]|-$/g, '').replace(/^[A-Za-z]+/, '');
  if (!/^-?\d+(\.\d+)?$/.test(digits)) {
    throw new BusinessRuleError(`Row ${row}: "${raw}" is not a recognised amount.`);
  }
  return negative ? dec(digits).negated() : dec(digits);
}

/** Reads a bank's CSV export, finding columns by their usual names. One bad row rejects the file. */
export function parseStatementCsv(csv: string, order: DateOrder): StatementRow[] {
  const [header, ...rows] = parseCsv(csv);
  const names = (header ?? []).map((name) => name.toLowerCase().replace(/\s+/g, ' ').trim());
  const find = (candidates: string[]) => {
    for (const candidate of candidates) {
      const index = names.indexOf(candidate);
      if (index >= 0) return index;
    }
    return -1;
  };
  const column = {
    date: find(COLUMN_NAMES.date),
    description: find(COLUMN_NAMES.description),
    reference: find(COLUMN_NAMES.reference),
    amount: find(COLUMN_NAMES.amount),
    debit: find(COLUMN_NAMES.debit),
    credit: find(COLUMN_NAMES.credit),
    balance: find(COLUMN_NAMES.balance),
  };
  if (column.date < 0) throw new BusinessRuleError('The file has no date column.');
  if (column.amount < 0 && column.debit < 0 && column.credit < 0) {
    throw new BusinessRuleError('The file needs an amount column, or debit and credit columns.');
  }

  return rows.map((row, index) => {
    const line = index + 2;
    const cell = (at: number) => (at >= 0 ? (row[at] ?? '').trim() : '');
    let amount: Decimal;
    if (column.amount >= 0) {
      amount = parseAmount(cell(column.amount), line);
    } else {
      const money = (at: number) => (cell(at) ? parseAmount(cell(at), line).abs() : new Decimal(0));
      amount = money(column.credit).minus(money(column.debit));
    }
    const balance = cell(column.balance);
    return {
      date: parseDate(cell(column.date), order, line),
      description: cell(column.description),
      reference: cell(column.reference),
      amount,
      ...(balance ? { balance: parseAmount(balance, line) } : {}),
    };
  });
}
