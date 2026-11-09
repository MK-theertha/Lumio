import type mongoose from 'mongoose';
import { loadEnv } from '../config/env.js';
import { initRuntime } from '../config/runtime.js';
import { createObjectStore } from '../modules/documents/index.js';
import { runIntegrityChecks } from '../modules/maintenance/index.js';
import { CompanyModel } from '../modules/organisation/index.js';
import { connectDatabase, disconnectDatabase } from './connection.js';

/** After a restore: runs every integrity check on each company. Exits non-zero on any finding. */
const env = loadEnv();
initRuntime(env);
await connectDatabase(env.MONGODB_URI);
let failed = false;
try {
  const companies = await CompanyModel.find().select({ code: 1 }).lean();
  const store = createObjectStore(env);
  for (const company of companies) {
    const run = await runIntegrityChecks(company._id as mongoose.Types.ObjectId, store);
    process.stdout.write(
      `${company.code as string}: ${run.status} (${run.checks.length} checks)\n`,
    );
    for (const finding of run.findings)
      process.stdout.write(`  ${finding.check}: ${finding.detail}\n`);
    if (run.status !== 'PASSED') failed = true;
  }
} finally {
  await disconnectDatabase();
}
process.exitCode = failed ? 1 : 0;
