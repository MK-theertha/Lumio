import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
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
import { apiGet, apiSend } from '@/lib/api-client';

function useSend(done: (result: Row) => string, after?: () => void) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ path, body }: { path: string; body?: unknown }) =>
      apiSend<Row>('post', path, body),
    onSuccess: async (result) => {
      toast.success(done(result));
      after?.();
      await queryClient.invalidateQueries();
    },
    onError: (error) => toast.error(error.message),
  });
}

function MatchDialog({ line, onClose }: { line: Row; onClose: () => void }) {
  const send = useSend(() => 'Line matched', onClose);
  const [picked, setPicked] = useState<string[]>([]);
  const payments = useQuery({
    queryKey: ['bank-unmatched', line.financialAccountId],
    queryFn: () =>
      apiGet<Row[]>('/bank-unmatched-payments', { financialAccountId: line.financialAccountId }),
  });
  return (
    <Modal title={`Match ${formatDecimal(line.amount as string)}`} onClose={onClose} wide>
      <QueryState query={payments} empty={payments.data?.length === 0}>
        <div className="max-h-96 space-y-1 overflow-y-auto text-sm">
          {payments.data?.map((p) => (
            <label key={p.id} className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={picked.includes(p.id)}
                onChange={(e) =>
                  setPicked((s) => (e.target.checked ? [...s, p.id] : s.filter((x) => x !== p.id)))
                }
              />
              {p.number as string} · {(p.paymentDate as string).slice(0, 10)} ·{' '}
              {p.direction === 'RECEIPT' ? '+' : '-'}
              {formatDecimal(p.amount as string)} · {(p.reference as string) ?? ''}
            </label>
          ))}
        </div>
      </QueryState>
      <div className="mt-3 flex justify-end gap-2">
        <Button variant="outline" onClick={onClose}>
          Cancel
        </Button>
        <Button
          disabled={picked.length === 0 || send.isPending}
          onClick={() =>
            send.mutate({
              path: `/bank-statement-lines/${line.id}/match`,
              body: { paymentIds: picked },
            })
          }
        >
          Match
        </Button>
      </div>
    </Modal>
  );
}

