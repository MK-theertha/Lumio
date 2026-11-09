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
  Select,
  Table,
} from '@/components/app/primitives';
import { useRefOptions, type Row } from '@/components/app/resource-page';
import { Button } from '@/components/ui/button';
import { apiGet, apiSend, downloadExport } from '@/lib/api-client';

function DateRange({
  from,
  to,
  setFrom,
  setTo,
}: {
  from: string;
  to: string;
  setFrom: (value: string) => void;
  setTo: (value: string) => void;
}) {
  return (
    <>
      <Field label="From">
        <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
      </Field>
      <Field label="To">
        <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
      </Field>
    </>
  );
}

interface LedgerResult<T> {
  opening: string;
  closing: string;
  rows: T[];
}

export function CashBookPage() {
  const accounts = useRefOptions('/financial-accounts');
  const [chosen, setChosen] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const accountId = chosen || accounts.data?.rows[0]?.id || '';
  const query = useQuery({
    queryKey: ['cash-book', accountId, from, to],
    queryFn: () =>
      apiGet<LedgerResult<Row>>('/cash-book', {
        financialAccountId: accountId,
        from: from || undefined,
        to: to || undefined,
      }),
    enabled: Boolean(accountId),
  });
  return (
    <div className="space-y-4">
      <PageHeader title="Cash book" />
      <Card className="grid items-end gap-3 md:grid-cols-3">
        <Field label="Account">
          <Select value={accountId} onChange={(e) => setChosen(e.target.value)}>
            {accounts.data?.rows.map((a) => (
              <option key={a.id} value={a.id}>
                {a.code as string} {a.name as string}
              </option>
            ))}
          </Select>
        </Field>
        <DateRange from={from} to={to} setFrom={setFrom} setTo={setTo} />
      </Card>
      <QueryState query={query} empty={query.data?.rows.length === 0}>
        <p className="text-sm text-muted-foreground">
          Opening {formatDecimal(query.data?.opening)}, closing {formatDecimal(query.data?.closing)}
        </p>
        <Table
          rows={query.data?.rows ?? []}
          columns={[
            { header: 'Date', render: (r) => (r.date as string).slice(0, 10) },
            { header: 'Number', render: (r) => r.number as string },
            { header: 'Details', render: (r) => r.description as string },
            { header: 'Receipt', numeric: true, render: (r) => r.receipt as string },
            { header: 'Payment', numeric: true, render: (r) => r.payment as string },
            { header: 'Balance', numeric: true, render: (r) => formatDecimal(r.balance as string) },
          ]}
        />
      </QueryState>
    </div>
  );
}

interface StatementRow {
  date: string;
  journal: string;
  description: string;
  debit: string;
  credit: string;
  balance: string;
}

function ActivityNotes({ partyId }: { partyId: string }) {
  const queryClient = useQueryClient();
  const [note, setNote] = useState('');
  const query = useQuery({
    queryKey: ['activities', partyId],
    queryFn: () => apiGet<Row[]>(`/parties/${partyId}/activities`),
  });
  const add = useMutation({
    mutationFn: () => apiSend('post', `/parties/${partyId}/activities`, { note }),
    onSuccess: async () => {
      setNote('');
      await queryClient.invalidateQueries({ queryKey: ['activities', partyId] });
    },
    onError: (error) => toast.error(error.message),
  });
  return (
    <Card className="space-y-2">
      <h2 className="text-sm font-semibold">Activity notes</h2>
      <div className="flex gap-2">
        <Input aria-label="New note" value={note} onChange={(e) => setNote(e.target.value)} />
        <Button disabled={!note || add.isPending} onClick={() => add.mutate()}>
          Add
        </Button>
      </div>
      <ul className="space-y-1 text-sm">
        {query.data?.map((row) => (
          <li key={row.id}>
            <span className="text-muted-foreground">{(row.at as string).slice(0, 10)}</span>{' '}
            {row.note as string}
          </li>
        ))}
      </ul>
    </Card>
  );
}

