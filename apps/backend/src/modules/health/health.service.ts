import type { HealthStatus, ReadinessReport } from '@lumio/shared-types';

export type HealthCheck = () => Promise<unknown>;

const CHECK_TIMEOUT_MS = 2000;

async function probe(check: HealthCheck): Promise<HealthStatus> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      check(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Health check timed out')), CHECK_TIMEOUT_MS);
      }),
    ]);
    return 'up';
  } catch {
    // A failed dependency is the expected, reported outcome of this probe.
    return 'down';
  } finally {
    clearTimeout(timer);
  }
}

export async function evaluateReadiness(
  checks: Record<string, HealthCheck>,
): Promise<ReadinessReport> {
  const results = await Promise.all(
    Object.entries(checks).map(async ([name, check]) => [name, await probe(check)] as const),
  );
  const status = results.every(([, result]) => result === 'up') ? 'up' : 'down';
  return { status, checks: Object.fromEntries(results) };
}
