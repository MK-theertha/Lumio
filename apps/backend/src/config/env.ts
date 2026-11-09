import { z } from 'zod';

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'staging', 'production']),
    PORT: z.coerce.number().int().positive().default(4000),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),
    MONGODB_URI: z.string().regex(/^mongodb(\+srv)?:\/\//, 'Must be a MongoDB connection string'),
    REDIS_CACHE_URL: z.string().regex(/^rediss?:\/\//, 'Must be a Redis URL'),
    REDIS_QUEUE_URL: z.string().regex(/^rediss?:\/\//, 'Must be a Redis URL'),
    CORS_ORIGINS: z
      .string()
      .transform((value) =>
        value
          .split(',')
          .map((origin) => origin.trim())
          .filter(Boolean),
      )
      .pipe(z.array(z.url()).min(1)),
    TRUST_PROXY_HOPS: z.coerce.number().int().min(0).default(0),
    SENTRY_DSN: z
      .string()
      .optional()
      .transform((value) => value || undefined),
    WORKER_HEALTH_PORT: z.coerce.number().int().positive().default(4001),
    JWT_ACCESS_SECRET: z.string().min(32),
    ENCRYPTION_KEY: z.string().min(32),
    BLIND_INDEX_KEY: z.string().min(32),
    APP_URL: z.url().default('http://localhost:5173'),
    SMTP_URL: z.string().default('smtp://localhost:1025'),
    EMAIL_FROM: z.string().default('Lumio <no-reply@lumio.local>'),
  })
  .superRefine((env, issue) => {
    if (env.NODE_ENV !== 'production' && env.NODE_ENV !== 'staging') return;
    for (const key of ['JWT_ACCESS_SECRET', 'ENCRYPTION_KEY', 'BLIND_INDEX_KEY'] as const) {
      if (env[key].startsWith('dev-only')) {
        issue.addIssue({
          code: 'custom',
          path: [key],
          message: 'Development secret is not allowed',
        });
      }
    }
  });

export type Env = z.output<typeof envSchema>;

/** Validates configuration at startup. Throws, naming only the invalid keys, never their values. */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
    throw new Error(`Invalid environment configuration:\n  ${problems.join('\n  ')}`);
  }
  return parsed.data;
}
