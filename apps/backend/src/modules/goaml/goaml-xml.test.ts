import { XMLParser } from 'fast-xml-parser';
import { describe, expect, it } from 'vitest';
import { renderGoamlXml, reportWarnings, splitName, type GoamlReportData } from './goaml-xml.js';

const report: GoamlReportData = {
  reportType: 'DPMSR',
  reference: 'GOAML-000001',
  entityId: 'RE-1',
  submissionDate: '2026-11-09',
  currency: 'AED',
  reporter: { firstName: 'Compliance', lastName: 'Officer', email: 'c@example.com' },
  reason: 'Cash sale <above> threshold & repeated',
  indicators: ['DPMSR'],
  transactions: [
    {
      number: 'INV-1',
      date: '2026-11-08',
      amount: '60000.00',
      description: 'Sale of precious metals',
      direction: 'FROM_PARTY',
      mode: 'CASH',
      party: { name: 'Jane Middle Doe', type: 'INDIVIDUAL' },
    },
  ],
};

describe('goAML XML', () => {
  it('escapes text and produces parseable XML', () => {
    const xml = renderGoamlXml(report);
    expect(xml).toContain('Cash sale &lt;above&gt; threshold &amp; repeated');
    const parsed = new XMLParser({ parseTagValue: false }).parse(xml) as {
      report: {
        report_code: string;
        transaction: { t_from: { person: { first_name: string; last_name: string } } };
      };
    };
    expect(parsed.report.report_code).toBe('DPMSR');
    expect(parsed.report.transaction.t_from.person).toMatchObject({
      first_name: 'Jane Middle',
      last_name: 'Doe',
    });
  });

  it('puts the party on the receiving side when money goes out', () => {
    const [first] = report.transactions;
    const xml = renderGoamlXml({
      ...report,
      transactions: [{ ...first!, direction: 'TO_PARTY' }],
    });
    expect(xml).toContain('<t_to><person>');
    expect(xml).toContain('<t_from_my_client><rentity_id>RE-1');
  });

  it('warns about what the regulator will expect but the record lacks', () => {
    expect(reportWarnings(report)).toEqual([
      'Jane Middle Doe: no date of birth.',
      'Jane Middle Doe: no nationality.',
      'Jane Middle Doe: no KYC identity document.',
    ]);
  });

  it('fills both required name fields for a single-word name', () => {
    expect(splitName('Madonna')).toEqual({ firstName: 'Madonna', lastName: 'Madonna' });
  });
});