function AdjustDialog({ line, onClose }: { line: Row; onClose: () => void }) {
  const send = useSend((r) => `Posted as ${r.journalNumber as string}`, onClose);
  const accounts = useRefOptions('/ledger-accounts');
  const branches = useRefOptions('/branches');
  const [ledgerAccountId, setLedgerAccountId] = useState('');
  const [branchId, setBranchId] = useState('');
  const [memo, setMemo] = useState(line.description as string);
  return (
    <Modal title={`Book ${formatDecimal(line.amount as string)} to the ledger`} onClose={onClose}>
      <div className="space-y-3">
        <Field label="Ledger account">
          <Select value={ledgerAccountId} onChange={(e) => setLedgerAccountId(e.target.value)}>
            <option value="">Select…</option>
            {accounts.data?.rows.map((a) => (
              <option key={a.id} value={a.id}>
                {a.code as string} {a.name as string}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Branch">
          <Select value={branchId} onChange={(e) => setBranchId(e.target.value)}>
            <option value="">Select…</option>
            {branches.data?.rows.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name as string}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Memo">
          <Input value={memo} onChange={(e) => setMemo(e.target.value)} />
        </Field>
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={!ledgerAccountId || !branchId || !memo || send.isPending}
            onClick={() =>
              send.mutate({
                path: `/bank-statement-lines/${line.id}/adjust`,
                body: { ledgerAccountId, branchId, memo },
              })
            }
          >
            Post
          </Button>
        </div>
      </div>
    </Modal>
  );
}

/** Pairs a line with the one that cancels it, such as a returned cheque. */
function NetDialog({ line, onClose }: { line: Row; onClose: () => void }) {
  const send = useSend(() => 'Lines netted off', onClose);
  const lines = useQuery({
    queryKey: ['bank-lines', line.financialAccountId, 'UNMATCHED'],
    queryFn: () =>
      apiGet<Row[]>('/bank-statement-lines', {
        financialAccountId: line.financialAccountId,
        status: 'UNMATCHED',
      }),
  });
  const opposites = lines.data?.filter(
    (other) => Number(other.amount) === -Number(line.amount) && other.id !== line.id,
  );
  return (
    <Modal title={`Net off ${formatDecimal(line.amount as string)}`} onClose={onClose}>
      <QueryState query={lines} empty={opposites?.length === 0}>
        <ul className="space-y-2 text-sm">
          {opposites?.map((other) => (
            <li key={other.id} className="flex items-center justify-between gap-2">
              <span>
                {(other.date as string).slice(0, 10)} {other.description as string}{' '}
                {formatDecimal(other.amount as string)}
              </span>
              <Button
                variant="outline"
                disabled={send.isPending}
                onClick={() =>
                  send.mutate({
                    path: `/bank-statement-lines/${line.id}/net`,
                    body: { otherLineId: other.id },
                  })
                }
              >
                Net off
              </Button>
            </li>
          ))}
        </ul>
      </QueryState>
    </Modal>
  );
}

interface Summary {
  closingBalance: string;
  depositsInTransit: string;
  outstandingPayments: string;
  adjustedBankBalance: string;
  cashBookBalance: string;
  difference: string;
  unmatchedLines: number;
  ledgerMovement: string;
}

function Reconciliation({ accountId }: { accountId: string }) {
  const { can } = useAuth();
  const send = useSend(() => 'Saved');
  const [statementDate, setStatementDate] = useState(new Date().toISOString().slice(0, 10));
  const [closingBalance, setClosingBalance] = useState('');
  const [openingBalance, setOpeningBalance] = useState('');
  const query = useQuery({
    queryKey: ['bank-reconciliations', accountId],
    queryFn: () => apiGet<Row[]>('/bank-reconciliations', { financialAccountId: accountId }),
  });
  const open = query.data?.find((r) => r.status === 'OPEN');
  const summary = open?.summary as Summary | undefined;
  const first = query.data?.length === 0;
  const rows: [string, string | undefined][] = summary
    ? [
        ['Statement closing balance', summary.closingBalance],
        ['Add deposits in transit', summary.depositsInTransit],
        ['Less outstanding payments', summary.outstandingPayments],
        ['Adjusted bank balance', summary.adjustedBankBalance],
        ['Cash book balance', summary.cashBookBalance],
        ['Difference', summary.difference],
      ]
    : [];

  return (
    <Card className="space-y-3">
      <h2 className="text-sm font-semibold">Reconciliation</h2>
      {open && summary ? (
        <>
          <dl className="grid max-w-md grid-cols-2 gap-1 text-sm">
            {rows.map(([label, value]) => (
              <div key={label} className="contents">
                <dt className="text-muted-foreground">{label}</dt>
                <dd className="text-right tabular-nums">{formatDecimal(value)}</dd>
              </div>
            ))}
          </dl>
          <p className="text-sm text-muted-foreground">
            {summary.unmatchedLines} statement line(s) still to deal with. Ledger account movement
            to this date: {formatDecimal(summary.ledgerMovement)}.
          </p>
          {can('bank_reconciliation:complete') && (
            <Button
              disabled={send.isPending}
              onClick={() => send.mutate({ path: `/bank-reconciliations/${open.id}/complete` })}
            >
              Complete reconciliation
            </Button>
          )}
        </>
      ) : (
        can('bank_reconciliation:manage') && (
          <div className="grid items-end gap-3 md:grid-cols-4">
            <Field label="Statement date">
              <Input
                type="date"
                value={statementDate}
                onChange={(e) => setStatementDate(e.target.value)}
              />
            </Field>
            <Field label="Closing balance on statement">
              <Input
                inputMode="decimal"
                value={closingBalance}
                onChange={(e) => setClosingBalance(e.target.value)}
              />
            </Field>
            {first && (
              <Field label="Balance before first recorded payment">
                <Input
                  inputMode="decimal"
                  value={openingBalance}
                  onChange={(e) => setOpeningBalance(e.target.value)}
                />
              </Field>
            )}
            <Button
              disabled={!closingBalance || (first && !openingBalance) || send.isPending}
              onClick={() =>
                send.mutate({
                  path: '/bank-reconciliations',
                  body: {
                    financialAccountId: accountId,
                    statementDate,
                    closingBalance,
                    ...(first ? { openingBalance } : {}),
                  },
                })
              }
            >
              Start
            </Button>
          </div>
        )
      )}
      <QueryState query={query} empty={query.data?.length === 0}>
        <Table
          rows={query.data?.filter((r) => r.status === 'COMPLETED') ?? []}
          columns={[
            { header: 'Statement date', render: (r) => (r.statementDate as string).slice(0, 10) },
            {
              header: 'Closing balance',
              numeric: true,
              render: (r) => formatDecimal(r.closingBalance as string),
            },
            { header: 'Completed', render: (r) => (r.completedAt as string).slice(0, 10) },
            { header: 'Status', render: (r) => <StatusBadge status={r.status as string} /> },
          ]}
        />
      </QueryState>
    </Card>
  );
}

export function BankReconciliationPage() {
  const { can } = useAuth();
  const accounts = useRefOptions('/financial-accounts');
  const banks = accounts.data?.rows.filter((a) => a.kind === 'BANK') ?? [];
  const [chosen, setChosen] = useState('');
  const accountId = chosen || (banks[0]?.id ?? '');
  const [dateOrder, setDateOrder] = useState('DMY');
  const [status, setStatus] = useState('UNMATCHED');
  const [matching, setMatching] = useState<Row | null>(null);
  const [adjusting, setAdjusting] = useState<Row | null>(null);
  const [netting, setNetting] = useState<Row | null>(null);
  const importing = useSend(
    (r) => `${String(r.imported)} new line(s), ${String(r.duplicates)} already held`,
  );
  const auto = useSend((r) => `${String(r.matched)} matched, ${String(r.remaining)} left`);
  const unmatch = useSend(() => 'Line unmatched');
  const lines = useQuery({
    queryKey: ['bank-lines', accountId, status],
    queryFn: () =>
      apiGet<Row[]>('/bank-statement-lines', {
        financialAccountId: accountId,
        ...(status ? { status } : {}),
      }),
    enabled: Boolean(accountId),
  });
  const manage = can('bank_reconciliation:manage');

  return (
    <div className="space-y-4">
      <PageHeader title="Bank reconciliation" />
      <Card className="grid items-end gap-3 md:grid-cols-4">
        <Field label="Bank account">
          <Select value={accountId} onChange={(e) => setChosen(e.target.value)}>
            {banks.map((a) => (
              <option key={a.id} value={a.id}>
                {a.code as string} {a.name as string}
              </option>
            ))}
          </Select>
        </Field>
        {manage && (
          <>
            <Field label="Dates in the file are">
              <Select value={dateOrder} onChange={(e) => setDateOrder(e.target.value)}>
                <option value="DMY">Day first (31/12/2026)</option>
                <option value="MDY">Month first (12/31/2026)</option>
                <option value="YMD">Year first (2026-12-31)</option>
              </Select>
            </Field>
            <Field label="Statement file (CSV)">
              <input
                type="file"
                accept=".csv"
                className="block w-full text-sm"
                disabled={!accountId || importing.isPending}
                onChange={(event) => {
                  const input = event.target;
                  const file = input.files?.[0];
                  if (!file) return;
                  file
                    .text()
                    .then((csv) =>
                      importing.mutate({
                        path: '/bank-statements/import',
                        body: { financialAccountId: accountId, csv, dateOrder },
                      }),
                    )
                    .catch(() => toast.error('The file could not be read.'))
                    .finally(() => {
                      input.value = '';
                    });
                }}
              />
            </Field>
            <Button
              variant="outline"
              disabled={!accountId || auto.isPending}
              onClick={() =>
                auto.mutate({
                  path: '/bank-reconciliations/auto-match',
                  body: { financialAccountId: accountId },
                })
              }
            >
              Auto-match
            </Button>
          </>
        )}
      </Card>

      {accountId && <Reconciliation accountId={accountId} />}

      <div className="w-56">
        <Field label="Show lines">
          <Select value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="UNMATCHED">Unmatched</option>
            <option value="MATCHED">Matched</option>
            <option value="ADJUSTED">Booked</option>
            <option value="NETTED">Netted off</option>
            <option value="">All</option>
          </Select>
        </Field>
      </div>
      {accountId ? (
        <QueryState query={lines} empty={lines.data?.length === 0}>
          <Table
            rows={lines.data ?? []}
            columns={[
              { header: 'Date', render: (r) => (r.date as string).slice(0, 10) },
              { header: 'Description', render: (r) => r.description as string },
              { header: 'Reference', render: (r) => r.reference as string },
              {
                header: 'Amount',
                numeric: true,
                render: (r) => formatDecimal(r.amount as string),
              },
              { header: 'Status', render: (r) => <StatusBadge status={r.status as string} /> },
            ]}
            actions={(r) =>
              manage ? (
                <div className="flex justify-end gap-2">
                  {r.status === 'UNMATCHED' && (
                    <>
                      <Button variant="outline" onClick={() => setMatching(r)}>
                        Match
                      </Button>
                      <Button variant="outline" onClick={() => setAdjusting(r)}>
                        Book
                      </Button>
                      <Button variant="ghost" onClick={() => setNetting(r)}>
                        Net off
                      </Button>
                    </>
                  )}
                  {r.status === 'MATCHED' && !r.reconciliationId && (
                    <Button
                      variant="ghost"
                      onClick={() =>
                        unmatch.mutate({ path: `/bank-statement-lines/${r.id}/unmatch` })
                      }
                    >
                      Unmatch
                    </Button>
                  )}
                </div>
              ) : null
            }
          />
        </QueryState>
      ) : (
        <p className="text-sm text-muted-foreground">
          Add a bank account under Cash and bank first.
        </p>
      )}
      {matching && <MatchDialog line={matching} onClose={() => setMatching(null)} />}
      {adjusting && <AdjustDialog line={adjusting} onClose={() => setAdjusting(null)} />}
      {netting && <NetDialog line={netting} onClose={() => setNetting(null)} />}
    </div>
  );
}
