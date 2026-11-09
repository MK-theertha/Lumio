import { randomUUID } from 'node:crypto';
import type { Request, RequestHandler } from 'express';
import type { Redis } from 'ioredis';
import { RateLimitError, ServiceUnavailableError } from '../shared/errors.js';
import type { Logger } from '../shared/logger.js';

// Atomic sliding window: prune, count, then record only if under the limit.
const SLIDING_WINDOW = `
redis.call('ZREMRANGEBYSCORE', KEYS[1], 0, ARGV[1] - ARGV[2])
local count = redis.call('ZCARD', KEYS[1])
if count < tonumber(ARGV[3]) then
  redis.call('ZADD', KEYS[1], ARGV[1], ARGV[4])
  redis.call('PEXPIRE', KEYS[1], ARGV[2])
  return 1
end
return 0`;

export interface RateLimitOptions {
  redis: Redis;
  logger: Logger;
  name: string;
  limit: number;
  windowMs: number;
  /** Authentication routes fail closed; general routes stay available if Redis is down. */
  onStoreFailure: 'allow' | 'reject';
  key?: (req: Request) => string;
}

export function rateLimit(options: RateLimitOptions): RequestHandler {
  const { redis, logger, name, limit, windowMs, onStoreFailure } = options;
  const keyOf = options.key ?? ((req: Request) => req.ip ?? 'unknown');

  return async (req, _res, next) => {
    let allowed: unknown;
    try {
      allowed = await redis.eval(
        SLIDING_WINDOW,
        1,
        `ratelimit:${name}:${keyOf(req)}`,
        Date.now(),
        windowMs,
        limit,
        randomUUID(),
      );
    } catch (error) {
      logger.error({ err: error, limiter: name }, 'Rate limit store unavailable');
      if (onStoreFailure === 'reject') throw new ServiceUnavailableError();
      next();
      return;
    }
    if (allowed !== 1) throw new RateLimitError();
    next();
  };
}
