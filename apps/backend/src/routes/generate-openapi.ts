import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { buildOpenApiDocument } from './openapi.js';

const target = resolve(import.meta.dirname, '../../../../docs/api/openapi.json');
const generated = `${JSON.stringify(buildOpenApiDocument(), null, 2)}\n`;

if (process.argv.includes('--check')) {
  const committed = await readFile(target, 'utf8').catch(() => '');
  if (committed !== generated) {
    process.stderr.write('docs/api/openapi.json is stale. Run: npm run openapi:generate\n');
    process.exitCode = 1;
  }
} else {
  await writeFile(target, generated);
}
