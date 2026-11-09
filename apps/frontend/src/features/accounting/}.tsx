import { paymentSchema } from '@lumio/validation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import {
  Card,
  Field,
  formatDecimal,
  Input,
  Modal,
  PageHeader,
  QueryState,
  Select,
  StatusBadge,
  Table,
} from '@/components/app/primitives';
import { useRefOptions, type Row } from '@/components/app/resource-page';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/contexts/auth-context';
import { apiCommand, apiGet, apiSend, downloadCsv } from '@/lib/api-client';

const today = () => new Date().toISOString().slice(0, 10);

function useAction() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ path, body }: { path: string; body?: unknown }) => apiSend('post', path, body),
    onSuccess: async () => {
      toast.success('Done');
      await queryClient.invalidateQueries();
    },
    onError: (error) => toast.error(error.message),
  });
}

export function PaymentsPage() {
  const { can } = useAuth();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const parties = useRefOptions('/parties');
  const accounts = useRefOptions('/financial-accounts');
  const methods = useRefOptions('/payment-methods');
  const branches = useRefOptions('/branches');
  const query = useQuery({ queryKey: ['payments'], queryFn: () => apiGet<Row[]>('/payments') });
  const party = useMemo(
    () => new Map(parties.data?.rows.map((p) => [p.id, p.name as string])),
    [parties.data],
  );

  const [direction, setDirection] = useState<'RECEIPT' | 'PAYMENT'>('RECEIPT');
  const [partyId, setPartyId] = useState('');
  const [amount, setAmount] = useState('');
  const [account, setAccount] = useState('');
  const [method, setMethod] = useState('');
  const [paymentDate, setPaymentDate] = useState(today());
  const [picked, setPicked] = useState<Record<string, string>>({});
  // A retried submission of the same form reuses its key, so it cannot pay twice.
  const [key, setKey] = useState(() => crypto.randomUUID());
  const side = direction === 'RECEIPT' ? 'RECEIVABLE' : 'PAYABLE';
  const open_items = useQuery({
    queryKey: ['open-items', partyId, side],
    queryFn: () => apiGet<Row[]>('/open-items', { partyId, side }),
    enabled: Boolean(partyId),
  });

  const create = useMutation({
    mutationFn: (body: unknown) => apiCommand('/payments', body, key),
    onSuccess: async () => {
      toast.success('Payment posted');
      setOpen(false);
      setKey(crypto.randomUUID());
      setPicked({});
      await queryClient.invalidateQueries();
    },
    onError: (error) => toast.error(error.message),
  });

  const submit = () => {
    const allocations = Object.entries(picked)
      .filter(([, v]) => v)
      .map(([openItemId, value]) => ({ openItemId, amount: value }));
    const parsed = paymentSchema.safeParse({
      direction,
      partyId,
      branchId: branches.data?.rows[0]?.id,
      financialAccountId: account,
      methodId: method,
      amount,
      paymentDate,
      allocations,
    });
    if (!parsed.success) {
      toast.error(parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
      return;
    }
    create.mutate(parsed.data);
  };

  const reverse = useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) =>
      apiCommand(`/payments/${id}/reverse`, { reason }),
    onSuccess: async () => {
      toast.success('Payment reversed');
      await queryClient.invalidateQueries();
    },
    onError: (error) => toast.error(error.message),
  });

  return (
    <div>
      <PageHeader title="Payments and receipts">
        {can('payment:post') && <Button onClick={() => setOpen(true)}>New payment</Button>}
      </PageHeader>
      <QueryState query={query} empty={query.data?.length === 0}>
        <Table
          rows={query.data ?? []}
          columns={[
            { header: 'Number', render: (r) => r.number as string },
            { header: 'Date', render: (r) => (r.paymentDate as string).slice(0, 10) },
            { header: 'Party', render: (r) => party.get(r.partyId as string) ?? '—' },
            { header: 'Type', render: (r) => r.direction as string },
            { header: 'Amount', numeric: true, render: (r) => formatDecimal(r.amount as string) },
            { header: 'Status', render: (r) => <StatusBadge status={r.status as string} /> },
          ]}
          actions={(r) =>
            r.status === 'POSTED' && can('payment:reverse') ? (
              <Button
                variant="outline"
                onClick={() => {
                  const reason = window.prompt('Reason for the reversal');
                  if (reason) reverse.mutate({ id: r.id, reason });
                }}
              >
                Reverse
              </Button>
            ) : null
          }
        />
      </QueryState>
      {open && (
        <Modal title="New payment" onClose={() => setOpen(false)}>
          <div className="space-y-3">
            <Field label="Type">
              <Select
                value={direction}
                onChange={(e) => {
                  setDirection(e.target.value as 'RECEIPT' | 'PAYMENT');
                  setPicked({});
                }}
              >
                <option value="RECEIPT">Receipt from customer</option>
                <option value="PAYMENT">Payment to supplier</option>
              </Select>
            </Field>
            <Field label="Party">
              <Select
                value={partyId}
                onChange={(e) => {
                  setPartyId(e.target.value);
                  setPicked({});
                }}
              >
                <option value="">Select…</option>
                {parties.data?.rows.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name as string}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Amount">
              <Input
                inputMode="decimal"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
              />
            </Field>
            <Field label="Account">
              <Select value={account} onChange={(e) => setAccount(e.target.value)}>
                <option value="">Select…</option>
                {accounts.data?.rows.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name as string}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Method">
              <Select value={method} onChange={(e) => setMethod(e.target.value)}>
                <option value="">Select…</option>
                {methods.data?.rows.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name as string}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Date">
              <Input
                type="date"
                value={paymentDate}
                onChange={(e) => setPaymentDate(e.target.value)}
              />
            </Field>
            {open_items.data && open_items.data.length > 0 && (
              <div>
                <p className="mb-1 text-sm font-medium">Allocate to invoices</p>
                <ul className="space-y-1 text-sm">
                  {open_items.data.map((item) => (
                    <li key={item.id} className="flex items-center justify-between gap-2">
                      <span>
                        {item.number as string} — {formatDecimal(item.outstanding as string)} due
                      </span>
                      <Input
                        aria-label={`Allocate to ${item.number as string}`}
                        className="w-28"
                        inputMode="decimal"
                        value={picked[item.id] ?? ''}
                        onChange={(e) => setPicked((p) => ({ ...p, [item.id]: e.target.value }))}
                      />
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <div className="flex justify-end">
              <Button disabled={create.isPending} onClick={submit}>
                Post
              </Button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}

export function JournalsPage() {
  const { can } = useAuth();
  const action = useAction();
  const accounts = useRefOptions('/ledger-accounts');
  const branches = useRefOptions('/branches');
  const [selected, setSelected] = useState<string | null>(null);
  const [drafting, setDrafting] = useState(false);
  const [memo, setMemo] = useState('');
  const [date, setDate] = useState(today());
  const [lines, setLines] = useState([
    { accountId: '', debit: '', credit: '' },
    { accountId: '', debit: '', credit: '' },
  ]);
  const account = useMemo(
    () =>
      new Map(accounts.data?.rows.map((a) => [a.id, `${a.code as string} ${a.name as string}`])),
    [accounts.data],
  );
  const entries = useQuery({ queryKey: ['journals'], queryFn: () => apiGet<Row[]>('/journals') });
  const drafts = useQuery({
    queryKey: ['journal-drafts'],
    queryFn: () => apiGet<Row[]>('/journal-drafts'),
  });
  const detail = useQuery({
    queryKey: ['journals', selected],
    queryFn: () => apiGet<Row[]>(`/journals/${selected as string}/lines`),
    enabled: Boolean(selected),
  });
  const pending = drafts.data?.filter((d) => d.status === 'DRAFT') ?? [];

  return (
    <div className="space-y-4">
      <PageHeader title="Journals">
        {can('journal:create') && <Button onClick={() => setDrafting(true)}>New journal</Button>}
      </PageHeader>
      {pending.length > 0 && (
        <Card>
          <h2 className="mb-2 text-sm font-medium">Awaiting posting</h2>
          <ul className="space-y-2 text-sm">
            {pending.map((d) => (
              <li key={d.id} className="flex items-center justify-between gap-2">
                <span>{d.memo as string}</span>
                {can('journal:post') && (
                  <Button
                    variant="outline"
                    onClick={() => action.mutate({ path: `/journal-drafts/${d.id}/post` })}
                  >
                    Post
                  </Button>
                )}
              </li>
            ))}
          </ul>
        </Card>
      )}
      <QueryState query={entries} empty={entries.data?.length === 0}>
        <Table
          rows={entries.data ?? []}
          onRowClick={(r) => setSelected(r.id)}
          columns={[
            { header: 'Number', render: (r) => r.number as string },
            { header: 'Date', render: (r) => (r.postingDate as string).slice(0, 10) },
            { header: 'Memo', render: (r) => r.memo as string },
            { header: 'Source', render: (r) => r.sourceType as string },
            {
              header: 'Amount',
              numeric: true,
              render: (r) => formatDecimal(r.totalDebit as string),
            },
          ]}
          actions={(r) =>
            can('journal:reverse') && !r.reversesEntryId ? (
              <Button
                variant="outline"
                onClick={() => {
                  const reason = window.prompt('Reason for the reversal');
                  if (reason)
                    action.mutate({ path: `/journals/${r.id}/reverse`, body: { reason } });
                }}
              >
                Reverse
              </Button>
            ) : null
          }
        />
      </QueryState>
      {selected && (
        <Modal title="Journal lines" onClose={() => setSelected(null)}>
          <QueryState query={detail}>
            <Table
              rows={detail.data ?? []}
              columns={[
                { header: 'Account', render: (r) => account.get(r.accountId as string) ?? '—' },
                { header: 'Debit', numeric: true, render: (r) => formatDecimal(r.debit as string) },
                {
                  header: 'Credit',
                  numeric: true,
                  render: (r) => formatDecimal(r.credit as string),
                },
              ]}
            />
          </QueryState>
        </Modal>
      )}
      {drafting && (
        <Modal title="New journal" onClose={() => setDrafting(false)} wide>
          <div className="space-y-3">
            <Field label="Memo">
              <Input value={memo} onChange={(e) => setMemo(e.target.value)} />
            </Field>
            <Field label="Date">
              <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
            </Field>
            {lines.map((line, index) => (
              <div key={index} className="grid grid-cols-3 gap-2">
                <Select
                  aria-label="Account"
                  value={line.accountId}
                  onChange={(e) =>
                    setLines((all) =>
                      all.map((l, i) => (i === index ? { ...l, accountId: e.target.value } : l)),
                    )
                  }
                >
                  <option value="">Account…</option>
                  {accounts.data?.rows.map((a) => (
                    <option
                      key={a.id}
                      value={a.id}
                    >{`${a.code as string} ${a.name as string}`}</option>
                  ))}
                </Select>
                <Input
                  aria-label="Debit"
                  placeholder="Debit"
                  inputMode="decimal"
                  value={line.debit}
                  onChange={(e) =>
                    setLines((all) =>
                      all.map((l, i) => (i === index ? { ...l, debit: e.target.value } : l)),
                    )
                  }
                />
                <Input
                  aria-label="Credit"
                  placeholder="Credit"
                  inputMode="decimal"
                  value={line.credit}
                  onChange={(e) =>
                    setLines((all) =>
                      all.map((l, i) => (i === index ? { ...l, credit: e.target.value } : l)),
                    )
                  }
                />
              </div>
            ))}
            <div className="flex justify-between">
              <Button
                variant="outline"
                onClick={() =>
                  setLines((all) => [...all, { accountId: '', debit: '', credit: '' }])
                }
              >
                Add line
              </Button>
              <Button
                onClick={() => {
                  action.mutate({
                    path: '/journal-drafts',
                    body: {
                      memo,
                      postingDate: date,
                      branchId: branches.data?.rows[0]?.id,
                      lines: lines
                        .filter((l) => l.accountId)
                        .map((l) => ({
                          accountId: l.accountId,
                          debit: l.debit || '0',
                          credit: l.credit || '0',
                        })),
                    },
                  });
                  setDrafting(false);
                }}
              >
                Save draft
              </Button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}

export function PeriodsPage() {
  const { can } = useAuth();
  const action = useAction();
  const query = useQuery({ queryKey: ['periods'], queryFn: () => apiGet<Row[]>('/periods') });
  return (
    <div>
      <PageHeader title="Financial periods">
        {can('period:create') && (
          <Button
            variant="outline"
            onClick={() => {
              const year = window.prompt('Create periods for which year?');
              if (year) action.mutate({ path: '/periods/year', body: { year: Number(year) } });
            }}
          >
            Create year
          </Button>
        )}
      </PageHeader>
      <QueryState query={query} empty={query.data?.length === 0}>
        <Table
          rows={query.data ?? []}
          columns={[
            { header: 'Period', render: (r) => r.name as string },
            { header: 'Status', render: (r) => <StatusBadge status={r.status as string} /> },
          ]}
          actions={(r) => (
            <div className="flex justify-end gap-2">
              {r.status === 'OPEN' && can('period:close') && (
                <Button
                  variant="outline"
                  onClick={() => action.mutate({ path: `/periods/${r.id}/begin-close` })}
                >
                  Close
                </Button>
              )}
              {r.status === 'CLOSING' && can('period:close') && (
                <Button
                  variant="outline"
                  onClick={() => action.mutate({ path: `/periods/${r.id}/complete-close` })}
                >
                  Finish closing
                </Button>
              )}
              {r.status !== 'OPEN' && can('period:reopen') && (
                <Button
                  variant="outline"
                  onClick={() => {
                    const reason = window.prompt('Reason for reopening');
                    if (reason)
                      action.mutate({ path: `/periods/${r.id}/reopen`, body: { reason } });
                  }}
                >
                  Reopen
                </Button>
              )}
            </div>
          )}
        />
      </QueryState>
    </div>
  );
}

interface Line {
  code: string;
  name: string;
  amount: string;
}

function Section({ title, rows, total }: { title: string; rows: Line[]; total: string }) {
  return (
    <div className="mb-4">
      <h3 className="mb-1 text-sm font-medium">{title}</h3>
      <ul className="text-sm">
        {rows.map((r) => (
          <li key={r.code} className="flex justify-between border-b py-1">
            <span>
              {r.code} {r.name}
            </span>
            <span className="tabular-nums">{formatDecimal(r.amount)}</span>
          </li>
        ))}
        <li className="flex justify-between py-1 font-semibold">
          <span>Total</span>
          <span className="tabular-nums">{formatDecimal(total)}</span>
        </li>
      </ul>
    </div>
  );
}

export function StatementsPage() {
  const [tab, setTab] = useState<
    'trial-balance' | 'profit-and-loss' | 'balance-sheet' | 'cash-flow'
  >('trial-balance');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- each statement has its own shape, rendered below
  const query = useQuery<any>({
    queryKey: ['statement', tab, from, to],
    queryFn: () => apiGet(`/statements/${tab}`, { from: from || undefined, to: to || undefined }),
  });
  const d = query.data;
  return (
    <div>
      <PageHeader title="Financial statements">
        <Select
          aria-label="Statement"
          className="w-48"
          value={tab}
          onChange={(e) => setTab(e.target.value as typeof tab)}
        >
          <option value="trial-balance">Trial balance</option>
          <option value="profit-and-loss">Profit and loss</option>
          <option value="balance-sheet">Balance sheet</option>
          <option value="cash-flow">Cash flow</option>
        </Select>
        <Input
          aria-label="From"
          type="date"
          className="w-40"
          value={from}
          onChange={(e) => setFrom(e.target.value)}
        />
        <Input
          aria-label="To"
          type="date"
          className="w-40"
          value={to}
          onChange={(e) => setTo(e.target.value)}
        />
      </PageHeader>
      <QueryState query={query}>
        {d && tab === 'trial-balance' && (
          <>
            <Table
              rows={d.rows}
              columns={[
                { header: 'Code', render: (r: Row) => r.code as string },
                { header: 'Account', render: (r: Row) => r.name as string },
                {
                  header: 'Debit',
                  numeric: true,
                  render: (r: Row) => formatDecimal(r.debit as string),
                },
                {
                  header: 'Credit',
                  numeric: true,
                  render: (r: Row) => formatDecimal(r.credit as string),
                },
              ]}
            />
            <p className="mt-2 text-end text-sm font-semibold tabular-nums">
              {formatDecimal(d.totalDebit)} / {formatDecimal(d.totalCredit)}
            </p>
          </>
        )}
        {d && tab === 'profit-and-loss' && (
          <Card>
            <Section title="Income" rows={d.income} total={d.totalIncome} />
            <Section title="Expenses" rows={d.expenses} total={d.totalExpenses} />
            <p className="text-end font-semibold tabular-nums">
              Net profit {formatDecimal(d.netProfit)}
            </p>
          </Card>
        )}
        {d && tab === 'balance-sheet' && (
          <Card>
            {!d.balanced && (
              <p role="alert" className="mb-2 text-sm text-destructive">
                This balance sheet does not balance. Investigate before relying on it.
              </p>
            )}
            <Section title="Assets" rows={d.assets} total={d.totalAssets} />
            <Section title="Liabilities" rows={d.liabilities} total={d.totalLiabilities} />
            <Section
              title="Equity (including current earnings)"
              rows={d.equity}
              total={d.totalEquity}
            />
          </Card>
        )}
        {d && tab === 'cash-flow' && (
          <Card className="space-y-1 text-sm">
            {(['operating', 'investing', 'financing', 'netChange'] as const).map((k) => (
              <div key={k} className="flex justify-between">
                <span className="capitalize">{k === 'netChange' ? 'Net change' : k}</span>
                <span className="tabular-nums">{formatDecimal(d[k])}</span>
              </div>
            ))}
          </Card>
        )}
      </QueryState>
    </div>
  );
}

export function ReportsPage() {
  const { can } = useAuth();
  const [key, setKey] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const list = useQuery({
    queryKey: ['reports'],
    queryFn: () => apiGet<{ key: string; title: string }[]>('/reports'),
  });
  const active = key || list.data?.[0]?.key || '';
  const params = { from: from || undefined, to: to || undefined };
  const query = useQuery({
    queryKey: ['report', active, from, to],
    queryFn: () =>
      apiGet<{ title: string; rows: Record<string, unknown>[] }>(`/reports/${active}`, params),
    enabled: Boolean(active),
  });
  const rows = query.data?.rows ?? [];
  const headers = rows[0] ? Object.keys(rows[0]) : [];
  return (
    <div>
      <PageHeader title="Reports">
        <Select
          aria-label="Report"
          className="w-56"
          value={active}
          onChange={(e) => setKey(e.target.value)}
        >
          {list.data?.map((r) => (
            <option key={r.key} value={r.key}>
              {r.title}
            </option>
          ))}
        </Select>
        <Input
          aria-label="From"
          type="date"
          className="w-40"
          value={from}
          onChange={(e) => setFrom(e.target.value)}
        />
        <Input
          aria-label="To"
          type="date"
          className="w-40"
          value={to}
          onChange={(e) => setTo(e.target.value)}
        />
        {can('report:export') && (
          <Button
            variant="outline"
            disabled={rows.length === 0}
            onClick={() => void downloadCsv(`/reports/${active}`, `${active}.csv`, params)}
          >
            Export CSV
          </Button>
        )}
      </PageHeader>
      <QueryState query={query} empty={rows.length === 0}>
        <Table
          rows={rows as Row[]}
          columns={headers.map((h) => ({ header: h, render: (r: Row) => String(r[h] ?? '') }))}
        />
      </QueryState>
    </div>
  );
}
