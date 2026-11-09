import { describe, expect, it } from 'vitest';
import { parseCsv } from './csv.js';

describe('parseCsv', () => {
  it('handles quotes, doubled quotes, embedded separators and newlines', () => {
    expect(parseCsv('a,"b,c","d""e"\r\n"f\ng",h,\n')).toEqual([
      ['a', 'b,c', 'd"e'],
      ['f\ng', 'h', ''],
    ]);
  });

  it('skips blank rows, tolerates a byte order mark and a missing final newline', () => {
    expect(parseCsv('﻿a,b\n\n,\nc,d')).toEqual([
      ['a', 'b'],
      ['c', 'd'],
    ]);
  });

  it('returns nothing for empty input', () => {
    expect(parseCsv('')).toEqual([]);
  });
});