export function PartyStatementPage() {
  const parties = useRefOptions('/parties');
  const [partyId, setPartyId] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const params = { from: from || undefined, to: to || undefined };
  const query = useQuery({
    queryKey: ['party-statement', partyId, from, to],
    queryFn: () =>
      apiGet<LedgerResult<StatementRow> & { party: string }>(
        `/party-statements/${partyId}`,
        params,
      ),
    enabled: Boolean(partyId),
  });
  return (
    <div className="space-y-4">
      <PageHeader title="Party statements">
        {partyId && (
          <Button
            variant="outline"
            onClick={() =>
              void downloadExport(`/party-statements/${partyId}`, 'statement.pdf', 'pdf', params)
            }
          >
            PDF
          </Button>
        )}
      </PageHeader>
      <Card className="grid items-end gap-3 md:grid-cols-3">
        <Field label="Customer or supplier">
          <Select value={partyId} onChange={(e) => setPartyId(e.target.value)}>
            <option value="">Select…</option>
            {parties.data?.rows.map((p) => (
              <option key={p.id} value={p.id}>
                {p.code as string} {p.name as string}
              </option>
            ))}
          </Select>
        </Field>
        <DateRange from={from} to={to} setFrom={setFrom} setTo={setTo} />
      </Card>
      {partyId && <ActivityNotes partyId={partyId} />}
      {partyId && (
        <QueryState query={query} empty={query.data?.rows.length === 0}>
          <p className="text-sm text-muted-foreground">
            Opening {formatDecimal(query.data?.opening)}, closing{' '}
            {formatDecimal(query.data?.closing)}
          </p>
          <Table
            rows={(query.data?.rows ?? []).map((r, index) => ({ ...r, id: String(index) }))}
            columns={[
              { header: 'Date', render: (r) => r.date },
              { header: 'Journal', render: (r) => r.journal },
              { header: 'Details', render: (r) => r.description },
              { header: 'Debit', numeric: true, render: (r) => formatDecimal(r.debit) },
              { header: 'Credit', numeric: true, render: (r) => formatDecimal(r.credit) },
              { header: 'Balance', numeric: true, render: (r) => formatDecimal(r.balance) },
            ]}
          />
        </QueryState>
      )}
    </div>
  );
}

export function ReportSchedules({ reports }: { reports: { key: string; title: string }[] }) {
  const queryClient = useQueryClient();
  const [reportKey, setReportKey] = useState('');
  const [frequency, setFrequency] = useState('WEEKLY');
  const [format, setFormat] = useState('XLSX');
  const [recipients, setRecipients] = useState('');
  const query = useQuery({
    queryKey: ['report-schedules'],
    queryFn: () => apiGet<Row[]>('/report-schedules'),
  });
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['report-schedules'] });
  const create = useMutation({
    mutationFn: () =>
      apiSend('post', '/report-schedules', {
        reportKey: reportKey || reports[0]?.key,
        frequency,
        format,
        recipients: recipients
          .split(/[,;\s]+/)
          .map((r) => r.trim())
          .filter(Boolean),
      }),
    onSuccess: async () => {
      toast.success('Schedule saved');
      setRecipients('');
      await refresh();
    },
    onError: (error) => toast.error(error.message),
  });
  const remove = useMutation({
    mutationFn: (id: string) => apiSend('delete', `/report-schedules/${id}`),
    onSuccess: refresh,
    onError: (error) => toast.error(error.message),
  });
  const title = new Map(reports.map((r) => [r.key, r.title]));
  return (
    <Card className="mt-4 space-y-3">
      <h2 className="text-sm font-semibold">Scheduled reports</h2>
      <div className="grid items-end gap-3 md:grid-cols-5">
        <Field label="Scheduled report">
          <Select value={reportKey} onChange={(e) => setReportKey(e.target.value)}>
            {reports.map((r) => (
              <option key={r.key} value={r.key}>
                {r.title}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="How often">
          <Select value={frequency} onChange={(e) => setFrequency(e.target.value)}>
            <option value="DAILY">Daily</option>
            <option value="WEEKLY">Weekly (Mondays)</option>
            <option value="MONTHLY">Monthly (the 1st)</option>
          </Select>
        </Field>
        <Field label="Format">
          <Select value={format} onChange={(e) => setFormat(e.target.value)}>
            <option>XLSX</option>
            <option>PDF</option>
          </Select>
        </Field>
        <Field label="Email to">
          <Input value={recipients} onChange={(e) => setRecipients(e.target.value)} />
        </Field>
        <Button disabled={!recipients || create.isPending} onClick={() => create.mutate()}>
          Add schedule
        </Button>
      </div>
      <QueryState query={query} empty={query.data?.length === 0}>
        <Table
          rows={query.data ?? []}
          columns={[
            {
              header: 'Report',
              render: (r) => title.get(r.reportKey as string) ?? (r.reportKey as string),
            },
            { header: 'Frequency', render: (r) => r.frequency as string },
            { header: 'Format', render: (r) => r.format as string },
            { header: 'Recipients', render: (r) => (r.recipients as string[]).join(', ') },
            { header: 'Last sent', render: (r) => (r.lastRunOn as string) ?? '—' },
          ]}
          actions={(r) => (
            <Button variant="ghost" onClick={() => remove.mutate(r.id)}>
              Remove
            </Button>
          )}
        />
      </QueryState>
    </Card>
  );
}
