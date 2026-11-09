import type { Env } from './env.js';

let current: Env | undefined;

/** Set once at process start, or by tests, so services need not thread configuration through. */
export function initRuntime(env: Env): void {
  current = env;
}

export function runtime(): Env {
  if (!current) throw new Error('Runtime configuration was not initialised');
  return current;
}
