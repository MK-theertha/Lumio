/** RFC 4180 parser: quoted fields, doubled quotes, embedded newlines, CRLF or LF. Skips blank rows. */
export function parseCsv(text: string): string[][] {
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;

  const endField = () => {
    row.push(field.trim());
    field = '';
  };
  const endRow = () => {
    endField();
    if (row.some(Boolean)) rows.push(row);
    row = [];
  };

  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    if (quoted) {
      if (char !== '"') field += char;
      else if (source[i + 1] === '"') {
        field += '"';
        i += 1;
      } else quoted = false;
    } else if (char === '"' && field === '') quoted = true;
    else if (char === ',') endField();
    else if (char === '\n') endRow();
    else if (char !== '\r') field += char;
  }
  if (field !== '' || row.length > 0) endRow();
  return rows;
}
