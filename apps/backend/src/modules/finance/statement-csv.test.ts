import { describe, expect, it } from 'vitest';
import { parseStatementCsv } from './statement-csv.js';

describe('bank statement CSV', () => {
  it('reads a signed amount column and day-first dates', () => {
    const rows = parseStatementCsv(
      'Date,Description,Reference,Amount,Balance\n05/11/2026,"Fee, monthly",F1,"-1,250.50","10,000.00"\n',
      'DMY',
    );
    expect(rows[0]?.date.toISOString().slice(0, 10)).toBe('2026-11-05');
    expect(rows[0]?.description).toBe('Fee, monthly');
    expect(rows[0]?.amount.toFixed(2)).toBe('-1250.50');
    expect(rows[0]?.balance?.toFixed(2)).toBe('10000.00');
  });

  it('reads separate debit and credit columns', () => {
    const rows = parseStatementCsv(
      'Value Date,Narration,Withdrawals,Deposits\n2026-11-01,In,,100.00\n2026-11-02,Out,40.00,\n',
      'DMY',
    );
    expect(rows.map((r) => r.amount.toFixed(2))).toEqual(['100.00', '-40.00']);
  });

  it('honours the chosen date order and month names', () => {
    const header = 'Date,Amount\n';
    const day = (csv: string, order: 'DMY' | 'MDY') =>
      parseStatementCsv(header + csv, order)[0]
        ?.date.toISOString()
        .slice(0, 10);
    expect(day('03/04/2026,1', 'DMY')).toBe('2026-04-03');
    expect(day('03/04/2026,1', 'MDY')).toBe('2026-03-04');
    expect(day('05-Nov-26,1', 'DMY')).toBe('2026-11-05');
  });

  it('reads accounting-style negatives', () => {
    expect(parseStatementCsv('Date,Amount\n2026-01-01,(75.00)', 'YMD')[0]?.amount.toFixed(2)).toBe(
      '-75.00',
    );
  });

  it('rejects impossible dates and bad amounts with the row number', () => {
    expect(() => parseStatementCsv('Date,Amount\n31/02/2026,1', 'DMY')).toThrow(/Row 2/);
    expect(() => parseStatementCsv('Date,Amount\n2026-01-01,abc', 'DMY')).toThrow(/Row 2/);
  });

  it('explains missing columns', () => {
    expect(() => parseStatementCsv('Amount\n1', 'DMY')).toThrow(/date column/);
    expect(() => parseStatementCsv('Date,Note\n2026-01-01,x', 'DMY')).toThrow(/amount column/);
  });
});
