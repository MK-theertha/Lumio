import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Card, PageHeader, QueryState, StatusBadge, Table } from '@/components/app/primitives';
import type { Row } from '@/components/app/resource-page';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/contexts/auth-context';
import { apiGet, apiSend, downloadFile } from '@/lib/api-client';

function useSubmit() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (saleId: string) => apiSend('post', `/e-invoices/sales/${saleId}/submit`),
    onSuccess: async () => {
      toast.success('E-invoice submitted');
      await queryClient.invalidateQueries();
    },
    onError: (error) => toast.error(error.message),
  });
}

const downloadXml = (saleId: string, number: string) => {
  downloadFile(`/e-invoices/sales/${saleId}/xml`, `${number}.xml`).catch((error: Error) =>
    toast.error(error.message),
  );
};

export function EInvoicesPage() {
  const { can } = useAuth();
  const submit = useSubmit();
  const query = useQuery({
    queryKey: ['e-invoices'],
    queryFn: () => apiGet<{ enabled: boolean; rows: Row[] }>('/e-invoices'),
  });
  const simulated = query.data?.rows.some((r) => r.provider === 'simulated');
  return (
    <div className="space-y-4">
      <PageHeader title="E-invoices" />
      {query.data && !query.data.enabled && (
        <p role="status" className="rounded-md bg-primary/15 p-3 text-sm">
          No e-invoicing provider is configured, so nothing is being sent.
        </p>
      )}
      {simulated && (
        <p role="status" className="rounded-md bg-primary/15 p-3 text-sm">
          These results come from the local simulator. Nothing has reached a tax system.
        </p>
      )}
      <QueryState query={query} empty={query.data?.rows.length === 0}>
        <Table
          rows={query.data?.rows ?? []}
          columns={[
            { header: 'Invoice', render: (r) => r.number as string },
            { header: 'Provider', render: (r) => r.provider as string },
            { header: 'Reference', render: (r) => (r.providerReference as string) ?? '—' },
            { header: 'Message', render: (r) => (r.message as string) ?? '—' },
            { header: 'Status', render: (r) => <StatusBadge status={r.status as string} /> },
          ]}
          actions={(r) => (
            <div className="flex justify-end gap-2">
              <Button
                variant="outline"
                onClick={() => downloadXml(r.sourceId as string, r.number as string)}
              >
                XML
              </Button>
              {['REJECTED', 'FAILED'].includes(r.status as string) && can('einvoice:submit') && (
                <Button
                  variant="outline"
                  disabled={submit.isPending}
                  onClick={() => submit.mutate(r.sourceId as string)}
                >
                  Resubmit
                </Button>
              )}
            </div>
          )}
        />
      </QueryState>
    </div>
  );
}

/** The state of one sale's e-invoice, shown on the invoice itself. */
export function EInvoiceStatus({ saleId, number }: { saleId: string; number: string }) {
  const query = useQuery({
    queryKey: ['e-invoice', saleId],
    queryFn: () => apiGet<Row | null>(`/e-invoices/sales/${saleId}/status`),
  });
  return (
    <Card className="flex flex-wrap items-center justify-between gap-2 text-sm">
      <span>
        E-invoice:{' '}
        {query.data ? (
          <StatusBadge status={query.data.status as string} />
        ) : (
          <span className="text-muted-foreground">not submitted</span>
        )}
      </span>
      <Button variant="outline" onClick={() => downloadXml(saleId, number)}>
        Download XML
      </Button>
    </Card>
  );
}
