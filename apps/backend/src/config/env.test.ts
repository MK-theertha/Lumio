import { describe, expect, it } from 'vitest';
import { loadEnv } from './env.js';

const valid = {
  NODE_ENV: 'test',
  MONGODB_URI: 'mongodb://localhost:27017/x?replicaSet=rs0',
  REDIS_CACHE_URL: 'redis://localhost:6379',
  REDIS_QUEUE_URL: 'redis://localhost:6380',
  CORS_ORIGINS: 'http://localhost:5173, https://erp.example.com',
  JWT_ACCESS_SECRET: 'dev-only-jwt-secret-0123456789abcdef',
  ENCRYPTION_KEY: 'dev-only-encryption-0123456789abcdef',
  BLIND_INDEX_KEY: 'dev-only-blind-index-0123456789abcde',
};

describe('loadEnv', () => {
  it('parses valid configuration and applies defaults', () => {
    const env = loadEnv(valid);
    expect(env.PORT).toBe(4000);
    expect(env.CORS_ORIGINS).toEqual(['http://localhost:5173', 'https://erp.example.com']);
    expect(env.SENTRY_DSN).toBeUndefined();
  });

  it('refuses development secrets in production', () => {
    expect(() => loadEnv({ ...valid, NODE_ENV: 'production' })).toThrow(/JWT_ACCESS_SECRET/);
  });

  it('names missing keys', () => {
    expect(() => loadEnv({ ...valid, MONGODB_URI: undefined })).toThrow(/MONGODB_URI/);
  });

  it('never echoes a rejected value', () => {
    const secret = 'not-a-uri-with-hunter2-password';
    let message = '';
    try {
      loadEnv({ ...valid, MONGODB_URI: secret });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('MONGODB_URI');
    expect(message).not.toContain('hunter2');
  });

  it('rejects a non-URL CORS origin', () => {
    expect(() => loadEnv({ ...valid, CORS_ORIGINS: 'not a url' })).toThrow(/CORS_ORIGINS/);
  });
});
