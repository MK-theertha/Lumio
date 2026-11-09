import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import mongoose from 'mongoose';
import { pino } from 'pino';
import { loadEnv } from '../src/config/env.js';
import { initRuntime } from '../src/config/runtime.js';
import { connectDatabase, disconnectDatabase } from '../src/database/connection.js';
import { migrations } from '../src/database/migrations/index.js';
import { runMigrations } from '../src/database/migrations/runner.js';
import type { RequestContext } from '../src/shared/context.js';

export const silentLogger = pino({ level: 'silent' });

export function testRedisUrl(): string {
  const url = process.env.TEST_REDIS_URL;
  if (!url) throw new Error('Integration global setup did not run');
  return url;
}

export const testEnv = loadEnv({
  NODE_ENV: 'test',
  MONGODB_URI: 'mongodb://unused/x',
  REDIS_CACHE_URL: 'redis://unused',
  REDIS_QUEUE_URL: 'redis://unused',
  CORS_ORIGINS: 'https://erp.example.com',
  JWT_ACCESS_SECRET: 'dev-only-jwt-secret-0123456789abcdef',
  ENCRYPTION_KEY: 'dev-only-encryption-0123456789abcdef',
  BLIND_INDEX_KEY: 'dev-only-blind-index-0123456789abcde',
  S3_ENDPOINT: process.env.TEST_S3_ENDPOINT,
  S3_ACCESS_KEY_ID: 'test',
  S3_SECRET_ACCESS_KEY: 'test',
});

export async function startTestDatabase(): Promise<void> {
  initRuntime(testEnv);
  const uri = process.env.TEST_MONGODB_URI;
  if (!uri) throw new Error('Integration global setup did not run');
  await connectDatabase(uri);
  await mongoose.connection.dropDatabase();
  await runMigrations(migrations, silentLogger);
}

export async function clearCollections(): Promise<void> {
  const db = mongoose.connection.db;
  if (!db) throw new Error('MongoDB is not connected');
  for (const collection of await db.collections()) {
    if (collection.collectionName !== 'migrations') await collection.deleteMany({});
  }
}

export async function stopTestDatabase(): Promise<void> {
  await disconnectDatabase();
}

export function testContext(overrides: Partial<RequestContext> = {}): RequestContext {
  return {
    companyId: new mongoose.Types.ObjectId(),
    userId: new mongoose.Types.ObjectId().toString(),
    branchScope: 'ALL',
    permissions: new Set(),
    correlationId: randomUUID(),
    ...overrides,
  };
}

export function createTestRedis(): Redis {
  return new Redis(testRedisUrl());
}
