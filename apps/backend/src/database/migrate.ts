import { loadEnv } from '../config/env.js';
import { createLogger } from '../shared/logger.js';
import { connectDatabase, disconnectDatabase } from './connection.js';
import { migrations } from './migrations/index.js';
import { runMigrations } from './migrations/runner.js';

const env = loadEnv();
const logger = createLogger(env.LOG_LEVEL, 'migrate');

try {
  await connectDatabase(env.MONGODB_URI);
  const applied = await runMigrations(migrations, logger);
  logger.info({ applied }, 'Migrations complete');
} catch (error) {
  logger.fatal({ err: error }, 'Migration failed');
  process.exitCode = 1;
} finally {
  await disconnectDatabase();
}
