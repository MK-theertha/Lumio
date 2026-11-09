import type { HealthStatus, ReadinessReport } from '@lumio/shared-types';
import { useQuery } from '@tanstack/react-query';
import { RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { fetchReadiness } from '@/lib/api-client';
import { cn } from '@/lib/utils';

const LABELS: Record<string, string> = {
  mongodb: 'Database',
  redisCache: 'Cache',
  redisQueue: 'Job queue',
};

function StatusBadge({ status }: { status: HealthStatus }) {
  return (
    <span
      className={cn(
        'rounded-full px-2.5 py-0.5 text-xs font-medium',
        status === 'up' ? 'bg-success/15 text-success' : 'bg-destructive/15 text-destructive',
      )}
    >
      {status === 'up' ? 'Operational' : 'Unavailable'}
    </span>
  );
}

export function SystemStatusPage() {
  const query = useQuery({
    queryKey: ['system', 'readiness'],
    queryFn: () => fetchReadiness<ReadinessReport>(),
    refetchInterval: 15_000,
  });

  return (
    <div className="max-w-2xl space-y-4">
      <div className="flex items-center justify-between gap-4">
        <h1 className="text-xl font-semibold">System status</h1>
        <Button variant="outline" disabled={query.isFetching} onClick={() => void query.refetch()}>
          <RefreshCw className={cn('size-4', query.isFetching && 'animate-spin')} aria-hidden />
          Refresh
        </Button>
      </div>

      {query.isPending && (
        <div role="status" aria-label="Loading" className="space-y-2">
          <div className="h-14 animate-pulse rounded-md bg-muted" />
          <div className="h-14 animate-pulse rounded-md bg-muted" />
        </div>
      )}

      {query.isError && (
        <div role="alert" className="rounded-md border border-destructive/40 p-4 text-sm">
          The API could not be reached. {query.error.message}
        </div>
      )}

      {query.data && (
        <ul className="divide-y rounded-md border bg-card">
          {Object.entries(query.data.checks).map(([name, status]) => (
            <li key={name} className="flex items-center justify-between p-4 text-sm">
              <span>{LABELS[name] ?? name}</span>
              <StatusBadge status={status} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
