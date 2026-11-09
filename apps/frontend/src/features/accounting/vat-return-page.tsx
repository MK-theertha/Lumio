import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { toast } from 'sonner';
import {
  Card,
  Field,
  formatDecimal,
  Input,
  PageHeader,
  QueryState,
  StatusBadge,
  Table,
} from '@/components/app/primitives';
import type { Row } from '@/components/app/resource-page';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/contexts/auth-context';
import { apiGet, apiSend } from '@/lib/api-client';

interface Amounts {
  amount: string;
  vat: string;
}
interface VatReturn {
  box1ByEmirate: Record<string, Amounts>;
  box3ReverseCharge: Amounts;
  box4ZeroRated: Amounts;
  box5Exempt: Amounts;
  box6Imports: Amounts;
  box8TotalOutput: Amounts;
  box9StandardExpenses: Amounts;
  box10ReverseChargeRecoverable: Amounts;
  box11TotalInput: Amounts;
  box12TotalDue: string;
  box13TotalRecoverable: string;
  box14NetPayable: string;
  warnings: string[];
}
type Line = { id: string; label: string; amount: string; vat: string };
interface Recon {
  balanced: boolean;
  output: { reported: string; ledger: string; difference: string };
  input: { reported: string; ledger: string; difference: string };
}

const firstOfQuarter = () => {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), Math.floor(now.getUTCMonth() / 3) * 3, 1))
    .toISOString()
    .slice(0, 10);
};

export function VatReturnPage() {
  const { can } = useAuth();
  const queryClient = useQueryClient();
  const [from, setFrom] = useState(firstOfQuarter());
  const [to, setTo] = useState(new Date().toISOString().slice(0, 10));
  const period = { from, to };
  const preview = useQuery({
    queryKey: ['vat-return', from, to],
    queryFn: () => apiGet<VatReturn>('/vat-return', period),
  });
  const recon = useQuery({
    queryKey: ['vat-recon', from, to],
    queryFn: () => apiGet<Recon>('/vat-reconciliation', period),
  });
  const filed = useQuery({
    queryKey: ['vat-returns'],
    queryFn: () => apiGet<Row[]>('/vat-returns'),
  });
  const file = useMutation({
    mutationFn: (ftaReference: string) =>
      apiSend('post', '/vat-returns', { ...period, ftaReference }),
    onSuccess: async () => {
      toast.success('Filing recorded');
      await queryClient.invalidateQueries({ queryKey: ['vat-returns'] });
    },
    onError: (error) => toast.error(error.message),
  });
  const d = preview.data;
  const lines: Line[] = d
    ? [
        ...Object.entries(d.box1ByEmirate).map(([emirate, a]) => ({
          id: emirate,
          label: `1 Standard rated: ${emirate.replaceAll('_', ' ').toLowerCase()}`,
          ...a,
        })),
        { id: '3', label: '3 Reverse charge supplies', ...d.box3ReverseCharge },
        { id: '4', label: '4 Zero rated', ...d.box4ZeroRated },
        { id: '5', label: '5 Exempt', ...d.box5Exempt },
        { id: '6', label: '6 Imports (enter on the FTA portal)', ...d.box6Imports },
        { id: '8', label: '8 Total output', ...d.box8TotalOutput },
        { id: '9', label: '9 Standard rated expenses', ...d.box9StandardExpenses },
        { id: '10', label: '10 Reverse charge recoverable', ...d.box10ReverseChargeRecoverable },
        { id: '11', label: '11 Total input', ...d.box11TotalInput },
      ]
    : [];
  return (
    <div className="space-y-4">
      <PageHeader title="VAT return">
        {can('tax:update') && (
          <Button
            variant="outline"
            disabled={file.isPending}
            onClick={() => {
              const reference = window.prompt('FTA reference for this filing');
              if (reference) file.mutate(reference);
            }}
          >
            Record filing
          </Button>
        )}
      </PageHeader>
      <Card className="grid gap-3 md:grid-cols-2">
        <Field label="From">
          <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </Field>
        <Field label="To">
          <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </Field>
      </Card>
      <p role="status" className="rounded-md bg-primary/15 p-3 text-sm">
        A draft of VAT Form 201 for your adviser to check. Lumio does not file with the FTA.
      </p>
      {d?.warnings.map((warning) => (
        <p key={warning} role="status" className="rounded-md bg-primary/15 p-3 text-sm">
          {warning}
        </p>
      ))}
      <QueryState query={preview}>
        <Table
          rows={lines}
          columns={[
            { header: 'Box', render: (l) => l.label },
            { header: 'Amount', numeric: true, render: (l) => formatDecimal(l.amount) },
            { header: 'VAT', numeric: true, render: (l) => formatDecimal(l.vat) },
          ]}
        />
        <dl className="mt-3 grid max-w-md grid-cols-2 gap-1 text-sm">
          <dt>12 Total due</dt>
          <dd className="text-right">{formatDecimal(d?.box12TotalDue)}</dd>
          <dt>13 Total recoverable</dt>
          <dd className="text-right">{formatDecimal(d?.box13TotalRecoverable)}</dd>
          <dt className="font-semibold">14 Net payable</dt>
          <dd className="text-right font-semibold">{formatDecimal(d?.box14NetPayable)}</dd>
        </dl>
      </QueryState>
      <Card>
        <h2 className="mb-2 text-sm font-semibold">Reconciliation to the ledger</h2>
        <QueryState query={recon}>
          <p className="mb-2">
            <StatusBadge status={recon.data?.balanced ? 'PASSED' : 'FAILED'} />
          </p>
          <Table
            rows={[
              { id: 'o', label: 'Output VAT', ...recon.data?.output },
              { id: 'i', label: 'Input VAT', ...recon.data?.input },
            ]}
            columns={[
              { header: 'Tax', render: (r) => r.label },
              { header: 'Reported', numeric: true, render: (r) => formatDecimal(r.reported) },
              { header: 'Ledger', numeric: true, render: (r) => formatDecimal(r.ledger) },
              { header: 'Difference', numeric: true, render: (r) => formatDecimal(r.difference) },
            ]}
          />
        </QueryState>
      </Card>
      <QueryState query={filed} empty={filed.data?.length === 0}>
        <Table
          rows={filed.data ?? []}
          columns={[
            { header: 'From', render: (r) => (r.from as string).slice(0, 10) },
            { header: 'To', render: (r) => (r.to as string).slice(0, 10) },
            { header: 'FTA reference', render: (r) => r.ftaReference as string },
          ]}
        />
      </QueryState>
    </div>
  );
}
