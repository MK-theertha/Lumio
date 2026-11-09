import { loadEnv } from '../config/env.js';
import { initRuntime } from '../config/runtime.js';
import { provisionCompany } from '../modules/onboarding/index.js';
import { CompanyModel } from '../modules/organisation/index.js';
import { createLogger } from '../shared/logger.js';
import { connectDatabase, disconnectDatabase } from './connection.js';

const env = loadEnv();
initRuntime(env);
const logger = createLogger(env.LOG_LEVEL, 'seed');
if (env.NODE_ENV === 'production' || env.NODE_ENV === 'staging') {
  throw new Error('Demo data can only be seeded in development.');
}

const DEMO_EMAIL = 'admin@demo.lumio.local';
const DEMO_PASSWORD = 'demo-only-change-me';

await connectDatabase(env.MONGODB_URI);
try {
  if (await CompanyModel.findOne({ code: 'DEMO' }).lean()) {
    logger.info('Demo company already exists');
  } else {
    await provisionCompany(
      { userId: 'seed', correlationId: 'seed-demo-company' },
      {
        code: 'DEMO',
        legalName: 'Demo Gold Trading LLC',
        baseCurrency: 'AED',
        adminEmail: DEMO_EMAIL,
        adminName: 'Demo Administrator',
        branchName: 'Head office',
      },
      { isDemo: true, adminPassword: DEMO_PASSWORD },
    );
    logger.info({ email: DEMO_EMAIL }, 'Demo company created. The password is in database/seed.ts');
  }
} finally {
  await disconnectDatabase();
}
