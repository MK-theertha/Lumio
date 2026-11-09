import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bell } from 'lucide-react';
import { Link, useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { PageHeader, QueryState, StatusBadge, Table } from '@/components/app/primitives';
import type { Row } from '@/components/app/resource-page';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/contexts/auth-context';
import { apiGet, apiSend } from '@/lib/api-client';
import { cn } from '@/lib/utils';

const REFRESH_MS = 60_000;

function useNotifications(enabled: boolean) {
  return useQuery({
    queryKey: ['notifications'],
    queryFn: () => apiGet<Row[]>('/notifications'),
    refetchInterval: REFRESH_MS,
    enabled,
  });
}

export function NotificationBell() {
  const { user } = useAuth();
  const query = useNotifications(Boolean(user?.companyId));
  const unread = query.data?.filter((n) => !n.read).length ?? 0;
  return (
    <Button
      asChild
      variant="ghost"
      size="icon"
      aria-label={`Notifications, ${unread} unread`}
      className="relative"
    >
      <Link to="/notifications">
        <Bell className="size-4" />
        {unread > 0 && (
          <span className="absolute end-1 top-1 rounded-full bg-destructive px-1 text-[10px] leading-4 text-white">
            {unread > 9 ? '9+' : unread}
          </span>
        )}
      </Link>
    </Button>
  );
}

export function NotificationsPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const query = useNotifications(true);
  const markRead = useMutation({
    mutationFn: (id: string) => apiSend('post', `/notifications/${id}/read`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['notifications'] }),
  });
  return (
    <div>
      <PageHeader title="Notifications" />
      <QueryState query={query} empty={query.data?.length === 0}>
        <Table
          rows={query.data ?? []}
          columns={[
            { header: 'Severity', render: (r) => <StatusBadge status={r.severity as string} /> },
            {
              header: 'Title',
              render: (r) => (
                <span className={cn(!r.read && 'font-semibold')}>{r.title as string}</span>
              ),
            },
            { header: 'Details', render: (r) => r.body as string },
            { header: 'Raised', render: (r) => (r.createdAt as string).slice(0, 10) },
          ]}
          actions={(r) => (
            <div className="flex justify-end gap-2">
              {Boolean(r.link) && (
                <Button
                  variant="outline"
                  onClick={() => {
                    markRead.mutate(r.id);
                    void navigate(r.link as string);
                  }}
                >
                  Open
                </Button>
              )}
              {!r.read && (
                <Button variant="ghost" onClick={() => markRead.mutate(r.id)}>
                  Mark read
                </Button>
              )}
            </div>
          )}
        />
      </QueryState>
    </div>
  );
}

interface IntegrityRun extends Row {
  status: string;
  startedAt: string;
  checks: string[];
  findings: { check: string; detail: string }[];
}

export function IntegrityPage() {
  const { can } = useAuth();
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: ['integrity-runs'],
    queryFn: () => apiGet<IntegrityRun[]>('/integrity-runs'),
  });
  const run = useMutation({
    mutationFn: () => apiSend<IntegrityRun>('post', '/integrity-runs'),
    onSuccess: async (result) => {
      toast[result.status === 'PASSED' ? 'success' : 'error'](
        `Integrity check ${result.status.toLowerCase()}`,
      );
      await queryClient.invalidateQueries();
    },
    onError: (error) => toast.error(error.message),
  });
  const latest = query.data?.[0];
  return (
    <div className="space-y-4">
      <PageHeader title="Integrity checks">
        {can('settings:manage') && (
          <Button disabled={run.isPending} onClick={() => run.mutate()}>
            Run now
          </Button>
        )}
      </PageHeader>
      <p className="text-sm text-muted-foreground">
        Runs nightly. Problems are reported and never corrected automatically.
      </p>
      <QueryState query={query} empty={query.data?.length === 0}>
        <Table
          rows={query.data ?? []}
          columns={[
            { header: 'Started', render: (r) => r.startedAt.replace('T', ' ').slice(0, 19) },
            { header: 'Checks', numeric: true, render: (r) => String(r.checks.length) },
            { header: 'Findings', numeric: true, render: (r) => String(r.findings.length) },
            { header: 'Result', render: (r) => <StatusBadge status={r.status} /> },
          ]}
        />
        {latest && latest.findings.length > 0 && (
          <div className="mt-4">
            <Table
              rows={latest.findings.map((f, index) => ({ ...f, id: String(index) }))}
              columns={[
                { header: 'Check', render: (f) => f.check },
                { header: 'Finding', render: (f) => f.detail },
              ]}
            />
          </div>
        )}
      </QueryState>
    </div>
  );
}
