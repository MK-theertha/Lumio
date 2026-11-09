import { passwordSchema } from '@lumio/validation';
import { z } from 'zod';
import { loadEnv } from '../config/env.js';
import { initRuntime } from '../config/runtime.js';
import { createFirstPlatformAdmin } from '../modules/identity/index.js';
import { createLogger } from '../shared/logger.js';
import { connectDatabase, disconnectDatabase } from './connection.js';

// Read from the environment so the password never appears in a process list or shell history.
const input = z
  .object({
    PLATFORM_ADMIN_EMAIL: z.email(),
    PLATFORM_ADMIN_NAME: z.string().trim().min(1),
    PLATFORM_ADMIN_PASSWORD: passwordSchema,
  })
  .parse(process.env);

const env = loadEnv();
initRuntime(env);
const logger = createLogger(env.LOG_LEVEL, 'create-platform-admin');
await connectDatabase(env.MONGODB_URI);
try {
  const { id } = await createFirstPlatformAdmin({
    email: input.PLATFORM_ADMIN_EMAIL,
    name: input.PLATFORM_ADMIN_NAME,
    password: input.PLATFORM_ADMIN_PASSWORD,
  });
  logger.info({ userId: id }, 'Platform administrator created');
} finally {
  await disconnectDatabase();
}
