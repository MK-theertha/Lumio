import { describe, expect, it } from 'vitest';
import { parseSanctionsCsv, parseUnConsolidatedXml } from './sanctions-list.js';

// Trimmed from the structure of the published UN consolidated list.
const UN_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<CONSOLIDATED_LIST dateGenerated="2026-11-08T00:00:00.869Z">
  <INDIVIDUALS>
    <INDIVIDUAL>
      <DATAID>6907993</DATAID>
      <FIRST_NAME>ERIC</FIRST_NAME>
      <SECOND_NAME>BADEGE</SECOND_NAME>
      <UN_LIST_TYPE>DRC</UN_LIST_TYPE>
      <REFERENCE_NUMBER>CDi.001</REFERENCE_NUMBER>
      <NATIONALITY><VALUE>Democratic Republic of the Congo</VALUE></NATIONALITY>
      <INDIVIDUAL_ALIAS><QUALITY>Good</QUALITY><ALIAS_NAME>E. B. Alias</ALIAS_NAME></INDIVIDUAL_ALIAS>
      <INDIVIDUAL_ALIAS><QUALITY/><ALIAS_NAME/></INDIVIDUAL_ALIAS>
      <INDIVIDUAL_DATE_OF_BIRTH><TYPE_OF_DATE>EXACT</TYPE_OF_DATE><YEAR>1971</YEAR></INDIVIDUAL_DATE_OF_BIRTH>
    </INDIVIDUAL>
  </INDIVIDUALS>
  <ENTITIES>
    <ENTITY>
      <DATAID>110</DATAID>
      <FIRST_NAME>GOLD &amp; SONS</FIRST_NAME>
      <UN_LIST_TYPE>Al-Qaida</UN_LIST_TYPE>
      <REFERENCE_NUMBER>QDe.001</REFERENCE_NUMBER>
      <ENTITY_ALIAS><ALIAS_NAME>G and S</ALIAS_NAME></ENTITY_ALIAS>
    </ENTITY>
  </ENTITIES>
</CONSOLIDATED_LIST>`;

describe('UN consolidated list', () => {
  it('reads individuals and entities with aliases, ignoring empty ones', () => {
    const { version, entries } = parseUnConsolidatedXml(UN_XML);
    expect(version).toBe('2026-11-08T00:00:00.869Z');
    expect(entries).toEqual([
      {
        externalId: 'CDi.001',
        program: 'DRC',
        name: 'ERIC BADEGE',
        aliases: ['E. B. Alias'],
        type: 'INDIVIDUAL',
        dateOfBirth: '1971',
        nationality: 'Democratic Republic of the Congo',
      },
      {
        externalId: 'QDe.001',
        program: 'Al-Qaida',
        name: 'GOLD & SONS',
        aliases: ['G and S'],
        type: 'ENTITY',
      },
    ]);
  });

  it('rejects a file that is not the list', () => {
    expect(() => parseUnConsolidatedXml('<other/>')).toThrow(/not a UN consolidated/);
  });
});

describe('CSV lists', () => {
  it('reads the documented columns', () => {
    const { entries } = parseSanctionsCsv(
      'externalId,name,aliases,type,nationality\nX1,"Doe, Jane",JD;J. Doe,individual,AE\n',
    );
    expect(entries).toEqual([
      {
        externalId: 'X1',
        name: 'Doe, Jane',
        aliases: ['JD', 'J. Doe'],
        type: 'INDIVIDUAL',
        nationality: 'AE',
      },
    ]);
  });

  it('names missing columns and bad rows', () => {
    expect(() => parseSanctionsCsv('name\nJane')).toThrow(/externalid/);
    expect(() => parseSanctionsCsv('externalId,name,aliases,type\nX,J,,ALIEN')).toThrow(/Row 2/);
  });
});
